export type Direction = "me_to_partner" | "partner_to_me";
export type TargetLang = "zh" | "en" | "ja" | "ko";
export type Lang = "th" | TargetLang | "other";
export type Domain = "general" | "medical" | "tech" | "robotics";
export type Tone =
  | "neutral" | "polite" | "joke" | "tease" | "sarcasm" | "idiom"
  | "slang" | "compliment" | "complaint" | "rude" | "urgent";

export const DIRECTIONS: Direction[] = ["me_to_partner", "partner_to_me"];
export const TARGET_LANGS: TargetLang[] = ["zh", "en", "ja", "ko"];
export const LANGS: Lang[] = ["th", "zh", "en", "ja", "ko", "other"];

/**
 * ตรวจภาษาจากตัวอักษร (แม่น/ไวกว่าให้โมเดลเดา) — null = บอกไม่ได้
 * ญี่ปุ่นต้องเช็กก่อนจีน (คันจิเป็นอักษรจีน แต่มีคานะ = ญี่ปุ่น)
 */
export function scriptLang(text: string): Lang | null {
  const s = text.replace(/[\s\p{P}\p{S}\d]+/gu, "");
  if (!s) return null;
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  const ko = count(/[가-힯ᄀ-ᇿ㄰-㆏]/g);
  const kana = count(/[぀-ヿ]/g);
  const han = count(/[一-鿿㐀-䶿]/g);
  const th = count(/[฀-๿]/g);
  const latin = count(/[A-Za-z]/g);
  const total = s.length;
  if (ko / total > 0.3) return "ko";
  if (kana > 0 && (kana + han) / total > 0.3) return "ja";
  if (han / total > 0.3) return "zh";
  if (th / total > 0.3) return "th";
  if (latin / total > 0.5) return "en";
  return null;
}
export const DOMAINS: Domain[] = ["general", "medical", "tech", "robotics"];
export const TONES: Tone[] = [
  "neutral", "polite", "joke", "tease", "sarcasm", "idiom",
  "slang", "compliment", "complaint", "rude", "urgent",
];

export interface HistoryTurn { who: "me" | "partner"; text: string; translation?: string }
export interface GlossaryHit { term: string; lang?: string; meaning_th: string; tag?: string }

export interface TranslateRequest {
  text: string;
  direction: Direction;
  target_lang: TargetLang;
  domain: Domain;
  history: HistoryTurn[];
  glossary: GlossaryHit[];
  request_id: string;
  segment_id?: string;
}

export interface TranslationResult {
  detected_lang: Lang;
  translation: string;
  back_translation_th: string;
  tone: Tone;
  note_th: string;
  terms: { src: string; meaning_th: string }[];
  needs_confirm: boolean;
  /** ประโยคตอบกลับแนะนำ (partner_to_me) — th = ความหมายไทย, target = ภาษาเพื่อนพร้อมพูด */
  replies: { th: string; target: string }[];
}

export type ErrorCode = "RATE_LIMIT" | "UPSTREAM_DOWN" | "TIMEOUT" | "BAD_INPUT" | "AUTH" | "TOO_LARGE";

export interface Env {
  THAILLM_URL: string;
  THAILLM_MODEL: string;
  THAILLM_API_KEY: string;
  /** รุ่นสำรองบน ThaiLLM เมื่อรุ่นหลักล่ม (เช่น Typhoon-S-ThaiLLM-8B-Instruct) */
  THAILLM_FALLBACK_MODEL?: string;
  APP_TOKEN: string;
  ALLOWED_ORIGIN: string;
  FALLBACK_LLM_URL?: string;
  FALLBACK_LLM_KEY?: string;
  FALLBACK_LLM_MODEL?: string;
}
