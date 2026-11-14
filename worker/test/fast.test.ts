import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractTranslation, handleFast, translationOk } from "../src/fast";
import { _resetThinkingCache, primaryIsDown } from "../src/thaillm";
import type { Env } from "../src/types";

const env: Env = {
  THAILLM_URL: "https://thaillm.test/v1/chat/completions",
  THAILLM_MODEL: "qwen",
  THAILLM_FALLBACK_MODEL: "small8b",
  THAILLM_API_KEY: "k",
  APP_TOKEN: "t".repeat(24),
  ALLOWED_ORIGIN: "*",
  FALLBACK_LLM_URL: "https://typhoon.test/v1/chat/completions",
  FALLBACK_LLM_KEY: "k2",
  FALLBACK_LLM_MODEL: "big30b",
};
const req = (over: any = {}) => ({ text: "你这操作666啊", direction: "partner_to_me", target_lang: "zh", domain: "general", history: [], glossary: [], request_id: "r1", ...over }) as any;
const full = (tr: string) => JSON.stringify({ translation: tr, tone: "compliment", note_th: "666 = เก่งมาก", back_translation_th: "", needs_confirm: false, replies: [{ th: "ขอบใจนะ", target: "谢谢啦" }], terms: [], detected_lang: "zh" });

type Plan = { status?: number; delayFirst?: number; chunks?: string[]; gap?: number; cutAfter?: number; back?: string };
/** mock upstream ตามชื่อรุ่น: หน่วงเวลา / ตอบ error / stream ทีละชิ้น / ตัดกลางคัน — เคารพ abort */
function mockUpstream(plans: Record<string, Plan>) {
  const calls: string[] = [];
  const aborted: string[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const reqBody = JSON.parse(init.body as string);
    const model = reqBody.model as string;
    const p = plans[model] ?? { status: 500 };
    // คำขอแปลกลับ (ไม่ stream) → ตอบ JSON ธรรมดา
    if (reqBody.stream === false) {
      calls.push(model + ":back");
      return new Response(JSON.stringify({ choices: [{ message: { content: p.back ?? "แปลกลับไทย" } }] }), { status: p.back === "FAIL" ? 500 : 200 });
    }
    calls.push(model);
    const sig = init.signal!;
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, p.delayFirst ?? 0);
      sig.addEventListener("abort", () => { clearTimeout(t); aborted.push(model); rej(new DOMException("aborted", "AbortError")); }, { once: true });
    });
    if (p.status && p.status !== 200) return new Response("error", { status: p.status });
    const e = new TextEncoder();
    const body = new ReadableStream({
      async start(c) {
        const chunks = p.chunks ?? [];
        for (let i = 0; i < chunks.length; i++) {
          if (sig.aborted) return;
          if (p.cutAfter !== undefined && i === p.cutAfter) { c.error(new Error("reset")); return; }
          c.enqueue(e.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`));
          await new Promise((r) => setTimeout(r, p.gap ?? 1));
        }
        c.enqueue(e.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    sig.addEventListener("abort", () => { if (!aborted.includes(model)) aborted.push(model); }, { once: true });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, aborted };
}
const split = (s: string, n = 6) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));
function allEvents(text: string) {
  return text.split("\n\n").filter((b) => b.startsWith("event:")).map((b) => ({ event: /event: (\w+)/.exec(b)![1], data: JSON.parse(/data: (.*)/.exec(b)![1]) }));
}
/** event หลัก (ไม่รวม progress ที่ไหลระหว่างพิมพ์) */
const events = (text: string) => allEvents(text).filter((e) => e.event !== "progress");

beforeEach(() => { _resetThinkingCache(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => vi.unstubAllGlobals());

describe("extractTranslation", () => {
  it("ได้คำแปลทันทีที่ string ปิด แม้ JSON ยังไม่จบ", () => {
    expect(extractTranslation('{"translation":"นายนี่เก่ง')).toBeNull();
    expect(extractTranslation('{"translation":"นายนี่เก่ง\\"จริงๆ\\"","tone":"jo')).toBe('นายนี่เก่ง"จริงๆ"');
    expect(extractTranslation('<think>{"translation":"ผิด"}</think>```json\n{"translation":"ถูก"')).toBe("ถูก"); // ข้ามของใน <think>, ตัด fence
    expect(extractTranslation('<think>x</think>{"translation":"ถูก"')).toBe("ถูก");
  });
  it("ตรวจภาษา", () => {
    expect(translationOk("สวัสดี", "partner_to_me")).toBe(true);
    expect(translationOk("你好", "partner_to_me")).toBe(false);
    expect(translationOk("你好", "me_to_partner")).toBe(true);
  });
});

describe("/api/translate/fast", () => {
  it("รุ่นหลักล่มทันที → รุ่นถัดไป: partial มาก่อน แล้วตามด้วย result เต็ม", async () => {
    const { calls } = mockUpstream({ qwen: { status: 504 }, big30b: { chunks: split(full("นายนี่เก่งจริงๆ")) } });
    const ev = events(await handleFast(env, req(), {}).text());
    expect(ev.map((e) => e.event)).toEqual(["partial", "result"]);
    expect(ev[0].data.translation).toBe("นายนี่เก่งจริงๆ");
    expect(ev[1].data).toMatchObject({ translation: "นายนี่เก่งจริงๆ", tone: "compliment", engine: "external", back_translation_th: "นายนี่เก่งจริงๆ" });
    expect(ev[1].data.replies).toHaveLength(1);
    expect(calls).toEqual(["qwen", "big30b"]);
    expect(primaryIsDown()).toBe(true);
  });

  it("รุ่นแรกช้า → hedge ยิงรุ่นถัดไปคู่ขนาน ใครได้ก่อนชนะ ผู้แพ้ถูกยกเลิก", async () => {
    const { calls, aborted } = mockUpstream({
      qwen: { delayFirst: 400, chunks: split(full("ช้า")) },
      big30b: { chunks: split(full("เร็ว")) },
    });
    const t0 = Date.now();
    const res = handleFast(env, req(), {}, undefined, { hedgeMs: 50 });
    const rd = res.body!.getReader();
    const dec = new TextDecoder();
    let txt = "", partialAt = 0;
    for (;;) { const x = await rd.read(); if (x.done) break; txt += dec.decode(x.value); if (!partialAt && txt.includes("event: partial")) partialAt = Date.now() - t0; }
    const ev = events(txt);
    expect(ev[0]).toMatchObject({ event: "partial", data: { translation: "เร็ว" } });
    expect(ev.at(-1)!.data.engine).toBe("external");
    expect(calls).toEqual(["qwen", "big30b"]);
    expect(aborted).toContain("qwen");
    expect(partialAt).toBeLessThan(380); // คำแปลถึงผู้ใช้ก่อนรุ่นช้าจะตอบ (400ms)
  });

  it("รุ่นแรกตอบผิดภาษา → ข้ามไปรุ่นถัดไปทันที ไม่ส่งคำแปลผิดให้ผู้ใช้", async () => {
    mockUpstream({ qwen: { chunks: split(full("你真厉害")) }, big30b: { chunks: split(full("เก่งจัง")) } });
    const ev = events(await handleFast(env, req(), {}, undefined, { hedgeMs: 5000 }).text());
    expect(ev.filter((e) => e.event === "partial").map((e) => e.data.translation)).toEqual(["เก่งจัง"]);
    expect(ev.at(-1)!.event).toBe("result");
  });

  it("ทุกรุ่นล่ม → event: error (ไม่เงียบ ไม่ค้าง)", async () => {
    mockUpstream({ qwen: { status: 502 }, big30b: { status: 500 }, small8b: { status: 503 } });
    const ev = events(await handleFast(env, req(), {}).text());
    expect(ev).toHaveLength(1);
    expect(ev[0].event).toBe("error");
    expect(ev[0].data.message_th).toMatch(/ขัดข้อง/);
  });

  it("ผู้ชนะหลุดกลางทางหลังส่ง partial → ยังได้ result จากคำแปลที่มี", async () => {
    const chunks = split(full("คำแปลครบแล้ว"), 4);
    const cutAt = chunks.findIndex((_, i) => chunks.slice(0, i).join("").includes('"tone"')) + 1;
    mockUpstream({ qwen: { chunks, cutAfter: cutAt } });
    const ev = events(await handleFast(env, req(), {}, undefined, { hedgeMs: 5000 }).text());
    expect(ev.map((e) => e.event)).toEqual(["partial", "result"]);
    expect(ev[1].data.translation).toBe("คำแปลครบแล้ว");
  });

  it("me_to_partner: partial เป็นภาษาเพื่อน + result มีแปลกลับไทย", async () => {
    const body = JSON.stringify({ translation: "请问洗手间在哪里？", tone: "polite", note_th: "", back_translation_th: "ห้องน้ำอยู่ไหน", replies: [], terms: [] });
    const { calls } = mockUpstream({ qwen: { chunks: split(body), back: "ขอถามหน่อย ห้องน้ำอยู่ที่ไหน" } });
    const ev = events(await handleFast(env, req({ text: "ห้องน้ำอยู่ไหน", direction: "me_to_partner" }), {}).text());
    expect(ev[0].data.translation).toBe("请问洗手间在哪里？");
    // "เพื่อนจะเข้าใจว่า" มาจากคำขอแปลกลับแยก (ไม่ใช่ที่โมเดลลอกคำพูดเรา)
    expect(ev[1].data.back_translation_th).toBe("ขอถามหน่อย ห้องน้ำอยู่ที่ไหน");
    expect(calls).toContain("qwen:back");
  });
  it("แปลกลับล้ม → ใช้ของเดิม ไม่ทำให้ผลหลักพัง", async () => {
    const body = JSON.stringify({ translation: "请问洗手间在哪里？", tone: "polite", note_th: "", back_translation_th: "ห้องน้ำอยู่ที่ไหน", replies: [], terms: [] });
    mockUpstream({ qwen: { chunks: split(body), back: "FAIL" } });
    const ev = events(await handleFast(env, req({ text: "ห้องน้ำอยู่ไหน", direction: "me_to_partner" }), {}).text());
    expect(ev.map((e) => e.event)).toEqual(["partial", "result"]);
    expect(ev[1].data.back_translation_th).toBe("ห้องน้ำอยู่ที่ไหน");
  });

  it("คำแปลไหลขึ้นจอระหว่างพิมพ์ (progress) และทุกชิ้นเป็นส่วนต้นของคำแปลจริง", async () => {
    const tr = "ช่างบอกว่าแผ่นเบรกหมดแล้ว ต้องเปลี่ยนใหม่ ใช้เวลาสองชั่วโมง ค่าใช้จ่ายประมาณแปดร้อยหยวน";
    mockUpstream({ qwen: { chunks: split(full(tr), 3) } });
    const all = allEvents(await handleFast(env, req({ text: "The brake pads are worn out" }), {}).text());
    const prog = all.filter((e) => e.event === "progress");
    expect(prog.length).toBeGreaterThan(2);
    // ประกอบแบบเดียวกับแอป: ส่วนที่เพิ่ม {from, d} → ทุกขั้นต้องเป็นส่วนต้นของคำแปลจริง
    let acc = "";
    for (const p of prog) { acc = p.data.translation ?? acc.slice(0, p.data.from) + p.data.d; expect(tr.startsWith(acc)).toBe(true); }
    expect(prog.every((p) => p.data.d !== undefined)).toBe(true); // ส่งแบบส่วนที่เพิ่มจริง (ประหยัดเน็ต)
    const iPartial = all.findIndex((e) => e.event === "partial");
    expect(all.slice(0, iPartial).every((e) => e.event === "progress")).toBe(true);
    expect(all[iPartial].data.translation).toBe(tr);
  });
  it("progress ไม่ปล่อยถ้าภาษาผิด (ตรวจตั้งแต่ 3 ตัวอักษรแรก)", async () => {
    mockUpstream({ qwen: { chunks: split(full("这是错误的语言输出内容"), 3) }, big30b: { chunks: split(full("ถูกภาษา"), 3) } });
    const all = allEvents(await handleFast(env, req(), {}, undefined, { hedgeMs: 5000 }).text());
    let acc = "";
    for (const e of all.filter((x) => x.event === "progress" || x.event === "partial")) {
      acc = e.data.translation ?? acc.slice(0, e.data.from) + e.data.d;
      expect(acc).not.toMatch(/[一-鿿]/); // ไม่มีจีนหลุดไปถึงผู้ใช้
      expect(acc).toMatch(/[ก-๙]/);
    }
  });
});

describe("จำว่ารุ่นหลักเงียบ", () => {
  beforeEach(() => { _resetThinkingCache(); vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => vi.unstubAllGlobals());
  it("รุ่นหลักเงียบสนิทจนถูกแซง → พักรุ่นหลัก คำขอถัดไปไม่ต้องรอ", async () => {
    const { calls } = mockUpstream({ qwen: { delayFirst: 2000, chunks: split(full("ช้า")) }, big30b: { chunks: split(full("เร็ว")) } });
    await handleFast(env, req(), {}, undefined, { primaryHedgeMs: 30 }).text();
    expect(primaryIsDown()).toBe(true);
    calls.length = 0;
    await handleFast(env, req(), {}, undefined, { primaryHedgeMs: 30 }).text();
    expect(calls[0]).toBe("big30b"); // ไม่เรียกรุ่นหลักก่อนแล้ว
  });
});
