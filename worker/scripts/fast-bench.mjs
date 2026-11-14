// วัด /api/translate/fast จริง: เวลาที่ "คำแปลขึ้นจอ" (partial) vs "คำตอบเต็ม" (result)
// ใช้: node worker/scripts/fast-bench.mjs [base] [รอบ=2]
import { readFileSync } from "node:fs";
import { loadDevVars, pct } from "./devvars.mjs";
import { Glossary, toHints } from "../../app/js/core/glossary.js";

const env = loadDevVars();
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const ROUNDS = Number(process.argv[3] || 2);
const gloss = new Glossary().load(["zh", "en", "ja", "ko", "th"].flatMap((l) => JSON.parse(readFileSync(new URL(`../../app/data/glossary/${l}.json`, import.meta.url), "utf8"))));
const CASES = [
  ["你这操作666啊", "partner_to_me", "zh"], ["我直接躺平了", "partner_to_me", "zh"], ["你可真行啊", "partner_to_me", "zh"],
  ["绝绝子", "partner_to_me", "zh"], ["别卷了", "partner_to_me", "zh"], ["你对青霉素过敏吗？", "partner_to_me", "zh", "medical"],
  ["เอ่อ ห้องน้ำ อยู่ไหน อะครับ", "me_to_partner", "zh"], ["อันนี้ จึ้งมาก ชอบ", "me_to_partner", "zh"],
  ["ปวดหัว ตั้งแต่เมื่อวาน มีไข้นิดหน่อย", "me_to_partner", "zh", "medical"],
  ["That's a piece of cake", "partner_to_me", "en"], ["マジでヤバい", "partner_to_me", "ja"], ["대박!", "partner_to_me", "ko"],
];
const P = [], R = [];
const engines = {};
for (let round = 1; round <= ROUNDS; round++) {
  for (const [text, direction, target_lang, domain = "general"] of CASES) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/api/translate/fast`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN },
      body: JSON.stringify({ text, direction, target_lang, domain, history: [], request_id: crypto.randomUUID(),
        glossary: toHints(gloss.find(text, { lang: direction === "me_to_partner" ? "th" : target_lang, domain })) }),
    });
    const rd = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", partial = null, result = null, pAt = 0, err = null;
    for (;;) {
      const x = await rd.read(); if (x.done) break;
      buf += dec.decode(x.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(b)?.[1]; const d = /data: (.*)/.exec(b)?.[1];
        if (ev === "partial") { partial = JSON.parse(d); pAt = performance.now() - t0; }
        if (ev === "result") result = JSON.parse(d);
        if (ev === "error") err = JSON.parse(d);
      }
    }
    const rAt = performance.now() - t0;
    if (pAt) P.push(pAt);
    R.push(rAt);
    if (result) engines[result.model] = (engines[result.model] ?? 0) + 1;
    console.log(`${String(Math.round(pAt)).padStart(5)}ms คำแปล | ${String(Math.round(rAt)).padStart(5)}ms ครบ | ${(result?.model ?? "ERR").padEnd(32)} | ${text} → ${partial?.translation ?? err?.message_th}${result?.tone && result.tone !== "neutral" ? ` [${result.tone}]` : ""}${result?.note_th ? ` 💡${result.note_th}` : ""}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
console.log(`\nคำแปลขึ้นจอ: p50=${Math.round(pct(P, 50))}ms p90=${Math.round(pct(P, 90))}ms | คำตอบเต็ม: p50=${Math.round(pct(R, 50))}ms p90=${Math.round(pct(R, 90))}ms | ≤3วิ: ${P.filter((x) => x <= 3000).length}/${P.length}`);
console.log("รุ่นที่ชนะ:", engines);
