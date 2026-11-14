// ชุดทดสอบความแม่น 50 เคส: คำแสลง / มุก / แซว / ประชด / สำนวน / ภาษาอัตโนมัติ / แพทย์ / ช่าง / ข้อความยาว
// ตรวจอัตโนมัติ: ภาษาถูก, ป้ายน้ำเสียงอยู่ในกลุ่มที่ยอมรับ, มีคำสำคัญในคำแปล/คำอธิบาย, ไม่สลับบทบาท
// ใช้: (เปิด npm run dev:api) แล้ว node tools/cases.mjs [base] [concurrency=2]
import { readFileSync } from "node:fs";
import { loadDevVars } from "../worker/scripts/devvars.mjs";
import { Glossary, toHints } from "../app/js/core/glossary.js";

const env = loadDevVars();
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const CONC = Number(process.argv[3] || 2);
const H = { "Content-Type": "application/json", "X-App-Token": env.APP_TOKEN };
const gloss = new Glossary().load(["zh", "en", "ja", "ko", "th"].flatMap((l) => JSON.parse(readFileSync(new URL(`../app/data/glossary/${l}.json`, import.meta.url), "utf8"))));
const THAI = /[฀-๿]/;
const P = "partner_to_me", M = "me_to_partner";
const hist = (me, tr) => [{ who: "me", text: me, translation: tr }];

/** @type {{id:string, text:string, dir:string, lang:string, domain?:string, history?:any[], tones?:string[], any?:string[], none?:string[], note?:boolean, replyLatin?:boolean}[]} */
export const CASES = [
  // ── จีน: คำแสลง/วัยรุ่น
  { id: "zh-666", text: "你这操作666啊", dir: P, lang: "zh", tones: ["compliment", "slang", "joke", "tease"], any: ["เก่ง", "เทพ", "เจ๋ง"] },
  { id: "zh-躺平", text: "我直接躺平了", dir: P, lang: "zh", any: ["ไม่สู้", "ปล่อย", "นอน", "ยอม", "พัก"] },
  { id: "zh-绝绝子", text: "绝绝子", dir: P, lang: "zh", any: ["สุดยอด", "เริ่ด", "ปัง", "เจ๋ง", "ดีมาก", "ดีสุด"] },
  { id: "zh-别卷了", text: "别卷了", dir: P, lang: "zh", any: ["แข่ง", "ขยัน", "พอ"] },
  { id: "zh-yyds", text: "这家奶茶yyds", dir: P, lang: "zh", any: ["ที่สุด", "เทพ", "ตลอดกาล", "สุดยอด", "อร่อย"] },
  { id: "zh-凡尔赛", text: "他又在凡尔赛了", dir: P, lang: "zh", any: ["อวด", "ถ่อม", "ขิง", "โม้"] },
  { id: "zh-emo", text: "我今天emo了", dir: P, lang: "zh", any: ["เศร้า", "ดาวน์", "จิตตก", "เซ็ง", "หดหู่", "อารมณ์"] },
  { id: "zh-柠檬精", text: "你真是个柠檬精", dir: P, lang: "zh", any: ["อิจฉา"] },
  { id: "zh-吃瓜", text: "我就是个吃瓜群众", dir: P, lang: "zh", any: ["ดู", "มุง", "เผือก", "นั่ง"] },
  { id: "zh-绝了", text: "这家店的菜真的绝了", dir: P, lang: "zh", any: ["อร่อย", "สุดยอด", "เด็ด", "เริ่ด"] },
  // ── จีน: มุก/แซว/ประชด/หัวเราะ
  { id: "zh-笑死", text: "哈哈哈笑死我了", dir: P, lang: "zh", tones: ["joke", "tease"], any: ["ขำ", "ฮา", "ตาย", "ตลก"] },
  { id: "zh-菜", text: "哈哈你也太菜了吧", dir: P, lang: "zh", tones: ["tease", "joke"], any: ["อ่อน", "ไม่เก่ง", "กาก", "กระจอก", "ห่วย", "อ่อนหัด"] },
  { id: "zh-真行-ประชด", text: "你可真行啊", dir: P, lang: "zh", history: hist("ขอโทษ ฉันทำแก้วของเธอตกแตก", "对不起，我把你的杯子摔碎了"), tones: ["sarcasm", "tease", "complaint"], any: ["ประชด", "แซว", "ไม่ได้ชม", "ตำหนิ", "เก่ง"] },
  { id: "zh-呵呵", text: "呵呵", dir: P, lang: "zh", note: true },
  { id: "zh-别闹", text: "别闹了，快点干活", dir: P, lang: "zh", any: ["เล่น", "ล้อ", "อย่า", "ทำงาน"] },
  { id: "zh-有毛病", text: "你是不是有毛病啊", dir: P, lang: "zh", tones: ["rude", "complaint", "tease", "joke", "sarcasm"] },
  // ── อังกฤษ
  { id: "en-cake", text: "That's a piece of cake", dir: P, lang: "en", tones: ["idiom", "slang", "neutral", "joke"], any: ["ง่าย"] },
  { id: "en-nocap", text: "No cap, this is the best pizza ever", dir: P, lang: "en", any: ["ไม่โม้", "จริง", "ไม่ได้โกหก", "สาบาน"] },
  { id: "en-ohgreat", text: "Oh great, another meeting.", dir: P, lang: "en", tones: ["sarcasm", "complaint"] },
  { id: "en-noob", text: "lol you're such a noob", dir: P, lang: "en", tones: ["tease", "joke"], any: ["มือใหม่", "อ่อน", "ไม่เก่ง", "หัดใหม่", "กระจอก"] },
  { id: "en-breakaleg", text: "Break a leg tonight!", dir: P, lang: "en", any: ["โชคดี"], none: ["ขาหัก"] },
  { id: "en-dead", text: "I'm dead 💀 that's hilarious", dir: P, lang: "en", tones: ["joke", "tease"], any: ["ขำ", "ฮา", "ตลก"] },
  { id: "en-armleg", text: "It costs an arm and a leg", dir: P, lang: "en", any: ["แพง"] },
  { id: "en-jk", text: "Just kidding, relax!", dir: P, lang: "en", tones: ["joke", "tease"], any: ["ล้อ", "พูดเล่น", "แกล้ง"] },
  // ── ญี่ปุ่น
  { id: "ja-yabai", text: "マジでヤバい", dir: P, lang: "ja", note: true },
  { id: "ja-草", text: "それは草", dir: P, lang: "ja", tones: ["joke", "tease", "slang"], any: ["ขำ", "ตลก", "555", "ฮา"] },
  { id: "ja-大丈夫", text: "大丈夫です", dir: P, lang: "ja", history: hist("กินเพิ่มอีกไหมคะ", "もっと食べますか？"), any: ["ปฏิเสธ", "ไม่เอา", "ไม่ต้อง", "พอแล้ว", "ไม่เป็นไร"] },
  { id: "ja-ウケる", text: "めっちゃウケる", dir: P, lang: "ja", tones: ["joke", "tease", "slang"], any: ["ขำ", "ตลก", "ฮา"] },
  { id: "ja-さすが", text: "さすがですね", dir: P, lang: "ja", history: hist("ฉันทำพังอีกแล้ว", "また壊しちゃった"), tones: ["sarcasm", "tease"], any: ["ประชด", "แซว"] },
  // ── เกาหลี
  { id: "ko-대박", text: "대박!", dir: P, lang: "ko", any: ["สุดยอด", "ว้าว", "เจ๋ง", "เยี่ยม"] },
  { id: "ko-ㅋㅋ", text: "ㅋㅋㅋ 진짜 웃겨", dir: P, lang: "ko", tones: ["joke", "tease"], any: ["ขำ", "ตลก", "ฮา"] },
  { id: "ko-밥", text: "밥 먹었어?", dir: P, lang: "ko", any: ["ทักทาย", "กินข้าว"] },
  { id: "ko-잘한다", text: "잘~한다", dir: P, lang: "ko", history: hist("ขอโทษ ทำของตกแตกอีกแล้ว", "미안, 또 깨뜨렸어"), tones: ["sarcasm", "tease", "complaint"] },
  { id: "ko-킹받네", text: "아 진짜 킹받네", dir: P, lang: "ko", any: ["หงุดหงิด", "โมโห", "หัวร้อน", "เซ็ง", "รำคาญ", "โกรธ"] },
  // ── เรา → เพื่อน (คำวัยรุ่นไทย/พูดไม่เรียบ/ไม่สลับบทบาท)
  { id: "th-จึ้ง", text: "อันนี้ จึ้งมาก ชอบ", dir: M, lang: "zh", any: ["太", "超", "好", "喜欢", "绝"] },
  { id: "th-แกง", text: "โดนแกงอะ", dir: M, lang: "zh", note: false, any: ["骗", "坑", "整", "套路", "耍"] },
  { id: "th-555", text: "555 ตลกมาก", dir: M, lang: "zh", any: ["哈", "好笑", "搞笑"] },
  { id: "th-ห้องน้ำ", text: "เอ่อ ห้องน้ำ อยู่ไหน อะครับ", dir: M, lang: "zh", any: ["洗手间", "厕所", "卫生间"] },
  { id: "en-discount", text: "Can you give me a discount? I am a student", dir: M, lang: "zh", any: ["我是学生", "我是學生"], none: ["你是学生", "你是不是学生", "给你优惠"] },
  { id: "th-ลดราคา", text: "ขอลดหน่อยได้ไหม แพงไป", dir: M, lang: "zh", any: ["便宜", "优惠", "打折", "贵"] },
  { id: "th-ช่วยด้วย", text: "ช่วยด้วย มีคนล้ม", dir: M, lang: "zh", any: ["救命", "帮", "摔", "倒"] },
  // ── แพทย์
  { id: "med-青霉素", text: "你对青霉素过敏吗？", dir: P, lang: "zh", domain: "medical", any: ["เพนิซิลลิน", "เพนนิซิลลิน"] },
  { id: "med-ท้องเสีย", text: "ปวดท้อง ท้องเสีย ตั้งแต่เมื่อคืน", dir: M, lang: "zh", domain: "medical", any: ["拉肚子", "腹泻"], none: ["一整天"] },
  { id: "med-แพ้ถั่ว", text: "ฉันแพ้ถั่วลิสง", dir: M, lang: "zh", domain: "medical", any: ["过敏"] },
  // ── ภาษาอัตโนมัติ (ภาษาที่เลือกเป็นอย่างหนึ่ง แต่คนพูดอีกภาษา)
  { id: "auto-en-in-zh", text: "Where are you from? Is this your first time here?", dir: P, lang: "zh", any: ["มาจาก", "ครั้งแรก"], replyLatin: true },
  { id: "auto-ja-in-zh", text: "日本から来ました。よろしくお願いします", dir: P, lang: "zh", any: ["ญี่ปุ่น"] },
  { id: "auto-zh-in-en", text: "这个多少钱？", dir: P, lang: "en", any: ["เท่าไร", "เท่าไหร่", "ราคา"] },
  // ── ช่าง/ข้อความยาว
  { id: "mech-刹车片", text: "你的刹车片要换了", dir: P, lang: "zh", any: ["ผ้าเบรก"] },
  { id: "mech-机油", text: "机油该换了，已经很黑了", dir: P, lang: "zh", any: ["น้ำมันเครื่อง"] },
  // ── ตัวเลข/เงิน (ห้ามเปลี่ยนสกุลเงิน)
  { id: "money-块", text: "你的车刹车片要换了，大概八百块。", dir: P, lang: "zh", any: ["หยวน"], none: ["บาท"] },
  { id: "money-円", text: "全部で3500円です", dir: P, lang: "ja", any: ["เยน", "3500", "3,500", "สามพันห้า"], none: ["บาท"] },
  { id: "money-원", text: "이거 만 오천 원이에요", dir: P, lang: "ko", any: ["วอน"], none: ["บาท"] },
  { id: "money-me", text: "ราคา 800 หยวนแพงไป ขอ 600 ได้ไหม", dir: M, lang: "zh", any: ["800", "八百"], none: ["泰铢"] },
  { id: "mix-zh-en", text: "这个 bearing 坏了，要换 new one", dir: P, lang: "zh", any: ["ลูกปืน", "แบริ่ง", "เปลี่ยน"] },
  { id: "mix-en-zh", text: "The 发动机 is too hot, 要等一下", dir: P, lang: "zh", any: ["เครื่องยนต์", "ร้อน", "รอ"] },
  { id: "long-zh", text: "你这个车的问题不小啊。刹车片已经磨没了，刹车盘也有点划伤。我建议你今天就把刹车片换了，大概八百块钱，两个小时左右能弄好。", dir: P, lang: "zh", any: ["ผ้าเบรก", "เบรก"], none: ["ผ้าใบ"] },
];

async function run(c) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/translate/fast`, {
    method: "POST", headers: H,
    body: JSON.stringify({ text: c.text, direction: c.dir, target_lang: c.lang, domain: c.domain ?? "general", history: c.history ?? [], request_id: crypto.randomUUID(),
      glossary: toHints(gloss.find(c.text, { domain: c.domain ?? "general" })) }),
  });
  const txt = await res.text();
  const ev = txt.split("\n\n").filter((b) => b.startsWith("event:")).map((b) => ({ e: /event: (\w+)/.exec(b)[1], d: JSON.parse(/data: (.*)/.exec(b)[1]) }));
  const r = ev.find((x) => x.e === "result")?.d;
  const ms = Math.round(performance.now() - t0);
  const issues = [];
  if (!r) return { c, ok: false, ms, issues: ["ไม่ได้ผล: " + (ev.find((x) => x.e === "error")?.d.message_th ?? "?")], r };
  const hay = `${r.translation} ${r.note_th} ${r.back_translation_th} ${(r.terms ?? []).map((t) => t.meaning_th).join(" ")}`;
  if (c.dir === P && !THAI.test(r.translation)) issues.push("คำแปลไม่ใช่ไทย");
  if (c.dir === M && THAI.test(r.translation)) issues.push("คำแปลยังเป็นไทย");
  if (r.note_th && !THAI.test(r.note_th)) issues.push("คำอธิบายไม่ใช่ไทย");
  if (c.tones && !c.tones.includes(r.tone)) issues.push(`ป้าย ${r.tone} (ควร ${c.tones.join("/")})`);
  if (c.any && !c.any.some((k) => hay.includes(k))) issues.push(`ไม่มีคำสำคัญ (${c.any.slice(0, 4).join("/")})`);
  // คำต้องห้ามตรวจเฉพาะ "คำแปล" (คำอธิบายพูดถึงได้ เช่น "ไม่ได้แปลว่าขาหัก")
  if (c.none && c.none.some((k) => r.translation.includes(k))) issues.push(`มีคำผิด (${c.none.filter((k) => r.translation.includes(k)).join("/")})`);
  if (c.note && !r.note_th) issues.push("ไม่มีคำอธิบาย");
  if (c.replyLatin && !(r.replies ?? []).every((x) => /[A-Za-z]/.test(x.target))) issues.push("ตอบกลับไม่ใช่ภาษาที่เขาพูด");
  return { c, ok: !issues.length, ms, issues, r };
}

const out = [];
const queue = [...CASES];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const x = await run(c);
    out.push(x);
    console.log(`${x.ok ? "✅" : "❌"} ${c.id.padEnd(16)} ${String(x.ms).padStart(5)}ms [${x.r?.tone ?? "-"}] ${x.r?.translation?.slice(0, 38) ?? ""}${x.r?.note_th ? ` 💡${x.r.note_th.slice(0, 40)}` : ""}${x.ok ? "" : `  ← ${x.issues.join(", ")}`}`);
  }
}));
const pass = out.filter((x) => x.ok).length;
console.log(`\nผ่าน ${pass}/${out.length} (${Math.round((pass / out.length) * 100)}%)`);
process.exit(pass === out.length ? 0 : 1);
