import { buildSystemPrompt, buildUserMessage, LANG_NAMES, MAX_GLOSSARY } from "./prompt";
import { fallbackResult, languageOk, parseTranslation, salvagePartial } from "./parse";
import { AppError } from "./resilience";
import { chat, type ChatMessage, type ChatResult } from "./thaillm";
import {
  DIRECTIONS, DOMAINS, TARGET_LANGS, scriptLang,
  type Env, type GlossaryHit, type HistoryTurn, type TranslateRequest, type TranslationResult,
} from "./types";

export const MAX_TEXT = 1000;

/** Validate body → TranslateRequest หรือ throw BAD_INPUT */
export function validateRequest(body: unknown): TranslateRequest {
  const b = body as Record<string, unknown>;
  const bad = (why: string) => new AppError("BAD_INPUT", undefined, undefined, why);
  if (!b || typeof b !== "object") throw bad("body");
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw bad("text empty");
  if (text.length > MAX_TEXT) throw bad("text too long");
  if (!DIRECTIONS.includes(b.direction as any)) throw bad("direction");
  if (!TARGET_LANGS.includes(b.target_lang as any)) throw bad("target_lang");
  const domain = b.domain === undefined ? "general" : b.domain;
  if (!DOMAINS.includes(domain as any)) throw bad("domain");

  const history: HistoryTurn[] = Array.isArray(b.history)
    ? b.history
        .filter((h: any) => h && (h.who === "me" || h.who === "partner") && typeof h.text === "string")
        .map((h: any) => ({ who: h.who, text: String(h.text).slice(0, 500), translation: typeof h.translation === "string" ? h.translation.slice(0, 500) : undefined }))
    : [];
  const glossary: GlossaryHit[] = Array.isArray(b.glossary)
    ? b.glossary
        .filter((g: any) => g && typeof g.term === "string" && typeof g.meaning_th === "string")
        .slice(0, MAX_GLOSSARY)
        .map((g: any) => ({ term: g.term.slice(0, 100), lang: g.lang, meaning_th: g.meaning_th.slice(0, 200), tag: g.tag }))
    : [];
  const request_id = typeof b.request_id === "string" && b.request_id ? b.request_id.slice(0, 64) : crypto.randomUUID();
  const segment_id = typeof b.segment_id === "string" ? b.segment_id.slice(0, 64) : undefined;

  return { text, direction: b.direction as any, target_lang: b.target_lang as any, domain: domain as any, history, glossary, request_id, segment_id };
}

/**
 * สเปกเดิม min(800, 120 + chars*3) ไม่พอ: JSON + note_th ภาษาไทย + replies ใช้ ~250-400 token แม้ input สั้น
 * (ทดสอบจริงแล้ว JSON ขาดกลางทาง) → ปรับฐานเป็น 420
 */
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
/** Clean up suggested replies: drop any that copy the partner's own words / contain Thai in the target-language field / duplicates */
export function cleanReplies(r: TranslationResult, input: string): TranslationResult {
  // ภาษาที่ตรวจจากตัวอักษรแม่นกว่าที่โมเดลเดา
  r.detected_lang = scriptLang(input) ?? r.detected_lang;
  const src = norm(input);
  const seen = new Set<string>();
  r.replies = r.replies.filter((x) => {
    const t = norm(x.target);
    if (!t || t === src || (src.length > 4 && (t.includes(src) || src.includes(t))) || /[฀-๿]/.test(x.target) || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return r;
}

export const maxTokensFor = (inputChars: number) => Math.min(900, 420 + inputChars * 3);

/** แบ่งข้อความเป็น 2 ท่อนตามจุดจบประโยคที่ใกล้กลางที่สุด (ไม่มีก็ตัดกลาง) */
export function splitInHalf(text: string): [string, string] {
  const mid = Math.floor(text.length / 2);
  const re = /[。！？!?.\n，,、；;\s]/g;
  let best = -1;
  for (let m; (m = re.exec(text)); ) {
    if (best === -1 || Math.abs(m.index - mid) < Math.abs(best - mid)) best = m.index;
  }
  const cut = best > 0 && best < text.length - 1 ? best + 1 : mid;
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

function mergeResults(a: TranslationResult, b: TranslationResult, sep: string): TranslationResult {
  const priority = (t: TranslationResult) => (t.tone === "neutral" || t.tone === "polite" ? 0 : 1);
  return {
    detected_lang: a.detected_lang,
    translation: [a.translation, b.translation].filter(Boolean).join(sep),
    back_translation_th: [a.back_translation_th, b.back_translation_th].filter(Boolean).join(" "),
    tone: priority(b) > priority(a) ? b.tone : a.tone,
    note_th: [a.note_th, b.note_th].filter(Boolean).join(" "),
    terms: [...a.terms, ...b.terms],
    needs_confirm: a.needs_confirm || b.needs_confirm,
    replies: b.replies.length ? b.replies : a.replies,
  };
}

type Ctx = { waitUntil(p: Promise<unknown>): void } | undefined;
export interface Outcome { result: TranslationResult; engine: ChatResult["engine"] }

function readResult(content: string, finish: string | null, direction: TranslateRequest["direction"]) {
  const strict = parseTranslation(content, direction);
  if (strict) return { r: strict, truncated: finish === "length" };
  if (finish === "length") return { r: salvagePartial(content, direction), truncated: true };
  return { r: null, truncated: false };
}

/**
 * แปล 1 ครั้ง:
 * parse JSON (ขาดเพราะ length → กู้) → พัง/ผิดภาษา → retry temp 0 พร้อมคำสั่งแก้ → ยังพัง fallback ข้อความดิบ
 */
async function translateOnce(env: Env, req: TranslateRequest, ctx: Ctx): Promise<Outcome & { truncated: boolean }> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ direction: req.direction, targetLang: req.target_lang, domain: req.domain, history: req.history, glossary: req.glossary }) },
    { role: "user", content: buildUserMessage(req.text, req.direction, req.target_lang) },
  ];
  const maxTokens = maxTokensFor(req.text.length);
  const first = await chat(env, messages, { temperature: 0.3, maxTokens }, ctx);
  const a = readResult(first.content, first.finishReason, req.direction);
  if (a.r && languageOk(a.r, req.direction)) return { result: a.r, engine: first.engine, truncated: a.truncated };

  const target = LANG_NAMES[req.target_lang];
  const fix = a.r
    ? `Your answer broke the language rules. "translation" must be ${req.direction === "partner_to_me" ? "Thai" : target + " (no Thai)"}; "note_th" must be Thai. Return the corrected JSON only.`
    : "Return valid JSON only.";
  const second = await chat(env, [...messages, { role: "assistant", content: first.content.slice(0, 1500) }, { role: "user", content: fix }], { temperature: 0, maxTokens }, ctx);
  const b = readResult(second.content, second.finishReason, req.direction);
  if (b.r && (languageOk(b.r, req.direction) || !a.r)) return { result: b.r, engine: second.engine, truncated: b.truncated };
  if (a.r) return { result: a.r, engine: first.engine, truncated: a.truncated };
  return { result: fallbackResult(second.content || first.content, req.direction), engine: second.engine, truncated: false };
}

const isSizeError = (e: unknown) =>
  e instanceof AppError && (e.code === "TOO_LARGE" || (e.code === "BAD_INPUT" && e.upstreamStatus !== undefined && e.upstreamStatus > 0));

/**
 * แปลพร้อมรับมือขนาด:
 * - upstream 400/413 → ลดขนาดเป็นขั้น: history เหลือ 2 → ตัด glossary → แบ่ง text ครึ่ง
 * - finish_reason=length → แบ่ง text ครึ่งแล้วแปลใหม่
 */
export async function translate(env: Env, req: TranslateRequest, ctx?: Ctx, depth = 0): Promise<Outcome> {
  const steps: TranslateRequest[] = [
    req,
    { ...req, history: req.history.slice(-2) },
    { ...req, history: req.history.slice(-2), glossary: [] },
  ];
  let lastErr: unknown;
  for (const step of steps) {
    try {
      const { result, engine, truncated } = await translateOnce(env, step, ctx);
      if (truncated && depth < 2 && step.text.length >= 8) return splitAndTranslate(env, step, ctx, depth);
      return { result: cleanReplies(result, step.text), engine };
    } catch (e) {
      if (!isSizeError(e)) throw e;
      lastErr = e;
    }
  }
  if (depth < 2 && req.text.length >= 8) return splitAndTranslate(env, { ...req, history: req.history.slice(-2), glossary: [] }, ctx, depth);
  throw lastErr;
}

async function splitAndTranslate(env: Env, req: TranslateRequest, ctx: Ctx, depth: number): Promise<Outcome> {
  const [a, b] = splitInHalf(req.text);
  if (!a || !b) throw new AppError("TOO_LARGE");
  const ra = await translate(env, { ...req, text: a }, ctx, depth + 1);
  const rb = await translate(env, { ...req, text: b }, ctx, depth + 1);
  const spaced = req.direction === "partner_to_me" || req.target_lang === "en" || req.target_lang === "ko";
  return { result: mergeResults(ra.result, rb.result, spaced ? " " : ""), engine: rb.engine };
}
