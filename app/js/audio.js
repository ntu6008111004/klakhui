// เสียง: <audio> ตัวเดียวทั้งแอป + คิว (ไม่เล่นซ้อน), ปลดล็อก iOS ตอนแตะครั้งแรก,
// edge-tts ล้ม → speechSynthesis ของเครื่องทันที (ผู้ใช้ต้องได้ยินเสียงเสมอ)
import { chunkForTts } from "./core/text.js";
import { fmtPitch, fmtRate } from "./config.js";

const VOICE_LANG = { th: "th-TH", zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR" };
/** WAV เงียบ 0.05 วิ (สร้างเอง ไม่ต้องพึ่งไฟล์) ใช้ปลดล็อกเสียงบน iOS */
function silentWav(ms = 50, rate = 8000) {
  const n = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}
const SILENT_MP3 = silentWav();

export class AudioOut extends EventTarget {
  /** @param {{el:HTMLAudioElement, api:import("./api.js").Api, settings:()=>any}} o */
  constructor(o) {
    super();
    this.el = o.el;
    this.api = o.api;
    this.settings = o.settings;
    this.unlocked = false;
    /** @type {{text:string, lang:string, opts:any, resolve:Function}[]} */ this.queue = [];
    this.playing = false;
    this.cache = new Map(); // key → objectURL (จำเสียงที่เคยได้ ไม่ต้องขอซ้ำ)
    this.ctx = null;
    this.current = null;
    this.speaking = false;
    this.el.setAttribute("playsinline", "");
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** iOS บล็อก autoplay → เล่นเสียงเงียบตอนแตะครั้งแรก */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.el.src = SILENT_MP3;
      const p = this.el.play();
      p?.catch?.(() => { this.unlocked = false; });
    } catch { this.unlocked = false; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.ctx) {
        this.ctx = new AC();
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      }
      this.ctx?.resume?.();
    } catch { /* ignore */ }
    try { speechSynthesis?.getVoices(); } catch { /* ignore */ }
  }

  /**
   * พูด (เข้าคิว ไม่เล่นซ้อน)
   * @param {string} text @param {string} lang
   * @param {{device?:boolean, rateBoost?:number, priority?:boolean, volume?:number}} [opts]
   */
  speak(text, lang, opts = {}) {
    if (!text?.trim()) return Promise.resolve();
    return new Promise((resolve) => {
      const item = { text, lang, opts, resolve };
      if (opts.priority) { this.stop(); this.queue.unshift(item); } else this.queue.push(item);
      this.pump();
    });
  }

  get backlog() { return this.queue.length + (this.playing ? 1 : 0); }

  /** ข้ามของเก่า เหลือแค่รายการล่าสุด */
  keepLatest() {
    while (this.queue.length > 1) this.queue.shift().resolve();
  }

  stop() {
    for (const q of this.queue) q.resolve();
    this.queue = [];
    try { this.el.pause(); } catch { /* ignore */ }
    try { speechSynthesis?.cancel(); } catch { /* ignore */ }
    this.current?.resolve?.();
  }

  async pump() {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) { if (this.speaking) { this.speaking = false; this.emit("idle"); } return; }
    this.playing = true;
    if (!this.speaking) { this.speaking = true; this.emit("busy"); }
    this.current = item;
    this.emit("speak", { text: item.text, lang: item.lang });
    try {
      if (item.opts.device) await this.playDevice(item.text, item.lang, item.opts);
      else await this.playEdge(item.text, item.lang, item.opts);
    } catch {
      /* เงียบไว้ ไปท่อนต่อไป */
    } finally {
      item.resolve();
      this.current = null;
      this.playing = false;
      this.pump();
    }
  }

  ttsBody(text, lang, opts) {
    const s = this.settings();
    const rate = Math.min(100, s.rate + (opts.rateBoost ?? 0));
    return { text, lang, gender: s.gender, rate: fmtRate(rate), pitch: fmtPitch(s.pitch) };
  }

  cacheKey(b) { return `${b.lang}|${b.gender}|${b.rate}|${b.pitch}|${b.text}`; }

  /** ขอเสียงล่วงหน้า (ประโยคด่วน / ท่อนถัดไป) */
  async prefetch(text, lang, opts = {}) {
    const b = this.ttsBody(text, lang, opts);
    const k = this.cacheKey(b);
    if (this.cache.has(k)) return this.cache.get(k);
    const p = this.fetchAudio(b).then((url) => { this.cache.set(k, url); return url; });
    this.cache.set(k, p);
    try { return await p; } catch (e) { this.cache.delete(k); throw e; }
  }

  async fetchAudio(b) {
    // ประโยคด่วน: ลองจาก Cache Storage ก่อน (เล่นได้ตอนออฟไลน์)
    const cacheUrl = `/__tts/${encodeURIComponent(this.cacheKey(b))}`;
    try {
      const c = await caches.open("qp-audio-v1");
      const hit = await c.match(cacheUrl);
      if (hit) return URL.createObjectURL(await hit.blob());
      const blob = await this.api.tts(b);
      if (b.text.length <= 120) c.put(cacheUrl, new Response(blob, { headers: { "Content-Type": "audio/mpeg" } })).catch(() => {});
      return URL.createObjectURL(blob);
    } catch (e) {
      if (typeof caches === "undefined") return URL.createObjectURL(await this.api.tts(b));
      throw e;
    }
  }

  async playEdge(text, lang, opts) {
    const chunks = chunkForTts(text);
    try {
      // ขอท่อนแรกก่อน เล่นทันที ระหว่างนั้นขอท่อนถัดไป
      let next = this.prefetch(chunks[0], lang, opts);
      for (let i = 0; i < chunks.length; i++) {
        const url = await next;
        if (i + 1 < chunks.length) next = this.prefetch(chunks[i + 1], lang, opts);
        await this.playUrl(url, opts);
      }
    } catch {
      this.emit("fallback", { lang });
      await this.playDevice(text, lang, opts);
    }
  }

  /** บลูทูธมักกลืนพยางค์แรก → เล่นความเงียบนำหน้า 200ms */
  async padForBluetooth() {
    if (this.settings().headset !== "bt" || !this.ctx) return;
    try {
      await this.ctx.resume();
      const buf = this.ctx.createBuffer(1, Math.round(this.ctx.sampleRate * 0.2), this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.ctx.destination);
      await new Promise((r) => { src.onended = r; src.start(); setTimeout(r, 300); });
    } catch { /* ignore */ }
  }

  playUrl(url, opts = {}) {
    return new Promise(async (resolve, reject) => {
      await this.padForBluetooth();
      const el = this.el;
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error("play")); };
      const cleanup = () => { el.removeEventListener("ended", done); el.removeEventListener("error", fail); clearTimeout(guard); };
      el.addEventListener("ended", done, { once: true });
      el.addEventListener("error", fail, { once: true });
      const guard = setTimeout(done, 30_000);
      this.current = { ...this.current, resolve: done };
      el.src = url;
      el.volume = opts.volume ?? (this.settings().headset === "none" ? 0.85 : 1);
      el.playbackRate = 1;
      const p = el.play();
      if (p?.catch) p.catch(fail);
    });
  }

  pickVoice(lang) {
    const want = VOICE_LANG[lang];
    const voices = speechSynthesis.getVoices();
    const s = this.settings();
    const same = voices.filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith(want.slice(0, 2).toLowerCase()));
    const exact = same.filter((v) => v.lang.replace("_", "-").toLowerCase() === want.toLowerCase());
    const pool = exact.length ? exact : same;
    const female = /female|woman|premwadee|kanya|narisa|xiaoxiao|ting|mei|kyoko|o-ren|yuna|samantha|ava|zira/i;
    const male = /male|man|niwat|yunxi|otoya|kenji|minsu|daniel|alex|david/i;
    return pool.find((v) => (s.gender === "male" ? male : female).test(v.name)) ?? pool[0] ?? null;
  }

  playDevice(text, lang, opts = {}) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = VOICE_LANG[lang];
        const v = this.pickVoice(lang);
        if (v) u.voice = v;
        const s = this.settings();
        u.rate = Math.max(0.6, Math.min(2, 1 + (s.rate + (opts.rateBoost ?? 0)) / 100));
        u.pitch = Math.max(0.5, Math.min(1.5, 1 + s.pitch / 25));
        u.volume = opts.volume ?? (s.headset === "none" ? 0.85 : 1);
        const guard = setTimeout(resolve, Math.max(4000, text.length * 220));
        u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
        this.current = { ...this.current, resolve };
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch {
        resolve();
      }
    });
  }
}
