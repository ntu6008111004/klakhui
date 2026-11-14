import { AppError, errorFromStatus, fetchWithTimeout, withRetry } from "./resilience";
import type { Env } from "./types";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface ChatResult {
  content: string;
  finishReason: string | null;
  latencyMs: number;
  /** primary = รุ่นหลัก, fallback = รุ่นสำรอง ThaiLLM, external = FALLBACK_LLM_* */
  engine: "primary" | "fallback" | "external";
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  /** false = "เปิด" thinking (ใช้เฉพาะ benchmark) */
  disableThinking?: boolean;
  timeoutMs?: number;
}

export interface Tier { engine: ChatResult["engine"]; url: string; key: string; model: string }

/** cache ต่อรุ่น ว่ารับ chat_template_kwargs ไหม (undefined = ยังไม่รู้) */
const kwargsSupported = new Map<string, boolean>();
/** circuit ของรุ่นหลัก: ล่มเมื่อไรให้ใช้รุ่นสำรองไปก่อนจนถึงเวลานี้ */
let primaryDownUntil = 0;
let lastProbeAt = 0;
export const PRIMARY_COOLDOWN_MS = 60_000;

/** circuit ของรุ่นสำรองแต่ละตัว */
const tierDownUntil = new Map<string, number>();
const tierFails = new Map<string, number[]>();
export function _resetThinkingCache() { kwargsSupported.clear(); primaryDownUntil = 0; lastProbeAt = 0; tierDownUntil.clear(); tierFails.clear(); }
export function _getThinkingCache(model = "qwen3.6-35b-a3b") { return kwargsSupported.get(model) ?? null; }
export function primaryIsDown(now = Date.now()) { return now < primaryDownUntil; }
export function markPrimaryDown(now = Date.now()) { primaryDownUntil = now + PRIMARY_COOLDOWN_MS; }

/** ใช้ร่วมกับ fast path: รุ่นนี้ควรข้ามไหม */
export function tierIsDown(t: Tier, now = Date.now()) {
  return t.engine === "primary" ? primaryIsDown(now) : (tierDownUntil.get(t.model) ?? 0) > now;
}
export function noteTierOk(t: Tier) {
  if (t.engine === "primary") primaryDownUntil = 0;
  tierDownUntil.delete(t.model);
  tierFails.delete(t.model);
}
/** รุ่นหลักล้มครั้งเดียว → พัก; รุ่นอื่นล้ม 2 ครั้งใน 60 วิ → พัก */
export function noteTierFail(t: Tier, now = Date.now()) {
  if (t.engine === "primary") return markPrimaryDown(now);
  const recent = (tierFails.get(t.model) ?? []).filter((x) => now - x < 60_000);
  recent.push(now);
  tierFails.set(t.model, recent);
  if (recent.length >= 2) tierDownUntil.set(t.model, now + PRIMARY_COOLDOWN_MS);
}
export function shouldSendKwargs(t: Tier) { return t.engine !== "external" && kwargsSupported.get(t.model) !== false; }
export function noteKwargs(t: Tier, ok: boolean) { kwargsSupported.set(t.model, ok); }
/** probe รุ่นหลักเบื้องหลัง (ไม่ให้ผู้ใช้ต้องรอ) */
export function maybeProbePrimary(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  if (!ctx || !primaryIsDown() || Date.now() - lastProbeAt < 30_000) return;
  lastProbeAt = Date.now();
  const p = tiers(env)[0];
  ctx.waitUntil(
    callTier(p, [{ role: "user", content: "ping" }], { temperature: 0, maxTokens: 5, disableThinking: true, timeoutMs: 9000 })
      .then(() => { primaryDownUntil = 0; })
      .catch(() => markPrimaryDown()),
  );
}

function looksLikeUnknownField(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /chat_template_kwargs|enable_thinking|extra (fields|inputs)|unrecognized|unknown (field|param)|not permitted|additional properties/i.test(body);
}

export const fallbackModels = (env: Env) => (env.THAILLM_FALLBACK_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function tiers(env: Env): Tier[] {
  const t: Tier[] = [{ engine: "primary", url: env.THAILLM_URL, key: env.THAILLM_API_KEY, model: env.THAILLM_MODEL }];
  // LLM ภายนอก (เช่น Typhoon 2.5 30B ฟรีจาก opentyphoon) มาก่อนรุ่น 8B เพราะเก่งกว่า
  if (env.FALLBACK_LLM_URL && env.FALLBACK_LLM_KEY && env.FALLBACK_LLM_MODEL)
    t.push({ engine: "external", url: env.FALLBACK_LLM_URL, key: env.FALLBACK_LLM_KEY, model: env.FALLBACK_LLM_MODEL });
  // รุ่นสำรองบน ThaiLLM ได้หลายตัว คั่นด้วย , (เรียงตามลำดับที่อยากใช้)
  for (const model of fallbackModels(env)) t.push({ engine: "fallback", url: env.THAILLM_URL, key: env.THAILLM_API_KEY, model });
  return t;
}

type Resolved = Required<ChatOpts>;

async function callOnce(tier: Tier, messages: ChatMessage[], o: Resolved, sendKwargs: boolean): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: tier.model,
    messages,
    temperature: o.temperature,
    max_tokens: o.maxTokens,
    stream: false,
  };
  if (sendKwargs) body.chat_template_kwargs = { enable_thinking: !o.disableThinking };

  const t0 = Date.now();
  const res = await fetchWithTimeout(
    tier.url,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tier.key}` }, body: JSON.stringify(body) },
    o.timeoutMs,
  );
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    if (sendKwargs && looksLikeUnknownField(res.status, text)) throw new AppError("BAD_INPUT", undefined, -1, "kwargs_unsupported");
    throw errorFromStatus(res.status, res.headers.get("Retry-After"), text);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new AppError("UPSTREAM_DOWN", undefined, res.status, "invalid upstream json");
  }
  const choice = json?.choices?.[0];
  // ไม่สนใจ reasoning_content เด็ดขาด — ใช้แค่ content
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  return { content, finishReason: choice?.finish_reason ?? null, latencyMs: Date.now() - t0, engine: tier.engine };
}

/** เรียก 1 tier: จัดการ kwargs ที่ไม่รองรับ (ลองใหม่ไม่ส่ง + cache) */
async function callTier(tier: Tier, messages: ChatMessage[], o: Resolved): Promise<ChatResult> {
  // ไม่ส่ง chat_template_kwargs ให้ผู้ให้บริการภายนอก (ไม่ใช่ ThaiLLM)
  const send = tier.engine !== "external" && kwargsSupported.get(tier.model) !== false;
  try {
    const r = await callOnce(tier, messages, o, send);
    if (send) kwargsSupported.set(tier.model, true);
    return r;
  } catch (e) {
    if (e instanceof AppError && e.upstreamStatus === -1) {
      const r = await callOnce(tier, messages, o, false);
      kwargsSupported.set(tier.model, false);
      return r;
    }
    throw e;
  }
}

const isDownish = (e: unknown) => e instanceof AppError && (e.code === "UPSTREAM_DOWN" || e.code === "TIMEOUT");

/**
 * เรียก LLM:
 * - รุ่นหลักก่อน (retry 1 ครั้งเมื่อ 429; ถ้าไม่มีรุ่นสำรอง retry 1 ครั้งเมื่อ 5xx/timeout ด้วย)
 * - รุ่นหลักล่ม/ช้าเกิน → สลับรุ่นสำรองทันที + พักรุ่นหลัก 60 วิ (probe เบื้องหลังผ่าน waitUntil)
 */
export async function chat(env: Env, messages: ChatMessage[], opts: ChatOpts = {}, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<ChatResult> {
  const o: Resolved = {
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 500,
    disableThinking: opts.disableThinking ?? true,
    timeoutMs: opts.timeoutMs ?? 9000,
  };
  const all = tiers(env);
  const [primary, ...backups] = all;
  const hasBackup = backups.length > 0;

  let lastErr: unknown;
  const skipPrimary = hasBackup && primaryIsDown();
  if (skipPrimary && ctx && Date.now() - lastProbeAt > 30_000) {
    lastProbeAt = Date.now();
    ctx.waitUntil(
      callTier(primary, [{ role: "user", content: "ping" }], { ...o, maxTokens: 5, timeoutMs: 9000 })
        .then(() => { primaryDownUntil = 0; })
        .catch(() => markPrimaryDown()),
    );
  }
  if (!skipPrimary) {
    try {
      // มีรุ่นสำรอง → ไม่รอรุ่นหลักนาน (client timeout 10 วิ) — Qwen non-thinking ปกติตอบใน 1–3 วิ
      const po = hasBackup ? { ...o, timeoutMs: Math.min(o.timeoutMs, 4000) } : o;
      return await withRetry(() => callTier(primary, messages, po), {
        retries: 1,
        baseMs: 500,
        ...(hasBackup ? { shouldRetry: (e: unknown) => e instanceof AppError && e.code === "RATE_LIMIT" } : {}),
      });
    } catch (e) {
      if (!hasBackup || !isDownish(e)) throw e;
      markPrimaryDown();
      lastErr = e;
    }
  }
  // รุ่นสำรอง: ข้ามตัวที่เพิ่งล้ม (ยกเว้นเหลือตัวเดียว), ตัวที่ไม่ใช่ตัวสุดท้ายไม่ retry — ล้มแล้วสลับทันที
  const now = Date.now();
  const healthy = backups.filter((t) => (tierDownUntil.get(t.model) ?? 0) < now);
  const order = healthy.length ? [...healthy, ...backups.filter((t) => !healthy.includes(t))] : backups;
  for (let i = 0; i < order.length; i++) {
    const tier = order[i];
    const last = i === order.length - 1;
    try {
      const r = await withRetry(() => callTier(tier, messages, last ? o : { ...o, timeoutMs: Math.min(o.timeoutMs, 5000) }), {
        retries: last ? 1 : 0,
        baseMs: 500,
      });
      tierDownUntil.delete(tier.model);
      tierFails.delete(tier.model);
      return r;
    } catch (e) {
      lastErr = e;
      console.log(JSON.stringify({ tier_fail: tier.engine, model: tier.model, code: e instanceof AppError ? e.code : "ERR", status: e instanceof AppError ? e.upstreamStatus : undefined }));
      if (!isDownish(e) && !(e instanceof AppError && e.code === "RATE_LIMIT")) throw e;
      // ช้า/ล้มครั้งเดียวอาจเป็นจังหวะเดียว → พักรุ่นนั้นเมื่อล้ม 2 ครั้งติดใน 60 วิ
      const t = Date.now();
      const recent = (tierFails.get(tier.model) ?? []).filter((x) => t - x < 60_000);
      recent.push(t);
      tierFails.set(tier.model, recent);
      if (recent.length >= 2) tierDownUntil.set(tier.model, t + PRIMARY_COOLDOWN_MS);
    }
  }
  throw lastErr ?? new AppError("UPSTREAM_DOWN");
}
