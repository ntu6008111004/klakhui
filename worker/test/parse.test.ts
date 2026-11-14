import { describe, expect, it } from "vitest";
import { extractFirstJson, fallbackResult, parseTranslation, stripThink } from "../src/parse";

const good = { detected_lang: "zh", translation: "นายนี่เก่งจริงๆ", back_translation_th: "นายนี่เก่งจริงๆ", tone: "compliment", note_th: "666 = เก่งมาก", terms: [{ src: "666", meaning_th: "เทพ" }], needs_confirm: false, replies: [] };

describe("stripThink", () => {
  it("ลบ <think> ที่ปิดครบ", () => expect(stripThink("<think>abc\n{x}</think>\nhello")).toBe("hello"));
  it("ลบหลาย block", () => expect(stripThink("<think>a</think>X<think>b</think>Y")).toBe("XY"));
  it("</think> ลอย (template ใส่ <think> ไว้ก่อน)", () => expect(stripThink("thinking...{\"a\":1}</think>{\"b\":2}")).toBe('{"b":2}'));
  it("<think> ไม่ปิด → ทิ้ง", () => expect(stripThink("<think>still thinking {\"translation\":\"x\"}")).toBe(""));
});

describe("extractFirstJson", () => {
  it("ดึงก้อนแรกที่ parse ได้", () => expect(extractFirstJson('text {bad} more {"a":1} {"b":2}')).toEqual({ a: 1 }));
  it("ไม่โดนหลอกด้วย } ใน string", () => expect(extractFirstJson('{"a":"x}y","b":{"c":1}}')).toEqual({ a: "x}y", b: { c: 1 } }));
  it("ไม่มี JSON → undefined", () => expect(extractFirstJson("ไม่มีอะไร")).toBeUndefined());
});

describe("parseTranslation", () => {
  it("JSON ปกติ", () => expect(parseTranslation(JSON.stringify(good), "partner_to_me")).toEqual(good));
  it("มี <think> ยาวนำหน้า", () => expect(parseTranslation("<think>" + "คิด ".repeat(500) + "</think>" + JSON.stringify(good), "partner_to_me")?.tone).toBe("compliment"));
  it("มี code fence", () => expect(parseTranslation("```json\n" + JSON.stringify(good) + "\n```", "partner_to_me")?.translation).toBe(good.translation));
  it("JSON ขาด → null", () => expect(parseTranslation('{"translation": "abc", "tone":', "partner_to_me")).toBeNull());
  it("field หาย → เติม default", () => {
    const r = parseTranslation('{"translation":"请问洗手间在哪里？"}', "me_to_partner")!;
    expect(r).toEqual({ detected_lang: "th", translation: "请问洗手间在哪里？", back_translation_th: "", tone: "neutral", note_th: "", terms: [], needs_confirm: false, replies: [] });
  });
  it("tone/lang แปลกๆ → default, needs_confirm string", () => {
    const r = parseTranslation('{"translation":"x","tone":"HAPPY","detected_lang":"fr","needs_confirm":"true","terms":[{"src":"a"},null,{"src":"b","meaning_th":"บี"}]}', "partner_to_me")!;
    expect(r.tone).toBe("neutral");
    expect(r.detected_lang).toBe("zh");
    expect(r.needs_confirm).toBe(true);
    expect(r.terms).toEqual([{ src: "b", meaning_th: "บี" }]);
    expect(r.back_translation_th).toBe("x");
  });
  it("translation ว่าง → null", () => expect(parseTranslation('{"translation":""}', "partner_to_me")).toBeNull());
  it("ข้อความดิบ → null", () => expect(parseTranslation("สวัสดีครับ", "partner_to_me")).toBeNull());
});

describe("fallbackResult", () => {
  it("ใช้ข้อความดิบ", () => {
    const r = fallbackResult("<think>x</think>สวัสดี", "partner_to_me");
    expect(r.translation).toBe("สวัสดี");
    expect(r.tone).toBe("neutral");
    expect(r.note_th).toBe("");
  });
  it("ว่างเปล่า → ข้อความแจ้ง", () => expect(fallbackResult("", "me_to_partner").translation).toBe("(แปลไม่สำเร็จ)"));
});
