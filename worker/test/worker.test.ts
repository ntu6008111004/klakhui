import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { AppError, withRetry } from "../src/resilience";
import { _getThinkingCache, _resetThinkingCache } from "../src/thaillm";
import { splitInHalf } from "../src/translate";
import type { Env } from "../src/types";

const env: Env = {
  THAILLM_URL: "https://mock.test/v1/chat/completions",
  THAILLM_MODEL: "qwen3.6-35b-a3b",
  THAILLM_API_KEY: "test-key",
  APP_TOKEN: "test-token-123456789012345",
  ALLOWED_ORIGIN: "https://translate.dentcos.com",
};

const ctx: any = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {} };
const ok = (content: string, finish = "stop", extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: finish }] }), { status: 200 });
const resultJson = (translation: string, tone = "neutral") =>
  JSON.stringify({ detected_lang: "zh", translation, back_translation_th: translation, tone, note_th: "", terms: [], needs_confirm: false });

function call(body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request("https://api.test/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN, Origin: "https://translate.dentcos.com", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}
const base = { text: "你这操作666啊", direction: "partner_to_me", target_lang: "zh", domain: "general", history: [], glossary: [], request_id: "r1" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  _resetThinkingCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const sentBodies = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));

describe("/api/translate", () => {
  it("สำเร็จ + ส่ง enable_thinking:false + ไม่สน reasoning_content + CORS", async () => {
    fetchMock.mockResolvedValueOnce(ok(resultJson("เก่งมาก", "compliment"), "stop", { reasoning_content: "ignore me" }));
    const res = await call(base);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.translation).toBe("เก่งมาก");
    expect(j.request_id).toBe("r1");
    expect(typeof j.latency_ms).toBe("number");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://translate.dentcos.com");
    const b = sentBodies()[0];
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(b.stream).toBe(false);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key");
  });

  it("upstream ไม่รู้จัก chat_template_kwargs → ลองใหม่โดยไม่ส่ง แล้ว cache", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"Unrecognized field chat_template_kwargs"}', { status: 400 }))
      .mockResolvedValueOnce(ok(resultJson("ก")))
      .mockResolvedValueOnce(ok(resultJson("ข")));
    expect((await call(base)).status).toBe(200);
    expect((await call(base)).status).toBe(200);
    const bodies = sentBodies();
    expect(bodies[0].chat_template_kwargs).toBeDefined();
    expect(bodies[1].chat_template_kwargs).toBeUndefined();
    expect(bodies[2].chat_template_kwargs).toBeUndefined(); // cache แล้ว ไม่ลองซ้ำ
    expect(_getThinkingCache()).toBe(false);
  });

  it("JSON เสีย → retry temp 0 + 'Return valid JSON only.'", async () => {
    fetchMock.mockResolvedValueOnce(ok("ขอโทษ ฉันคิดว่า...")).mockResolvedValueOnce(ok(resultJson("โอเค")));
    const j: any = await (await call(base)).json();
    expect(j.translation).toBe("โอเค");
    const b2 = sentBodies()[1];
    expect(b2.temperature).toBe(0);
    expect(b2.messages.at(-1).content).toBe("Return valid JSON only.");
  });

  it("JSON เสีย 2 ครั้ง → fallback ข้อความดิบ ไม่ค้าง", async () => {
    fetchMock.mockResolvedValueOnce(ok("<think>x</think>เก่งจริง")).mockResolvedValueOnce(ok("เก่งจริงๆ"));
    const res = await call(base);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.translation).toBe("เก่งจริงๆ");
    expect(j.tone).toBe("neutral");
  });

  it("429 แล้วสำเร็จ (retry ฝั่ง worker 1 ครั้ง)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("rate", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(ok(resultJson("โอเค")));
    expect((await call(base)).status).toBe(200);
  });

  it("500 สองครั้ง → 502 UPSTREAM_DOWN + message_th", async () => {
    fetchMock.mockResolvedValue(new Response("down", { status: 500, headers: { "Retry-After": "0" } }));
    const res = await call(base);
    expect(res.status).toBe(502);
    const j: any = await res.json();
    expect(j.error.code).toBe("UPSTREAM_DOWN");
    expect(j.error.message_th).toMatch(/ขัดข้อง/);
  });

  it("400 จาก upstream (ยาวเกิน) → ลดขนาดเป็นขั้นแล้วสำเร็จ", async () => {
    const history = Array.from({ length: 6 }, (_, i) => ({ who: "partner", text: "历史" + i }));
    const glossary = [{ term: "666", meaning_th: "เก่ง" }];
    fetchMock
      .mockResolvedValueOnce(new Response("context length exceeded", { status: 400 }))
      .mockResolvedValueOnce(new Response("context length exceeded", { status: 400 }))
      .mockResolvedValueOnce(ok(resultJson("โอเค")));
    const res = await call({ ...base, history, glossary });
    expect(res.status).toBe(200);
    const sys = sentBodies().map((b) => b.messages[0].content as string);
    expect(sys[0]).toContain("历史0");
    expect(sys[1]).not.toContain("历史3"); // เหลือ 2 turn
    expect(sys[1]).toContain("历史5");
    expect(sys[1]).toContain("666");
    expect(sys[2]).not.toContain("- 666"); // ตัด glossary
  });

  it("finish_reason=length → แบ่งครึ่งแล้วแปลใหม่ครบ", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(resultJson("ครึ่ง"), "length"))
      .mockResolvedValueOnce(ok(resultJson("ท่อนแรก")))
      .mockResolvedValueOnce(ok(resultJson("ท่อนสอง")));
    const j: any = await (await call({ ...base, text: "今天天气很好。我们去公园散步吧！" })).json();
    expect(j.translation).toBe("ท่อนแรก ท่อนสอง");
  });

  it("token ผิด → 401 ภาษาไทย ไม่เรียก upstream", async () => {
    const res = await call(base, { "X-App-Token": "wrong" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.message_th).toMatch(/รหัสแอป/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body > 16KB → 413", async () => {
    const res = await call({ ...base, history: [{ who: "me", text: "ก".repeat(20000) }] });
    expect(res.status).toBe(413);
  });

  it("input ผิด → 400 ทันที", async () => {
    expect((await call({ ...base, direction: "x" })).status).toBe(400);
    expect((await call({ ...base, text: "" })).status).toBe(400);
    expect((await call({ ...base, text: "a".repeat(1001) })).status).toBe(400);
    expect((await call("{not json")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("timeout → 504", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    const p = call(base);
    await vi.advanceTimersByTimeAsync(30000);
    const res = await p;
    vi.useRealTimers();
    expect(res.status).toBe(504);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};
  it("ไม่ retry 400/401", async () => {
    const fn = vi.fn().mockRejectedValue(new AppError("BAD_INPUT"));
    await expect(withRetry(fn, { retries: 3, baseMs: 1, sleepFn: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("เคารพ retryAfterMs", async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new AppError("RATE_LIMIT", 1234)).mockResolvedValue("ok");
    await withRetry(fn, { retries: 1, baseMs: 500, sleepFn: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1234]);
  });
});

describe("splitInHalf", () => {
  it("ตัดที่จุดจบประโยค", () => expect(splitInHalf("今天天气很好。我们去公园散步吧！")).toEqual(["今天天气很好。", "我们去公园散步吧！"]));
  it("ไม่มีวรรคตอน ตัดกลาง", () => expect(splitInHalf("abcdef")).toEqual(["abc", "def"]));
});
