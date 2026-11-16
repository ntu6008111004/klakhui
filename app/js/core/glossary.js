// คลังคำฝั่ง client: index ตามตัวอักษรแรก → longest-match → domain ปัจจุบันก่อน → ≤ 15 รายการ
// เป้า: ค้น 10,000 รายการ < 5ms บนมือถือ

/** @typedef {{term:string, lang:string, meaning_th:string, tag?:string, domain?:string, aliases?:string[], user?:boolean}} Entry */

const isWordChar = (c) => !!c && /[a-z0-9']/i.test(c);

export class Glossary {
  constructor() {
    /** @type {Map<string, {key:string, entry:Entry}[]>} */
    this.index = new Map();
    this.size = 0;
  }

  /** @param {Entry[]} entries — รายการทีหลังทับรายการก่อน (คำของผู้ใช้ควรใส่ทีหลัง) */
  load(entries) {
    for (const e of entries) {
      if (!e?.term || !e?.meaning_th) continue;
      for (const k of [e.term, ...(e.aliases ?? [])]) this.addKey(k, e);
      this.size++;
    }
    for (const list of this.index.values()) list.sort((a, b) => b.key.length - a.key.length);
    return this;
  }

  addKey(raw, entry) {
    const key = raw.trim().toLowerCase();
    if (!key) return;
    const first = key[0];
    let list = this.index.get(first);
    if (!list) this.index.set(first, (list = []));
    const dup = list.findIndex((x) => x.key === key && x.entry.lang === entry.lang);
    if (dup !== -1) list[dup] = { key, entry };
    else list.push({ key, entry });
  }

  /**
   * @param {string} text
   * @param {{lang?:string, domain?:string, max?:number}} [o]
   * @returns {Entry[]}
   */
  find(text, o = {}) {
    const max = o.max ?? 15;
    const src = text.toLowerCase();
    /** @type {Map<string, {entry:Entry, len:number, pos:number}>} */
    const hits = new Map();
    for (let i = 0; i < src.length; ) {
      const list = this.index.get(src[i]);
      let matched = 0;
      if (list) {
        for (const { key, entry } of list) {
          if (o.lang && entry.lang !== o.lang) continue;
          if (!src.startsWith(key, i)) continue;
          // คำแสลงอักษรจีนตัวเดียว (เช่น 菜 = อ่อน) ห้ามจับกลางคำอื่น (菜单 = เมนู) — ยอมให้ตามด้วยคำลงท้าย (你太菜了)
          if (key.length === 1 && /[一-鿿]/.test(key) && /slang|teen/.test(entry.tag ?? "") && /[一-鿿]/.test(src[i + 1] ?? "") && !"了啊吧呢吗嘛的哦呀啦".includes(src[i + 1])) continue;
          // ภาษาที่มีช่องว่าง (en) ต้องตรงขอบคำ
          if (/^[a-z0-9]/.test(key) && (isWordChar(src[i - 1]) || isWordChar(src[i + key.length]))) continue;
          if (!hits.has(entry.term)) hits.set(entry.term, { entry, len: key.length, pos: i });
          matched = key.length;
          break; // longest-match
        }
      }
      i += matched || 1;
    }
    const domain = o.domain ?? "general";
    return [...hits.values()]
      .sort((a, b) =>
        Number(b.entry.domain === domain) - Number(a.entry.domain === domain) ||
        Number(!!b.entry.user) - Number(!!a.entry.user) ||
        b.len - a.len ||
        a.pos - b.pos)
      .slice(0, max)
      .map((h) => h.entry);
  }
}

/** แปลงเป็นรูปแบบที่ worker รับ */
export const toHints = (entries) => entries.map((e) => ({ term: e.term, lang: e.lang, meaning_th: e.meaning_th, tag: e.tag }));
