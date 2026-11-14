// หัวใจโหมด "รับฟังตลอด": Segmenter (ตัดท่อน) + Coalescer (คิวรวมท่อน) + EchoFilter (กันแปลเสียงตัวเอง)
import { isFiller, measure, normalize, similarity } from "./text.js";

const CUT_AT = /[，,。！？!?、；;．.\s]/g;

/**
 * ตัดท่อนจาก STT ต่อเนื่อง — ส่งเมื่อ: isFinal | interim นิ่ง silenceMs | ยาวเกิน (40 ตัว CJK / 20 คำ en)
 * กันท่อนซ้ำ + กรองคำว่าง/คำอุทาน
 */
export class Segmenter {
  /**
   * @param {{lang:string, onSegment:(text:string)=>void, silenceMs?:number, maxChars?:number, maxWords?:number,
   *          setTimer?:(fn:Function, ms:number)=>any, clearTimer?:(t:any)=>void}} o
   */
  constructor(o) {
    this.lang = o.lang;
    this.onSegment = o.onSegment;
    this.silenceMs = o.silenceMs ?? 700;
    this.maxChars = o.maxChars ?? 40;
    this.maxWords = o.maxWords ?? 20;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t));
    this.sentLen = 0; // ส่วนของ utterance ปัจจุบันที่ส่งไปแล้ว
    this.utter = "";
    this.timer = null;
    /** @type {string[]} */ this.recent = [];
    this.paused = false;
  }

  setSilence(ms) { this.silenceMs = ms; }

  /** @param {string} text ข้อความ interim ทั้งก้อนของ utterance ปัจจุบัน */
  interim(text) {
    if (text.length < this.sentLen || !text.startsWith(this.utter.slice(0, this.sentLen))) this.sentLen = Math.min(this.sentLen, text.length);
    this.utter = text;
    this.armTimer();
    let rest = text.slice(this.sentLen);
    const limit = this.lang === "en" ? this.maxWords : this.maxChars;
    while (measure(rest, this.lang) > limit) {
      const cut = this.cutPoint(rest, limit);
      this.emit(rest.slice(0, cut));
      this.sentLen += cut;
      rest = text.slice(this.sentLen);
    }
  }

  /** @param {string} text ผล final ของ utterance */
  final(text) {
    this.clearTimer(this.timer);
    this.timer = null;
    const rest = text.length >= this.sentLen ? text.slice(this.sentLen) : text;
    this.emit(rest);
    this.sentLen = 0;
    this.utter = "";
  }

  /** เงียบครบเวลา → ส่งส่วนที่ค้าง (ไม่ปิด utterance เพราะ STT อาจยังต่อท้ายได้) */
  flush() {
    this.timer = null;
    const rest = this.utter.slice(this.sentLen);
    if (!rest.trim()) return;
    this.emit(rest);
    this.sentLen = this.utter.length;
  }

  reset() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.sentLen = 0;
    this.utter = "";
  }

  armTimer() {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.flush(), this.silenceMs);
  }

  cutPoint(rest, limit) {
    if (this.lang === "en") {
      const words = [...rest.matchAll(/\S+\s*/g)];
      let end = 0, punct = 0;
      for (let i = 0; i < Math.min(limit, words.length); i++) {
        end = (words[i].index ?? 0) + words[i][0].length;
        if (/[,.!?;:]\s*$/.test(words[i][0])) punct = end;
      }
      return punct > end * 0.4 ? punct : end;
    }
    // CJK: ตัดที่วรรคตอนล่าสุดภายใน limit ตัวอักษร (นับไม่รวมช่องว่าง)
    let count = 0, idx = 0, lastPunct = -1;
    for (; idx < rest.length && count < limit; idx++) {
      if (!/\s/.test(rest[idx])) count++;
      CUT_AT.lastIndex = 0;
      if (CUT_AT.test(rest[idx])) lastPunct = idx + 1;
    }
    return lastPunct > idx * 0.4 ? lastPunct : idx;
  }

  emit(raw) {
    let text = raw.trim();
    if (!text || isFiller(text)) return;
    const n = normalize(text);
    // ตัดส่วนที่ซ้ำกับท่อนก่อนหน้า (STT ชอบส่งข้อความซ้ำหัวท่อน)
    const prev = this.recent[this.recent.length - 1];
    if (prev && n.startsWith(prev) && n.length > prev.length) {
      // หาตำแหน่งในข้อความดิบที่ส่วนซ้ำ (หลัง normalize) จบลง แล้วตัดทิ้ง
      let count = 0, i = 0;
      for (; i < text.length && count < prev.length; i++) if (normalize(text[i])) count++;
      text = text.slice(i).trim();
    }
    const nn = normalize(text);
    if (!nn || isFiller(text) || this.recent.includes(nn)) return;
    this.recent.push(nn);
    if (this.recent.length > 20) this.recent.shift();
    this.onSegment(text);
  }
}

/**
 * คิวงานแปล: วิ่งได้ 1 + รอได้ 1; ท่อนใหม่ระหว่างรอ → ต่อท้ายงานที่รอ (ไม่ยิงเพิ่ม)
 * งานที่รอยาวเกิน maxChars → ส่งทันทีไม่รอ
 */
export class Coalescer {
  /**
   * @param {{run:(job:{id:number, text:string})=>Promise<unknown>, maxChars?:number, sep?:string}} o
   */
  constructor(o) {
    this.run = o.run;
    this.maxChars = o.maxChars ?? 300;
    this.sep = o.sep ?? " ";
    this.running = 0;
    /** @type {{id:number, text:string} | null} */ this.pending = null;
    this.seq = 0;
    /** @type {((job:{id:number,text:string})=>void) | null} */ this.onQueued = null;
  }

  /** @param {string} text */
  push(text) {
    if (this.running === 0) return this.start({ id: ++this.seq, text });
    if (this.pending) {
      this.pending.text += this.sep + text;
      this.onQueued?.(this.pending);
    } else {
      this.pending = { id: ++this.seq, text };
      this.onQueued?.(this.pending);
    }
    if (this.pending.text.length > this.maxChars) {
      const job = this.pending;
      this.pending = null;
      this.start(job);
    }
  }

  start(job) {
    this.running++;
    let p;
    try { p = Promise.resolve(this.run(job)); } catch (e) { p = Promise.reject(e); }
    p.catch(() => {})
      .finally(() => {
        this.running--;
        if (this.pending && this.running === 0) {
          const next = this.pending;
          this.pending = null;
          this.start(next);
        }
      });
  }

  get busy() { return this.running > 0 || !!this.pending; }
}

/** กันเสียงสะท้อน: ท่อนที่ STT ได้ยินซึ่งคล้ายสิ่งที่แอปเพิ่งพูด (> threshold) → ทิ้ง */
export class EchoFilter {
  constructor(o = {}) {
    this.threshold = o.threshold ?? 0.6;
    this.holdMs = o.holdMs ?? 8000;
    this.now = o.now ?? (() => Date.now());
    /** @type {{text:string, until:number}[]} */ this.spoken = [];
  }
  /** เรียกตอนแอปเริ่มพูดข้อความ */
  noteSpoken(text) {
    this.spoken.push({ text, until: this.now() + this.holdMs + Math.min(20_000, text.length * 120) });
    if (this.spoken.length > 12) this.spoken.shift();
  }
  isEcho(heard) {
    const t = this.now();
    this.spoken = this.spoken.filter((s) => s.until > t);
    return this.spoken.some((s) => similarity(s.text, heard) > this.threshold || (normalize(heard).length >= 4 && normalize(s.text).includes(normalize(heard))));
  }
}
