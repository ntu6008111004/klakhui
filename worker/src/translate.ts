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
/**
 * แก้หน่วยเงินที่โมเดลเปลี่ยนเอง (อันตราย: ราคาผิดหลายเท่า) — ต้นฉบับพูดหยวน/เยน/วอน แต่คำแปลไทยกลายเป็น "บาท"
 */
export function fixCurrency(input: string, text: string): string {
  if (!text || !input || !text.includes("บาท") || /บาท|泰铢|baht|฿/i.test(input)) return text;
  const unit = /[块塊元]|人民币|rmb|yuan/i.test(input) ? "หยวน" : /[円]|えん|yen/i.test(input) ? "เยน" : /원|won/i.test(input) ? "วอน" : null;
  return unit ? text.replace(/บาท/g, unit) : text;
}

/** 600 → 六百, 1500 → 一千五百 (พอสำหรับเช็กตัวเลขที่พูดในชีวิตประจำวัน < 1 แสน) */
export function toChineseNum(n: number): string {
  const d = "零一二三四五六七八九";
  if (n === 0) return "零";
  const units: [number, string][] = [[10000, "万"], [1000, "千"], [100, "百"], [10, "十"], [1, ""]];
  let out = "";
  let zero = false;
  for (const [u, name] of units) {
    const q = Math.floor(n / u) % 10;
    if (u === 10000) { const w = Math.floor(n / 10000); if (w) out += toChineseNum(w) + "万"; continue; }
    if (q) { if (zero && out) out += "零"; out += d[q] + name; zero = false; } else if (out) zero = true;
  }
  return out.replace(/^一十/, "十");
}

/**
 * เรา→เพื่อน: ทุกตัวเลขที่ผู้ใช้พูด (เงิน/เวลา/จำนวน) ต้องอยู่ในคำแปล — หายไป = อันตราย (ต่อราคาผิด นัดเวลาผิด)
 * หาย → ติดธง needs_confirm + เตือนใน note_th ให้ผู้ใช้เช็กกับเพื่อน
 */
export function checkNumbers(input: string, r: TranslationResult): TranslationResult {
  const nums = [...new Set((input.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, "")))];
  const tr = r.translation.replace(/[,，]/g, "");
  const missing = nums.filter((n) => {
    if (tr.includes(n)) return false;
    const v = Number(n);
    return !(Number.isInteger(v) && v < 1e8 && tr.includes(toChineseNum(v)));
  });
  if (missing.length) {
    r.needs_confirm = true;
    const warn = `⚠️ ตัวเลข ${missing.join(", ")} อาจตกหล่นในคำแปล — เช็กกับเพื่อนอีกครั้ง`;
    r.note_th = r.note_th ? `${warn} · ${r.note_th}` : warn;
  }
  return r;
}

const CJK_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9,
};
const CJK_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 萬: 10000, 십: 10, 백: 100, 천: 1000, 만: 10000 };

/**
 * อ่านตัวเลขเขียนแบบจีน/เกาหลีเป็นค่า: 一千二 = 1200, 两千 = 2000, 八百 = 800, 三万五 = 35000, 만 오천 = 15000
 * (รูปย่อ: ตัวเลขท้ายหลังหน่วย = หลักถัดลงมา เช่น 一千二 = 1200)
 */
export function parseCjkNumber(s: string): number | null {
  const t = s.replace(/\s+/g, "");
  if (!t || ![...t].some((c) => c in CJK_UNIT || c in CJK_DIGIT)) return null;
  let total = 0, section = 0, digit = -1, lastUnit = 0, zeroSeen = false;
  for (const c of t) {
    if (c in CJK_DIGIT) { digit = CJK_DIGIT[c]; if (digit === 0) zeroSeen = true; continue; }
    const u = CJK_UNIT[c];
    if (u === undefined) return null;
    const d = digit < 0 ? 1 : digit;
    if (u === 10000) { total += (section + (digit < 0 ? (section ? 0 : 1) : digit)) * 10000; section = 0; }
    else section += d * u;
    lastUnit = u;
    digit = -1;
  }
  // 一千二 → +200 (รูปย่อ) แต่ 一百零五 → +5 (มี 零 คั่น = หลักหน่วยจริง)
  if (digit >= 0) section += !zeroSeen && lastUnit >= 100 ? digit * (lastUnit === 10000 ? 1000 : lastUnit / 10) : digit;
  return total + section;
}

/** เงิน/จำนวนที่เขียนเป็นตัวอักษรจีน/เกาหลีในต้นฉบับ (ไม่รวมเวลา — เวลาเปลี่ยนรูปเป็น ทุ่ม/โมง ได้) */
export function cjkAmounts(input: string): number[] {
  const re = /([零〇一二两兩三四五六七八九十百千万萬영공일이삼사오육칠팔구십백천만\s]{1,12})\s*(块|塊|元|钱|錢|毛|个|個|件|张|張|碗|杯|份|瓶|원|개|명|장|잔|병|그릇)/g;
  const out: number[] = [];
  for (const m of input.matchAll(re)) {
    const v = parseCjkNumber(m[1]);
    if (v !== null && v >= 10) out.push(v);
  }
  return out;
}

/** ตัวเลขเป็นคำไทย (สำหรับยอมรับคำแปลที่เขียนเป็นคำ เช่น "แปดร้อย") */
export function thaiNumWords(n: number): string {
  const d = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
  const u = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const v = Number(s[i]), pos = s.length - 1 - i;
    if (!v) continue;
    if (pos === 1 && v === 1) out += "สิบ";
    else if (pos === 1 && v === 2) out += "ยี่สิบ";
    else if (pos === 0 && v === 1 && s.length > 1) out += "เอ็ด";
    else out += d[v] + u[pos];
  }
  return out;
}

/**
 * เพื่อน→เรา: เงิน/จำนวนที่เขาพูดเป็นตัวอักษร (만 오천 원, 一千二块) ต้องตรงในคำแปลไทย
 * ไม่ตรง → เตือนพร้อม "ค่าที่ถูก" ที่คำนวณเอง (ไม่พึ่งโมเดล)
 */
export function checkCjkAmounts(input: string, r: TranslationResult): TranslationResult {
  const tr = r.translation.replace(/[,\s]/g, "");
  const missing = cjkAmounts(input).filter((v) => !tr.includes(String(v)) && !tr.includes(thaiNumWords(v)));
  if (missing.length) {
    r.needs_confirm = true;
    const warn = `⚠️ ตัวเลขที่เขาพูดจริง = ${missing.map((v) => v.toLocaleString("en-US")).join(", ")} — คำแปลอาจผิด เช็กอีกครั้ง`;
    r.note_th = r.note_th ? `${warn} · ${r.note_th}` : warn;
  }
  return r;
}

/** ป้ายน้ำเสียงให้ตรงกับคำอธิบาย: คำอธิบายบอก "ประชด" แต่ป้ายเป็นพูดเล่น/ชม → ประชด */
export function fixTone(r: TranslationResult): TranslationResult {
  if (/ประชด|ประชดประชัน/.test(r.note_th ?? "") && ["joke", "compliment", "neutral", "polite"].includes(r.tone)) r.tone = "sarcasm";
  return r;
}

export function cleanReplies(r: TranslationResult, input: string): TranslationResult {
  // ภาษาที่ตรวจจากตัวอักษรแม่นกว่าที่โมเดลเดา
  r.detected_lang = scriptLang(input) ?? r.detected_lang;
  r.translation = fixCurrency(input, r.translation);
  r.back_translation_th = fixCurrency(input, r.back_translation_th);
  // "เพื่อนจะเข้าใจว่า" ต้องเป็นไทยเท่านั้น (รุ่นเล็กบางทีใส่ภาษาเพื่อนซ้ำมา) — ไม่ใช่ไทย = ไม่แสดงดีกว่าแสดงผิด
  if (r.back_translation_th && !/[฀-๿]/.test(r.back_translation_th)) r.back_translation_th = "";
  fixTone(r);
  // เรา→เพื่อน (คำแปลไม่ใช่ไทย) + มีตัวเลขในคำพูด → ตรวจว่าตัวเลขครบ
  if (r.translation && /\d/.test(input) && !/[฀-๿]/.test(r.translation)) checkNumbers(input, r);
  // เพื่อน→เรา (คำแปลเป็นไทย): เงิน/จำนวนที่พูดเป็นตัวอักษรจีน/เกาหลีต้องตรง
  if (r.translation && /[฀-๿]/.test(r.translation)) checkCjkAmounts(input, r);
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
