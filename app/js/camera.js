// แปลจากภาพ: ถ่าย/เลือกรูป + กล้องแปลสด (อ่านเฉพาะตอนกล้องนิ่งและภาพเปลี่ยน — ประหยัดเน็ต/โควตา)
import { fitSize, imageDirection, LiveGate, pairLines, toGray } from "./core/image.js";
import { toHints } from "./core/glossary.js";
import { ApiError } from "./core/retry.js";
import { uid } from "./core/id.js";
import { h } from "./ui.js";

const $ = (s) => document.querySelector(s);
const PHOTO_MAX = 1600; // ด้านยาวสุดของรูปที่ส่ง (ชัดพอสำหรับ OCR, ไฟล์ ~150–300KB)
const LIVE_MAX = 1280;

/** วาดภาพลง canvas ขนาดย่อ → data URL JPEG */
function toJpeg(src, sw, sh, max, quality) {
  const { w, h: hh } = fitSize(sw, sh, max);
  const c = document.createElement("canvas");
  c.width = w; c.height = hh;
  c.getContext("2d").drawImage(src, 0, 0, w, hh);
  return c.toDataURL("image/jpeg", quality);
}

async function fileToJpeg(file) {
  // createImageBitmap หมุนรูปตาม EXIF ให้เอง (รูปจากมือถือไม่กลับหัว)
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = bmp.width ?? bmp.naturalWidth, hh = bmp.height ?? bmp.naturalHeight;
  return toJpeg(bmp, w, hh, PHOTO_MAX, 0.82);
}

export class CameraTranslate {
  /** @param {{api:any, audio:any, ui:any, settings:()=>any, glossary:()=>any, onSave:(r:any)=>void}} o */
  constructor(o) {
    Object.assign(this, o);
    this.view = $("#cam-view");
    this.video = $("#cam-video");
    this.photo = $("#cam-photo");
    this.list = $("#cam-list");
    this.status = $("#cam-status");
    this.stream = null;
    this.timer = 0;
    this.gate = new LiveGate();
    this.last = null; // ผลล่าสุด {lines, translation, direction, note}
    this.seq = 0;
    $("#cam-close").addEventListener("click", () => this.close());
    $("#cam-shot").addEventListener("click", () => this.freeze());
    $("#cam-again").addEventListener("click", () => this.again());
    $("#cam-read").addEventListener("click", () => this.readAloud());
    $("#cam-save").addEventListener("click", () => { if (this.last) { this.onSave(this.last); this.ui.toast("บันทึกลงบทสนทนาแล้ว"); } });
    $("#cam-file").addEventListener("change", (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) this.fromFile(f); });
    document.addEventListener("visibilitychange", () => { if (document.hidden && this.stream) this.stopStream(); else if (!document.hidden && this.mode === "live" && !this.stream) this.startLive(); });
  }

  setShotLabel(mode) {
    $("#cam-shot span").textContent = mode === "live" ? "ถ่ายแปลภาพนี้" : "ถ่าย/เลือกรูปใหม่";
  }

  setStatus(text, kind = "") { this.status.textContent = text; this.status.dataset.kind = kind; }

  open(mode) {
    this.mode = mode;
    this.view.hidden = false;
    this.view.dataset.mode = mode;
    this.setShotLabel(mode);
    this.list.replaceChildren();
    this.last = null;
    $("#cam-actions").hidden = true;
  }

  close() {
    this.stopStream();
    this.view.hidden = true;
    this.mode = null;
    this.audio.stop();
  }

  /* ===== ถ่าย/เลือกรูป ===== */
  pickPhoto() { $("#cam-file").click(); }

  async fromFile(file) {
    this.open("photo");
    this.setStatus("กำลังเตรียมรูป…");
    try {
      const jpeg = await fileToJpeg(file);
      this.photo.src = jpeg;
      await this.process(jpeg);
    } catch {
      this.setStatus("เปิดรูปนี้ไม่ได้ ลองรูปอื่น", "bad");
    }
  }

  /* ===== กล้องแปลสด ===== */
  async startLive() {
    this.open("live");
    this.setStatus("กำลังเปิดกล้อง…");
    this.gate = new LiveGate();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
    } catch (e) {
      this.setStatus(e?.name === "NotAllowedError" ? "ยังไม่ได้อนุญาตกล้อง — เปิดสิทธิ์กล้องในการตั้งค่าเบราว์เซอร์" : "เปิดกล้องไม่ได้ — ใช้ปุ่มถ่ายรูปแทน", "bad");
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.setStatus("เล็งไปที่ตัวหนังสือแล้วถือนิ่งๆ");
    const small = document.createElement("canvas");
    small.width = 48; small.height = 36;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.stream || this.video.readyState < 2) return;
      sctx.drawImage(this.video, 0, 0, 48, 36);
      const g = toGray(sctx.getImageData(0, 0, 48, 36).data);
      const s = this.gate.feed(g, performance.now());
      if (s === "read") this.captureLive();
      else if (s === "moving" && !this.gate.busy) this.setStatus("ถือนิ่งๆ สักครู่…");
    }, 450);
  }

  async captureLive() {
    const v = this.video;
    const jpeg = toJpeg(v, v.videoWidth, v.videoHeight, LIVE_MAX, 0.72);
    try { await this.process(jpeg, true); } finally { this.gate.done(); }
  }

  /** หยุดภาพปัจจุบันไว้ (เหมือนถ่ายรูป) แล้วอ่านทันที */
  async freeze() {
    if (this.mode !== "live" || !this.stream) return this.pickPhoto();
    const v = this.video;
    const jpeg = toJpeg(v, v.videoWidth, v.videoHeight, PHOTO_MAX, 0.82);
    this.stopStream();
    this.view.dataset.mode = "photo";
    this.mode = "photo";
    this.setShotLabel("photo");
    this.photo.src = jpeg;
    await this.process(jpeg);
  }

  /** อ่านใหม่: โหมดรูป = อ่านรูปเดิมซ้ำ / กล้องสด = บังคับอ่านเฟรมถัดไป */
  again() {
    if (this.view.dataset.mode === "photo") { if (this.photo.src) this.process(this.photo.src); }
    else { this.gate.reset(); this.setStatus("อ่านใหม่…"); }
  }

  stopStream() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /* ===== อ่าน → แปล → แสดงรายบรรทัด ===== */
  async process(jpeg, live = false) {
    const my = ++this.seq;
    this.setStatus("กำลังอ่านตัวหนังสือ…", "busy");
    let ocr;
    try {
      ocr = await this.api.ocr(jpeg);
    } catch (e) {
      if (my !== this.seq) return;
      const msg = e instanceof ApiError && e.code === "RATE_LIMIT" ? "อ่านถี่ไป รอแป๊บเดียว" : e instanceof ApiError ? e.message_th : "อ่านไม่สำเร็จ";
      this.setStatus(msg, "bad");
      return;
    }
    if (my !== this.seq) return;
    if (!ocr.lines?.length) {
      this.setStatus(live ? "ยังไม่เจอตัวหนังสือ — เล็งให้ชัด/ใกล้ขึ้น" : "ไม่เจอตัวหนังสือในรูปนี้", "bad");
      return;
    }
    const s = this.settings();
    const text = ocr.lines.join("\n");
    const direction = imageDirection(text);
    this.render(ocr.lines.map((src) => ({ src, tr: "" })), "", direction);
    this.setStatus("กำลังแปล…", "busy");
    const req = {
      text, direction, target_lang: s.lang, domain: s.domain, history: [],
      glossary: toHints(this.glossary().find(text, { domain: s.domain })),
      request_id: uid(), source: "image",
    };
    const show = (tr, note) => { if (my === this.seq) this.render(pairLines(ocr.lines, tr), note, direction); };
    try {
      const r = await this.api.translateFast(req, {
        onProgress: (p) => show(p.translation, ""),
        onPartial: (p) => show(p.translation, ""),
      });
      if (my !== this.seq) return;
      show(r.translation, r.note_th);
      this.last = { lines: ocr.lines, translation: r.translation, note: r.note_th, direction, lang: s.lang };
      $("#cam-actions").hidden = false;
      this.setStatus(live ? "✓ แปลแล้ว — เล็งที่อื่นได้เลย" : "✓ แปลแล้ว", "ok");
    } catch (e) {
      if (my !== this.seq) return;
      this.setStatus(e instanceof ApiError ? e.message_th : "แปลไม่สำเร็จ", "bad");
    }
  }

  render(rows, note, direction) {
    const tLang = direction === "partner_to_me" ? "th" : this.settings().lang;
    this.list.replaceChildren(
      ...(note ? [h("li", { class: "cam-note", text: `💡 ${note}` })] : []),
      ...rows.map((r) => h("li", { class: "cam-row" }, [
        h("div", { class: "cam-src", text: r.src }),
        h("div", { class: "cam-tr", lang: tLang, text: r.tr || "…" }),
      ])),
    );
  }

  readAloud() {
    if (!this.last) return;
    const th = this.last.direction === "partner_to_me";
    this.audio.speak(this.last.translation.replace(/\n+/g, " "), th ? "th" : this.last.lang, { priority: true, device: th && this.settings().listenVoice !== "edge" });
  }
}
