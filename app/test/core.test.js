import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RateLimiter } from "../js/core/limiter.js";
import { ApiError, CircuitBreaker, errorFromResponse, fetchWithTimeout, withRetry } from "../js/core/retry.js";
import { chunkForSend, chunkForTts, chunkText, isFiller, similarity, splitSentences } from "../js/core/text.js";
import { Coalescer, EchoFilter, Segmenter } from "../js/core/listen.js";
import { Glossary } from "../js/core/glossary.js";
import { SseParser } from "../js/core/sse.js";

describe("RateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Firing 20 in a burst → at most 4 per second, none dropped", async () => {
    const lim = new RateLimiter();
    const done = [];
    for (let i = 0; i < 20; i++) lim.schedule(() => done.push(Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1050); // +50ms safety margin
    expect(done).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(4300);
    expect(done).toHaveLength(20);
    // any 1-second window never holds more than 4
    for (let i = 4; i < done.length; i++) expect(done[i] - done[i - 4]).toBeGreaterThan(1000);
  });

  it("Never more than 180 per minute", async () => {
    const lim = new RateLimiter({ perSec: 1000 });
    let n = 0;
    for (let i = 0; i < 200; i++) lim.schedule(() => n++);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(n).toBe(180);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(n).toBe(200);
  });

  it("On 429 → halve the cap for 60s, then raise it back +1 every 10s", () => {
    let t = 0;
    const lim = new RateLimiter({ now: () => t });
    lim.on429();
    expect(lim.caps().sec).toBe(2);
    expect(lim.caps().min).toBe(90);
    t = 59_999; expect(lim.caps().sec).toBe(2);
    t = 60_000; expect(lim.caps().sec).toBe(3);
    t = 70_000; expect(lim.caps().sec).toBe(4);
    expect(lim.caps().min).toBe(180);
  });
});

describe("withRetry / errors", () => {
  const noSleep = async () => {};
  it("Retry network/5xx/429, then succeed", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ApiError("RATE_LIMIT"))
      .mockRejectedValueOnce(new ApiError("UPSTREAM_DOWN"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { sleepFn: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("No retry on 400/401", async () => {
    for (const code of ["BAD_INPUT", "AUTH"]) {
      const fn = vi.fn().mockRejectedValue(new ApiError(code));
      await expect(withRetry(fn, { sleepFn: noSleep })).rejects.toMatchObject({ code });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
  it("Max 3 retries, backoff 400 → 1000 → 2500 (+jitter ≤30%)", async () => {
    const waits = [];
    const fn = vi.fn().mockRejectedValue(new ApiError("NETWORK"));
    await expect(withRetry(fn, { sleepFn: async (ms) => { waits.push(ms); }, random: () => 1 })).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([520, 1300, 3250]);
  });
  it("Honors retry_after_ms", async () => {
    const waits = [];
    const fn = vi.fn().mockRejectedValueOnce(new ApiError("RATE_LIMIT", { retryAfterMs: 1200 })).mockResolvedValue(1);
    await withRetry(fn, { sleepFn: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1200]);
  });
  it("Worker's Thai error JSON → ApiError", async () => {
    const res = new Response(JSON.stringify({ error: { code: "AUTH", message_th: "รหัสแอปไม่ถูกต้อง" } }), { status: 401 });
    const e = await errorFromResponse(res);
    expect(e.code).toBe("AUTH");
    expect(e.retryable).toBe(false);
    expect(e.message_th).toBe("รหัสแอปไม่ถูกต้อง");
    const e2 = await errorFromResponse(new Response(JSON.stringify({ error: { code: "RATE_LIMIT", retry_after_ms: 800 } }), { status: 429 }));
    expect(e2.retryAfterMs).toBe(800);
  });
  it("timeout → TIMEOUT, external cancel → ABORTED", async () => {
    vi.useFakeTimers();
    const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("x"))));
    const p = fetchWithTimeout("u", {}, 10_000, undefined, hang);
    vi.advanceTimersByTime(10_001);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    const c = new AbortController();
    const p2 = fetchWithTimeout("u", {}, 10_000, c.signal, hang);
    c.abort();
    await expect(p2).rejects.toMatchObject({ code: "ABORTED" });
    vi.useRealTimers();
  });
  it("Circuit breaker: 5 fails in 60s → pause 15s, then recover on its own", () => {
    let t = 0;
    const cb = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 4; i++) cb.failure();
    expect(cb.isOpen()).toBe(false);
    cb.failure();
    expect(cb.isOpen()).toBe(true);
    t = 14_999; expect(cb.isOpen()).toBe(true);
    t = 15_000; expect(cb.isOpen()).toBe(false);
  });
});

describe("Sentence chunking", () => {
  it("zh/ja/ko split at sentence ends", () => {
    expect(splitSentences("今天天气很好。我们去公园吧！你呢？")).toEqual(["今天天气很好。", "我们去公园吧！", "你呢？"]);
    expect(splitSentences("こんにちは。元気ですか？")).toEqual(["こんにちは。", "元気ですか？"]);
    expect(splitSentences("안녕하세요. 반갑습니다!")).toEqual(["안녕하세요.", "반갑습니다!"]);
  });
  it("en does not split on decimal points", () => {
    expect(splitSentences("It costs 3.50 dollars. OK?")).toEqual(["It costs 3.50 dollars.", "OK?"]);
  });
  it("Long text → chunks within limit, order preserved, no text lost", () => {
    const zh = "我今天去了市场。".repeat(60);
    const chunks = chunkForSend(zh, "zh");
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join("")).toBe(zh);
    const th = "วันนี้อากาศดีมาก เราไปเดินเล่นที่สวนกันไหม ".repeat(30).trim();
    const tc = chunkForSend(th, "th");
    expect(tc.every((c) => c.length <= 600)).toBe(true);
    expect(tc.join(" ").replace(/\s+/g, "")).toBe(th.replace(/\s+/g, ""));
  });
  it("TTS chunks ≤ 120 characters", () => {
    const en = "This is a fairly long sentence for testing purposes. ".repeat(8);
    expect(chunkForTts(en).every((c) => c.length <= 120)).toBe(true);
  });
  it("A single sentence with no punctuation is still split", () => {
    expect(chunkText("ก".repeat(250), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});

describe("Segmenter", () => {
  let segs, seg, timers;
  beforeEach(() => {
    vi.useFakeTimers();
    segs = [];
    seg = new Segmenter({ lang: "zh", onSegment: (s) => segs.push(s) });
  });
  afterEach(() => vi.useRealTimers());

  it("Silence 700ms → send", () => {
    seg.interim("你好");
    seg.interim("你好我是小明");
    vi.advanceTimersByTime(699);
    expect(segs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(segs).toEqual(["你好我是小明"]);
  });
  it("isFinal → send immediately (only the unsent part)", () => {
    seg.interim("你好我是小明");
    vi.advanceTimersByTime(700);
    seg.final("你好我是小明，很高兴认识你");
    expect(segs).toEqual(["你好我是小明", "，很高兴认识你"]);
  });
  it("Over 40 characters → cut at the last punctuation and send the first part", () => {
    const long = "今天我们去了一个很远的地方玩，那里风景特别漂亮，还有很多好吃的东西我们都吃不完了真的太开心";
    seg.interim(long);
    expect(segs.length).toBe(1);
    expect(segs[0].endsWith("，")).toBe(true);
    expect(segs[0].length).toBeLessThanOrEqual(41);
  });
  it("en over 20 words → cut", () => {
    const s = new Segmenter({ lang: "en", onSegment: (x) => segs.push(x) });
    s.interim("one two three four five six seven eight nine ten, eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo");
    expect(segs.length).toBe(1);
    expect(segs[0].split(/\s+/).length).toBeLessThanOrEqual(20);
  });
  it("Filter filler words / blanks, no duplicate segments", () => {
    seg.final("嗯");
    seg.final("啊");
    seg.final("  ");
    seg.final("谢谢你");
    seg.final("谢谢你");
    expect(segs).toEqual(["谢谢你"]);
  });
  it("Different silence delay for Bluetooth (900ms)", () => {
    seg.setSilence(900);
    seg.interim("你好吗");
    vi.advanceTimersByTime(800);
    expect(segs).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(segs).toEqual(["你好吗"]);
  });
});

describe("Coalescer", () => {
  it("1 running + 1 waiting, new segments appended to the waiting job", async () => {
    const runs = [];
    let release;
    const c = new Coalescer({ run: (job) => { runs.push(job.text); return new Promise((r) => (release = r)); } });
    c.push("A");
    c.push("B");
    c.push("C");
    c.push("D");
    expect(runs).toEqual(["A"]);
    expect(c.pending?.text).toBe("B C D");
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual(["A", "B C D"]);
  });
  it("Waiting job over 300 characters → send immediately", () => {
    const runs = [];
    const c = new Coalescer({ run: (job) => { runs.push(job.text.length); return new Promise(() => {}); } });
    c.push("x");
    c.push("y".repeat(200));
    expect(runs).toEqual([1]);
    c.push("z".repeat(150));
    expect(runs).toEqual([1, 200 + 1 + 150]); // "y…" + " " + "z…"
    expect(c.pending).toBeNull();
  });
  it("Firing 30 segments in 10s → none lost (merged) and API calls stay well below the segment count", async () => {
    vi.useFakeTimers();
    const sent = [];
    const c = new Coalescer({ run: async (job) => { sent.push(job.text); await new Promise((r) => setTimeout(r, 900)); } });
    for (let i = 0; i < 30; i++) { c.push(`s${i}`); await vi.advanceTimersByTimeAsync(333); }
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    const all = sent.join(" ").split(" ");
    expect(all).toEqual(Array.from({ length: 30 }, (_, i) => `s${i}`));
    expect(sent.length).toBeLessThan(15);
  });
});

describe("EchoFilter", () => {
  it("Drop segments similar to what was just spoken, keep other speech", () => {
    let t = 0;
    const f = new EchoFilter({ now: () => t });
    f.noteSpoken("请问洗手间在哪里？");
    expect(f.isEcho("请问洗手间在哪里")).toBe(true);
    expect(f.isEcho("洗手间在哪里")).toBe(true);
    expect(f.isEcho("你今天吃饭了吗")).toBe(false);
    t = 60_000;
    expect(f.isEcho("请问洗手间在哪里")).toBe(false);
  });
  it("similarity", () => {
    expect(similarity("hello world", "Hello, world!")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
  it("isFiller", () => {
    expect(isFiller("嗯")).toBe(true);
    expect(isFiller("um")).toBe(true);
    expect(isFiller("ㅋ")).toBe(true);
    expect(isFiller("你好")).toBe(false);
  });
});

describe("Glossary", () => {
  const g = new Glossary().load([
    { term: "666", lang: "zh", meaning_th: "เก่งมาก", tag: "slang", domain: "general" },
    { term: "躺平", lang: "zh", meaning_th: "ขอไม่สู้", tag: "slang", domain: "general" },
    { term: "躺", lang: "zh", meaning_th: "นอน", tag: "formal", domain: "general" },
    { term: "过敏", lang: "zh", meaning_th: "แพ้", tag: "medical", domain: "medical" },
    { term: "过", lang: "zh", meaning_th: "ผ่าน", domain: "general" },
    { term: "piece of cake", lang: "en", meaning_th: "ง่ายมาก", tag: "idiom", domain: "general" },
    { term: "cake", lang: "en", meaning_th: "เค้ก", domain: "general" },
    { term: "ヤバい", lang: "ja", meaning_th: "สุดยอด/แย่", aliases: ["やばい"], domain: "general" },
  ]);
  it("longest-match", () => {
    expect(g.find("我直接躺平了").map((e) => e.term)).toEqual(["躺平"]);
    expect(g.find("That's a piece of cake").map((e) => e.term)).toEqual(["piece of cake"]);
  });
  it("aliases + case-insensitive", () => {
    expect(g.find("まじでやばい").map((e) => e.term)).toEqual(["ヤバい"]);
    expect(g.find("PIECE OF CAKE!").map((e) => e.term)).toEqual(["piece of cake"]);
  });
  it("en must match word boundaries", () => expect(g.find("cupcakes").length).toBe(0));
  it("Current domain first", () => {
    const r = g.find("过敏 666", { domain: "medical" });
    expect(r[0].term).toBe("过敏");
  });
  it("Max 15 entries", () => {
    const many = new Glossary().load(Array.from({ length: 40 }, (_, i) => ({ term: `w${i}x`, lang: "en", meaning_th: "m" })));
    expect(many.find(Array.from({ length: 40 }, (_, i) => `w${i}x`).join(" ")).length).toBe(15);
  });
  it("Search 10,000 entries < 5ms", () => {
    const big = new Glossary().load(Array.from({ length: 10_000 }, (_, i) => ({ term: `词${i}语`, lang: "zh", meaning_th: "m" })));
    const text = "我们今天讨论一下这个词123语还有词9999语以及别的东西，".repeat(4);
    big.find(text); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) big.find(text);
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(5);
  });
  it("Real glossary files load fine + core test cases are found", () => {
    const load = (l) => JSON.parse(readFileSync(new URL(`../data/glossary/${l}.json`, import.meta.url), "utf8"));
    const real = new Glossary().load([...load("zh"), ...load("en"), ...load("ja"), ...load("ko"), ...load("th")]);
    expect(real.size).toBeGreaterThan(1500);
    const terms = (t, lang) => real.find(t, { lang }).map((e) => e.term);
    expect(terms("你这操作666啊", "zh")).toContain("666");
    expect(terms("我直接躺平了", "zh")).toContain("躺平");
    expect(terms("绝绝子", "zh")).toContain("绝绝子");
    expect(terms("That's a piece of cake", "en")).toContain("piece of cake");
    expect(terms("대박!", "ko")).toContain("대박");
    expect(terms("อันนี้ จึ้งมาก ชอบ", "th")).toContain("จึ้ง");
  });
});

describe("SseParser", () => {
  it("events + ping + chunks split mid-line", () => {
    const p = new SseParser();
    const a = p.push('event: delta\ndata: {"t":"สวัส');
    const b = p.push('ดี"}\n\n: ping\n\nevent: done\ndata: {"latency_ms":900}\n\n');
    expect(a).toEqual([]);
    expect(b).toEqual([
      { event: "delta", data: { t: "สวัสดี" } },
      { event: "ping", data: null },
      { event: "done", data: { latency_ms: 900 } },
    ]);
  });
});

describe("Data: quick phrases", () => {
  it("Every phrase has all 5 languages and a valid category", () => {
    const q = JSON.parse(readFileSync(new URL("../data/quick-phrases.json", import.meta.url), "utf8"));
    const cats = new Set(q.categories.map((c) => c.id));
    for (const p of q.phrases) {
      for (const k of ["th", "zh", "en", "ja", "ko"]) expect(p[k], `${p.id}.${k}`).toBeTruthy();
      expect(cats.has(p.cat)).toBe(true);
    }
  });
});
