import { describe, expect, it } from "vitest";
import { buildSystemPrompt, formatGlossary, trimHistory } from "../src/prompt";

describe("prompt", () => {
  it("แทนค่าตัวแปรครบ ไม่เหลือ {…}", () => {
    const p = buildSystemPrompt({ direction: "partner_to_me", targetLang: "zh", domain: "medical", history: [], glossary: [] });
    expect(p).toContain("Chinese");
    expect(p).toContain("Direction: partner_to_me");
    expect(p).toContain("Domain mode: medical");
    expect(p).not.toMatch(/\{(TARGET_LANG_NAME|DIRECTION|DOMAIN|HISTORY|GLOSSARY)\}/);
  });
  it("history ≤ 6 turn และ ≤ 1500 ตัว", () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ who: "me" as const, text: "ก".repeat(400) + i }));
    const t = trimHistory(h);
    expect(t.length).toBeLessThanOrEqual(6);
    expect(t.reduce((a, x) => a + x.text.length, 0)).toBeLessThanOrEqual(1500);
    expect(t[t.length - 1].text.endsWith("9")).toBe(true);
  });
  it("glossary ≤ 15", () => {
    const g = Array.from({ length: 30 }, (_, i) => ({ term: "t" + i, meaning_th: "m" }));
    expect(formatGlossary(g).split("\n")).toHaveLength(15);
  });
});

import { scriptLang } from "../src/types";
describe("scriptLang (ตรวจภาษาอัตโนมัติจากตัวอักษร)", () => {
  it.each([
    ["你这操作666啊", "zh"], ["请问洗手间在哪里？", "zh"], ["マジでヤバい", "ja"], ["今日は暑いですね", "ja"],
    ["대박!", "ko"], ["ㅋㅋㅋ 진짜 웃겨", "ko"], ["That's a piece of cake", "en"], ["lol ok", "en"],
    ["ห้องน้ำอยู่ไหน", "th"], ["555 ขำมาก", "th"], ["666", null], ["", null],
  ])("%s → %s", (t, want) => expect(scriptLang(t as string)).toBe(want));
});
