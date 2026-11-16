// ตรรกะภาพที่ทดสอบได้ (ไม่แตะ DOM): ขนาดย่อ, ตรวจภาพนิ่ง/ภาพเปลี่ยน, จับคู่บรรทัด, เดาทิศทางแปล

/** ขนาดใหม่ที่ด้านยาวไม่เกิน max (ไม่ขยายรูปเล็ก) */
export function fitSize(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** ความต่างเฉลี่ยของภาพขาวดำย่อ 2 ภาพ (0..255) — ใช้ดูว่ากล้องนิ่งไหม / ภาพเปลี่ยนไหม */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** RGBA → ค่าความสว่าง (Uint8Array) */
export function toGray(rgba) {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return g;
}

/**
 * ตัดสินใจว่ากล้องสดควรส่งภาพไปอ่านไหม:
 * นิ่งแล้ว (ต่างจากเฟรมก่อน < still) ติดกัน ≥ stableFrames และ ภาพต่างจากที่อ่านล่าสุด > changed
 * และห่างจากครั้งก่อน ≥ minGapMs (โควตา OCR 20/นาที) และไม่มีงานค้าง
 */
export class LiveGate {
  constructor(o = {}) {
    this.still = o.still ?? 6;
    this.changed = o.changed ?? 14;
    this.stableFrames = o.stableFrames ?? 2;
    this.minGapMs = o.minGapMs ?? 4000;
    this.prev = null;
    this.lastRead = null;
    this.stable = 0;
    this.lastAt = -Infinity;
    this.busy = false;
  }
  /** @returns {"read"|"moving"|"same"|"wait"|"busy"} */
  feed(gray, now) {
    const motion = frameDiff(gray, this.prev);
    this.prev = gray;
    if (motion > this.still) { this.stable = 0; return "moving"; }
    this.stable++;
    if (this.stable < this.stableFrames) return "moving";
    if (this.busy) return "busy";
    if (this.lastRead && frameDiff(gray, this.lastRead) <= this.changed) return "same";
    if (now - this.lastAt < this.minGapMs) return "wait";
    this.lastRead = gray;
    this.lastAt = now;
    this.busy = true;
    return "read";
  }
  done() { this.busy = false; }
  /** บังคับอ่านรอบหน้า (เช่น ผู้ใช้กด "อ่านใหม่") */
  reset() { this.lastRead = null; this.lastAt = -Infinity; }
}

/** จับคู่บรรทัดต้นฉบับ ↔ คำแปล (จำนวนไม่ตรง → บรรทัดที่เหลือรวมไว้ท้าย ไม่ทิ้ง) */
export function pairLines(src, translation) {
  const tr = String(translation ?? "").split(/\r?\n/).map((s) => s.trim()).filter((s, i, a) => s || i < a.length - 1);
  const rows = src.map((s, i) => ({ src: s, tr: tr[i] ?? "" }));
  if (tr.length > src.length && rows.length) rows[rows.length - 1].tr = [rows[rows.length - 1].tr, ...tr.slice(src.length)].filter(Boolean).join(" ");
  return rows;
}

/** ข้อความในภาพเป็นไทยเป็นหลัก → แปลไปภาษาเพื่อน / ไม่งั้น → แปลเป็นไทย */
export function imageDirection(text) {
  const s = text.replace(/[\s\p{P}\p{S}\d]+/gu, "");
  if (!s) return "partner_to_me";
  const th = (s.match(/[฀-๿]/g) ?? []).length;
  return th / s.length > 0.5 ? "me_to_partner" : "partner_to_me";
}
