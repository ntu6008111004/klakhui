/**
 * POST /api/translate/fast — แปลแบบ "ไวสุดแต่ยังแม่น" (ตอบเป็น SSE)
 *
 * 1) stream จากรุ่นที่ดีที่สุดที่ยังไม่ล่ม — ทันทีที่ field "translation" ปิด → ส่ง event: partial (แอปโชว์ + พูดได้เลย)
 * 2) hedging: ถ้ารุ่นแรกยังไม่ได้คำแปลภายใน hedgeMs → ยิงรุ่นถัดไปคู่ขนาน ใครได้คำแปล "ถูกภาษา" ก่อนชนะ
 *    (ผู้แพ้ถูกยกเลิก) — ล้มเร็ว (HTTP error) → เริ่มรุ่นถัดไปทันทีไม่ต้องรอ
 * 3) ผู้ชนะ stream จบ → event: result (JSON เต็ม: tone/note_th/replies/terms) — parse พังก็ยังส่ง result จากคำแปลที่ได้
 * event: error เมื่อทุกรุ่นล้ม (แอป fallback ไป /api/translate แบบเดิม)
 */
import { buildSystemPrompt, buildUserMessage, LANG_NAMES } from "./prompt";
import { fallbackResult, normalizeResult, parseTranslation, salvagePartial, stripFences, stripThink } from "./parse";
import { AppError, errorFromStatus, MESSAGES_TH } from "./resilience";
import { SseLineReader } from "./streamparse";
import { maybeProbePrimary, noteKwargs, noteTierFail, noteTierOk, shouldSendKwargs, tierIsDown, tiers, type Tier } from "./thaillm";
import { cleanReplies, maxTokensFor } from "./translate";
import type { Env, TranslateRequest, TranslationResult } from "./types";

const THAI = /[฀-๿]/;
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export interface FastOpts {
  /** เริ่มรุ่นถัดไปคู่ขนานถ้ายังไม่ได้คำแปลภายในเวลานี้ */
  hedgeMs?: number;
  /** เวลารอทั้งหมดต่อรุ่น */
  tierTimeoutMs?: number;
}

/** ดึงค่า "translation" ที่ปิด string แล้วจาก JSON ที่ยังมาไม่ครบ */
export function extractTranslation(acc: string): string | null {
  const s = stripFences(stripThink(acc));
  const m = /"translation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  if (!m) return null;
  try { return (JSON.parse(`"${m[1]}"`) as string).trim(); } catch { return m[1].trim(); }
}

export function translationOk(t: string, direction: TranslateRequest["direction"]): boolean {
  if (!t) return false;
  return direction === "partner_to_me" ? THAI.test(t) : !THAI.test(t);
}

/** stream content deltas จาก tier หนึ่ง (OpenAI-compatible SSE) */
async function* streamTier(tier: Tier, messages: { role: string; content: string }[], maxTokens: number, signal: AbortSignal): AsyncGenerator<string> {
  const send = shouldSendKwargs(tier);
  const body = (kw: boolean) => JSON.stringify({
    model: tier.model, messages, temperature: 0.3, max_tokens: maxTokens, stream: true,
    ...(kw ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  });
  const post = (kw: boolean) => fetch(tier.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tier.key}` }, body: body(kw), signal });
  let res: Response;
  try {
    res = await post(send);
    if (send && (res.status === 400 || res.status === 422)) {
      const txt = await res.text();
      if (/chat_template_kwargs|enable_thinking|unrecognized|unknown|extra/i.test(txt)) {
        noteKwargs(tier, false);
        res = await post(false);
      } else throw errorFromStatus(res.status, null, txt);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(signal.aborted ? "TIMEOUT" : "UPSTREAM_DOWN");
  }
  if (!res.ok || !res.body) throw errorFromStatus(res.status, res.headers.get("Retry-After"), await res.text().catch(() => ""));
  if (send) noteKwargs(tier, true);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const lines = new SseLineReader();
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try { r = await reader.read(); } catch { throw new AppError(signal.aborted ? "TIMEOUT" : "UPSTREAM_DOWN"); }
    if (r.done) return;
    const { content, done } = lines.push(dec.decode(r.value, { stream: true }));
    for (const c of content) yield c;
    if (done) return;
  }
}

export function handleFast(env: Env, req: TranslateRequest, cors: Record<string, string>, ctx?: { waitUntil(p: Promise<unknown>): void }, o: FastOpts = {}): Response {
  const t0 = Date.now();
  // เคสแพทย์รอรุ่นใหญ่นานกว่า (ความแม่นสำคัญกว่า)
  const hedgeMs = o.hedgeMs ?? (req.domain === "medical" ? 2500 : 1800);
  const tierTimeoutMs = o.tierTimeoutMs ?? 9000;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  let closed = false;
  const write = (b: Uint8Array) => (closed ? Promise.resolve() : w.write(b).catch(() => { closed = true; }));
  const ping = setInterval(() => write(enc.encode(": ping\n\n")), 3000);

  maybeProbePrimary(env, ctx);
  const all = tiers(env);
  const healthy = all.filter((t) => !tierIsDown(t));
  const order = healthy.length ? healthy : all.slice(1).length ? all.slice(1) : all;

  const messages = [
    { role: "system", content: buildSystemPrompt({ direction: req.direction, targetLang: req.target_lang, domain: req.domain, history: req.history, glossary: req.glossary }) },
    { role: "user", content: buildUserMessage(req.text, req.direction, req.target_lang) },
  ];
  const maxTokens = maxTokensFor(req.text.length);

  const run = (async () => {
    let winner: Tier | null = null;
    let next = 0;
    let running = 0;
    const ctrls = new Map<Tier, AbortController>();
    let finished = false;
    let resolveAll!: () => void;
    const allDone = new Promise<void>((r) => (resolveAll = r));
    let hedgeTimer: any;
    let lastErr: AppError | null = null;

    const finish = async (result: TranslationResult | null, tier: Tier | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      for (const [t, c] of ctrls) if (t !== tier) c.abort();
      if (result && tier) {
        await write(sse("result", { ...cleanReplies(result, req.text), engine: tier.engine, model: tier.model, latency_ms: Date.now() - t0, request_id: req.request_id }));
      } else {
        const e = lastErr ?? new AppError("UPSTREAM_DOWN");
        await write(sse("error", { code: e.code, message_th: MESSAGES_TH[e.code], retry_after_ms: e.retryAfterMs ?? 800 }));
      }
      resolveAll();
    };

    const startNext = () => {
      if (finished || winner || next >= order.length) {
        if (!finished && !winner && running === 0) finish(null, null);
        return;
      }
      const tier = order[next++];
      running++;
      clearTimeout(hedgeTimer);
      if (next < order.length) hedgeTimer = setTimeout(() => { if (!winner) startNext(); }, hedgeMs);
      runTier(tier).finally(() => {
        running--;
        if (!finished && !winner) startNext(); // ล้ม → เริ่มรุ่นถัดไปทันที
      });
    };

    const runTier = async (tier: Tier) => {
      const ctrl = new AbortController();
      ctrls.set(tier, ctrl);
      const timer = setTimeout(() => ctrl.abort(), tierTimeoutMs);
      let acc = "";
      let partialSent = false;
      try {
        for await (const d of streamTier(tier, messages, maxTokens, ctrl.signal)) {
          if (finished || (winner && winner !== tier)) { ctrl.abort(); return; }
          acc += d;
          if (!partialSent) {
            const tr = extractTranslation(acc);
            if (tr !== null) {
              if (!translationOk(tr, req.direction)) throw new AppError("BAD_INPUT", undefined, -2, "wrong language");
              if (!winner) {
                winner = tier;
                partialSent = true;
                clearTimeout(hedgeTimer);
                for (const [t, c] of ctrls) if (t !== tier) c.abort(); // ผู้แพ้หยุด
                await write(sse("partial", { translation: tr, engine: tier.engine, latency_ms: Date.now() - t0 }));
              }
            }
          }
        }
        if (winner !== tier) return;
        noteTierOk(tier);
        const parsed = parseTranslation(acc, req.direction) ?? salvagePartial(acc, req.direction) ?? fallbackResult(acc, req.direction);
        // คำแปลใน result ต้องตรงกับ partial ที่ผู้ใช้เห็น/ได้ยินไปแล้ว
        const tr = extractTranslation(acc);
        if (tr && parsed.translation !== tr) parsed.translation = tr;
        await finish(parsed, tier);
      } catch (e) {
        if (winner === tier && !finished) {
          // ผู้ชนะหลุดกลางทางหลังส่ง partial → ส่ง result จากคำแปลที่ได้แล้ว (ไม่ให้แอปค้าง)
          const tr = extractTranslation(acc) ?? "";
          const r = normalizeResult({ translation: tr }, req.direction) ?? fallbackResult(tr, req.direction);
          await finish(r, tier);
          return;
        }
        if (ctrl.signal.aborted && (finished || winner)) return; // ถูกยกเลิกเพราะแพ้ ไม่ใช่ความผิดรุ่นนี้
        lastErr = e instanceof AppError && e.upstreamStatus !== -2 ? e : new AppError("UPSTREAM_DOWN");
        if (!(e instanceof AppError && e.upstreamStatus === -2)) noteTierFail(tier);
        console.log(JSON.stringify({ fast_tier_fail: tier.engine, model: tier.model, code: lastErr.code }));
      } finally {
        clearTimeout(timer);
      }
    };

    startNext();
    await allDone;
  })()
    .catch(async () => { await write(sse("error", { code: "UPSTREAM_DOWN", message_th: MESSAGES_TH.UPSTREAM_DOWN, retry_after_ms: 800 })); })
    .finally(async () => {
      clearInterval(ping);
      closed = true;
      await w.close().catch(() => {});
    });
  ctx?.waitUntil(run);

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...cors },
  });
}

export { LANG_NAMES };
