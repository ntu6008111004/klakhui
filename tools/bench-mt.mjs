// เปรียบเทียบความแม่น: Typhoon 30B vs Typhoon 8B (ThaiLLM) vs MyMemory (แปลฟรี มี API ทางการ)
// เทียบกับคำแปลอ้างอิงใน tools/corpus.json → ตัวตัดสิน (LLM) ให้คะแนนความหมาย 0/1/2 + เช็กคำสำคัญ
// ใช้: node tools/bench-mt.mjs [จำนวนประโยค=500] [ระบบ=30b,8b,mymemory]
// ผลลัพธ์: tools/bench-results.json (ใช้วิเคราะห์จุดผิด → จำเข้าคลังคำ)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDevVars } from "../worker/scripts/devvars.mjs";
import { Glossary, toHints } from "../app/js/core/glossary.js";
import { RateLimiter } from "../app/js/core/limiter.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = `${process.env.TEMP ?? "/tmp"}/bench-bundle.mjs`;
// bundle โค้ด prompt/parse ของ Worker (TypeScript) ด้วย esbuild ที่มากับ wrangler (ใช้ JS API — path มีช่องว่างก็ไม่พัง)
const esbuild = createRequire(`${root}worker/package.json`)("esbuild");
esbuild.buildSync({ entryPoints: [`${root}tools/bench-entry.ts`], bundle: true, format: "esm", platform: "neutral", outfile: tmp, logLevel: "error" });
const W = await import(pathToFileURL(tmp).href);

const env = loadDevVars();
const N = Number(process.argv[2] || 500);
const SYSTEMS = (process.argv[3] || "30b,8b,mymemory").split(",");
let corpus = JSON.parse(readFileSync(process.env.CORPUS ?? new URL("./corpus.json", import.meta.url), "utf8")).slice(0, N);
// ONLY_FAILED=<ไฟล์ผลเดิม> → รันซ้ำเฉพาะข้อที่ 30b เคยได้ < 2 (ใช้ยืนยันว่าแก้แล้วดีขึ้นจริง)
if (process.env.ONLY_FAILED) {
  const prev = JSON.parse(readFileSync(process.env.ONLY_FAILED, "utf8"));
  corpus = corpus.filter((c) => prev[c.id]?.sys?.["30b"] && prev[c.id].sys["30b"].score < 2);
  console.log(`รันซ้ำเฉพาะข้อที่เคยผิด/คลาด: ${corpus.length} ข้อ`);
}
const gloss = new Glossary().load(["zh", "en", "ja", "ko", "th", "learned"].flatMap((l) => { try { return JSON.parse(readFileSync(new URL(`../app/data/glossary/${l}.json`, import.meta.url), "utf8")); } catch { return []; } }));
const LANG = { zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", th: "Thai" };
const THAI = /[฀-๿]/;

const typhoonLim = new RateLimiter({ perSec: 3, perMin: 170 });
const thaillmLim = new RateLimiter({ perSec: 3, perMin: 170 });
const mmLim = new RateLimiter({ perSec: 1, perMin: 50 });

async function chat(url, key, model, messages, { temp = 0.3, max = 600, lim }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await lim.schedule(() => fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: temp, max_tokens: max, stream: false, ...(url === env.THAILLM_URL ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
        signal: AbortSignal.timeout(25_000),
      }));
      if (r.status === 429 || r.status >= 500) { lim.on429?.(); await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
      const j = await r.json();
      return String(j?.choices?.[0]?.message?.content ?? "");
    } catch { await new Promise((s) => setTimeout(s, 1000)); }
  }
  return "";
}

const T30 = { url: env.FALLBACK_LLM_URL, key: env.FALLBACK_LLM_KEY, model: env.FALLBACK_LLM_MODEL, lim: typhoonLim };
const T8 = { url: env.THAILLM_URL ?? "https://thaillm.or.th/api/v1/chat/completions", key: env.THAILLM_API_KEY, model: "Typhoon-S-ThaiLLM-8B-Instruct", lim: thaillmLim };

/** แปลด้วย prompt + ตัวกันผิดชุดเดียวกับระบบจริง */
async function ours(sys, it) {
  const srcLang = it.dir === "me_to_partner" ? "th" : it.lang;
  const req = { direction: it.dir, targetLang: it.lang, domain: it.cat === "medical" ? "medical" : it.cat === "mechanic" || it.cat === "tech" ? "tech" : "general", history: [],
    glossary: toHints(gloss.find(it.text, { domain: "general" })) };
  const content = await chat(sys.url, sys.key, sys.model, [
    { role: "system", content: W.buildSystemPrompt(req) },
    { role: "user", content: W.buildUserMessage(it.text, it.dir, it.lang) },
  ], { temp: it.dir === "me_to_partner" ? 0.1 : 0.3, max: W.maxTokensFor(it.text.length), lim: sys.lim });
  const r = W.parseTranslation(content, it.dir) ?? W.salvagePartial(content, it.dir) ?? W.fallbackResult(content, it.dir);
  return W.cleanReplies(r, it.text).translation;
}

let mmDead = false;
async function mymemory(it) {
  if (mmDead) return null;
  const pair = it.dir === "me_to_partner" ? `th|${it.lang === "zh" ? "zh-CN" : it.lang}` : `${it.lang === "zh" ? "zh-CN" : it.lang}|th`;
  try {
    const r = await mmLim.schedule(() => fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(it.text.slice(0, 480))}&langpair=${pair}`, { signal: AbortSignal.timeout(15_000) }));
    const j = await r.json();
    if (j.responseStatus !== 200 || /MYMEMORY WARNING|QUOTA/i.test(j.responseData?.translatedText ?? "")) { mmDead = true; console.log("⚠️ MyMemory หมดโควตาฟรีวันนี้ — หยุดใช้ตัวนี้"); return null; }
    return j.responseData.translatedText;
  } catch { return null; }
}

/** ตัวตัดสิน: ความหมายตรงกับคำแปลอ้างอิงไหม (0 ผิด / 1 คลาดเล็กน้อย / 2 ตรง) */
async function judge(it, cand) {
  if (!cand) return { score: 0, issue: "ไม่มีผล" };
  const target = it.dir === "me_to_partner" ? LANG[it.lang] : "Thai";
  const ref = it.dir === "me_to_partner" ? `${it.ref_target}  (meaning in Thai: ${it.ref_th})` : it.ref_th;
  const out = await chat(T30.url, T30.key, T30.model, [
    { role: "system", content: `You grade translations for a live interpreter. Compare the CANDIDATE (${target}) with the REFERENCE meaning.
Score 2 = same meaning (wording may differ; slang/idiom rendered naturally is fine).
Score 1 = mostly right but a minor nuance/tone lost.
Score 0 = wrong or missing meaning: changed/missing numbers or currency, wrong object, wrong who-does-what, question↔statement flip, literal idiom that misleads, wrong language.
Return ONLY JSON: {"score":0|1|2,"issue":"short Thai reason if score<2, else empty"}` },
    { role: "user", content: `SOURCE: ${it.text}\nREFERENCE: ${ref}\nCANDIDATE: ${cand}` },
  ], { temp: 0, max: 120, lim: T30.lim });
  const m = /\{[\s\S]*\}/.exec(out);
  try { const j = JSON.parse(m[0]); return { score: Number(j.score) || 0, issue: String(j.issue ?? "") }; } catch { return { score: -1, issue: "ตัดสินไม่ได้" }; }
}

const resultsFile = process.env.RESULTS ?? new URL("./bench-results.json", import.meta.url);
const done = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {};
let n = 0;
const t0 = Date.now();
await Promise.all(corpus.map(async (it) => {
  const row = done[it.id] ?? { id: it.id, dir: it.dir, lang: it.lang, cat: it.cat, len: it.len, text: it.text, ref_th: it.ref_th, sys: {} };
  for (const s of SYSTEMS) {
    if (row.sys[s]?.score >= 0) continue; // ทำแล้ว (รันต่อจากเดิมได้)
    const cand = s === "30b" ? await ours(T30, it) : s === "8b" ? await ours(T8, it) : await mymemory(it);
    if (cand === null) continue;
    const j = await judge(it, cand);
    const hay = cand;
    const keyHit = it.dir === "partner_to_me" ? (it.key ?? []).filter((k) => hay.includes(k)).length / Math.max(1, (it.key ?? []).length) : null;
    row.sys[s] = { out: cand, ...j, keyHit, langOk: it.dir === "partner_to_me" ? THAI.test(cand) : !THAI.test(cand) };
  }
  done[it.id] = row;
  if (++n % 25 === 0) { writeFileSync(resultsFile, JSON.stringify(done, null, 1)); console.log(`… ${n}/${corpus.length} (${Math.round((Date.now() - t0) / 1000)} วิ)`); }
}));
writeFileSync(resultsFile, JSON.stringify(done, null, 1));

// ── สรุป
const rows = Object.values(done).filter((r) => corpus.some((c) => c.id === r.id));
const summ = (filter) => {
  const o = {};
  for (const s of SYSTEMS) {
    const xs = rows.filter(filter).map((r) => r.sys[s]).filter((x) => x && x.score >= 0);
    if (!xs.length) continue;
    o[s] = { n: xs.length, exact: Math.round((xs.filter((x) => x.score === 2).length / xs.length) * 100), wrong: Math.round((xs.filter((x) => x.score === 0).length / xs.length) * 100) };
  }
  return o;
};
const fmt = (o) => Object.entries(o).map(([s, v]) => `${s}: ตรง ${v.exact}% ผิด ${v.wrong}% (n=${v.n})`).join(" | ");
console.log(`\n══ รวมทั้งหมด ══\n${fmt(summ(() => true))}`);
for (const key of ["dir", "lang", "len", "cat"]) {
  console.log(`\n── แยกตาม ${key}`);
  for (const v of [...new Set(rows.map((r) => r[key]))].sort()) console.log(`${String(v).padEnd(14)} ${fmt(summ((r) => r[key] === v))}`);
}
