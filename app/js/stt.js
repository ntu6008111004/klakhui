// STT ผ่าน Web Speech API: กดค้างพูด (push-to-talk) + ฟังต่อเนื่องพร้อม auto-restart/watchdog

const SR = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const sttSupported = !!SR;

export const STT_ERRORS = {
  "no-speech": "ไม่ได้ยินเสียง ลองพูดใหม่อีกที (ใกล้ไมค์ขึ้นนิด)",
  "not-allowed": "ยังไม่ได้อนุญาตไมค์ — แตะรูปกุญแจ/aA ที่แถบที่อยู่ แล้วเปิด \"ไมโครโฟน\"",
  "service-not-allowed": "เครื่องนี้ไม่ให้ฟังเสียงในโหมดนี้ — ลองเปิดผ่าน Safari แทนไอคอนหน้าจอโฮม",
  network: "ระบบฟังเสียงต้องใช้เน็ต — สลับไปพิมพ์แทนชั่วคราว",
  "audio-capture": "ไม่พบไมโครโฟน หรือแอปอื่นใช้อยู่",
  aborted: "",
  "language-not-supported": "เครื่องนี้ฟังภาษานี้ไม่ได้ ใช้การพิมพ์แทน",
};

/** กดค้างพูด: start() ตอนกด, stop() ตอนปล่อย */
export class PushToTalk {
  /**
   * @param {{lang:string, onInterim:(t:string)=>void, onFinal:(t:string)=>void, onError:(code:string)=>void, onEnd?:()=>void}} h
   */
  constructor(h) {
    this.h = h;
    this.rec = null;
    this.finalText = "";
    this.interimText = "";
    this.stopping = false;
  }

  start() {
    if (!SR) return this.h.onError("unsupported");
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.h.lang;
    rec.interimResults = true;
    rec.continuous = true; // กดค้างนานได้ ไม่ตัดเองกลางประโยค
    rec.maxAlternatives = 1;
    this.finalText = "";
    this.interimText = "";
    this.stopping = false;
    rec.onresult = (e) => {
      let fin = "", int = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else int += r[0].transcript;
      }
      this.finalText = fin;
      this.interimText = int;
      this.h.onInterim((fin + int).trim());
    };
    rec.onerror = (e) => { if (e.error !== "aborted") this.h.onError(e.error); };
    rec.onend = () => {
      const text = (this.finalText + this.interimText).trim();
      this.rec = null;
      this.h.onFinal(text);
      this.h.onEnd?.();
    };
    try { rec.start(); } catch { this.h.onError("audio-capture"); }
  }

  stop() {
    if (!this.rec || this.stopping) return;
    this.stopping = true;
    // หน่วงนิดให้คำสุดท้ายเข้ามาครบ
    setTimeout(() => { try { this.rec?.stop(); } catch { /* ignore */ } }, 250);
  }

  abort() {
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
  }
}

/**
 * ฟังต่อเนื่องสำหรับโหมดรับฟังตลอด:
 * - onend/onerror ขณะสวิตช์เปิด → start() ใหม่ (backoff 300ms → 1s → 3s, reset เมื่อสำเร็จ)
 * - watchdog: ไม่มี event นาน 15 วิ → stop + start ใหม่
 * - กลับจากพื้นหลัง → resume เอง
 */
export class ContinuousListener extends EventTarget {
  constructor(lang) {
    super();
    this.lang = lang;
    this.on = false;
    this.rec = null;
    this.fails = 0;
    this.lastEvent = 0;
    this.watchdog = null;
    this.restartTimer = null;
    this.state = "off";
    this.onVis = () => { if (document.visibilityState === "visible" && this.on) this.restart(0, "กลับมาจากพื้นหลัง"); };
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s, why = "") { this.state = s; this.emit("state", { state: s, why }); }

  start() {
    if (!SR) { this.setState("off", "เครื่องนี้ไม่รองรับการฟังเสียง ใช้ Safari/Chrome รุ่นใหม่"); return; }
    this.on = true;
    document.addEventListener("visibilitychange", this.onVis);
    this.watchdog = setInterval(() => {
      if (this.on && Date.now() - this.lastEvent > 15_000) this.restart(0, "เงียบนานเกิน เริ่มใหม่");
    }, 3000);
    this.spawn();
  }

  stop() {
    this.on = false;
    clearInterval(this.watchdog);
    clearTimeout(this.restartTimer);
    document.removeEventListener("visibilitychange", this.onVis);
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
    this.setState("off", "");
  }

  setLang(lang) {
    this.lang = lang;
    if (this.on) this.restart(0, "เปลี่ยนภาษา");
  }

  restart(delay, why) {
    if (!this.on) return;
    clearTimeout(this.restartTimer);
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
    this.setState("restarting", why);
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  spawn() {
    if (!this.on) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.lastEvent = Date.now();
    rec.onstart = () => { this.lastEvent = Date.now(); this.setState("on"); };
    rec.onaudiostart = () => { this.lastEvent = Date.now(); };
    rec.onresult = (e) => {
      this.lastEvent = Date.now();
      this.fails = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.emit("final", { text: r[0].transcript });
        else interim += r[0].transcript;
      }
      if (interim) this.emit("interim", { text: interim });
    };
    rec.onerror = (e) => {
      this.lastEvent = Date.now();
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.on = false;
        this.setState("off", STT_ERRORS[e.error]);
        return;
      }
      if (e.error !== "no-speech" && e.error !== "aborted") this.fails++;
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.on) return;
      const delay = [300, 1000, 3000][Math.min(this.fails, 2)];
      this.restart(delay, this.fails ? "เชื่อมต่อใหม่" : "");
    };
    try { rec.start(); } catch { this.fails++; this.restart(1000, "เริ่มใหม่"); }
  }
}
