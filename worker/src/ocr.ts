/**
 * POST /api/ocr — อ่านตัวอักษรจากรูป (ป้าย/เมนู/ฉลาก) ด้วย Typhoon OCR
 * ทดสอบแล้ว: อ่านจีน/ญี่ปุ่น/เกาหลี/อังกฤษ/ไทยได้ (~1.2 วิ) — ไม่คืนตำแหน่งตัวอักษร จึงแสดงคำแปลเป็นรายบรรทัด
 * จำกัด 2 ครั้ง/วิ, 20 ครั้ง/นาที (ฝั่งแอปคุมไว้ต่ำกว่านี้)
 */
import { AppError, errorFromStatus, fetchWithTimeout } from "./resilience";
import { scriptLang, type Env } from "./types";

/** รูป base64 สูงสุด ~1.5MB (แอปย่อเหลือ ≤ 1600px JPEG ก่อนส่ง ปกติ 100–300KB) */
export const MAX_IMAGE_B64 = 2_000_000;

export interface OcrResult { text: string; lines: string[]; lang: string | null; latency_ms: number }

/** ล้าง markdown ที่ OCR ใส่มา (# หัวข้อ, ตาราง, **ตัวหนา**) ให้เหลือข้อความรายบรรทัด */
export function cleanOcrText(md: string): string[] {
  return md
    .replace(/<\/?[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*+]\s+/, "").replace(/\*\*|__|`/g, "").replace(/^\|?\s*[-:| ]+\s*\|?$/, "").replace(/\s*\|\s*/g, "  ").replace(/^\s*\|/, "").trim())
    .filter((l) => l && !/^!\[.*\]\(.*\)$/.test(l));
}

export function validateImage(body: unknown): string {
  const img = (body as Record<string, unknown>)?.image;
  if (typeof img !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img.slice(0, 64) + img.slice(-8)))
    throw new AppError("BAD_INPUT", undefined, undefined, "image");
  if (img.length > MAX_IMAGE_B64) throw new AppError("TOO_LARGE");
  return img;
}

export async function ocrImage(env: Env, dataUrl: string): Promise<OcrResult> {
  const t0 = Date.now();
  const url = env.OCR_URL ?? env.FALLBACK_LLM_URL ?? "https://api.opentyphoon.ai/v1/chat/completions";
  const key = env.OCR_KEY ?? env.FALLBACK_LLM_KEY;
  if (!key) throw new AppError("UPSTREAM_DOWN", undefined, undefined, "no ocr key");
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env.OCR_MODEL ?? "typhoon-ocr",
        max_tokens: 1500,
        temperature: 0.1,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Extract all the text in this image exactly as written, line by line. Keep numbers and prices exactly." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      }),
    },
    12_000,
  );
  if (!res.ok) throw errorFromStatus(res.status, res.headers.get("Retry-After"), await res.text().catch(() => ""));
  const j: any = await res.json();
  const lines = cleanOcrText(String(j?.choices?.[0]?.message?.content ?? ""));
  const text = lines.join("\n");
  return { text, lines, lang: text ? scriptLang(text) : null, latency_ms: Date.now() - t0 };
}
