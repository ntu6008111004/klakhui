import { extractFirstJson } from "./parse";
import { TONES, type Tone } from "./types";

const META = "##META";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** ความยาว suffix ของ s ที่เป็น prefix ของ token (ต้องกั๊กไว้ก่อน เผื่อ chunk ถัดไปต่อเป็น token) */
function heldSuffix(s: string, token: string): number {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) {
    if (token.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

export interface StreamMeta { tone: Tone; note_th: string }

/**
 * แยก stream ข้อความจาก LLM:
 *  - ตัด <think>…</think> ที่ขึ้นต้น (รวมกรณีขาดข้าม chunk)
 *  - ทุกอย่างก่อน ##META → delta (ส่งทันที)
 *  - หลัง ##META → parse เป็น meta ตอนจบ (พัง = ข้าม ไม่ล้ม)
 */
export class StreamTextParser {
  private state: "start" | "think" | "body" | "meta" = "start";
  private buf = "";
  private metaBuf = "";
  private emittedAny = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.state === "start") {
        const t = this.buf.replace(/^\s+/, "");
        if (t.startsWith(THINK_OPEN)) { this.buf = t.slice(THINK_OPEN.length); this.state = "think"; continue; }
        if (t.length < THINK_OPEN.length && THINK_OPEN.startsWith(t)) { this.buf = t; return out; } // รอดูก่อน
        this.buf = t;
        this.state = "body";
        continue;
      }
      if (this.state === "think") {
        const i = this.buf.indexOf(THINK_CLOSE);
        if (i === -1) { const h = heldSuffix(this.buf, THINK_CLOSE); this.buf = h ? this.buf.slice(-h) : ""; return out; }
        this.buf = this.buf.slice(i + THINK_CLOSE.length).replace(/^\s+/, "");
        this.state = "body";
        continue;
      }
      if (this.state === "body") {
        const i = this.buf.indexOf(META);
        if (i !== -1) {
          out += this.buf.slice(0, i).replace(/\s+$/, ""); // ช่องว่าง/ขึ้นบรรทัดก่อน META ทิ้ง
          this.metaBuf = this.buf.slice(i + META.length);
          this.buf = "";
          this.state = "meta";
          return this.finishDelta(out);
        }
        // กั๊กไว้: (1) ส่วนที่อาจเป็นต้น ##META (2) ช่องว่างท้าย (เผื่อตามด้วย META)
        let keep = heldSuffix(this.buf, META);
        const ws = /\s*$/.exec(this.buf.slice(0, this.buf.length - keep))![0].length;
        keep += ws;
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return this.finishDelta(out);
      }
      // meta
      this.metaBuf += this.buf;
      this.buf = "";
      return out;
    }
  }

  private finishDelta(out: string): string {
    if (!this.emittedAny) {
      out = out.replace(/^\s+/, "");
      if (out) this.emittedAny = true;
    }
    return out;
  }

  /** เรียกตอนจบ stream → delta ที่เหลือ + meta (หรือ null) */
  end(): { delta: string; meta: StreamMeta | null } {
    let delta = "";
    if (this.state === "body" || this.state === "start") delta = this.finishDelta(this.buf);
    this.buf = "";
    let meta: StreamMeta | null = null;
    if (this.metaBuf) {
      const o = extractFirstJson(this.metaBuf) as Record<string, unknown> | undefined;
      if (o) {
        const tone = String(o.tone ?? "").toLowerCase() as Tone;
        meta = { tone: TONES.includes(tone) ? tone : "neutral", note_th: typeof o.note_th === "string" ? o.note_th.trim() : "" };
      }
    }
    return { delta: delta.replace(/\s+$/, ""), meta };
  }
}

/** แยก SSE ของ OpenAI-compatible: คืน content delta ของแต่ละบรรทัด data: */
export class SseLineReader {
  private buf = "";
  push(text: string): { content: string[]; done: boolean; finish: string | null } {
    this.buf += text;
    const content: string[] = [];
    let done = false;
    let finish: string | null = null;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { done = true; continue; }
      try {
        const j = JSON.parse(data);
        const c = j?.choices?.[0];
        // ไม่สน reasoning_content
        if (typeof c?.delta?.content === "string") content.push(c.delta.content);
        if (c?.finish_reason) finish = c.finish_reason;
      } catch {
        /* บรรทัดเสีย ข้าม */
      }
    }
    return { content, done, finish };
  }
}
