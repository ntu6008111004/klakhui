import { LANGS, TONES, type Direction, type Lang, type TranslationResult, type Tone } from "./types";

/** ลบ <think>…</think> ทุกก้อน + กรณี </think> ลอยๆ (ตัดทุกอย่างก่อนหน้า) + <think> ที่ไม่ปิด */
export function stripThink(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const orphanClose = out.toLowerCase().lastIndexOf("</think>");
  if (orphanClose !== -1) out = out.slice(orphanClose + "</think>".length);
  const openIdx = out.toLowerCase().indexOf("<think>");
  if (openIdx !== -1) {
    // think ไม่ปิด: ถ้าก่อน <think> มีเนื้อหา ใช้ส่วนนั้น ไม่งั้นทิ้งทั้งหมด
    out = out.slice(0, openIdx);
  }
  return out.trim();
}

export function stripFences(s: string): string {
  return s.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
}

/** หา {…} ก้อนแรกที่ JSON.parse ได้ (จับคู่วงเล็บโดยข้ามเนื้อใน string) */
export function extractFirstJson(s: string): unknown | undefined {
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(s.slice(start, i + 1));
            if (v && typeof v === "object" && !Array.isArray(v)) return v;
          } catch {
            /* ลองตำแหน่ง { ถัดไป */
          }
          break;
        }
      }
    }
  }
  return undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Validate + เติม default ให้ทุก field */
export function normalizeResult(raw: Record<string, unknown>, direction: Direction): TranslationResult | null {
  const translation = str(raw.translation);
  if (!translation) return null;
  const detected = str(raw.detected_lang).toLowerCase() as Lang;
  const tone = str(raw.tone).toLowerCase() as Tone;
  const terms = Array.isArray(raw.terms)
    ? raw.terms
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t) => ({ src: str(t.src), meaning_th: str(t.meaning_th) }))
        .filter((t) => t.src && t.meaning_th)
        .slice(0, 20)
    : [];
  const replies = Array.isArray(raw.replies)
    ? raw.replies
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t) => ({ th: str(t.th), target: str(t.target) }))
        .filter((t) => t.th && t.target)
        .slice(0, 3)
    : [];
  return {
    detected_lang: LANGS.includes(detected) ? detected : direction === "me_to_partner" ? "th" : "zh",
    translation,
    back_translation_th: str(raw.back_translation_th) || (direction === "partner_to_me" ? translation : ""),
    tone: TONES.includes(tone) ? tone : "neutral",
    note_th: str(raw.note_th),
    terms,
    needs_confirm: raw.needs_confirm === true || raw.needs_confirm === "true",
    replies,
  };
}

/** คืนผลที่ parse ได้ หรือ null ถ้าพัง (ให้ผู้เรียกไป retry / fallback) */
export function parseTranslation(content: string, direction: Direction): TranslationResult | null {
  const cleaned = stripFences(stripThink(content));
  const obj = extractFirstJson(cleaned);
  if (!obj) return null;
  return normalizeResult(obj as Record<string, unknown>, direction);
}

/** ดึงค่า "key": "…" จาก JSON ที่ขาดกลางทาง (string ที่ไม่ปิดก็เอาเท่าที่มี) */
function salvageString(s: string, key: string): string {
  const m = s.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`));
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1].replace(/\\$/, "")}"`).trim();
  } catch {
    return m[1].trim();
  }
}

/** กู้ JSON ที่ถูกตัด (finish_reason=length) — ได้อย่างน้อย translation */
export function salvagePartial(content: string, direction: Direction): TranslationResult | null {
  const s = stripFences(stripThink(content));
  if (!s.includes('"translation"')) return null;
  const obj: Record<string, unknown> = {};
  for (const k of ["detected_lang", "translation", "back_translation_th", "tone", "note_th"]) {
    const v = salvageString(s, k);
    if (v) obj[k] = v;
  }
  obj.needs_confirm = /"needs_confirm"\s*:\s*true/.test(s);
  return normalizeResult(obj, direction);
}

/** fallback สุดท้าย: ใช้ข้อความดิบเป็นคำแปล ห้ามทำให้แอปค้าง และห้ามโชว์ JSON ดิบ */
export function fallbackResult(content: string, direction: Direction): TranslationResult {
  const salvaged = salvagePartial(content, direction);
  if (salvaged) return salvaged;
  let text = stripFences(stripThink(content));
  if (/^\s*[{[]/.test(text)) text = "";
  text = text || "(แปลไม่สำเร็จ)";
  return {
    detected_lang: direction === "me_to_partner" ? "th" : "zh",
    translation: text,
    back_translation_th: direction === "partner_to_me" ? text : "",
    tone: "neutral",
    note_th: "",
    terms: [],
    needs_confirm: false,
    replies: [],
  };
}

const THAI = /[฀-๿]/;
/** ตรวจว่าโมเดลตอบถูกภาษา: partner_to_me → translation ต้องเป็นไทย, me_to_partner → ไม่ใช่ไทย; note_th ต้องเป็นไทย */
export function languageOk(r: TranslationResult, direction: Direction): boolean {
  if (direction === "partner_to_me" && !THAI.test(r.translation)) return false;
  if (direction === "me_to_partner" && THAI.test(r.translation)) return false;
  if (r.note_th && !THAI.test(r.note_th)) return false;
  return true;
}
