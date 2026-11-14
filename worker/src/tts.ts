/**
 * TTS ผ่าน edge-tts (Microsoft Edge Read Aloud)
 *
 * หมายเหตุการออกแบบ: ทดลอง `edge-tts-universal@1.4.0` แล้ว ทาง isomorphic/webworker ใช้ `new WebSocket()`
 * ซึ่งบน Cloudflare Workers ส่ง header Origin/User-Agent ไม่ได้ (lib เตือน "using native WebSocket without headers")
 * จึงเขียน client ขนาดเล็กที่ใช้ `fetch(..., {Upgrade: websocket})` ของ Workers แทน โดยใช้ค่าคงที่ชุดเดียวกับ lib
 * และ (พ.ย. 2026) Microsoft เปลี่ยนโทเค็น Sec-MS-GEC เป็น v2 → lib npm ยังเป็น v1 โดน 403 จึงพอร์ต v2 จาก edge-tts (Python) ไว้ใน edgedrm.ts
 * ทุกอย่างห่อไว้ในไฟล์นี้ → สลับ provider ได้ที่ฟังก์ชัน synthesize() จุดเดียว
 */
import { randomMuid, secMsGecV2 } from "./edgedrm";
import { AppError, errorBody, HTTP_STATUS } from "./resilience";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split(".")[0];
const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

export type TtsLang = "th" | "zh" | "en" | "ja" | "ko";
export type Gender = "female" | "male";

export const VOICES: Record<TtsLang, Record<Gender, string[]>> = {
  zh: { female: ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural"], male: ["zh-CN-YunxiNeural", "zh-CN-YunjianNeural"] },
  en: { female: ["en-US-AvaNeural", "en-US-EmmaNeural"], male: ["en-US-AndrewNeural"] },
  ja: { female: ["ja-JP-NanamiNeural"], male: ["ja-JP-KeitaNeural"] },
  ko: { female: ["ko-KR-SunHiNeural"], male: ["ko-KR-InJoonNeural"] },
  th: { female: ["th-TH-PremwadeeNeural"], male: ["th-TH-NiwatNeural"] },
};
const ALL_VOICES = new Set(Object.values(VOICES).flatMap((g) => [...g.female, ...g.male]));

export interface TtsRequest { text: string; lang: TtsLang; gender: Gender; rate: string; pitch: string; voice: string }

export function validateTts(body: unknown): TtsRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (why: string) => new AppError("BAD_INPUT", undefined, undefined, why);
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw bad("text");
  if (text.length > 400) throw new AppError("TOO_LARGE");
  const lang = b.lang as TtsLang;
  if (!(lang in VOICES)) throw bad("lang");
  const gender: Gender = b.gender === "male" ? "male" : "female";
  const rate = typeof b.rate === "string" && /^[+-]\d{1,3}%$/.test(b.rate) ? b.rate : "+8%";
  const pitch = typeof b.pitch === "string" && /^[+-]\d{1,3}Hz$/.test(b.pitch) ? b.pitch : "-3Hz";
  const voice = typeof b.voice === "string" && ALL_VOICES.has(b.voice) && b.voice.startsWith(VOICES[lang].female[0].slice(0, 5)) ? b.voice : VOICES[lang][gender][0];
  return { text, lang, gender, rate, pitch, voice };
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** "th-TH-PremwadeeNeural" → "Microsoft Server Speech Text to Speech Voice (th-TH, PremwadeeNeural)"
 *  (เหมือน edge-tts Python — บางเสียงเช่น Premwadee ใช้ชื่อสั้นไม่ได้ เซิร์ฟเวอร์ตัดการเชื่อมต่อ) */
export function longVoiceName(short: string): string {
  const m = /^([a-z]{2,3}-[A-Z]{2})-(.+)$/.exec(short);
  return m ? `Microsoft Server Speech Text to Speech Voice (${m[1]}, ${m[2]})` : short;
}

export function buildSsml(r: Pick<TtsRequest, "voice" | "rate" | "pitch" | "text">): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${longVoiceName(r.voice)}'><prosody pitch='${r.pitch}' rate='${r.rate}' volume='+0%'>${escapeXml(r.text)}</prosody></voice></speak>`;
}


/** วันที่แบบ JavaScript Date.toString() ใน UTC (เหมือน edge-tts Python) */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function stamp(d = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
const uuid = () => crypto.randomUUID().replace(/-/g, "");

/** แยก binary frame: 2 byte แรก = ความยาว header (big-endian) */
export function splitBinaryFrame(buf: Uint8Array): { path: string; audio: Uint8Array } | null {
  if (buf.length < 2) return null;
  const hl = (buf[0] << 8) | buf[1];
  const headers = new TextDecoder().decode(buf.subarray(2, 2 + hl));
  const path = /Path:([^\r\n]+)/.exec(headers)?.[1]?.trim() ?? "";
  return { path, audio: buf.subarray(2 + hl) };
}

let lastFailAt = 0;
let lastOkAt = 0;
export async function ttsHealth(): Promise<"ok" | "down"> {
  return lastFailAt > lastOkAt && Date.now() - lastFailAt < 60_000 ? "down" : "ok";
}

/**
 * สังเคราะห์เสียง → ReadableStream ของ mp3
 * รอจน chunk เสียงแรกมาถึงก่อนค่อย resolve (ถ้าเชื่อมต่อพัง client จะได้ error JSON แล้ว fallback เป็นเสียงเครื่อง)
 */
export async function synthesize(r: TtsRequest, firstAudioMs = 2000): Promise<ReadableStream<Uint8Array>> {
  // firstAudioMs = ต้องได้เสียงชิ้นแรกภายในเวลานี้ ไม่งั้นสลับเสียงสำรอง (ปกติได้ใน 0.4–0.9 วิ)
  const t0 = Date.now();
  const url = `https://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGecV2()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${uuid()}`;
  const upgrade = fetch(url, {
    headers: {
      Upgrade: "websocket",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${randomMuid()};`,
    },
  });
  const resp = await Promise.race([
    upgrade,
    new Promise<never>((_, rej) => setTimeout(() => rej(new AppError("TIMEOUT", undefined, undefined, "tts connect")), firstAudioMs)),
  ]);
  const ws = (resp as any).webSocket as WebSocket | null;
  if (!ws) throw new AppError("UPSTREAM_DOWN", undefined, resp.status, "tts ws upgrade failed");
  (ws as any).accept();

  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let started = false;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; }, cancel: () => { try { ws.close(); } catch {} } });

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => fail(new AppError("TIMEOUT", undefined, undefined, "tts first audio")), Math.max(300, firstAudioMs - (Date.now() - t0)));
    const fail = (e: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lastFailAt = Date.now();
      console.log(JSON.stringify({ tts_fail: e instanceof AppError ? e.code + ":" + e.message + ":" + (e.upstreamStatus ?? "") : String(e), voice: r.voice }));
      try { ws.close(); } catch {}
      if (started) { try { ctrl.error(e); } catch {} } else reject(e);
    };
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          if (!started) return fail(new AppError("UPSTREAM_DOWN", undefined, undefined, "tts no audio"));
          done = true;
          clearTimeout(timer);
          lastOkAt = Date.now();
          try { ctrl.close(); } catch {}
          try { ws.close(); } catch {}
        }
        return;
      }
      const f = splitBinaryFrame(new Uint8Array(ev.data as ArrayBuffer));
      if (!f || f.path !== "audio" || f.audio.length === 0) return;
      ctrl.enqueue(f.audio);
      if (!started) {
        started = true;
        // ได้เสียงแล้ว → เปลี่ยนเป็นเพดานรวม (ข้อความยาวสุด 400 ตัว ไม่ควรเกิน 20 วิ)
        clearTimeout(timer);
        timer = setTimeout(() => fail(new AppError("TIMEOUT", undefined, undefined, "tts total")), 20_000);
        resolve(stream);
      }
    });
    ws.addEventListener("error", () => fail(new AppError("UPSTREAM_DOWN", undefined, undefined, "tts ws error")));
    ws.addEventListener("close", () => { if (!done) fail(new AppError("UPSTREAM_DOWN", undefined, undefined, "tts ws closed")); });

    ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
    ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${buildSsml(r)}`);
  });
}

/** Other voices in the same language (same gender first, then the other gender) — used when the main voice fails */
export function alternateVoices(r: TtsRequest): string[] {
  const g = VOICES[r.lang];
  const other: Gender = r.gender === "female" ? "male" : "female";
  return [...g[r.gender], ...g[other]].filter((v) => v !== r.voice);
}

/**
 * Synthesize; if the main voice fails → switch once to another voice in the same language
 * (tested Nov 2026: Microsoft's th-TH-PremwadeeNeural intermittently returns "no audio" on some sentences — Python edge-tts fails the same way)
 * If both fail → error JSON → the client falls back to the device voice (speechSynthesis)
 */
const voiceDownUntil = new Map<string, number>();
export const VOICE_COOLDOWN_MS = 5 * 60_000;
export function _resetVoiceHealth() { voiceDownUntil.clear(); }

export async function synthesizeSafe(r: TtsRequest, synth: (r: TtsRequest, timeoutMs?: number) => Promise<ReadableStream<Uint8Array>> = synthesize): Promise<{ audio: ReadableStream<Uint8Array>; voice: string }> {
  const now = Date.now();
  const alts = alternateVoices(r).filter((v) => (voiceDownUntil.get(v) ?? 0) < now);
  // A voice that failed recently → skip straight to the backup (saves ~2.6s); retry it once the cooldown ends
  const order = (voiceDownUntil.get(r.voice) ?? 0) > now && alts.length ? [...alts.slice(0, 1), r.voice] : [r.voice, ...alts.slice(0, 1)];
  let last: unknown;
  for (let i = 0; i < order.length; i++) {
    const voice = order[i];
    try {
      const audio = await synth({ ...r, voice }, i === 0 ? 2000 : 3000);
      voiceDownUntil.delete(voice);
      return { audio, voice };
    } catch (e) {
      last = e;
      voiceDownUntil.set(voice, Date.now() + VOICE_COOLDOWN_MS);
    }
  }
  throw last;
}

export async function handleTts(body: unknown, cors: Record<string, string>): Promise<Response> {
  const r = validateTts(body);
  try {
    const { audio, voice } = await synthesizeSafe(r);
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-Voice": voice, ...cors },
    });
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError("UPSTREAM_DOWN");
    return new Response(JSON.stringify(errorBody(err)), { status: HTTP_STATUS[err.code], headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
  }
}

/** ตรวจ voice list จริง (Phase 3) */
export async function listVoices(): Promise<string[]> {
  const res = await fetch(`https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGecV2()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`);
  if (!res.ok) throw new AppError("UPSTREAM_DOWN", undefined, res.status);
  const list = (await res.json()) as { ShortName: string }[];
  return list.map((v) => v.ShortName);
}
