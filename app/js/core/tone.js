// ป้ายน้ำเสียง — ภาษาคนไม่มั่นใจอ่านแล้วเข้าใจทันทีว่า "เขาพูดเล่นหรือจริงจัง"
export const TONES = {
  joke: { emoji: "😄", label: "พูดเล่น", hint: "เขาพูดขำๆ ไม่ได้จริงจัง หัวเราะตามได้" },
  tease: { emoji: "😏", label: "แซว", hint: "เขาแซวแบบสนิท ไม่ได้ว่าจริง ยิ้มรับได้" },
  sarcasm: { emoji: "🙃", label: "ประชด", hint: "พูดกลับด้าน ความหมายจริงตรงข้ามกับคำพูด" },
  idiom: { emoji: "📖", label: "สำนวน", hint: "อย่าแปลตรงตัว ดูความหมายด้านล่าง" },
  slang: { emoji: "🔥", label: "คำวัยรุ่น", hint: "ภาษาพูด/คำฮิต ดูความหมายด้านล่าง" },
  compliment: { emoji: "🥰", label: "ชม", hint: "เขาชมคุณอยู่ ขอบคุณได้เลย" },
  complaint: { emoji: "😤", label: "บ่น", hint: "เขากำลังไม่พอใจหรือบ่นอะไรบางอย่าง" },
  rude: { emoji: "⚠️", label: "หยาบ", hint: "คำแรง/หยาบ ไม่ควรพูดตาม" },
  urgent: { emoji: "🚨", label: "ด่วน", hint: "เรื่องสำคัญหรือเร่งด่วน" },
  polite: { emoji: "🙏", label: "สุภาพ", hint: "" },
  neutral: { emoji: "", label: "", hint: "" },
};

/** แสดงป้ายเฉพาะน้ำเสียงที่ "ควรรู้" */
export const showTone = (tone) => !!TONES[tone]?.label && tone !== "polite";
export const toneInfo = (tone) => TONES[tone] ?? TONES.neutral;
