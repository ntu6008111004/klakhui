// วัด latency ThaiLLM จริง: ปิด thinking vs เปิด thinking (เรียก upstream ตรง)
// ใช้: npm run thinking-bench -- [จำนวนรอบ=5]
import { loadDevVars, pct } from "./devvars.mjs";

const env = loadDevVars();
const URL_ = env.THAILLM_URL || "https://thaillm.or.th/api/v1/chat/completions";
const MODEL = env.THAILLM_MODEL || "qwen3.6-35b-a3b";
if (!env.THAILLM_API_KEY) {
  console.error("ไม่พบ THAILLM_API_KEY — ใส่ไว้ใน worker/.dev.vars");
  process.exit(1);
}
const N = Number(process.argv[2] || 5);
const msgs = [
  { role: "system", content: 'Translate Chinese to Thai. Return ONLY JSON: {"translation":"...","tone":"..."}' },
  { role: "user", content: "你这操作666啊" },
];

async function once(kwargs) {
  const body = { model: MODEL, messages: msgs, temperature: 0.3, max_tokens: 500, stream: false };
  if (kwargs !== undefined) body.chat_template_kwargs = { enable_thinking: kwargs };
  const t0 = performance.now();
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.THAILLM_API_KEY}` },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  const msg = j.choices?.[0]?.message ?? {};
  return {
    status: res.status, ms,
    hasThinkTag: /<think>/i.test(msg.content || ""),
    reasoningLen: (msg.reasoning_content || "").length,
    content: (msg.content || text).slice(0, 120).replace(/\s+/g, " "),
    usage: j.usage,
  };
}

for (const [label, kw] of [["ปิด thinking (enable_thinking:false)", false], ["เปิด thinking (enable_thinking:true)", true], ["ไม่ส่ง field (ค่าเริ่มต้น)", undefined]]) {
  const times = [];
  console.log(`\n=== ${label} ===`);
  for (let i = 0; i < N; i++) {
    try {
      const r = await once(kw);
      times.push(r.ms);
      console.log(`#${i + 1} status=${r.status} ${r.ms}ms think_tag=${r.hasThinkTag} reasoning_chars=${r.reasoningLen} tokens=${r.usage?.completion_tokens ?? "?"} | ${r.content}`);
    } catch (e) {
      console.log(`#${i + 1} error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // อยู่ใต้ 5 req/วิ
  }
  if (times.length) console.log(`p50=${pct(times, 50)}ms p90=${pct(times, 90)}ms`);
}
