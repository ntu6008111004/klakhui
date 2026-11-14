// ทดสอบ limit: ยิงคำขอจริง 30 ครั้งพร้อมกันผ่าน limiter ของแอป (4/วิ, 180/นาที) → ต้องไม่เกินเพดาน และไม่โดน 429
// ใช้: npm run dev:api (อีกหน้าต่าง) แล้ว node tools/limit-test.mjs [base] [จำนวน]
import { RateLimiter } from "../app/js/core/limiter.js";
import { loadDevVars } from "../worker/scripts/devvars.mjs";

const env = loadDevVars();
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const N = Number(process.argv[3] || 30);
const lim = new RateLimiter({ perSec: 4, perMin: 180 });
const starts = [];
const status = {};
const t0 = Date.now();
const texts = ["你好", "谢谢", "多少钱？", "厕所在哪里？", "太好了", "我不懂", "慢一点", "再说一遍"];

await Promise.all(Array.from({ length: N }, (_, i) => lim.schedule(async () => {
  starts.push(Date.now() - t0);
  const r = await fetch(`${BASE}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN },
    body: JSON.stringify({ text: texts[i % texts.length], direction: "partner_to_me", target_lang: "zh", domain: "general", history: [], glossary: [], request_id: `lim-${i}` }),
  }).catch(() => ({ status: "NET" }));
  status[r.status] = (status[r.status] ?? 0) + 1;
})));

const maxIn1s = Math.max(...starts.map((s) => starts.filter((x) => x >= s && x < s + 1000).length));
// วัดฝั่งเซิร์ฟเวอร์ด้วย: เวลาที่ fn เริ่มจริง (หลัง microtask)
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`ส่ง ${N} คำขอ ใช้เวลา ${total} วิ | สูงสุดต่อ 1 วิ = ${maxIn1s} (เพดาน 4) | สถานะ:`, status);
const ok = maxIn1s <= 4 && !status[429] && (status[200] ?? 0) === N;
console.log(ok ? "✅ ผ่าน: คุมอัตราได้ ไม่โดน 429 สำเร็จครบ" : "❌ ไม่ผ่าน");
process.exit(ok ? 0 : 1);
