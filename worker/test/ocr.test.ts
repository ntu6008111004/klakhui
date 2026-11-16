import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanOcrText, validateImage, MAX_IMAGE_B64 } from "../src/ocr";
import { buildUserMessage } from "../src/prompt";
import workerEntry from "../src/index";

const env: any = { APP_TOKEN: "t".repeat(24), ALLOWED_ORIGIN: "*", FALLBACK_LLM_KEY: "k", FALLBACK_LLM_URL: "https://typhoon.test/v1/chat/completions" };
const ctx: any = { waitUntil() {} };
const IMG = "data:image/jpeg;base64," + "A".repeat(2000);
const post = (path: string, body: unknown) =>
  workerEntry.fetch(new Request(`https://x${path}`, { method: "POST", headers: { "X-App-Token": env.APP_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);

afterEach(() => vi.unstubAllGlobals());

describe("OCR", () => {
  it("ล้าง markdown ที่ OCR ใส่มาให้เหลือรายบรรทัด", () => {
    expect(cleanOcrText("# 今日特价菜单\n\n酸菜鱼(中份)68元\n**宫保鸡丁** 32元\n| 名称 | 价格 |\n|---|---|\n| 米饭 | 免费 |\n- 禁止吸烟")).toEqual([
      "今日特价菜单", "酸菜鱼(中份)68元", "宫保鸡丁 32元", "名称  价格", "米饭  免费", "禁止吸烟",
    ]);
  });
  it("ตรวจรูปที่ส่งมา: ต้องเป็น data URL รูปจริง และไม่ใหญ่เกิน", () => {
    expect(validateImage({ image: IMG })).toBe(IMG);
    expect(() => validateImage({ image: "http://evil/x.png" })).toThrow();
    expect(() => validateImage({ image: "data:text/html;base64,AAAA" })).toThrow();
    expect(() => validateImage({})).toThrow();
    expect(() => validateImage({ image: "data:image/jpeg;base64," + "A".repeat(MAX_IMAGE_B64) })).toThrow();
  });
  it("/api/ocr → เรียก Typhoon OCR พร้อมรูป แล้วคืนรายบรรทัด + ภาษาที่ตรวจได้", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "# 今日特价\n酸菜鱼 68元" } }] })));
    vi.stubGlobal("fetch", f);
    const r = await post("/api/ocr", { image: IMG });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.lines).toEqual(["今日特价", "酸菜鱼 68元"]);
    expect(j.lang).toBe("zh");
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.model).toBe("typhoon-ocr");
    expect(sent.messages[0].content[1].image_url.url).toBe(IMG);
  });
  it("รูปใหญ่ผ่านได้เฉพาะ /api/ocr (เส้นทางอื่นยังจำกัด 16KB)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }))));
    expect((await post("/api/ocr", { image: "data:image/jpeg;base64," + "A".repeat(500_000) })).status).toBe(200);
    expect((await post("/api/translate", { text: "A".repeat(20_000), direction: "partner_to_me", target_lang: "zh" })).status).toBe(413);
  });
  it("OCR ล่ม → error JSON ภาษาไทย (ไม่ค้าง)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    const r = await post("/api/ocr", { image: IMG });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.message_th).toBeTruthy();
  });
  it("โหมดรูป: สั่งแปลรายบรรทัดและบอกจำนวนบรรทัด", () => {
    const m = buildUserMessage("今日特价\n酸菜鱼 68元\n禁止吸烟", "partner_to_me", "zh", "image");
    expect(m).toContain("READ FROM A PHOTO");
    expect(m).toContain("EXACTLY 3 lines");
  });
});
