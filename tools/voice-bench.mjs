// วัดแบบแอปจริง: เวลา "ตัวอักษรแรกขึ้นจอ" / "เสียงแรกเริ่มดัง" / "ครบ" + ปริมาณเน็ตต่อครั้ง
// ความยาว 4 แบบ: สั้น / กลาง / ยาว / ยาวมาก — ทั้ง เรา→เพื่อน (พูดออกเสียง) และ เพื่อน→เรา (อ่านบนจอ)
// ใช้: (เปิด npm run dev:api) แล้ว node tools/voice-bench.mjs [base]
import { readFileSync } from "node:fs";
import { loadDevVars, pct } from "../worker/scripts/devvars.mjs";
import { Glossary, toHints } from "../app/js/core/glossary.js";
import { chunkForSend, chunkForTts, sentenceEnd } from "../app/js/core/text.js";

const env = loadDevVars();
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const H = { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN };
const gloss = new Glossary().load(["zh", "en", "ja", "ko", "th"].flatMap((l) => JSON.parse(readFileSync(new URL(`../app/data/glossary/${l}.json`, import.meta.url), "utf8"))));

const ME = {
  สั้น: "ห้องน้ำอยู่ไหนครับ",
  กลาง: "ขอโทษนะครับ ผมมาเที่ยวครั้งแรก ไม่ค่อยเข้าใจภาษา ช่วยพูดช้าๆ หน่อยได้ไหมครับ",
  ยาว: "สวัสดีครับ ผมชื่อต้น มาจากประเทศไทย ตอนนี้รถผมเสียอยู่ข้างทาง เครื่องยนต์มีเสียงดังแปลกๆ แล้วก็มีควันออกมานิดหน่อย ผมไม่แน่ใจว่าต้องซ่อมอะไรบ้าง รบกวนช่วยดูให้หน่อยได้ไหมครับ แล้วถ้าต้องเปลี่ยนอะไหล่ ช่วยบอกราคาก่อนได้ไหมครับ ผมมีเงินไม่ค่อยเยอะ",
  ยาวมาก: ("สวัสดีครับ ผมชื่อต้น มาจากประเทศไทย ตอนนี้รถผมเสียอยู่ข้างทาง เครื่องยนต์มีเสียงดังแปลกๆ แล้วก็มีควันออกมานิดหน่อย ผมไม่แน่ใจว่าต้องซ่อมอะไรบ้าง รบกวนช่วยดูให้หน่อยได้ไหมครับ ".repeat(3) + "ถ้าต้องเปลี่ยนอะไหล่ช่วยบอกราคาก่อนนะครับ ขอบคุณมากครับ"),
};
const PARTNER = {
  สั้น: "好的，没问题",
  กลาง: "你这个车刹车片磨损太严重了，必须得换，不然很危险",
  ยาว: "你这个车的问题不小啊。刹车片已经磨没了，刹车盘也有点划伤。我建议你今天就把刹车片换了，刹车盘可以先打磨一下，下次保养再看要不要换。换刹车片大概八百块钱，两个小时左右能弄好。你要是着急的话，我可以先给你弄。",
  ยาวมาก: "你这个车的问题不小啊。刹车片已经磨没了，刹车盘也有点划伤。我建议你今天就把刹车片换了，刹车盘可以先打磨一下，下次保养再看要不要换。".repeat(4) + "换刹车片大概八百块钱，两个小时左右能弄好。",
};

async function fastOnce(text, direction, wantVoice) {
  const t0 = performance.now();
  const body = JSON.stringify({ text, direction, target_lang: "zh", domain: "general", history: [], request_id: crypto.randomUUID(),
    glossary: toHints(gloss.find(text, { lang: direction === "me_to_partner" ? "th" : "zh" })) });
  const res = await fetch(`${BASE}/api/translate/fast`, { method: "POST", headers: H, body });
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", firstText = 0, voiceReq = null, done = 0, bytesIn = 0, translation = "";
  for (;;) {
    const x = await rd.read(); if (x.done) break;
    bytesIn += x.value.byteLength;
    buf += dec.decode(x.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const b = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(b)?.[1]; const d = /data: (.*)/.exec(b)?.[1];
      if (ev === "progress" || ev === "partial") {
        const j = JSON.parse(d);
        const tr = j.translation ?? translation.slice(0, j.from) + (j.d ?? ""); // ประกอบส่วนที่เพิ่มแบบแอป
        translation = tr;
        if (!firstText) firstText = performance.now() - t0;
        // แอปจริง: พูดทันทีที่จบประโยคแรก (หรือได้คำแปลครบ)
        const end = ev === "partial" ? tr.length : sentenceEnd(tr);
        if (wantVoice && !voiceReq && end > 0) {
          const seg = chunkForTts(tr.slice(0, end))[0];
          const tv = performance.now();
          voiceReq = fetch(`${BASE}/api/tts`, { method: "POST", headers: H, body: JSON.stringify({ text: seg, lang: "zh" }) })
            .then(async (r) => { const rr = r.body.getReader(); await rr.read(); const at = performance.now() - t0; let n = 0; for (;;) { const y = await rr.read(); if (y.done) break; n += y.value.byteLength; } return { at, ttsMs: performance.now() - tv, ok: r.status === 200 }; });
        }
      }
      if (ev === "result") done = performance.now() - t0;
    }
  }
  const voice = voiceReq ? await voiceReq : null;
  return { firstText, voiceAt: voice?.at, done: done || performance.now() - t0, bytesOut: body.length, bytesIn, translation };
}

const rows = [];
for (const [dirName, set, direction, voice] of [["เรา→เพื่อน (พูดออกเสียง)", ME, "me_to_partner", true], ["เพื่อน→เรา (อ่านบนจอ)", PARTNER, "partner_to_me", false]]) {
  console.log(`\n== ${dirName} ==`);
  for (const [len, text] of Object.entries(set)) {
    // ข้อความยาวมาก: แอปตัดเป็นท่อนแล้วส่งพร้อมกัน — วัดจากท่อนแรก (ที่ผู้ใช้เห็น/ได้ยินก่อน)
    const parts = chunkForSend(text);
    const t0 = performance.now();
    const all = await Promise.all(parts.map((p, i) => fastOnce(p, direction, voice && i === 0)));
    const first = all[0];
    const r = {
      dir: dirName, len, chars: text.length, parts: parts.length,
      firstText: Math.round(first.firstText), voiceAt: first.voiceAt ? Math.round(first.voiceAt) : null,
      done: Math.round(Math.max(...all.map((a) => a.done))), kbOut: all.reduce((s, a) => s + a.bytesOut, 0) / 1024, kbIn: all.reduce((s, a) => s + a.bytesIn, 0) / 1024,
    };
    rows.push(r);
    console.log(`${len.padEnd(6)} ${String(r.chars).padStart(4)} ตัว ${r.parts} ท่อน | ตัวแรกขึ้นจอ ${String(r.firstText).padStart(5)}ms | ${voice ? `เสียงแรก ${String(r.voiceAt).padStart(5)}ms | ` : ""}ครบ ${String(r.done).padStart(5)}ms | เน็ต ส่ง ${r.kbOut.toFixed(1)}KB รับ ${r.kbIn.toFixed(1)}KB | ${first.translation.slice(0, 40)}…`);
    await new Promise((s) => setTimeout(s, 400));
  }
}
const me = rows.filter((r) => r.voiceAt);
console.log(`\nสรุป: เสียงแรก p50=${Math.round(pct(me.map((r) => r.voiceAt), 50))}ms สูงสุด=${Math.max(...me.map((r) => r.voiceAt))}ms | ตัวแรกขึ้นจอ p50=${Math.round(pct(rows.map((r) => r.firstText), 50))}ms สูงสุด=${Math.max(...rows.map((r) => r.firstText))}ms`);
