// รันเคสความแม่นหัวข้อ 11 ผ่าน worker ที่รันอยู่ (npm run dev → http://127.0.0.1:8787)
// ใช้: npm run accuracy -- [base_url] [จำนวนรอบวัด latency=20]
import { loadDevVars, pct } from "./devvars.mjs";
import { readFileSync } from "node:fs";
import { Glossary, toHints } from "../../app/js/core/glossary.js";

// แนบคำจากคลังคำเหมือนแอปจริง (ปิดได้ด้วย NO_GLOSSARY=1)
const gloss = new Glossary().load(
  ["zh", "en", "ja", "ko", "th"].flatMap((l) => JSON.parse(readFileSync(new URL(`../../app/data/glossary/${l}.json`, import.meta.url), "utf8"))),
);
const hintsFor = (c) => (process.env.NO_GLOSSARY ? [] : toHints(gloss.find(c.text, { lang: c.direction === "me_to_partner" ? "th" : c.target_lang, domain: c.domain ?? "general" })));

const env = loadDevVars();
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const LAT_N = Number(process.argv[3] || 20);
if (!env.APP_TOKEN) { console.error("ไม่พบ APP_TOKEN ใน worker/.dev.vars"); process.exit(1); }

const cases = [
  { name: "666", text: "你这操作666啊", direction: "partner_to_me", target_lang: "zh", expect: "≈ นายนี่เก่งจริงๆ + tone compliment/slang + อธิบาย 666" },
  { name: "躺平", text: "我直接躺平了", direction: "partner_to_me", target_lang: "zh", expect: "อธิบายว่าขอไม่สู้/ปล่อยวาง" },
  { name: "真行 (ประชด)", text: "你可真行啊", direction: "partner_to_me", target_lang: "zh",
    history: [{ who: "me", text: "ขอโทษ ฉันทำแก้วของเธอตกแตก", translation: "对不起，我把你的杯子摔碎了" }], expect: "tone sarcasm" },
  { name: "绝绝子", text: "绝绝子", direction: "partner_to_me", target_lang: "zh", expect: "tone slang + สุดยอดมาก" },
  { name: "别卷了", text: "别卷了", direction: "partner_to_me", target_lang: "zh", expect: "อธิบาย 内卷" },
  { name: "青霉素 (medical)", text: "你对青霉素过敏吗？", direction: "partner_to_me", target_lang: "zh", domain: "medical", expect: "คุณแพ้ยาเพนิซิลลิน (青霉素) ไหม" },
  { name: "ห้องน้ำ", text: "เอ่อ ห้องน้ำ อยู่ไหน อะครับ", direction: "me_to_partner", target_lang: "zh", expect: "请问洗手间在哪里？" },
  { name: "จึ้ง", text: "อันนี้ จึ้งมาก ชอบ", direction: "me_to_partner", target_lang: "zh", expect: "จีนแบบเป็นกันเอง ≈ เจ๋งมาก ชอบเลย" },
  { name: "ปวดหัว (medical)", text: "ปวดหัว ตั้งแต่เมื่อวาน มีไข้นิดหน่อย", direction: "me_to_partner", target_lang: "zh", domain: "medical", expect: "แปลครบ ไม่เติมอาการ" },
  { name: "piece of cake", text: "That's a piece of cake", direction: "partner_to_me", target_lang: "en", expect: "idiom, ง่ายมาก" },
  { name: "マジでヤバい", text: "マジでヤバい", direction: "partner_to_me", target_lang: "ja", expect: "slang (บวก/ลบตามบริบท)" },
  { name: "대박", text: "대박!", direction: "partner_to_me", target_lang: "ko", expect: "slang สุดยอด/ว้าว" },
];

async function tr(c) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN },
    body: JSON.stringify({ domain: "general", history: [], request_id: crypto.randomUUID(), ...c, glossary: hintsFor(c), name: undefined, expect: undefined }),
  });
  return { status: res.status, ms: Math.round(performance.now() - t0), body: await res.json() };
}

console.log(`\n### ความแม่น (${BASE})\n`);
for (const c of cases) {
  const r = await tr(c);
  const b = r.body;
  console.log(`--- ${c.name} [${c.direction}/${c.target_lang}${c.domain ? "/" + c.domain : ""}] ${r.status} ${r.ms}ms`);
  console.log(`  input : ${c.text}`);
  console.log(`  ต้องได้: ${c.expect}`);
  if (b.error) console.log(`  ERROR : ${b.error.code} ${b.error.message_th}`);
  else {
    console.log(`  แปล   : ${b.translation}`);
    if (c.direction === "me_to_partner") console.log(`  กลับไทย: ${b.back_translation_th}`);
    console.log(`  tone  : ${b.tone}${b.needs_confirm ? "  ⚠️needs_confirm" : ""}`);
    if (b.note_th) console.log(`  note  : ${b.note_th}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\n### Latency ${LAT_N} ครั้ง (ประโยคสั้น)\n`);
const times = [];
for (let i = 0; i < LAT_N; i++) {
  const r = await tr(cases[i % cases.length]);
  if (r.status === 200) times.push(r.ms);
  else console.log(`#${i + 1} status ${r.status}`);
  await new Promise((r) => setTimeout(r, 300));
}
if (times.length) console.log(`สำเร็จ ${times.length}/${LAT_N}  p50=${pct(times, 50)}ms  p90=${pct(times, 90)}ms  max=${Math.max(...times)}ms`);
