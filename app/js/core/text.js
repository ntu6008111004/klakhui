// Pure text helpers: split sentences, chunk to size limits, similarity (echo filter), filler-word filtering

export const CJK_LANGS = new Set(["zh", "ja", "ko"]);

/** Send limit per request: zh/ja/ko ≤ 300 chars, th/en ≤ 600 */
export const sendLimit = (lang) => (CJK_LANGS.has(lang) ? 300 : 600);

const SENT_END = /([。！？!?．…]+|[.](?=\s|$)|\n+)/;

/** Split into sentences (keeping punctuation) */
export function splitSentences(text) {
  const parts = text.split(SENT_END);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const s = (parts[i] + (parts[i + 1] ?? "")).trim();
    if (s) out.push(s);
  }
  return out;
}

/** Hard-split one long sentence: at a comma/space nearest the limit, else by length */
function hardSplit(s, limit) {
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const m = Math.max(...[...window.matchAll(/[，,、；;：:\s]/g)].map((x) => x.index ?? -1), -1);
    const cut = m > limit * 0.4 ? m + 1 : limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Pack sentences into chunks ≤ limit (order preserved — used for sending translations and for TTS)
 * @param {string} text @param {number} limit
 */
export function chunkText(text, limit) {
  const chunks = [];
  let cur = "";
  for (const sent of splitSentences(text)) {
    const pieces = sent.length > limit ? hardSplit(sent, limit) : [sent];
    for (const p of pieces) {
      // CJK: ต่อกันไม่มีช่องว่าง / ไทย-อังกฤษ: ต่อด้วยช่องว่าง
      const joiner = !cur || /[　-ヿ㐀-鿿가-힯＀-￯]$/.test(cur) ? "" : " ";
      if ((cur + joiner + p).length <= limit) cur = cur + joiner + p;
      else { if (cur) chunks.push(cur); cur = p; }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** ตรวจว่าข้อความเป็น CJK ไหม (ไม่ต้องรู้ภาษาล่วงหน้า — รองรับโหมดภาษาอัตโนมัติ) */
export function isCjkText(text) {
  const s = text.replace(/[\s\p{P}\p{S}\d]+/gu, "");
  if (!s) return false;
  const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  return cjk / s.length > 0.3;
}

/** ตัดข้อความยาวเป็นท่อน: CJK ≤ 300 ตัว, ไทย/อังกฤษ ≤ 600 (lang ใส่ได้ ถ้าไม่ใส่จะตรวจเอง) */
export const chunkForSend = (text, lang) => chunkText(text, lang ? sendLimit(lang) : isCjkText(text) ? 300 : 600);
export const chunkForTts = (text) => chunkText(text, 120);

/**
 * ตำแหน่งหลังจุดจบประโยคสุดท้ายในข้อความที่ "ยังไหลเข้ามา" — 0 = ยังไม่จบสักประโยค
 * จบประโยค: 。！？!?… หรือ . ที่ตามด้วยช่องว่าง; จุลภาค/อัฒภาคนับด้วยถ้าหลังจากนั้นมีข้อความมาแล้ว ≥ 12 ตัว (ให้พูดได้เร็วขึ้นในประโยคยาว)
 */
export function sentenceEnd(text, allowComma = true) {
  let end = 0;
  const re = allowComma ? /[。！？!?…]+|[.](?=\s)|[，,；;、](?=.{12,})/g : /[。！？!?…]+|[.](?=\s)/g;
  for (const m of text.matchAll(re)) end = m.index + m[0].length;
  // ภาษาไทยไม่มีเครื่องหมายจบประโยค → ท่อนแรกตัดที่ "ช่องว่างระหว่างวลี" ได้
  // (ข้างหน้ามีไทย ≥ 10 ตัว และข้างหลังมาแล้ว ≥ 12 ตัว ไม่ให้ตัดกลางคำสั้นๆ)
  if (!end && allowComma && /[฀-๿]/.test(text)) {
    for (const m of text.matchAll(/ (?=.{12,})/g)) {
      if ((text.slice(0, m.index).match(/[฀-๿]/g) ?? []).length >= 10) { end = m.index + 1; break; }
    }
  }
  return end;
}

/** Normalize for comparison: lowercase, strip punctuation/spaces */
export function normalize(s) {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Dice coefficient over character bigrams (0..1) */
export function similarity(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 0.8 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
    return m;
  };
  const ga = grams(x), gb = grams(y);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** Interjections / meaningless sounds — not worth sending for translation */
const FILLERS = new Set([
  "嗯", "啊", "呃", "哦", "噢", "额", "嗯嗯", "啊啊", "那个", "就是",
  "uh", "um", "uhm", "hmm", "er", "ah", "oh", "mm", "huh",
  "えー", "えっと", "あの", "あのー", "うーん", "ん", "あ", "え",
  "음", "어", "아", "저기", "그", "음음",
  "เอ่อ", "อืม", "อ่า", "เออ",
]);
export function isFiller(s) {
  const n = normalize(s);
  return n.length < 2 || FILLERS.has(n) || /^(.)\1*$/u.test(n);
}

/** Count words (en) / characters (CJK) to decide when to cut a segment */
export function measure(s, lang) {
  return lang === "en" ? s.trim().split(/\s+/).filter(Boolean).length : s.replace(/\s+/g, "").length;
}
