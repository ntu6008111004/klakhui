// Central limiter shared across the whole app (every side/mode): ≤ 4 req/s, ≤ 180 req/min (headroom under ThaiLLM's 5/200)
// Adaptive: on 429 → halve the ceiling for 60s, then raise it back +1 every 10s

const MARGIN = 50;

export class RateLimiter {
  /**
   * @param {{perSec?:number, perMin?:number, now?:()=>number, setTimer?:(fn:Function,ms:number)=>any}} [o]
   */
  constructor(o = {}) {
    this.baseSec = o.perSec ?? 4;
    this.baseMin = o.perMin ?? 180;
    this.now = o.now ?? (() => Date.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    /** @type {number[]} */
    this.starts = [];
    /** @type {{fn:Function, resolve:Function, reject:Function}[]} */
    this.queue = [];
    /** @type {number|null} */ this.reducedAt = null;
    this.timer = null;
  }

  /** Current ceiling (accounting for 429 penalty + recovery) */
  caps(t = this.now()) {
    if (this.reducedAt === null) return { sec: this.baseSec, min: this.baseMin };
    const halfSec = Math.max(1, Math.floor(this.baseSec / 2));
    const elapsed = t - this.reducedAt;
    let sec = halfSec;
    if (elapsed >= 60_000) sec = Math.min(this.baseSec, halfSec + Math.floor((elapsed - 60_000) / 10_000) + 1);
    if (sec >= this.baseSec) { this.reducedAt = null; return { sec: this.baseSec, min: this.baseMin }; }
    return { sec, min: Math.max(1, Math.round((this.baseMin * sec) / this.baseSec)) };
  }

  on429() {
    this.reducedAt = this.now();
  }

  /** Reserve a slot to run fn — over the limit means it waits in the queue, never dropped */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }

  /** Time to wait (ms) until the next slot; 0 = run now */
  waitMs(t = this.now()) {
    this.starts = this.starts.filter((s) => t - s < 60_000 + MARGIN);
    const { sec, min } = this.caps(t);
    const lastSec = this.starts.filter((s) => t - s < 1000 + MARGIN);
    let wait = 0;
    // +MARGIN: timer มักยิงเร็วกว่ากำหนด ~1ms และเน็ตทำให้คำขอไปถึงเซิร์ฟเวอร์เบียดกัน → เผื่อไว้ไม่ให้เกินเพดานจริง
    if (lastSec.length >= sec) wait = Math.max(wait, lastSec[lastSec.length - sec] + 1000 + MARGIN - t);
    if (this.starts.length >= min) wait = Math.max(wait, this.starts[this.starts.length - min] + 60_000 + MARGIN - t);
    return Math.max(0, wait);
  }

  pump() {
    if (this.timer) return;
    while (this.queue.length) {
      const t = this.now();
      const w = this.waitMs(t);
      if (w > 0) {
        this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, w);
        return;
      }
      const job = this.queue.shift();
      this.starts.push(t);
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    }
  }

  get pending() { return this.queue.length; }
}
