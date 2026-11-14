// กล้าคุย — ต่อสายทุกอย่างเข้าด้วยกัน
import { uid } from "./core/id.js";
import { LANGS, apiBase, loadSettings, saveSettings, fmtPitch, fmtRate } from "./config.js";
import { Api } from "./api.js";
import { AudioOut } from "./audio.js";
import { PushToTalk, STT_ERRORS, sttSupported } from "./stt.js";
import { Glossary, toHints } from "./core/glossary.js";
import { ApiError, MSG } from "./core/retry.js";
import { sentenceEnd } from "./core/text.js";
import { UI, h } from "./ui.js";
import { db } from "./db.js";
import { ListenMode } from "./listen-mode.js";
import { detectHeadset, runWizard, watchDevices } from "./headset.js";

const $ = (s) => document.querySelector(s);
let settings = loadSettings();
const save = (patch) => { settings = { ...settings, ...patch }; saveSettings(settings); applySettings(); };

const api = new Api({ base: () => apiBase(settings), token: () => settings.token });
const audio = new AudioOut({ el: $("#player"), api, settings: () => settings });
let glossary = new Glossary();
let builtin = [];
let userWords = [];
let phrases = { categories: [], phrases: [] };
/** @type {any[]} */ let turns = [];
const inflight = { me: null, partner: null }; // AbortController ต่อฝั่ง

const ui = new UI({
  onReplay: (t, side) => side === "partner" ? audio.speak(t.result.translation, settings.lang, { priority: true }) : audio.speak(t.result.translation, "th", { priority: true }),
  onRetry: (t) => sendTurn(t),
  onAddWord: (w) => openWordDialog(w),
  onReply: (r) => sayReady(r.th, r.target, "reply", r.lang),
  onPhrases: () => openPhrases(),
});

/* ================= ตั้งค่า / ภาษา ================= */
/** ภาษาไมค์แต่ละฝั่ง (การแปลตรวจภาษาเองอยู่แล้ว ตัวนี้บอก STT ว่าจะฟังภาษาอะไร) */
// "zh-en" = เพื่อนพูดจีนปนอังกฤษ → ใช้ตัวฟังจีน (จับคำอังกฤษที่ปนมาได้ดีกว่าฟังทีละภาษา) การแปลตรวจภาษาเองทั้งประโยค
const STT_LANG = { th: "th-TH", zh: "zh-CN", "zh-en": "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR" };
const micLang = { me: "th", partner: null };
const partnerMic = () => micLang.partner ?? settings.lang;
function renderMicChips() {
  for (const [side, cur] of [["me", micLang.me], ["partner", partnerMic()]]) {
    for (const b of document.querySelectorAll(`#mic-${side} [data-mic]`)) b.setAttribute("aria-checked", String(b.dataset.mic === cur));
  }
}
for (const side of ["me", "partner"]) {
  $(`#mic-${side}`).addEventListener("click", (e) => {
    const b = e.target.closest("[data-mic]");
    if (!b) return;
    micLang[side] = b.dataset.mic;
    renderMicChips();
    if (side === "partner" && listen.active) listen.stt?.setLang(STT_LANG[partnerMic()]);
  });
}
/** ภาษาที่ใช้พูดตอบกลับ = ภาษาที่เพื่อนเพิ่งพูด (ถ้ารู้) ไม่งั้นภาษาที่เลือก */
const replyLang = (detected) => (["zh", "en", "ja", "ko"].includes(detected) ? detected : settings.lang);

function applySettings() {
  renderMicChips();
  const L = LANGS[settings.lang];
  $("#partner-hint").textContent = L.hint;
  $("#talk-partner-label").textContent = L.talk;
  $("#input-partner").placeholder = L.type;
  $("#half-partner").lang = settings.lang;
  $("#app").dataset.layout = settings.layout;
}

/* ================= คลังคำ ================= */
async function loadGlossary() {
  // learned = คำที่ "จำ" จากการทดสอบ 500 ประโยค (โหลดท้ายสุด = ใช้แทนความหมายเดิมถ้าซ้ำ) — ค้นในเครื่อง ไม่ทำให้ช้า
  const langs = ["zh", "en", "ja", "ko", "th", "learned"];
  const lists = await Promise.all(langs.map((l) => fetch(`data/glossary/${l}.json`).then((r) => r.json()).catch(() => [])));
  builtin = lists.flat();
  userWords = await db.all("words");
  rebuildGlossary();
}
function rebuildGlossary() {
  glossary = new Glossary().load([...builtin, ...userWords.map((w) => ({ ...w, user: true }))]);
  $("#glossary-count").textContent = `คำในคลัง ${builtin.length.toLocaleString("th")} คำ + ของฉัน ${userWords.length} คำ`;
}
function hintsFor(text, srcLang) {
  return toHints(glossary.find(text, { lang: srcLang, domain: settings.domain }));
}

/* ================= บทสนทนา ================= */
function historyForApi() {
  return turns.filter((t) => t.status === "done").slice(-4).map((t) => ({ who: t.who, text: t.text.slice(0, 200), translation: (t.result?.translation ?? "").slice(0, 200) }));
}

function newTurn(who, text, via = "voice") {
  const t = { id: uid(), who, text, via, lang: settings.lang, status: "pending", at: Date.now() };
  turns.push(t);
  ui.upsert(t, settings);
  return t;
}

async function persist(t) {
  if (t.status === "done") await db.put("history", { id: t.id, who: t.who, text: t.text, lang: t.lang, result: t.result, at: t.at, via: t.via });
}

/** ผู้ใช้พูดซ้อนระหว่างรอ (ฝั่งเดียวกัน) → ยกเลิกคำขอเก่า แล้วรวมข้อความเก่า+ใหม่ส่งครั้งเดียว ไม่ให้ข้อความหาย */
function takeOverPending(side, text) {
  const prev = inflight[side];
  if (!prev) return text;
  prev.ctrl.abort();
  const old = prev.turn;
  turns = turns.filter((x) => x !== old);
  ui.cards.get(old.id)?.me.remove();
  ui.cards.get(old.id)?.partner.remove();
  ui.cards.delete(old.id);
  return `${old.text} ${text}`;
}

async function translateText(who, text, via) {
  text = text.trim();
  if (!text) return;
  const side = who;
  text = takeOverPending(side, text);
  const t = newTurn(who, text, via);
  await sendTurn(t);
}

async function sendTurn(t) {
  const side = t.who;
  t.status = "pending";
  t.error = "";
  t.final = false;
  t.partialOnly = false;
  ui.upsert(t, settings);
  if (!navigator.onLine) return queueOffline(t);
  if (!settings.token) { t.status = "failed"; t.error = MSG.AUTH; ui.upsert(t, settings); openSettings(); return; }

  const ctrl = new AbortController();
  inflight[side] = { ctrl, turn: t };
  const slowTimer = setTimeout(() => ui.banner("slow", "เน็ตช้า — กำลังแปล…"), 4000);
  const srcLang = t.who === "me" ? "th" : settings.lang;
  let spoken = false;
  let spokenLen = 0;
  /** ฝั่งเรา: พูดทีละประโยคที่จบแล้ว (ไม่ต้องรอคำแปลครบทั้งก้อน) */
  const speakUpTo = (text, final) => {
    if (ctrl.signal.aborted) return;
    // ฝั่งเพื่อน: อ่านไทยให้เราฟังอัตโนมัติ (ปิดได้ในตั้งค่า)
    if (t.who === "partner" && !settings.autoReadThai) return;
    // ท่อนแรกตัดที่จุลภาคได้ (เริ่มพูดเร็ว) — ท่อนต่อไปตัดเฉพาะจบประโยค (เสียงลื่น ไม่เป็นห้วงๆ)
    const end = final ? text.length : sentenceEnd(text, spokenLen === 0);
    if (end <= spokenLen) return;
    const seg = text.slice(spokenLen, end).trim();
    spokenLen = end;
    if (seg) {
      if (t.who === "me") audio.speak(seg, settings.lang);
      else audio.speak(seg, "th", { device: settings.listenVoice !== "edge" }); // เสียงเครื่อง = เริ่มพูดทันที
      spoken = true;
    }
  };
  try {
    const r = await api.translateFast({
      text: t.text,
      direction: t.who === "me" ? "me_to_partner" : "partner_to_me",
      target_lang: settings.lang,
      domain: settings.domain,
      history: historyForApi(),
      glossary: hintsFor(t.text, srcLang),
      request_id: t.id,
    }, {
      signal: ctrl.signal,
      // คำแปลไหลขึ้นจอระหว่างโมเดลพิมพ์ + พูดประโยคที่จบแล้ว
      onProgress: (p) => {
        if (ctrl.signal.aborted || t.final || !t.who) return;
        t.result = { ...(t.result ?? {}), translation: p.translation, tone: "neutral", note_th: "", terms: [], replies: [], back_translation_th: "", needs_confirm: false };
        t.status = "done";
        t.partialOnly = true;
        ui.upsert(t, settings);
        clearTimeout(slowTimer);
        ui.banner("", "");
        if (inflight[side]?.turn === t) inflight[side] = null;
        speakUpTo(p.translation, false);
      },
      // คำแปลมาก่อน → ขึ้นจอ + พูดทันที (รายละเอียดน้ำเสียง/สำนวนตามมาทีหลัง)
      onPartial: (p) => {
        if (ctrl.signal.aborted || t.final) return;
        t.result = { ...(t.result ?? {}), translation: p.translation, engine: p.engine ?? t.result?.engine, tone: "neutral", note_th: "", terms: [], replies: [], back_translation_th: "", needs_confirm: false };
        t.status = "done";
        t.partialOnly = true;
        ui.upsert(t, settings);
        clearTimeout(slowTimer);
        ui.banner("", "");
        // พูดไปแล้ว → ห้ามถูกยกเลิก/รวมกับประโยคถัดไป (ไม่งั้นจะพูดซ้ำ)
        if (inflight[side]?.turn === t) inflight[side] = null;
        if (p.chunk) {
          // ข้อความยาว: พูดทีละท่อนตามลำดับ
          if (t.who === "me") { audio.speak(p.chunk, settings.lang); spoken = true; }
          else if (settings.autoReadThai) { audio.speak(p.chunk, "th", { device: settings.listenVoice !== "edge" }); spoken = true; }
        } else speakUpTo(p.translation, true);
        if (t.who === "me") ui.replies([]);
      },
    });
    if (ctrl.signal.aborted && !t.partialOnly) return;
    // กันผลซ้ำ (request_id เดิม) — ได้ผลเต็มแล้วไม่ทับ
    if (t.final) return;
    t.final = true;
    t.partialOnly = false;
    t.result = r;
    t.status = "done";
    ui.upsert(t, settings);
    persist(t);
    statusFromEngine(r.engine);
    if (!spoken) speakUpTo(r.translation, true);
    if (t.who === "me") {
      ui.replies([]);
    } else {
      ui.replies((r.replies ?? []).map((x) => ({ ...x, lang: replyLang(r.detected_lang) })));
    }
  } catch (e) {
    if (t.partialOnly) { t.partialOnly = false; t.final = true; ui.upsert(t, settings); persist(t); return; } // มีคำแปลแล้ว ไม่ต้องแจ้ง error
    if (e instanceof ApiError && e.code === "ABORTED") return;
    const err = e instanceof ApiError ? e : new ApiError("NETWORK");
    if (!navigator.onLine || err.code === "NETWORK") return queueOffline(t);
    t.status = "failed";
    t.error = err.code === "AUTH" ? MSG.AUTH : `แปลไม่สำเร็จ — ${err.message_th}`;
    ui.upsert(t, settings);
    if (err.code === "AUTH") { ui.toast(MSG.AUTH); openSettings(); }
  } finally {
    clearTimeout(slowTimer);
    ui.banner("", "");
    if (inflight[side]?.turn === t) inflight[side] = null;
  }
}

/** เน็ตหลุด → เก็บลงคิว (IndexedDB) แล้วส่งต่ออัตโนมัติเมื่อกลับมา */
async function queueOffline(t) {
  t.status = "queued";
  ui.upsert(t, settings);
  await db.put("outbox", { id: t.id, who: t.who, text: t.text, via: t.via, lang: t.lang, at: t.at });
  setNet();
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine || !settings.token) return;
  flushing = true;
  try {
    const hres = await api.health();
    if (!hres.ok) return;
    const items = (await db.all("outbox")).sort((a, b) => a.at - b.at);
    for (const it of items) {
      let t = turns.find((x) => x.id === it.id);
      if (!t) { t = { ...it, status: "queued" }; turns.push(t); }
      await db.del("outbox", it.id);
      await sendTurn(t);
    }
  } finally {
    flushing = false;
  }
}

/** ประโยคที่แปลไว้แล้ว (ตอบกลับแนะนำ / ประโยคด่วน) → พูดทันที ไม่ต้องเรียก API */
function sayReady(th, target, via, lang = settings.lang) {
  const t = newTurn("me", th, via);
  t.lang = lang;
  t.result = { translation: target, back_translation_th: th, tone: "neutral", note_th: "", terms: [], needs_confirm: false, replies: [] };
  t.status = "done";
  ui.upsert(t, settings);
  persist(t);
  ui.replies([]);
  audio.speak(target, lang, { priority: true });
}

/* ================= สถานะเครือข่าย ================= */
/** "สำรอง" เฉพาะตอนตกไปใช้รุ่นเล็ก 8B (Typhoon 30B แปลได้ดีพอๆ รุ่นหลัก ไม่ต้องทำให้ผู้ใช้กังวล) */
function statusFromEngine(engine) {
  if (engine === "fallback") ui.status("backup", "ใช้รุ่นสำรอง");
  else ui.status("ok", "พร้อม");
}
function setNet() {
  if (!navigator.onLine) {
    ui.banner("offline", MSG.OFFLINE);
    ui.status("offline", "ออฟไลน์");
  } else {
    ui.banner("", "");
    ui.status("ok", "พร้อม");
  }
}
addEventListener("offline", () => { setNet(); api.kickInflight(); });
addEventListener("online", () => { setNet(); api.kickInflight(); flushOutbox(); });
navigator.connection?.addEventListener?.("change", () => { api.kickInflight(); flushOutbox(); });
api.addEventListener("latency", (e) => { if (e.detail.ms > 4000) ui.status("slow", "เน็ตช้า"); });
api.addEventListener("retry", (e) => { if (e.detail.code === "RATE_LIMIT") ui.status("slow", "รอคิวแป๊บ"); });
api.addEventListener("circuit", (e) => {
  const end = Date.now() + e.detail.remainingMs;
  const tick = () => {
    const s = Math.ceil((end - Date.now()) / 1000);
    if (s <= 0) return ui.status("ok", "ลองใหม่…");
    ui.status("down", `ระบบแปลพัก ${s} วิ`);
    setTimeout(tick, 500);
  };
  tick();
});
api.addEventListener("streamoff", () => ui.toast("การแปลแบบทยอยขึ้นมีปัญหา — ใช้แบบปกติ 2 นาที"));
audio.addEventListener("fallback", () => ui.status("backup", "ใช้เสียงเครื่อง"));

/* ================= ไมค์ (กดค้างพูด) ================= */
function setupTalk(btn) {
  const side = btn.dataset.talk;
  let ptt = null;
  let pressed = false;
  const down = (e) => {
    e.preventDefault();
    audio.unlock();
    api.warm(); // เปิดการเชื่อมต่อรอไว้ระหว่างที่ผู้ใช้ยังพูด
    wakeLock();
    if (!sttSupported) return toggleType(side, true);
    if (pressed) return;
    pressed = true;
    audio.stop();
    if (listen.active && !listen.paused) listen.pause();
    btn.classList.add("rec");
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const lang = STT_LANG[side === "me" ? micLang.me : partnerMic()];
    ptt = new PushToTalk({
      lang,
      onInterim: (t) => ui.live(side, t),
      onFinal: (t) => {
        ui.live(side, "");
        if (t) translateText(side, t, "voice");
        else if (!ptt?.errored) ui.toast(STT_ERRORS["no-speech"]);
      },
      onError: (code) => {
        if (ptt) ptt.errored = true;
        const msg = STT_ERRORS[code];
        if (code === "network" || code === "language-not-supported" || code === "unsupported") toggleType(side, true);
        if (msg) ui.toast(msg, 4500);
      },
      onEnd: () => { if (listen.active && listen.paused && side === "me") listen.resume(); },
    });
    ptt.start();
  };
  const up = () => {
    if (!pressed) return;
    pressed = false;
    btn.classList.remove("rec");
    ptt?.stop();
  };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", up);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  // คีย์บอร์ด: Space/Enter ค้าง
  btn.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) down(e); });
  btn.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") up(); });
}

function toggleType(side, force) {
  const form = $(side === "me" ? "#type-me" : "#type-partner");
  form.hidden = force === undefined ? !form.hidden : !force;
  if (!form.hidden) form.querySelector("input").focus();
}

/* ================= ประโยคด่วน ================= */
let phraseCat = "basic";
function openPhrases() {
  audio.unlock();
  const tabs = $("#phrase-tabs");
  tabs.replaceChildren(...phrases.categories.map((c) => h("button", {
    type: "button", role: "tab", "aria-selected": String(c.id === phraseCat),
    onclick: () => { phraseCat = c.id; openPhrases(); },
  }, [c.label])));
  const list = $("#phrase-list");
  list.replaceChildren(...phrases.phrases.filter((p) => p.cat === phraseCat).map((p) => h("button", {
    class: "phrase", type: "button", dataset: { cat: p.cat },
    onclick: () => { $("#dlg-phrases").close(); sayReady(p.th, p[settings.lang], "phrase"); },
  }, [h("b", { text: p.th }), h("small", { lang: settings.lang, text: p[settings.lang] }), (() => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-speaker"); s.append(u); return s; })()])));
  if (!$("#dlg-phrases").open) $("#dlg-phrases").showModal();
}

/** เตรียมเสียงประโยคด่วนไว้ล่วงหน้า (เก็บใน Cache Storage ใช้ตอนออฟไลน์) */
async function precachePhrases() {
  if (!settings.token || !navigator.onLine) return;
  if (navigator.connection?.saveData) return; // ผู้ใช้เปิดโหมดประหยัดข้อมูล
  const important = phrases.phrases.filter((p) => ["basic", "emergency"].includes(p.cat) || (p.cat === "health" && /แพ้|ไม่สบาย|หมอ|โรงพยาบาล/.test(p.th)));
  for (const p of important) {
    try { await audio.prefetch(p[settings.lang], settings.lang); } catch { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ================= คลังคำของฉัน ================= */
function openWordDialog(prefill = {}) {
  const f = $("#word-form");
  f.reset();
  f.term.value = prefill.term ?? "";
  f.meaning_th.value = prefill.meaning_th ?? "";
  f.lang.value = prefill.lang ?? settings.lang;
  $("#dlg-word").showModal();
}
$("#word-form").addEventListener("submit", async (e) => {
  const f = e.target;
  const w = { id: `${f.lang.value}:${f.term.value.trim()}`, term: f.term.value.trim(), meaning_th: f.meaning_th.value.trim(), lang: f.lang.value, tag: f.tag.value, domain: settings.domain };
  if (!w.term || !w.meaning_th) return;
  await db.put("words", w);
  userWords = (await db.all("words"));
  rebuildGlossary();
  ui.toast(`เพิ่ม "${w.term}" ลงคลังแล้ว — ใช้ได้ทันที`);
});
$("#btn-add-word").addEventListener("click", () => openWordDialog());
$("#btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(userWords, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `klakhui-words-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
});
$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    let n = 0;
    for (const w of Array.isArray(list) ? list : []) {
      if (!w?.term || !w?.meaning_th) continue;
      await db.put("words", { id: `${w.lang ?? "zh"}:${w.term}`, term: String(w.term), meaning_th: String(w.meaning_th), lang: w.lang ?? "zh", tag: w.tag ?? "slang", domain: w.domain ?? "general" });
      n++;
    }
    userWords = await db.all("words");
    rebuildGlossary();
    ui.toast(`นำเข้า ${n} คำแล้ว`);
  } catch {
    ui.toast("ไฟล์ไม่ถูกต้อง (ต้องเป็น JSON ที่ส่งออกจากแอปนี้)");
  }
  e.target.value = "";
});

/* ================= ตั้งค่า (dialog) ================= */
function openSettings() {
  const f = $("#settings-form");
  f.autoReadThai.checked = settings.autoReadThai;
  for (const k of ["lang", "domain", "gender", "headset", "listenVoice"]) {
    const el = f.querySelector(`input[name="${k}"][value="${settings[k]}"]`);
    if (el) el.checked = true;
  }
  f.rate.value = settings.rate;
  f.pitch.value = settings.pitch;
  f.token.value = settings.token;
  f.api.value = settings.api;
  $("#out-rate").textContent = fmtRate(settings.rate);
  $("#out-pitch").textContent = fmtPitch(settings.pitch);
  detectHeadset().then((d) => { $("#headset-detected").textContent = d.name ? `พบอุปกรณ์: ${d.name}` : ""; });
  if (!$("#dlg-settings").open) $("#dlg-settings").showModal();
}
$("#settings-form").addEventListener("input", (e) => {
  const f = e.currentTarget;
  const fd = new FormData(f);
  const patch = {
    lang: fd.get("lang") ?? settings.lang,
    domain: fd.get("domain") ?? settings.domain,
    gender: fd.get("gender") ?? settings.gender,
    headset: fd.get("headset") ?? settings.headset,
    listenVoice: fd.get("listenVoice") ?? settings.listenVoice,
    rate: Number(fd.get("rate")),
    pitch: Number(fd.get("pitch")),
    token: String(fd.get("token") ?? "").trim(),
    api: String(fd.get("api") ?? "").trim(),
    autoReadThai: f.autoReadThai.checked,
  };
  const langChanged = patch.lang !== settings.lang;
  save(patch);
  $("#out-rate").textContent = fmtRate(settings.rate);
  $("#out-pitch").textContent = fmtPitch(settings.pitch);
  if (langChanged) { micLang.partner = null; renderMicChips(); ui.replies([]); precachePhrases(); }
});
$("#btn-try-voice").addEventListener("click", () => {
  audio.unlock();
  const sample = { zh: "你好，很高兴认识你！", en: "Hi! Nice to meet you.", ja: "こんにちは、はじめまして！", ko: "안녕하세요, 만나서 반가워요!" };
  audio.speak(sample[settings.lang], settings.lang, { priority: true });
});
$("#btn-clear").addEventListener("click", async () => {
  if (!confirm("ล้างประวัติสนทนาทั้งหมดในเครื่องนี้? (ย้อนกลับไม่ได้)")) return;
  await db.clear("history");
  turns = [];
  ui.clearFeeds();
  ui.toast("ล้างประวัติแล้ว");
});

/* ================= หูฟัง ================= */
let wizardCleanup = null;
$("#btn-headset-test").addEventListener("click", async () => {
  audio.unlock();
  $("#dlg-headset").showModal();
  wizardCleanup = await runWizard($("#wizard"), { audio, settings: () => settings, save, close: () => $("#dlg-headset").close() });
});
$("#dlg-headset").addEventListener("close", () => wizardCleanup?.());
watchDevices(async () => {
  const d = await detectHeadset();
  if (listen.active) {
    listen.stt?.restart(300, "หูฟังเปลี่ยน");
    audio.speak("เชื่อมต่อเสียงแล้ว", "th", { device: true });
  }
  if (d.guess && d.guess !== settings.headset) ui.toast(`พบหูฟัง${d.name ? ` "${d.name}"` : ""} — เปลี่ยนโปรไฟล์ได้ที่ตั้งค่า`, 3500);
});

/* ================= โหมดรับฟังตลอด ================= */
const listen = new ListenMode({
  api, audio, ui,
  sttLang: () => STT_LANG[partnerMic()],
  settings: () => settings,
  glossary: () => glossary,
  history: historyForApi,
  onTurn: (x) => {
    const t = { id: uid(), who: "partner", text: x.text, via: "listen", lang: settings.lang, status: "done", at: Date.now(), result: { translation: x.translation, tone: x.tone, note_th: x.note_th, terms: [], replies: [] } };
    turns.push(t);
    ui.upsert(t, settings);
    persist(t);
  },
});
$("#btn-listen").addEventListener("click", () => {
  audio.unlock();
  if (listen.active) return listen.stop();
  wakeLock();
  listen.start();
  markRead();
});
$("#lv-close").addEventListener("click", () => listen.stop());
$("#lv-pause").addEventListener("click", () => {
  if (listen.paused) { listen.resume(); $("#lv-pause span").textContent = "หยุดฟัง"; }
  else { listen.pause(); $("#lv-pause span").textContent = "ฟังต่อ"; }
});
$("#lv-speak").addEventListener("click", () => {
  // "ฉันจะพูด": พักฟัง → กลับหน้าหลักให้กดค้างพูด → พูดจบกลับมาฟังต่อเอง
  listen.pause();
  $("#listen-view").hidden = true;
  ui.toast("กดค้างปุ่มส้มแล้วพูดได้เลย พูดจบแล้วจะกลับไปฟังต่อเอง", 3500);
  const back = () => {
    setTimeout(() => {
      if (!listen.active) return;
      $("#listen-view").hidden = false;
      listen.resume();
    }, 1200);
  };
  audio.addEventListener("idle", back, { once: true });
});
function markRead() {
  for (const b of document.querySelectorAll("#lv-read button")) b.setAttribute("aria-checked", String(b.dataset.read === settings.listenRead));
}
$("#lv-read").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  save({ listenRead: b.dataset.read });
  markRead();
  if (settings.listenRead === "off") audio.stop();
});

/* ================= Screen Wake Lock ================= */
let lock = null;
async function wakeLock() {
  try {
    if ("wakeLock" in navigator && !lock) {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; });
    }
  } catch { /* ไม่รองรับ / แบตต่ำ */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && turns.length) wakeLock(); });

/* ================= ปุ่มทั่วไป ================= */
document.querySelectorAll("[data-talk]").forEach(setupTalk);
document.querySelectorAll("[data-toggle-type]").forEach((b) => b.addEventListener("click", () => toggleType(b.dataset.toggleType)));
for (const side of ["me", "partner"]) {
  $(`#type-${side}`).addEventListener("submit", (e) => {
    e.preventDefault();
    audio.unlock();
    const inp = $(`#input-${side}`);
    const text = inp.value;
    inp.value = "";
    translateText(side, text, "typed");
  });
}
$("#btn-phrases").addEventListener("click", openPhrases);
$("#replies-close").addEventListener("click", () => ui.replies([]));
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-flip").addEventListener("click", () => {
  save({ layout: settings.layout === "face" ? "solo" : "face" });
  ui.toast(settings.layout === "face" ? "โหมดวางโต๊ะ — ฝั่งบนหันให้เพื่อนอ่าน" : "โหมดถือคนเดียว");
});
$("#status-pill").addEventListener("click", async () => {
  ui.status("slow", "กำลังเช็ก…");
  const r = await api.health();
  if (!r.ok) ui.status("down", r.error === "AUTH" ? "รหัสแอปไม่ถูก" : "ต่อระบบไม่ได้");
  else ui.status("ok", "พร้อม"); // รุ่นหลักล่มแต่มีรุ่นสำรองที่ดีพอ = ใช้งานได้ปกติ
});
document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
document.addEventListener("pointerdown", () => audio.unlock(), { once: true, capture: true });

/* ================= เริ่มใช้งานครั้งแรก ================= */
$("#start-form").addEventListener("submit", (e) => {
  const fd = new FormData(e.target);
  save({ lang: String(fd.get("lang")), token: String(fd.get("token") ?? "").trim() || settings.token, onboarded: true });
  audio.unlock();
  precachePhrases();
  detectHeadset().then((d) => { if (d.guess) save({ headset: d.guess }); });
});

/* ================= boot ================= */
async function boot() {
  applySettings();
  setNet();
  if (!sttSupported) {
    document.querySelectorAll("[data-talk]").forEach((b) => { b.querySelector("span").textContent = b.dataset.talk === "me" ? "เครื่องนี้ใช้การพิมพ์แทน" : "Type below"; });
    toggleType("me", true);
  }
  const [hist] = await Promise.all([
    db.all("history"),
    loadGlossary(),
    fetch("data/quick-phrases.json").then((r) => r.json()).then((q) => (phrases = q)).catch(() => {}),
  ]);
  turns = hist.sort((a, b) => a.at - b.at).slice(-40).map((x) => ({ ...x, status: "done" }));
  for (const t of turns) ui.upsert(t, settings);
  if (!settings.onboarded) $("#dlg-start").showModal();
  else precachePhrases();
  // ส่งของที่ค้างจากรอบก่อน (ปิดแอป/รีเฟรช)
  const pending = await db.all("outbox");
  for (const p of pending) { const t = { ...p, status: "queued" }; turns.push(t); ui.upsert(t, settings); }
  flushOutbox();
  // iOS โหมดหน้าจอโฮม: Web Speech อาจใช้ไม่ได้ → แนะนำเปิดใน Safari (แสดงเมื่อเกิด error จริงใน STT_ERRORS)
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  setInterval(async () => { if (navigator.onLine && (await db.all("outbox")).length) flushOutbox(); }, 15_000);
}
boot();

// เปิดให้ทดสอบ/ดีบักจาก console
window.__klakhui = { api, audio, listen, get glossary() { return glossary; }, get turns() { return turns; }, settings: () => settings };
