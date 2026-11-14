// ชั้นเรียก API: ทุก network call ผ่าน limiter + retry + circuit breaker + timeout (หัวข้อ 8.1)
import { RateLimiter } from "./core/limiter.js";
import { ApiError, CircuitBreaker, fetchWithTimeout, withRetry, sleep } from "./core/retry.js";
import { chunkForSend } from "./core/text.js";
import { SseParser } from "./core/sse.js";

export const TIMEOUT = { translate: 10_000, tts: 8_000, health: 3_000 };

export class Api extends EventTarget {
  /** @param {{base:()=>string, token:()=>string}} o */
  constructor(o) {
    super();
    this.base = o.base;
    this.token = o.token;
    this.limiter = new RateLimiter({ perSec: 4, perMin: 180 });
    this.ttsLimiter = new RateLimiter({ perSec: 6, perMin: 300 });
    this.breaker = new CircuitBreaker();
    /** @type {Set<AbortController>} */ this.attempts = new Set();
    this.lastLatency = 0;
    this.streamFails = 0;
    this.streamOffUntil = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  headers() {
    return { "Content-Type": "application/json", "X-App-Token": this.token() };
  }

  /** fetch ที่ "เตะ" ได้ตอนเปลี่ยนเครือข่าย (ถือเป็น NETWORK → retry) */
  kickableFetch = (url, init) => {
    const ctrl = new AbortController();
    this.attempts.add(ctrl);
    const outer = init.signal;
    const onAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
      this.attempts.delete(ctrl);
      outer?.removeEventListener("abort", onAbort);
    });
  };

  /** เปลี่ยนเครือข่าย → ยกเลิก request ที่ค้างแล้วให้ retry ส่งใหม่ */
  kickInflight() {
    for (const c of this.attempts) c.abort();
  }

  /** POST JSON ผ่าน limiter + retry + breaker */
  async postJson(path, body, { timeout, signal, limiter = this.limiter, kind = "translate" } = {}) {
    return withRetry(
      async () => {
        if (this.breaker.isOpen()) {
          this.emit("circuit", { remainingMs: this.breaker.remainingMs() });
          await sleep(this.breaker.remainingMs(), signal);
        }
        if (!navigator.onLine) throw new ApiError("NETWORK");
        const t0 = performance.now();
        try {
          const res = await limiter.schedule(() =>
            fetchWithTimeout(`${this.base()}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, timeout, signal, this.kickableFetch),
          );
          this.breaker.success();
          this.lastLatency = performance.now() - t0;
          this.emit("latency", { ms: this.lastLatency, kind });
          return res;
        } catch (e) {
          if (e instanceof ApiError) {
            if (e.code === "RATE_LIMIT") limiter.on429();
            if (e.code === "UPSTREAM_DOWN" || e.code === "TIMEOUT" || e.code === "NETWORK") this.breaker.failure();
          }
          throw e;
        }
      },
      { signal, onRetry: (e, n, w) => this.emit("retry", { code: e.code, attempt: n, waitMs: w }) },
    );
  }

  /**
   * แปล (ยาวเกิน → ตัดตามประโยค ส่งทีละท่อน เรียงผลตาม index)
   * @returns {Promise<any>} ผลตาม contract + engine
   */
  async translate(req, { signal } = {}) {
    const srcLang = req.direction === "me_to_partner" ? "th" : req.target_lang;
    const parts = chunkForSend(req.text, srcLang);
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      const res = await this.postJson("/api/translate", { ...req, text: parts[i], request_id: `${req.request_id}#${i}` }, { timeout: TIMEOUT.translate, signal });
      results.push(await res.json());
    }
    if (results.length === 1) return results[0];
    const sep = srcLang === "th" && ["zh", "ja"].includes(req.target_lang) ? "" : " ";
    return {
      ...results[0],
      translation: results.map((r) => r.translation).join(req.direction === "partner_to_me" ? " " : sep),
      back_translation_th: results.map((r) => r.back_translation_th).join(" "),
      note_th: results.map((r) => r.note_th).filter(Boolean).join(" "),
      terms: results.flatMap((r) => r.terms ?? []),
      needs_confirm: results.some((r) => r.needs_confirm),
      tone: results.find((r) => !["neutral", "polite"].includes(r.tone))?.tone ?? results[0].tone,
      replies: results.at(-1)?.replies ?? [],
    };
  }

  /**
   * แปลแบบไวสุด: /api/translate/fast (SSE) — คำแปลมาก่อน (onPartial) แล้วรายละเอียดตามมา
   * ข้อความยาวหลายท่อน / เส้นทางเร็วใช้ไม่ได้ → fallback ไป translate() แบบเดิม (ผู้ใช้ไม่ค้าง)
   * @param {{signal?:AbortSignal, onPartial?:(p:{translation:string, engine?:string})=>void}} [o]
   */
  async translateFast(req, o = {}) {
    const srcLang = req.direction === "me_to_partner" ? "th" : req.target_lang;
    if (chunkForSend(req.text, srcLang).length > 1) return this.translate(req, { signal: o.signal });
    let partial = null;
    try {
      const res = await this.postJson("/api/translate/fast", req, { timeout: TIMEOUT.translate, signal: o.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const p = new SseParser();
      for (;;) {
        // body เงียบเกิน 12 วิ (ไม่มีแม้แต่ ping) → ถือว่าหลุด
        let idle;
        const r = await Promise.race([
          reader.read(),
          new Promise((_, rej) => { idle = setTimeout(() => rej(new ApiError("TIMEOUT")), 12_000); }),
        ]).finally(() => clearTimeout(idle));
        if (r.done) break;
        for (const ev of p.push(dec.decode(r.value, { stream: true }))) {
          if (ev.event === "partial") { partial = ev.data; o.onPartial?.(ev.data); }
          else if (ev.event === "result") { reader.cancel().catch(() => {}); return ev.data; }
          else if (ev.event === "error") throw new ApiError(ev.data.code || "UPSTREAM_DOWN", { message_th: ev.data.message_th, retryAfterMs: ev.data.retry_after_ms });
        }
      }
      if (partial) return { translation: partial.translation, engine: partial.engine, tone: "neutral", note_th: "", terms: [], replies: [], back_translation_th: "", needs_confirm: false };
      throw new ApiError("NETWORK");
    } catch (e) {
      if (o.signal?.aborted || (e instanceof ApiError && e.code === "ABORTED")) throw new ApiError("ABORTED");
      if (e instanceof ApiError && (e.code === "AUTH" || e.code === "BAD_INPUT" || e.code === "TOO_LARGE")) throw e;
      // ได้คำแปลแล้วแต่หลุดก่อนรายละเอียด → ใช้คำแปลที่มี ไม่ต้องขอใหม่
      if (partial) return { translation: partial.translation, engine: partial.engine, tone: "neutral", note_th: "", terms: [], replies: [], back_translation_th: "", needs_confirm: false };
      return this.translate(req, { signal: o.signal });
    }
  }

  get streamEnabled() { return Date.now() > this.streamOffUntil; }

  /**
   * โหมดรับฟังตลอด: SSE stream
   * ไม่มี byte/ping นาน 5 วิ หรือหลุด → throw (ผู้เรียก fallback ไป translate แบบไม่ stream)
   * @param {{onDelta:(t:string)=>void, onMeta:(m:any)=>void}} h
   */
  async stream(req, h, { signal } = {}) {
    if (!this.streamEnabled) throw new ApiError("UPSTREAM_DOWN", { message_th: "stream พักชั่วคราว" });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let idle;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), 5000); };
    try {
      const res = await this.limiter.schedule(() =>
        fetchWithTimeout(`${this.base()}/api/translate/stream`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) }, TIMEOUT.translate, ctrl.signal, this.kickableFetch),
      );
      arm();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const p = new SseParser();
      let done = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        arm();
        for (const ev of p.push(dec.decode(value, { stream: true }))) {
          if (ev.event === "delta") h.onDelta(ev.data.t);
          else if (ev.event === "meta") h.onMeta(ev.data);
          else if (ev.event === "done") done = ev.data;
          else if (ev.event === "error") throw new ApiError(ev.data.code || "UPSTREAM_DOWN", { message_th: ev.data.message_th, retryAfterMs: ev.data.retry_after_ms });
        }
      }
      if (!done) throw new ApiError("NETWORK");
      this.streamFails = 0;
      return done;
    } catch (e) {
      if (signal?.aborted) throw new ApiError("ABORTED");
      if (++this.streamFails >= 3) {
        this.streamOffUntil = Date.now() + 120_000; // ล้ม 3 ครั้งติด → ใช้แบบไม่ stream 2 นาที
        this.streamFails = 0;
        this.emit("streamoff", {});
      }
      throw e instanceof ApiError ? e : new ApiError("NETWORK");
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** TTS → Blob mp3 (ไม่นับโควตา ThaiLLM แต่มี limiter แยก ≤ 6/วิ) */
  async tts(body, { signal } = {}) {
    const res = await withRetry(
      () => this.ttsLimiter.schedule(() =>
        fetchWithTimeout(`${this.base()}/api/tts`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, TIMEOUT.tts, signal, this.kickableFetch)),
      { retries: 1, signal },
    );
    return res.blob();
  }

  async health() {
    try {
      const res = await fetchWithTimeout(`${this.base()}/api/health`, { headers: { "X-App-Token": this.token() } }, TIMEOUT.health);
      return await res.json();
    } catch (e) {
      return { ok: false, error: e instanceof ApiError ? e.code : "NETWORK" };
    }
  }
}
