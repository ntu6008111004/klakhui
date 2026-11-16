import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageOk, parseTranslation, salvagePartial, fallbackResult } from "../src/parse";
import { SseLineReader, StreamTextParser } from "../src/streamparse";
import { chat, primaryIsDown, _resetThinkingCache } from "../src/thaillm";
import { buildSsml, splitBinaryFrame, validateTts } from "../src/tts";
import { handleStream } from "../src/stream";
import type { Env } from "../src/types";

function feed(chunks: string[]) {
  const p = new StreamTextParser();
  let out = "";
  for (const c of chunks) out += p.push(c);
  const end = p.end();
  return { text: out + end.delta, meta: end.meta };
}

describe("StreamTextParser", () => {
  it("แยก delta กับ ##META", () => {
    const r = feed(["นายนี่", "เก่งจริงๆ\n", '##META {"tone":"compliment","note_th":"666 = เก่ง"}']);
    expect(r.text).toBe("นายนี่เก่งจริงๆ");
    expect(r.meta).toEqual({ tone: "compliment", note_th: "666 = เก่ง" });
  });
  it("##META ขาดข้าม chunk ไม่หลุดเป็น delta", () => {
    const r = feed(["สวัสดี\n#", "#ME", "TA {\"tone\":\"joke\",\"note_th\":\"\"}"]);
    expect(r.text).toBe("สวัสดี");
    expect(r.meta?.tone).toBe("joke");
  });
  it("<think> ขาดข้าม chunk ถูกตัดทิ้ง", () => {
    const r = feed(["<thi", "nk>คิดๆ ##META ปลอม", "</thi", "nk>\nคำแปลจริง\n##META {\"tone\":\"neutral\"}"]);
    expect(r.text).toBe("คำแปลจริง");
    expect(r.meta?.tone).toBe("neutral");
  });
  it("META เสีย → ข้าม ไม่ล้ม", () => {
    const r = feed(["ข้อความ\n##META {tone: broken"]);
    expect(r.text).toBe("ข้อความ");
    expect(r.meta).toBeNull();
  });
  it("ไม่มี META เลย", () => expect(feed(["ทดสอบ", " ต่อ"]).text).toBe("ทดสอบ ต่อ"));
  it("ส่ง delta ทันทีไม่ต้องรอจบ", () => {
    const p = new StreamTextParser();
    expect(p.push("สวัสดีครับ")).toBe("สวัสดีครับ");
  });
});

describe("SseLineReader", () => {
  it("อ่าน delta ข้าม chunk + [DONE] + ไม่สน reasoning", () => {
    const r = new SseLineReader();
    const a = r.push('data: {"choices":[{"delta":{"content":"ก"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"x"}}]}\ndata: {"choi');
    const b = r.push('ces":[{"delta":{"content":"ข"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
    expect(a.content).toEqual(["ก"]);
    expect(b.content).toEqual(["ข"]);
    expect(b.done).toBe(true);
    expect(b.finish).toBe("stop");
  });
});

describe("กู้ JSON ที่ขาด / ภาษา", () => {
  it("salvage translation จาก JSON ที่ถูกตัด", () => {
    const cut = '{"detected_lang":"zh","translation":"สุดยอดมาก","back_translation_th":"สุดยอดมาก","tone":"slang","note_th":"绝绝子 เป็นคำวัยรุ่นแปลว่า';
    const r = salvagePartial(cut, "partner_to_me")!;
    expect(r.translation).toBe("สุดยอดมาก");
    expect(r.tone).toBe("slang");
    expect(r.note_th.startsWith("绝绝子 เป็นคำวัยรุ่น")).toBe(true);
  });
  it("fallback ไม่โชว์ JSON ดิบ", () => {
    expect(fallbackResult('{"detected_lang":"zh", "tone"', "partner_to_me").translation).toBe("(แปลไม่สำเร็จ)");
  });
  it("languageOk ตรวจภาษาผิด", () => {
    const r = parseTranslation('{"translation":"你真厉害啊","note_th":"用行来夸赞"}', "partner_to_me")!;
    expect(languageOk(r, "partner_to_me")).toBe(false);
    const r2 = parseTranslation('{"translation":"เก่งจัง","note_th":"ชม"}', "partner_to_me")!;
    expect(languageOk(r2, "partner_to_me")).toBe(true);
    const r3 = parseTranslation('{"translation":"ห้องน้ำ"}', "me_to_partner")!;
    expect(languageOk(r3, "me_to_partner")).toBe(false);
  });
  it("replies ถูก normalize (สูงสุด 3, ตัดตัวไม่ครบ)", () => {
    const r = parseTranslation('{"translation":"ก","replies":[{"th":"ขำมาก","target":"哈哈哈"},{"th":"x"},{"th":"1","target":"1"},{"th":"2","target":"2"},{"th":"3","target":"3"}]}', "partner_to_me")!;
    expect(r.replies).toHaveLength(3);
    expect(r.replies[0]).toEqual({ th: "ขำมาก", target: "哈哈哈" });
  });
});

const env: Env = {
  THAILLM_URL: "https://mock.test/v1/chat/completions",
  THAILLM_MODEL: "qwen3.6-35b-a3b",
  THAILLM_FALLBACK_MODEL: "Typhoon-S-ThaiLLM-8B-Instruct",
  THAILLM_API_KEY: "k",
  APP_TOKEN: "t".repeat(24),
  ALLOWED_ORIGIN: "*",
};
const okRes = (c: string) => new Response(JSON.stringify({ choices: [{ message: { content: c }, finish_reason: "stop" }] }));

describe("สลับรุ่นสำรองเมื่อรุ่นหลักล่ม", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { _resetThinkingCache(); fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("รุ่นหลัก 504 → ใช้รุ่นสำรองทันที (ไม่ retry รุ่นหลักซ้ำ) แล้วพักรุ่นหลัก", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okRes("ok"))).mockResolvedValueOnce(new Response("error code: 504", { status: 504 }));
    const r = await chat(env, [{ role: "user", content: "x" }]);
    expect(r.engine).toBe("fallback");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("Typhoon-S-ThaiLLM-8B-Instruct");
    expect(primaryIsDown()).toBe(true);
    const waits: Promise<unknown>[] = [];
    const r2 = await chat(env, [{ role: "user", content: "y" }], {}, { waitUntil: (p) => waits.push(p) });
    expect(r2.engine).toBe("fallback");
    expect(waits).toHaveLength(1); // probe รุ่นหลักเบื้องหลัง
  });

  it("รุ่นหลัก 429 → retry รุ่นหลัก (ไม่สลับ)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } })).mockResolvedValueOnce(okRes("ok"));
    const r = await chat(env, [{ role: "user", content: "x" }]);
    expect(r.engine).toBe("primary");
  });

  it("ล่มทั้งคู่ → โยน UPSTREAM_DOWN", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 502, headers: { "Retry-After": "0" } }));
    await expect(chat(env, [{ role: "user", content: "x" }])).rejects.toMatchObject({ code: "UPSTREAM_DOWN" });
  });
});

describe("/api/translate/stream (mock upstream SSE)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const sseBody = (parts: string[], cut = false) =>
    new ReadableStream({
      start(c) {
        const e = new TextEncoder();
        for (const p of parts) c.enqueue(e.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
        if (cut) setTimeout(() => c.error(new Error("connection reset")), 20);
        else { c.enqueue(e.encode("data: [DONE]\n\n")); c.close(); }
      },
    });
  const req = { text: "你这操作666啊", direction: "partner_to_me", target_lang: "zh", domain: "general", history: [], glossary: [], request_id: "r", segment_id: "s1" } as any;

  it("ส่ง delta → meta → done", async () => {
    _resetThinkingCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sseBody(["นายนี่", "เก่งจริงๆ\n##META ", '{"tone":"compliment","note_th":"666=เก่ง"}']))));
    const text = await handleStream(env, req, {}).text();
    expect(text).toContain('event: delta\ndata: {"t":"นายนี่"}');
    expect(text).toContain("event: meta");
    expect(text).toContain('"segment_id":"s1"');
    expect(text.indexOf("event: done")).toBeGreaterThan(text.indexOf("event: meta"));
    expect(text).not.toContain("##META");
  });

  it("stream ตัดกลางคัน → event: error (ไม่เงียบ)", async () => {
    _resetThinkingCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sseBody(["ครึ่ง"], true))));
    const text = await handleStream(env, req, {}).text();
    expect(text).toContain('{"t":"ครึ่ง"}');
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: done");
  });
});

describe("TTS helpers", () => {
  it("validate + เลือกเสียงตามภาษา/เพศ", () => {
    expect(validateTts({ text: "你好", lang: "zh", gender: "male" }).voice).toBe("zh-CN-YunxiNeural");
    expect(validateTts({ text: "สวัสดี", lang: "th" }).voice).toBe("th-TH-PremwadeeNeural");
    expect(validateTts({ text: "hi", lang: "en", rate: "bad", pitch: "+2Hz" })).toMatchObject({ rate: "+8%", pitch: "+2Hz" });
    expect(() => validateTts({ text: "", lang: "zh" })).toThrow();
    expect(() => validateTts({ text: "x", lang: "fr" })).toThrow();
    expect(validateTts({ text: "x", lang: "zh", voice: "en-US-AvaNeural" }).voice).toBe("zh-CN-XiaoxiaoNeural"); // ห้ามข้ามภาษา
  });
  it("SSML escape ป้องกัน injection", () => {
    expect(buildSsml({ voice: "v", rate: "+0%", pitch: "+0Hz", text: "<a>&'" })).toContain("&lt;a&gt;&amp;&apos;");
  });
  it("แยก binary frame", () => {
    const h = new TextEncoder().encode("X-RequestId:1\r\nPath:audio\r\n");
    const buf = new Uint8Array(2 + h.length + 3);
    buf[0] = h.length >> 8; buf[1] = h.length & 255; buf.set(h, 2); buf.set([9, 8, 7], 2 + h.length);
    expect(splitBinaryFrame(buf)).toEqual({ path: "audio", audio: new Uint8Array([9, 8, 7]) });
  });
});

import { cleanReplies } from "../src/translate";
describe("cleanReplies", () => {
  it("drops replies that copy the partner's words / contain Thai / duplicate", () => {
    const r: any = { replies: [
      { th: "ขอบคุณ", target: "你这操作666啊，笑死我了" },
      { th: "ขอบคุณนะ", target: "谢谢！" },
      { th: "ขอบคุณนะ", target: "谢谢!" },
      { th: "ไทย", target: "ขอบคุณ" },
      { th: "ฮ่าๆ ใช่ไหม", target: "哈哈，是吗？" },
    ] };
    expect(cleanReplies(r, "你这操作666啊，笑死我了").replies.map((x: any) => x.target)).toEqual(["谢谢！", "哈哈，是吗？"]);
  });
});

import { handleTts, _resetVoiceHealth } from "../src/tts";
import workerEntry from "../src/index";
describe("TTS ล้มจริง → ยังได้ JSON error พร้อม CORS (แอป fallback ไปเสียงเครื่องได้)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("ต่อ edge-tts ไม่ได้ทั้งเสียงหลัก+สำรอง → 502 + CORS + message_th", async () => {
    _resetVoiceHealth();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const res = await handleTts({ text: "สวัสดี", lang: "th" }, { "Access-Control-Allow-Origin": "https://translate.dentcos.com" });
    expect(res.status).toBe(502);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://translate.dentcos.com");
    expect(((await res.json()) as any).error.message_th).toBeTruthy();
  });
  it("ทุก error ผ่าน entry ของ Worker มี CORS (รวม 401/404/400)", async () => {
    const env: any = { APP_TOKEN: "t".repeat(24), ALLOWED_ORIGIN: "https://translate.dentcos.com" };
    const ctx: any = { waitUntil() {} };
    const mk = (path: string, token: string, body = "{}") => workerEntry.fetch(new Request(`https://x${path}`, { method: "POST", headers: { Origin: "https://translate.dentcos.com", "X-App-Token": token }, body }), env, ctx);
    for (const r of [await mk("/api/translate", "bad"), await mk("/api/nope", env.APP_TOKEN), await mk("/api/translate", env.APP_TOKEN, "{bad"), await mk("/api/translate/fast", env.APP_TOKEN, "{}")]) {
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://translate.dentcos.com");
    }
  });
  it("origin แปลกปลอมไม่ได้ CORS", async () => {
    const env: any = { APP_TOKEN: "t".repeat(24), ALLOWED_ORIGIN: "https://translate.dentcos.com" };
    const r = await workerEntry.fetch(new Request("https://x/api/health", { headers: { Origin: "https://evil.example" } }), env, { waitUntil() {} } as any);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

import { fixCurrency, fixTone } from "../src/translate";
describe("กันแปลผิดที่อันตราย", () => {
  it("หน่วยเงิน: หยวน/เยน/วอน ห้ามกลายเป็นบาท", () => {
    expect(fixCurrency("大概八百块", "ประมาณแปดร้อยบาท")).toBe("ประมาณแปดร้อยหยวน");
    expect(fixCurrency("3500円です", "3500 บาท")).toBe("3500 เยน");
    expect(fixCurrency("만 원이에요", "หมื่นบาท")).toBe("หมื่นวอน");
    expect(fixCurrency("这个100泰铢", "อันนี้ 100 บาท")).toBe("อันนี้ 100 บาท"); // ต้นฉบับพูดบาทจริง ไม่แตะ
    expect(fixCurrency("你好", "สวัสดีบาท")).toBe("สวัสดีบาท"); // ไม่มีเงินในต้นฉบับ ไม่แตะ
  });
  it("ป้ายน้ำเสียงตรงกับคำอธิบาย", () => {
    expect(fixTone({ tone: "joke", note_th: "พูดประชด จริงๆ ไม่พอใจ" } as any).tone).toBe("sarcasm");
    expect(fixTone({ tone: "tease", note_th: "แซวเล่น" } as any).tone).toBe("tease");
  });
});

import { checkNumbers, toChineseNum } from "../src/translate";
describe("ตรวจตัวเลขตกหล่น (เงิน/เวลา/จำนวน)", () => {
  it("toChineseNum", () => {
    expect(toChineseNum(600)).toBe("六百");
    expect(toChineseNum(800)).toBe("八百");
    expect(toChineseNum(1500)).toBe("一千五百");
    expect(toChineseNum(10)).toBe("十");
    expect(toChineseNum(105)).toBe("一百零五");
    expect(toChineseNum(20000)).toBe("二万");
  });
  const base = () => ({ translation: "", note_th: "", needs_confirm: false } as any);
  it("ตัวเลขหาย → เตือน + needs_confirm", () => {
    const r = checkNumbers("ราคา 800 หยวนแพงไป ขอ 600 ได้ไหม", { ...base(), translation: "800元太贵了，能不能便宜点？" });
    expect(r.needs_confirm).toBe(true);
    expect(r.note_th).toContain("600");
    expect(r.note_th).not.toContain("800,");
  });
  it("ครบ (ตัวเลข หรือ ตัวอักษรจีน) → ไม่เตือน", () => {
    expect(checkNumbers("ขอ 600 ได้ไหม", { ...base(), translation: "六百可以吗？" }).needs_confirm).toBe(false);
    expect(checkNumbers("1,500 บาท", { ...base(), translation: "1500泰铢" }).needs_confirm).toBe(false);
  });
});

import { parseCjkNumber, cjkAmounts, thaiNumWords, checkCjkAmounts } from "../src/translate";
describe("อ่านตัวเลขจีน/เกาหลีเอง (ไม่พึ่งโมเดล)", () => {
  it.each([
    ["一千二", 1200], ["两千", 2000], ["八百", 800], ["三万五", 35000], ["十五", 15], ["一百零五", 105],
    ["만 오천", 15000], ["오천", 5000], ["삼만", 30000], ["천이백", 1200], ["이십", 20],
  ])("%s = %i", (s, v) => expect(parseCjkNumber(s as string)).toBe(v));
  it("ดึงเฉพาะเงิน/จำนวน ไม่รวมเวลา", () => {
    expect(cjkAmounts("만 오천 원입니다")).toEqual([15000]);
    expect(cjkAmounts("两件一起，算你一千二块")).toEqual([1200]);
    expect(cjkAmounts("今天加班到十点")).toEqual([]); // เวลา — ไม่ตรวจ
  });
  it("thaiNumWords", () => {
    expect(thaiNumWords(800)).toBe("แปดร้อย");
    expect(thaiNumWords(15000)).toBe("หนึ่งหมื่นห้าพัน");
    expect(thaiNumWords(21)).toBe("ยี่สิบเอ็ด");
  });
  it("คำแปลเงินผิด → เตือนพร้อมค่าที่ถูก / ถูก → ไม่เตือน", () => {
    const bad = checkCjkAmounts("만 오천 원입니다", { translation: "ราคาห้าพันวอนครับ", note_th: "", needs_confirm: false } as any);
    expect(bad.needs_confirm).toBe(true);
    expect(bad.note_th).toContain("15,000");
    expect(checkCjkAmounts("만 오천 원입니다", { translation: "15000 วอนครับ", note_th: "", needs_confirm: false } as any).needs_confirm).toBe(false);
    expect(checkCjkAmounts("大概八百块", { translation: "ประมาณแปดร้อยหยวน", note_th: "", needs_confirm: false } as any).needs_confirm).toBe(false);
  });
});
describe("fixTone ไม่เปลี่ยนป้ายเมื่อแค่ 'อาจประชด'", () => {
  it.each([
    ["ขำเพราะตลก แต่อาจพูดแบบประชดก็ได้", "joke", "joke"],
    ["พูดเล่น ไม่ได้ประชด", "joke", "joke"],
    ["ชมจริง หรือประชดขึ้นอยู่กับน้ำเสียง", "compliment", "compliment"],
    ["พูดประชด จริงๆ ไม่พอใจที่มาสาย", "compliment", "sarcasm"],
  ])("%s", (note, tone, want) => expect(fixTone({ note_th: note, tone } as any).tone).toBe(want));
});
import { contextSarcasm } from "../src/translate";
describe("ประชดจากบริบท", () => {
  const hist = (t: string) => [{ who: "me" as const, text: t }];
  it("เพิ่งทำพัง + เพื่อนชม → ประชด", () => {
    const r = contextSarcasm({ text: "さすがですね", direction: "partner_to_me", history: hist("ฉันทำพังอีกแล้ว") } as any, { tone: "compliment", note_th: "" } as any);
    expect(r.tone).toBe("sarcasm");
    expect(r.note_th).toContain("ประชด");
  });
  it("ไม่มีเรื่องพลาด → ชมจริง ไม่เปลี่ยน", () => {
    expect(contextSarcasm({ text: "さすがですね", direction: "partner_to_me", history: hist("ฉันสอบผ่านแล้ว") } as any, { tone: "compliment", note_th: "" } as any).tone).toBe("compliment");
  });
  it("ฝั่งเราพูด → ไม่แตะ", () => {
    expect(contextSarcasm({ text: "great job", direction: "me_to_partner", history: hist("ทำพัง") } as any, { tone: "compliment", note_th: "" } as any).tone).toBe("compliment");
  });
});
