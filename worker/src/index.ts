import { AppError, errorBody, fetchWithTimeout, HTTP_STATUS } from "./resilience";
import { primaryIsDown } from "./thaillm";
import { translate, validateRequest } from "./translate";
import { handleStream } from "./stream";
import { handleFast } from "./fast";
import { MAX_IMAGE_B64, ocrImage, validateImage } from "./ocr";
import { handleTts, ttsHealth } from "./tts";
import type { Env } from "./types";

// ห้าม export อย่างอื่นนอกจาก default จาก entry ของ Worker (workerd จะ start ไม่ขึ้น)
const MAX_BODY_BYTES = 16 * 1024;
const HEALTH_TTL_MS = 30_000;
let healthCache: { at: number; body: Record<string, unknown> } | null = null;

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes("*") || allowed.includes(origin));
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Expose-Headers": "X-Engine, X-Latency-Ms",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

/** เทียบ token แบบเวลาคงที่ */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw new AppError("TOO_LARGE");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new AppError("TOO_LARGE");
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new AppError("BAD_INPUT", undefined, undefined, "invalid json");
  }
}

function log(endpoint: string, status: number, t0: number, code?: string, engine?: string) {
  // ห้าม log ข้อความผู้ใช้ / key
  console.log(JSON.stringify({ endpoint, status, latency_ms: Date.now() - t0, ...(code ? { code } : {}), ...(engine ? { engine } : {}) }));
}

async function health(env: Env): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return healthCache.body;
  let thaillm: "ok" | "degraded" | "down" = "down";
  try {
    const res = await fetchWithTimeout(env.THAILLM_URL.replace(/\/chat\/completions$/, "/models"), { headers: { Authorization: `Bearer ${env.THAILLM_API_KEY}` } }, 2500);
    if (res.ok) thaillm = primaryIsDown() ? "degraded" : "ok";
  } catch {
    /* down */
  }
  const tts = await ttsHealth();
  const body = { ok: thaillm !== "down", thaillm, tts, time: new Date().toISOString() };
  healthCache = { at: now, body };
  return body;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const cors = corsHeaders(env, req.headers.get("Origin"));

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (!safeEqual(req.headers.get("X-App-Token") || "", env.APP_TOKEN || "")) throw new AppError("AUTH");

      if (url.pathname === "/api/translate" && req.method === "POST") {
        const body = validateRequest(await readJson(req));
        const { result, engine } = await translate(env, body, ctx);
        log(url.pathname, 200, t0, undefined, engine);
        return json({ ...result, engine, latency_ms: Date.now() - t0, request_id: body.request_id }, 200, cors);
      }

      if (url.pathname === "/api/translate/fast" && req.method === "POST") {
        const body = validateRequest(await readJson(req));
        log(url.pathname, 200, t0);
        return handleFast(env, body, cors, ctx);
      }

      if (url.pathname === "/api/translate/stream" && req.method === "POST") {
        const body = validateRequest(await readJson(req));
        if (body.direction !== "partner_to_me") throw new AppError("BAD_INPUT", undefined, undefined, "stream only partner_to_me");
        log(url.pathname, 200, t0);
        return handleStream(env, body, cors, ctx);
      }

      if (url.pathname === "/api/ocr" && req.method === "POST") {
        // รูปใหญ่กว่าคำขอข้อความ → เพดานแยก 2.1MB (แอปย่อรูปก่อนส่ง ปกติ 100–300KB)
        const img = validateImage(await readJson(req, MAX_IMAGE_B64 + 4096));
        const r = await ocrImage(env, img);
        log(url.pathname, 200, t0);
        return json(r, 200, cors);
      }

      if (url.pathname === "/api/tts" && req.method === "POST") {
        const res = await handleTts(await readJson(req), cors);
        log(url.pathname, res.status, t0);
        return res;
      }

      if (url.pathname === "/api/health" && req.method === "GET") {
        return json(await health(env), 200, cors);
      }

      if (url.pathname === "/api/stt") {
        // นอกขอบเขตรุ่นนี้ — stub ไว้สำหรับรุ่น 2
        return json({ error: { code: "NOT_IMPLEMENTED", message_th: "ยังไม่รองรับการถอดเสียงฝั่งเซิร์ฟเวอร์" } }, 501, cors);
      }

      return json({ error: { code: "NOT_FOUND", message_th: "ไม่พบเส้นทางนี้" } }, 404, cors);
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError("UPSTREAM_DOWN", undefined, undefined, String(e));
      const status = HTTP_STATUS[err.code];
      log(url.pathname, status, t0, err.code);
      return json(errorBody(err), status, cors);
    }
  },
};
