// วิเคราะห์ผล bench-mt: รายการที่ระบบเรา (30b) แปลผิด/คลาด → ใช้สรุปแพทเทิร์นเพิ่มเข้าคลังคำ
// ใช้: node tools/bench-analyze.mjs [ระบบ=30b] > tools/bench-failures.md
import { readFileSync } from "node:fs";

const sys = process.argv[2] || "30b";
const rows = Object.values(JSON.parse(readFileSync(new URL("./bench-results.json", import.meta.url), "utf8")));
const bad = rows.filter((r) => r.sys[sys] && r.sys[sys].score >= 0 && r.sys[sys].score < 2);
const byCat = {};
for (const r of bad) (byCat[r.cat] ??= []).push(r);

console.log(`# จุดที่ ${sys} แปลไม่ตรง (${bad.length}/${rows.length})\n`);
for (const [cat, list] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`## ${cat} (${list.length})\n`);
  for (const r of list) {
    const s = r.sys[sys];
    const others = Object.entries(r.sys).filter(([k]) => k !== sys).map(([k, v]) => `${k}(${v.score}): ${v.out}`).join(" | ");
    console.log(`- [${s.score}] \`${r.id}\` ${r.text}\n  - อ้างอิง: ${r.ref_th}\n  - ${sys}: ${s.out}\n  - ปัญหา: ${s.issue}\n  - เทียบ: ${others}`);
  }
  console.log("");
}
