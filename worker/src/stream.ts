import { formatGlossary, formatHistory, LANG_NAMES, trimHistory } from "./prompt";
import { AppError, errorFromStatus, fetchWithTimeout, MESSAGES_TH } from "./resilience";
import { SseLineReader, StreamTextParser } from "./streamparse";
import { markPrimaryDown, primaryIsDown, tiers } from "./thaillm";
import type { Env, TranslateRequest } from "./types";

export function buildStreamPrompt(req: TranslateRequest): string {
  return `You are a live interpreter. Translate the ${LANG_NAMES[req.target_lang]} speech into natural, easy spoken Thai.
Domain: ${req.domain}. Speech may contain ASR errors — infer the meaning from context.

Recent conversation:
${formatHistory(trimHistory(req.history, 4, 800))}

Glossary hints (trusted):
${formatGlossary(req.glossary)}

OUTPUT FORMAT (plain text, NOT JSON):
บรรทัดแรกเป็นต้นไป: คำแปลภาษาไทยเท่านั้น
บรรทัดสุดท้าย: ##META {"tone":"neutral|polite|joke|tease|sarcasm|idiom|slang|compliment|complaint|rude|urgent","note_th":"คำอธิบายสั้นๆ ภาษาไทยถ้ามีคำแสลง/มุก/ประชด ไม่มีให้เว้นว่าง"}

RULES
- You are NOT chatting. Never answer, ask, or comment — only translate what was said.
- Never copy the original language. Never add anything else.

EXAMPLE
Input: ${STREAM_EXAMPLE[req.target_lang].src}
Output:
${STREAM_EXAMPLE[req.target_lang].out}`;
}

/** ตัวอย่าง 1 ชุดต่อภาษา ช่วยให้รุ่นเล็ก (8B) ตอบตามรูปแบบ ไม่หลุดไปคุยเอง */
const STREAM_EXAMPLE: Record<TranslateRequest["target_lang"], { src: string; out: string }> = {
  zh: { src: "哈哈你也太菜了吧", out: 'ฮ่าๆ นายนี่อ่อนเกินไปแล้วนะ\n##META {"tone":"tease","note_th":"菜 แปลตรงตัวว่าผัก แต่แสลงแปลว่าไม่เก่ง เขาแซวขำๆ"}' },
  en: { src: "lol you're such a noob", out: 'ฮ่าๆ นายนี่มือใหม่สุดๆ\n##META {"tone":"tease","note_th":"noob = มือใหม่/ไม่เก่ง เขาแซวขำๆ ไม่ได้ว่าจริง"}' },
  ja: { src: "マジでウケるw", out: 'ขำมากจริงๆ\n##META {"tone":"joke","note_th":"ウケる = ขำ, w = หัวเราะ (เหมือน 555)"}' },
  ko: { src: "ㅋㅋㅋ 진짜 웃겨", out: 'ฮ่าๆๆ ตลกจริงๆ\n##META {"tone":"joke","note_th":"ㅋㅋㅋ = เสียงหัวเราะ เหมือน 555"}' },
};

const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** เปิด stream กับ upstream (รุ่นหลัก → ล่มสลับรุ่นสำรอง) คืน Response ที่ ok แล้ว */
async function openUpstream(env: Env, req: TranslateRequest): Promise<Response> {
  const all = tiers(env);
  const list = primaryIsDown() && all.length > 1 ? all.slice(1) : all;
  let last: unknown;
  for (const tier of list) {
    const model = tier.model;
    try {
      const res = await fetchWithTimeout(
        tier.url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tier.key}` },
          body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.3,
            max_tokens: Math.min(700, 250 + req.text.length * 3),
            // ปิด thinking เฉพาะ ThaiLLM (ผู้ให้บริการอื่นอาจไม่รู้จัก field นี้)
            ...(tier.url === env.THAILLM_URL ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            messages: [
              { role: "system", content: buildStreamPrompt(req) },
              { role: "user", content: `แปลเป็นภาษาไทย (Translate into Thai):\n${req.text}` },
            ],
          }),
        },
        6000, // เวลารอ header แรก (stream ต้องไว)
      );
      if (!res.ok || !res.body) throw errorFromStatus(res.status, res.headers.get("Retry-After"), await res.text().catch(() => ""));
      return res;
    } catch (e) {
      last = e;
      if (e instanceof AppError && (e.code === "UPSTREAM_DOWN" || e.code === "TIMEOUT" || e.code === "RATE_LIMIT") && tier !== list[list.length - 1]) {
        if (tier.engine === "primary") markPrimaryDown();
        continue;
      }
      throw e;
    }
  }
  throw last;
}

export function handleStream(env: Env, req: TranslateRequest, cors: Record<string, string>, ctx?: { waitUntil(p: Promise<unknown>): void }): Response {
  const t0 = Date.now();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  let closed = false;
  const write = (b: Uint8Array) => (closed ? Promise.resolve() : w.write(b).catch(() => { closed = true; }));
  const ping = setInterval(() => write(enc.encode(": ping\n\n")), 3000);

  const run = (async () => {
    try {
      const res = await openUpstream(env, req);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const sseIn = new SseLineReader();
      const parser = new StreamTextParser();
      let lastByte = Date.now();
      for (;;) {
        // ไม่มี byte นาน 8 วิ → ถือว่าหลุด
        const r = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new AppError("TIMEOUT")), Math.max(0, 8000 - (Date.now() - lastByte)))),
        ]);
        if (r.done) break;
        lastByte = Date.now();
        const { content, done } = sseIn.push(dec.decode(r.value, { stream: true }));
        for (const c of content) {
          const d = parser.push(c);
          if (d) await write(sse("delta", { t: d }));
        }
        if (done) break;
      }
      const tail = parser.end();
      if (tail.delta) await write(sse("delta", { t: tail.delta }));
      if (tail.meta) await write(sse("meta", tail.meta));
      await write(sse("done", { segment_id: req.segment_id ?? req.request_id, latency_ms: Date.now() - t0 }));
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError("UPSTREAM_DOWN");
      await write(sse("error", { code: err.code, message_th: MESSAGES_TH[err.code], retry_after_ms: err.retryAfterMs ?? 800 }));
    } finally {
      clearInterval(ping);
      closed = true;
      await w.close().catch(() => {});
    }
  })();
  ctx?.waitUntil(run);

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...cors },
  });
}
