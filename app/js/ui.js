// วาดหน้าจอ (ใช้ textContent ทั้งหมด — ไม่มี innerHTML กับข้อความผู้ใช้/โมเดล)
import { showTone, toneInfo } from "./core/tone.js";
import { LANGS } from "./config.js";

const $ = (s, r = document) => r.querySelector(s);

/** @param {string} tag @param {Record<string, any>} [a] @param {(Node|string|null|undefined|false)[]} [kids] */
export function h(tag, a = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c != null && c !== false) e.append(c);
  return e;
}
const icon = (id) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#i-${id}`);
  s.append(u);
  return s;
};
const isCjk = (lang) => ["zh", "ja", "ko"].includes(lang);

export class UI {
  /** @param {{onReplay:(turn:any, side:string)=>void, onRetry:(turn:any)=>void, onAddWord:(term:any)=>void, onReply:(r:any)=>void, onPhrases:()=>void}} cb */
  constructor(cb) {
    this.cb = cb;
    this.feedMe = $("#feed-me");
    this.feedPartner = $("#feed-partner");
    this.cards = new Map();
    this.toastTimer = 0;
  }

  scroll(feed) {
    requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
  }

  clearFeeds() {
    this.feedMe.querySelectorAll(".card").forEach((c) => c.remove());
    this.feedPartner.replaceChildren();
    this.cards.clear();
    this.replies([]);
  }

  /** เพิ่ม/อัปเดตการ์ดของ turn ทั้งสองฝั่ง */
  upsert(turn, settings) {
    $("#welcome")?.remove();
    const lang = turn.lang ?? settings.lang;
    let c = this.cards.get(turn.id);
    const fresh = !c;
    if (!c) {
      c = { me: h("li", { class: "card" }), partner: h("li", { class: "card" }) };
      this.cards.set(turn.id, c);
      this.feedMe.append(c.me);
      this.feedPartner.append(c.partner);
    }
    this.fillMe(c.me, turn, lang);
    this.fillPartner(c.partner, turn, lang);
    if (fresh || turn.status !== "pending") { this.scroll(this.feedMe); this.scroll(this.feedPartner); }
  }

  fillMe(li, t, lang) {
    const r = t.result;
    li.className = `card ${t.who === "me" ? "mine" : "them"} ${t.status}`;
    li.replaceChildren();
    const L = LANGS[lang];
    if (t.who === "partner") {
      li.append(h("div", { class: "who" }, [`${L.flag} เพื่อนพูด`, r?.engine && r.engine !== "primary" ? h("span", { class: "engine-tag", text: "โหมดสำรอง" }) : null]));
      li.append(h("div", { class: "src", lang, text: t.text }));
      li.append(h("div", { class: "big", lang: "th", text: t.status === "pending" ? (t.partial || "กำลังแปล") : r?.translation ?? statusText(t) }));
    } else {
      li.append(h("div", { class: "who", text: t.via === "reply" ? "คุณตอบ (ประโยคแนะนำ)" : t.via === "phrase" ? "ประโยคด่วน" : "คุณพูด" }));
      li.append(h("div", { class: "src", lang: "th", text: t.text }));
      li.append(h("div", { class: `big ${isCjk(lang) ? "cjk" : ""}`, lang, text: t.status === "pending" ? "กำลังแปล" : r?.translation ?? statusText(t) }));
      if (r?.back_translation_th) li.append(h("div", { class: "back" }, [h("b", { text: "เพื่อนจะเข้าใจว่า: " }), r.back_translation_th]));
    }
    if (r && showTone(r.tone)) {
      const ti = toneInfo(r.tone);
      li.append(h("div", { class: "tools" }, [h("span", { class: "tone", dataset: { tone: r.tone }, text: `${ti.emoji} ${ti.label}` }), h("span", { class: "tone-hint", text: ti.hint })]));
    }
    if (r?.note_th) li.append(h("div", { class: "note", text: r.note_th }));
    if (t.partialOnly) li.append(h("div", { class: "muted meta-wait", text: t.who === "me" ? "⏳ กำลังเช็กคำแปลกลับ…" : "⏳ กำลังดูน้ำเสียง/สำนวน…" }));
    if (r?.terms?.length) {
      li.append(h("details", { class: "terms" }, [
        h("summary", { text: `คำที่ควรรู้ (${r.terms.length})` }),
        h("ul", {}, r.terms.map((term) => h("li", {}, [h("b", { lang, text: term.src }), h("span", { text: term.meaning_th }),
          h("button", { class: "chip-btn", type: "button", "aria-label": "เพิ่มคำนี้ลงคลัง", onclick: () => this.cb.onAddWord({ term: term.src, meaning_th: term.meaning_th, lang: t.who === "me" ? "th" : lang }) }, [icon("plus"), "คลัง"])]))),
      ]));
    }
    if (r?.needs_confirm) li.append(h("div", { class: "confirm", text: "⚠️ โปรดยืนยันกับอีกฝ่าย — คำนี้สำคัญ ห้ามเดา" }));
    const tools = h("div", { class: "tools" });
    if (t.status === "done") {
      if (t.who === "me") tools.append(h("button", { class: "chip-btn", type: "button", onclick: () => this.cb.onReplay(t, "partner") }, [icon("speaker"), "พูดอีกครั้ง"]));
      else tools.append(h("button", { class: "chip-btn", type: "button", onclick: () => this.cb.onReplay(t, "me") }, [icon("speaker"), "อ่านไทยให้ฟัง"]));
    }
    if (t.status === "failed") {
      tools.append(h("button", { class: "chip-btn", type: "button", onclick: () => this.cb.onRetry(t) }, [icon("retry"), "ลองใหม่"]));
      tools.append(h("button", { class: "chip-btn", type: "button", onclick: () => this.cb.onPhrases() }, [icon("bolt"), "ใช้ประโยคด่วน"]));
    }
    if (tools.childElementCount) li.append(tools);
  }

  fillPartner(li, t, lang) {
    const r = t.result;
    li.className = `card ${t.who === "me" ? "mine" : "them"} ${t.status}`;
    li.replaceChildren();
    if (t.who === "me") {
      li.append(h("div", { class: `big ${isCjk(lang) ? "cjk" : ""}`, lang, text: t.status === "pending" ? "…" : r?.translation ?? "…" }));
      if (t.status === "done") li.append(h("div", { class: "tools" }, [h("button", { class: "chip-btn", type: "button", "aria-label": "replay", onclick: () => this.cb.onReplay(t, "partner") }, [icon("speaker")])]));
    } else {
      li.append(h("div", { class: `big ${isCjk(lang) ? "cjk" : ""}`, lang, text: t.text }));
      li.append(h("div", { class: "who", text: t.status === "done" ? "✓" : "…" }));
    }
  }

  /** ประโยคตอบกลับแนะนำ (จากคำพูดล่าสุดของเพื่อน) */
  replies(list) {
    const box = $("#replies"), row = $("#replies-row");
    row.replaceChildren(...list.map((r) => h("button", { class: "reply", type: "button", onclick: () => this.cb.onReply(r) }, [r.th, h("small", { text: r.target })])));
    box.hidden = !list.length;
  }

  live(side, text) {
    const el = $(side === "me" ? "#live-me" : "#live-partner");
    el.hidden = !text;
    el.textContent = text;
  }

  toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  banner(kind, msg) {
    const b = $("#banner");
    if (!msg) { b.hidden = true; return; }
    b.dataset.kind = kind;
    b.textContent = msg;
    b.hidden = false;
  }

  status(state, text) {
    const p = $("#status-pill");
    p.dataset.state = state;
    p.querySelector("span").textContent = text;
  }

  /* ===== โหมดรับฟังตลอด ===== */
  listenOpen(lang, headset) {
    $("#listen-view").hidden = false;
    $("#lv-lang").textContent = `ฟังภาษา${LANGS[lang].name} → ไทย`;
    $("#lv-tip").hidden = headset !== "none";
    $("#lv-feed").replaceChildren();
    this.lvItems = new Map();
    $("#btn-listen").setAttribute("aria-pressed", "true");
  }
  listenClose() {
    $("#listen-view").hidden = true;
    $("#btn-listen").setAttribute("aria-pressed", "false");
  }
  listenLight(state, why) {
    const l = $("#lv-light");
    l.dataset.state = state === "on" ? "on" : state === "off" ? "off" : "restarting";
    l.querySelector("span").textContent = state === "on" ? "กำลังฟัง" : state === "off" ? why || "ฟังไม่ได้" : `กำลังเริ่มใหม่${why ? ` (${why})` : ""}`;
  }
  listenInterim(text) { $("#lv-interim").textContent = text; }
  listenUpsert(id, d) {
    let li = this.lvItems.get(id);
    if (!li) {
      li = h("li", { class: "lv-item" });
      this.lvItems.set(id, li);
      $("#lv-feed").append(li);
    }
    li.className = `lv-item ${d.pending ? "pending" : ""}`;
    // replaceChildren แปลง null เป็นข้อความ "null" → กรองออกก่อน
    li.replaceChildren(...[
      h("div", { class: "src", text: d.src }),
      h("div", { class: "th", lang: "th", text: d.th || "…" }),
      d.tone && showTone(d.tone) ? h("span", { class: "tone", dataset: { tone: d.tone }, text: `${toneInfo(d.tone).emoji} ${toneInfo(d.tone).label}` }) : null,
      d.note ? h("div", { class: "note", text: d.note }) : null,
    ].filter(Boolean));
    const f = $("#lv-feed");
    if (f.scrollHeight - f.scrollTop - f.clientHeight < 240) f.scrollTop = f.scrollHeight;
  }
}

function statusText(t) {
  if (t.status === "queued") return "📡 รอส่งเมื่อเน็ตกลับมา";
  if (t.status === "failed") return t.error || "แปลไม่สำเร็จ";
  return "…";
}
