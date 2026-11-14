// โหมด "รับฟังตลอด": ไมค์ (ภาษาเพื่อน) → Segmenter → EchoFilter → Coalescer → stream แปล → จอ + เสียงไทย
import { uid } from "./core/id.js";
import { Coalescer, EchoFilter, Segmenter } from "./core/listen.js";
import { ContinuousListener } from "./stt.js";
import { LANGS } from "./config.js";
import { toHints } from "./core/glossary.js";
import { ApiError } from "./core/retry.js";

export class ListenMode extends EventTarget {
  /**
   * @param {{api:any, audio:any, settings:()=>any, glossary:()=>any, history:()=>any[], ui:any, onTurn:(t:any)=>void}} o
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.active = false;
    this.paused = false;
    this.echo = new EchoFilter();
    this.lastSpeakEnd = 0;
    this.items = new Map();
    this.metrics = [];
  }

  get lang() { return this.settings().lang; }

  start() {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    const s = this.settings();
    this.segmenter = new Segmenter({
      lang: this.lang,
      silenceMs: s.headset === "bt" ? 900 : 700,
      onSegment: (t) => this.onSegment(t),
    });
    this.coalescer = new Coalescer({ run: (job) => this.translateJob(job), sep: this.lang === "en" ? " " : "，" });
    this.coalescer.onQueued = (job) => this.ui.listenUpsert(job.id, { src: job.text, pending: true });
    this.stt = new ContinuousListener(LANGS[this.lang].stt);
    this.stt.addEventListener("state", (e) => this.ui.listenLight(e.detail.state, e.detail.why));
    this.stt.addEventListener("interim", (e) => this.onInterim(e.detail.text));
    this.stt.addEventListener("final", (e) => this.onFinal(e.detail.text));
    this.onAudioBusy = () => { this.appSpeaking = true; };
    this.onAudioIdle = () => { this.appSpeaking = false; this.lastSpeakEnd = Date.now(); };
    this.onAudioSpeak = (e) => this.echo.noteSpoken(e.detail.text);
    this.audio.addEventListener("busy", this.onAudioBusy);
    this.audio.addEventListener("idle", this.onAudioIdle);
    this.audio.addEventListener("speak", this.onAudioSpeak);
    this.stt.start();
    this.ui.listenOpen(this.lang, s.headset);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stt?.stop();
    this.segmenter?.reset();
    this.audio.removeEventListener("busy", this.onAudioBusy);
    this.audio.removeEventListener("idle", this.onAudioIdle);
    this.audio.removeEventListener("speak", this.onAudioSpeak);
    this.audio.stop();
    this.ui.listenClose();
  }

  /** "ฉันจะพูด": พักฟัง → ผู้ใช้พูด → กลับมาฟังต่อเอง */
  pause() { this.paused = true; this.stt?.stop(); this.segmenter?.reset(); this.ui.listenLight("off", "พักฟังอยู่"); }
  resume() { if (!this.active) return; this.paused = false; this.stt?.start(); }

  /** ไม่ใส่หูฟัง: ระหว่างแอปพูด (และหลังจบ 600ms) ให้พักการส่งท่อน */
  get suppress() {
    return this.settings().headset === "none" && (this.appSpeaking || Date.now() - this.lastSpeakEnd < 600);
  }

  onInterim(text) {
    this.ui.listenInterim(text);
    if (!this.suppress) this.segmenter.interim(text);
  }

  onFinal(text) {
    this.ui.listenInterim("");
    if (this.suppress) { this.segmenter.reset(); return; }
    this.segmenter.final(text);
  }

  onSegment(text) {
    if (this.echo.isEcho(text)) return; // เสียงของแอปเองย้อนเข้าไมค์ → ทิ้ง
    this.segEndAt = performance.now();
    this.coalescer.push(text);
  }

  async translateJob(job) {
    const t0 = this.segEndAt ?? performance.now();
    const s = this.settings();
    const req = {
      text: job.text,
      direction: "partner_to_me",
      target_lang: this.lang,
      domain: s.domain,
      history: this.history().slice(-4),
      glossary: toHints(this.glossary().find(job.text, { lang: this.lang, domain: s.domain })),
      request_id: uid(),
      segment_id: String(job.id),
    };
    let th = "";
    let firstAt = 0;
    this.ui.listenUpsert(job.id, { src: job.text, th: "", pending: true });
    try {
      if (!this.api.streamEnabled) throw new ApiError("UPSTREAM_DOWN");
      let meta = null;
      await this.api.stream(req, {
        onDelta: (d) => {
          if (!firstAt) { firstAt = performance.now(); this.metrics.push(firstAt - t0); }
          th += d;
          this.ui.listenUpsert(job.id, { src: job.text, th, pending: true });
        },
        onMeta: (m) => { meta = m; },
      });
      this.finish(job, { translation: th.trim(), tone: meta?.tone ?? "neutral", note_th: meta?.note_th ?? "" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "ABORTED") return;
      // stream หลุด/ใช้ไม่ได้ → เก็บข้อความที่ได้ไว้ → ขอใหม่แบบไม่ stream แล้วแทนที่ทั้งท่อน
      try {
        const r = await this.api.translate(req);
        if (!firstAt) this.metrics.push(performance.now() - t0);
        this.finish(job, r);
      } catch (e2) {
        this.ui.listenUpsert(job.id, { src: job.text, th: th || "แปลไม่สำเร็จ", pending: false, failed: !th });
      }
    }
  }

  finish(job, r) {
    this.ui.listenUpsert(job.id, { src: job.text, th: r.translation, tone: r.tone, note: r.note_th, pending: false });
    this.onTurn({ who: "partner", text: job.text, translation: r.translation, tone: r.tone, note_th: r.note_th, via: "listen" });
    this.speakThai(r.translation);
  }

  speakThai(text) {
    const s = this.settings();
    if (s.listenRead === "off" || !text) return;
    const backlog = this.audio.backlog;
    if (s.listenRead === "latest" || backlog > 4) this.audio.keepLatest();
    // คิวค้าง > 2 ท่อน → เร่งความเร็วอ่าน +25%
    const rateBoost = backlog > 2 ? 25 : 0;
    this.audio.speak(text, "th", { device: s.listenVoice !== "edge", rateBoost });
  }
}
