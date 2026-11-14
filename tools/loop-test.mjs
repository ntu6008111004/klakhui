// Loop test ก่อนส่งมอบ: รันทุกอย่างซ้ำหลายรอบ ต้องผ่านทุกรอบ
// ใช้: (เปิด npm run dev:api ไว้) แล้ว npm run loop -- [จำนวนรอบ=3] [base=http://127.0.0.1:8787]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadDevVars, pct } from "../worker/scripts/devvars.mjs";
import { Glossary, toHints } from "../app/js/core/glossary.js";
import { RateLimiter } from "../app/js/core/limiter.js";

const ROUNDS = Number(process.argv[2] || 3);
const BASE = process.argv[3] || "http://127.0.0.1:8787";
const env = loadDevVars();
const H = { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN };
const THAI = /[฀-๿]/;
const gloss = new Glossary().load(["zh", "en", "ja", "ko", "th"].flatMap((l) => JSON.parse(readFileSync(new URL(`../app/data/glossary/${l}.json`, import.meta.url), "utf8"))));

const CASES = [
  { text: "你这操作666啊", direction: "partner_to_me", target_lang: "zh", wantTone: true },
  { text: "我直接躺平了", direction: "partner_to_me", target_lang: "zh", wantTone: true },
  { text: "你对青霉素过敏吗？", direction: "partner_to_me", target_lang: "zh", domain: "medical" },
  { text: "That's a piece of cake", direction: "partner_to_me", target_lang: "en", wantTone: true },
  { text: "대박!", direction: "partner_to_me", target_lang: "ko", wantTone: true },
  { text: "マジでヤバい", direction: "partner_to_me", target_lang: "ja", wantTone: true },
  { text: "เอ่อ ห้องน้ำ อยู่ไหน อะครับ", direction: "me_to_partner", target_lang: "zh" },
  { text: "ปวดหัว ตั้งแต่เมื่อวาน มีไข้นิดหน่อย", direction: "me_to_partner", target_lang: "zh", domain: "medical" },
];
const TTS = [["th", "สวัสดีครับ"], ["zh", "你好"], ["en", "Hello"], ["ja", "こんにちは"], ["ko", "안녕하세요"]];

const results = [];
const lat = [];
const fastLat = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function translate(c) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/translate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ domain: "general", history: [], request_id: crypto.randomUUID(), ...c,
      glossary: toHints(gloss.find(c.text, { lang: c.direction === "me_to_partner" ? "th" : c.target_lang, domain: c.domain ?? "general" })) }),
  });
  const j = await r.json();
  const ms = performance.now() - t0;
  return { status: r.status, j, ms };
}

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n══════ รอบที่ ${round}/${ROUNDS} ══════`);

  const ut = spawnSync("npx", ["vitest", "run"], { cwd: new URL("..", import.meta.url), encoding: "utf8", shell: true });
  const m = /Tests\s+(\d+) passed(?: \((\d+)\))?/.exec(ut.stdout) ?? [];
  check("unit + fault-injection tests", ut.status === 0, m[1] ? `${m[1]} ผ่าน` : (ut.stdout + ut.stderr).slice(-300));

  const hr = await fetch(`${BASE}/api/health`, { headers: H }).then((r) => r.json()).catch(() => ({}));
  check("health", hr.ok === true, `thaillm=${hr.thaillm} tts=${hr.tts}`);

  const bad = await fetch(`${BASE}/api/translate`, { method: "POST", headers: { ...H, "X-App-Token": "wrong" }, body: "{}" });
  const badJ = await bad.json().catch(() => ({}));
  check("token ผิด → 401 ภาษาไทย", bad.status === 401 && THAI.test(badJ?.error?.message_th ?? ""));

  for (const c of CASES) {
    const { status, j, ms } = await translate(c);
    lat.push(ms);
    const issues = [];
    if (status !== 200) issues.push(`HTTP ${status}`);
    if (c.direction === "partner_to_me" && !THAI.test(j.translation ?? "")) issues.push("คำแปลไม่ใช่ไทย");
    if (c.direction === "me_to_partner" && THAI.test(j.translation ?? "")) issues.push("คำแปลยังเป็นไทย");
    if (c.direction === "me_to_partner" && !THAI.test(j.back_translation_th ?? "")) issues.push("ไม่มีแปลกลับไทย");
    if (j.note_th && !THAI.test(j.note_th)) issues.push("note_th ไม่ใช่ไทย");
    if (c.wantTone && !j.note_th && ["neutral", "polite"].includes(j.tone)) issues.push("ไม่ได้อธิบายคำแสลง/สำนวน");
    // normalize แบบรองรับ Unicode (\W เดิมลบอักษรจีน/ญี่ปุ่น/เกาหลีทิ้งหมด → เทียบผิด)
    const nz = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    // ถ้าคำพูดเรามีคำเติม (เอ่อ/อะ/อืม) แล้วแปลกลับยังติดมาเหมือนเดิม = ลอก ไม่ได้แปลกลับจริง
    // (ประโยคสะอาดอยู่แล้ว แปลกลับได้เหมือนเดิมถือว่าถูก)
    if (c.direction === "me_to_partner" && /เอ่อ|อืม|\bอะ\b|อ่ะ/.test(c.text) && nz(j.back_translation_th ?? "") === nz(c.text)) issues.push("แปลกลับไทยลอกคำพูดเรา (เช็กไม่ได้)");
    if ((j.replies ?? []).some((x) => nz(x.target) === nz(c.text))) issues.push("ประโยคตอบกลับลอกต้นฉบับ");
    check(`แปล "${c.text}"`, !issues.length, issues.join(", ") || `${Math.round(ms)}ms [${j.engine}] → ${j.translation}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // เส้นทางเร็ว (ที่แอปใช้จริง): คำแปลต้องขึ้นจอภายใน 3 วิ
  for (const c of CASES) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/api/translate/fast`, {
      method: "POST", headers: H,
      body: JSON.stringify({ domain: "general", history: [], request_id: crypto.randomUUID(), ...c, wantTone: undefined,
        glossary: toHints(gloss.find(c.text, { lang: c.direction === "me_to_partner" ? "th" : c.target_lang, domain: c.domain ?? "general" })) }),
    });
    const txt = await res.text();
    const pAt = performance.now() - t0;
    const evs = txt.split("\n\n").filter((b) => b.startsWith("event:")).map((b) => ({ e: /event: (\w+)/.exec(b)[1], d: JSON.parse(/data: (.*)/.exec(b)[1]) }));
    const partial = evs.find((x) => x.e === "partial");
    const result = evs.find((x) => x.e === "result");
    const pMs = partial?.d.latency_ms ?? Infinity;
    fastLat.push(pMs);
    const issues = [];
    if (!partial) issues.push("ไม่มีคำแปลก่อน");
    if (!result) issues.push("ไม่มีผลเต็ม");
    if (pMs > 3000) issues.push(`คำแปลช้า ${pMs}ms`);
    if (partial && c.direction === "partner_to_me" && !THAI.test(partial.d.translation)) issues.push("ไม่ใช่ไทย");
    if (partial && c.direction === "me_to_partner" && THAI.test(partial.d.translation)) issues.push("ยังเป็นไทย");
    if (result && partial && result.d.translation !== partial.d.translation) issues.push("ผลเต็มไม่ตรงกับคำแปลที่พูดไปแล้ว");
    check(`เร็ว "${c.text}"`, !issues.length, issues.join(", ") || `คำแปล ${pMs}ms ครบ ${Math.round(pAt)}ms [${result?.d.model}]`);
    await new Promise((r) => setTimeout(r, 250));
  }

  for (const [lang, text] of TTS) {
    const t0 = performance.now();
    const r = await fetch(`${BASE}/api/tts`, { method: "POST", headers: H, body: JSON.stringify({ text, lang }) });
    const b = await r.arrayBuffer();
    check(`เสียง ${lang}`, r.status === 200 && b.byteLength > 4000, `${r.status} ${b.byteLength}B ${Math.round(performance.now() - t0)}ms ${r.headers.get("x-voice") ?? ""}`);
  }

  {
    const t0 = performance.now();
    const r = await fetch(`${BASE}/api/translate/stream`, { method: "POST", headers: H, body: JSON.stringify({ text: "哈哈哈笑死我了", direction: "partner_to_me", target_lang: "zh", domain: "general", history: [], glossary: [], segment_id: "loop" }) });
    const txt = await r.text();
    const first = txt.indexOf("event: delta");
    check("stream (โหมดรับฟังตลอด)", txt.includes("event: delta") && txt.includes("event: done") && first >= 0, `${Math.round(performance.now() - t0)}ms`);
  }

  {
    const lim = new RateLimiter();
    const starts = [];
    const st = {};
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 12 }, (_, i) => lim.schedule(async () => {
      starts.push(Date.now() - t0);
      const r = await fetch(`${BASE}/api/translate`, { method: "POST", headers: H, body: JSON.stringify({ text: ["你好", "谢谢", "再见"][i % 3], direction: "partner_to_me", target_lang: "zh", request_id: `loop-lim-${round}-${i}` }) });
      st[r.status] = (st[r.status] ?? 0) + 1;
    })));
    const max1s = Math.max(...starts.map((s) => starts.filter((x) => x >= s && x < s + 1000).length));
    check("limit: ยิงรัว 12 คำขอ", max1s <= 4 && !st[429] && st[200] === 12, `สูงสุด ${max1s}/วิ สถานะ ${JSON.stringify(st)}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n══════ สรุป ══════`);
console.log(`ผ่าน ${results.length - failed.length}/${results.length} รายการ (${ROUNDS} รอบ)`);
if (fastLat.length) console.log(`⚡ คำแปลขึ้นจอ (เส้นทางเร็ว): p50=${Math.round(pct(fastLat, 50))}ms p90=${Math.round(pct(fastLat, 90))}ms ≤3วิ ${fastLat.filter((x) => x <= 3000).length}/${fastLat.length}`);
if (lat.length) console.log(`latency แปล (แบบเดิม): p50=${Math.round(pct(lat, 50))}ms p90=${Math.round(pct(lat, 90))}ms (${lat.length} ครั้ง)`);
for (const f of failed) console.log(`❌ ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
