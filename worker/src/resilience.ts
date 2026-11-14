import type { ErrorCode } from "./types";

export const MESSAGES_TH: Record<ErrorCode, string> = {
  RATE_LIMIT: "ใช้งานถี่เกินไป รอสักครู่แล้วระบบจะลองใหม่ให้เอง",
  UPSTREAM_DOWN: "ระบบแปลขัดข้องชั่วคราว กำลังลองใหม่",
  TIMEOUT: "ระบบแปลตอบช้าเกินไป ลองใหม่อีกครั้ง",
  BAD_INPUT: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
  AUTH: "รหัสแอปไม่ถูกต้อง กรุณาเปิดตั้งค่าแล้วกรอกใหม่",
  TOO_LARGE: "ข้อความยาวเกินไป ลองแบ่งพูดเป็นช่วงสั้นๆ",
};

export const HTTP_STATUS: Record<ErrorCode, number> = {
  RATE_LIMIT: 429,
  UPSTREAM_DOWN: 502,
  TIMEOUT: 504,
  BAD_INPUT: 400,
  AUTH: 401,
  TOO_LARGE: 413,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public retryAfterMs?: number,
    /** status ที่ได้จาก upstream (ใช้ตัดสินใจลดขนาดคำขอ) */
    public upstreamStatus?: number,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** แปลง Retry-After (วินาที หรือวันที่) เป็น ms */
export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/** fetch + timeout (AbortController) — timeout → AppError TIMEOUT, network error → UPSTREAM_DOWN */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new AppError("TIMEOUT");
    throw new AppError("UPSTREAM_DOWN", undefined, undefined, String(e));
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryable(e: unknown): boolean {
  return e instanceof AppError && (e.code === "RATE_LIMIT" || e.code === "UPSTREAM_DOWN" || e.code === "TIMEOUT");
}

export interface RetryOpts {
  retries: number;
  baseMs: number;
  /** ใส่ได้เพื่อเทส */
  sleepFn?: (ms: number) => Promise<void>;
  random?: () => number;
  /** override เงื่อนไข retry (ค่าเริ่มต้น = isRetryable) */
  shouldRetry?: (e: unknown) => boolean;
}

/** retry เฉพาะ 429/5xx/network/timeout, backoff base*2^n + jitter, เคารพ retryAfterMs */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOpts): Promise<T> {
  const sl = opts.sleepFn ?? sleep;
  const rnd = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= opts.retries || !(opts.shouldRetry ?? isRetryable)(e)) throw e;
      const ra = (e as AppError).retryAfterMs;
      const wait = ra !== undefined ? Math.min(ra, 5000) : opts.baseMs * 2 ** attempt + rnd() * opts.baseMs * 0.5;
      await sl(wait);
    }
  }
}

/** แปลง status upstream → AppError */
export function errorFromStatus(status: number, retryAfter: string | null, body = ""): AppError {
  if (status === 429) return new AppError("RATE_LIMIT", parseRetryAfter(retryAfter) ?? 1200, status, body);
  if (status === 408) return new AppError("TIMEOUT", undefined, status, body);
  if (status >= 500) return new AppError("UPSTREAM_DOWN", parseRetryAfter(retryAfter), status, body);
  if (status === 401 || status === 403) return new AppError("UPSTREAM_DOWN", undefined, status, "upstream auth: " + body);
  if (status === 413) return new AppError("TOO_LARGE", undefined, status, body);
  return new AppError("BAD_INPUT", undefined, status, body);
}

export function errorBody(e: AppError) {
  return {
    error: {
      code: e.code,
      message_th: MESSAGES_TH[e.code],
      ...(e.retryAfterMs !== undefined ? { retry_after_ms: Math.round(e.retryAfterMs) } : {}),
    },
  };
}
