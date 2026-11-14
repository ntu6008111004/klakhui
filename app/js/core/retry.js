// Client resilience layer: timeout, retry/backoff+jitter, retry_after, circuit breaker, Thai error messages

export const MSG = {
  OFFLINE: "📡 เน็ตหลุด — จะส่งให้อัตโนมัติเมื่อกลับมา",
  AUTH: "รหัสแอปไม่ถูก เปิดตั้งค่าแล้วกรอกใหม่",
  BAD_INPUT: "ข้อความนี้ส่งไม่ได้ ลองพูดใหม่สั้นๆ",
  TOO_LARGE: "ข้อความยาวเกินไป ลองแบ่งพูดเป็นช่วงสั้นๆ",
  TIMEOUT: "ระบบตอบช้า กำลังลองใหม่",
  RATE_LIMIT: "ใช้งานถี่ไป รอแป๊บเดียว",
  UPSTREAM_DOWN: "ระบบแปลขัดข้องชั่วคราว",
  CIRCUIT_OPEN: "ระบบแปลพักชั่วคราว จะลองใหม่เอง",
  NETWORK: "เชื่อมต่อไม่ได้ กำลังลองใหม่",
  ABORTED: "ยกเลิกแล้ว",
};

export class ApiError extends Error {
  /** @param {string} code @param {{status?:number, message_th?:string, retryAfterMs?:number}} [o] */
  constructor(code, o = {}) {
    super(o.message_th || MSG[code] || code);
    this.code = code;
    this.status = o.status ?? 0;
    this.message_th = o.message_th || MSG[code] || "เกิดข้อผิดพลาด";
    this.retryAfterMs = o.retryAfterMs;
  }
  get retryable() {
    return ["NETWORK", "TIMEOUT", "RATE_LIMIT", "UPSTREAM_DOWN"].includes(this.code);
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new ApiError("ABORTED")); }, { once: true });
  });

/** Convert a Response that isn't ok → ApiError (reads code/retry_after_ms from the worker contract) */
export async function errorFromResponse(res) {
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  const e = body?.error;
  const ra = e?.retry_after_ms ?? (res.headers.get("Retry-After") ? Number(res.headers.get("Retry-After")) * 1000 : undefined);
  const code =
    res.status === 401 ? "AUTH" :
    res.status === 413 ? "TOO_LARGE" :
    res.status === 429 ? "RATE_LIMIT" :
    res.status === 504 ? "TIMEOUT" :
    res.status >= 500 ? "UPSTREAM_DOWN" :
    e?.code === "AUTH" ? "AUTH" : "BAD_INPUT";
  return new ApiError(code, { status: res.status, message_th: e?.message_th, retryAfterMs: Number.isFinite(ra) ? ra : undefined });
}

/**
 * fetch + timeout + external signal (to cancel when the user talks over)
 * @returns {Promise<Response>} ok response, or throws ApiError
 */
export async function fetchWithTimeout(url, init, timeoutMs, externalSignal, fetchImpl = fetch) {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (externalSignal?.aborted) throw new ApiError("ABORTED");
    if (timedOut) throw new ApiError("TIMEOUT");
    throw new ApiError("NETWORK");
  } finally {
    clearTimeout(t);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

export const BACKOFF = [400, 1000, 2500];

/**
 * Retry only network/5xx/429/timeout, max 3 times (400ms → 1s → 2.5s + jitter), honoring retry_after_ms
 * @template T
 * @param {(attempt:number)=>Promise<T>} fn
 * @param {{retries?:number, delays?:number[], random?:()=>number, sleepFn?:(ms:number, s?:AbortSignal)=>Promise<void>, signal?:AbortSignal, onRetry?:(e:ApiError, attempt:number, waitMs:number)=>void}} [o]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, o = {}) {
  const retries = o.retries ?? 3;
  const delays = o.delays ?? BACKOFF;
  const rnd = o.random ?? Math.random;
  const sl = o.sleepFn ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("NETWORK");
      if (attempt >= retries || !e.retryable || o.signal?.aborted) throw e;
      const base = delays[Math.min(attempt, delays.length - 1)];
      const wait = e.retryAfterMs !== undefined ? e.retryAfterMs : base + rnd() * base * 0.3;
      o.onRetry?.(e, attempt + 1, wait);
      await sl(wait, o.signal);
    }
  }
}

/** Upstream fails 5 times in a row within 60s → stop sending for 15s, then try again */
export class CircuitBreaker {
  constructor(o = {}) {
    this.threshold = o.threshold ?? 5;
    this.windowMs = o.windowMs ?? 60_000;
    this.openMs = o.openMs ?? 15_000;
    this.now = o.now ?? (() => Date.now());
    /** @type {number[]} */ this.fails = [];
    this.openUntil = 0;
  }
  isOpen() { return this.now() < this.openUntil; }
  remainingMs() { return Math.max(0, this.openUntil - this.now()); }
  success() { this.fails = []; }
  failure() {
    const t = this.now();
    this.fails = this.fails.filter((f) => t - f < this.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.threshold) { this.openUntil = t + this.openMs; this.fails = []; }
  }
}
