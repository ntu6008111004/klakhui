// รองรับหูฟังทุกแบบ: เดาจากชื่ออุปกรณ์ + วิซาร์ดทดสอบ 30 วิ + devicechange
import { LANGS } from "./config.js";

export async function detectHeadset() {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    const outs = (devs ?? []).filter((d) => d.kind === "audiooutput" || d.kind === "audioinput").map((d) => d.label).filter(Boolean);
    const name = outs.find((l) => /airpods|bluetooth|buds|bt|hands-?free|headset|wh-|wf-|jabra|bose|beats|sony/i.test(l));
    if (name) return { guess: "bt", name };
    const wired = outs.find((l) => /headphone|earphone|wired|usb|หูฟัง/i.test(l));
    if (wired) return { guess: "wired", name: wired };
    return { guess: null, name: outs[0] ?? "" };
  } catch {
    return { guess: null, name: "" };
  }
}

/** ฟังการถอด/เสียบหูฟังกลางคัน */
export function watchDevices(cb) {
  try { navigator.mediaDevices?.addEventListener?.("devicechange", cb); } catch { /* ignore */ }
}

/**
 * วิซาร์ด: ก) ฟังเสียงทดสอบ ✅/❌  ข) วัดระดับเสียงไมค์ให้เพื่อนพูดห่าง ~1 เมตร  ค) บันทึกโปรไฟล์
 * @param {HTMLElement} root
 * @param {{audio:any, settings:()=>any, save:(patch:any)=>void, close:()=>void}} ctx
 */
export async function runWizard(root, ctx) {
  const s = ctx.settings();
  const result = { heard: null, level: 0 };
  let stream = null, raf = 0, ac = null;

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    ac?.close?.().catch?.(() => {});
  };

  const step1 = () => {
    root.innerHTML = `
      <div class="step">ขั้นที่ 1 / 3</div>
      <h3>ได้ยินเสียงทดสอบชัดไหม?</h3>
      <p class="muted">ใส่หูฟังที่จะใช้จริง แล้วกดเล่นเสียง</p>
      <button class="big-btn quiet full" data-act="play">🔊 เล่นเสียงทดสอบ</button>
      <div class="row-btns"><button class="big-btn hot" data-act="yes">✅ ชัด</button><button class="big-btn quiet" data-act="no">❌ ไม่ชัด/ไม่ได้ยิน</button></div>`;
    root.querySelector('[data-act="play"]').onclick = () => ctx.audio.speak("ได้ยินชัดไหมคะ ถ้าชัดกดปุ่มชัดได้เลย", "th", { priority: true });
    root.querySelector('[data-act="yes"]').onclick = () => { result.heard = true; step2(); };
    root.querySelector('[data-act="no"]').onclick = () => { result.heard = false; step2(); };
  };

  const step2 = async () => {
    root.innerHTML = `
      <div class="step">ขั้นที่ 2 / 3</div>
      <h3>ให้เพื่อนพูดอะไรก็ได้ ห่างประมาณ 1 เมตร</h3>
      <p class="muted">${LANGS[s.lang].flag} เช่น "${s.lang === "zh" ? "你好，今天天气不错" : s.lang === "ja" ? "こんにちは" : s.lang === "ko" ? "안녕하세요" : "Hello, nice weather today"}" — แถบจะขยับตามเสียง</p>
      <div class="meter" id="meter"><i></i></div>
      <p class="muted" id="meter-txt">กำลังเปิดไมค์…</p>
      <button class="big-btn hot full" data-act="done" disabled>ถัดไป</button>`;
    const bar = root.querySelector("#meter i"), meter = root.querySelector("#meter"), txt = root.querySelector("#meter-txt");
    const btn = root.querySelector('[data-act="done"]');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      const data = new Float32Array(an.fftSize);
      const t0 = performance.now();
      let peak = 0;
      const tick = () => {
        an.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const rms = Math.sqrt(sum / data.length);
        const lvl = Math.min(1, rms * 8);
        peak = Math.max(peak * 0.995, lvl);
        result.level = Math.max(result.level, lvl);
        bar.style.width = `${Math.round(lvl * 100)}%`;
        meter.classList.toggle("low", peak < 0.15);
        const sec = Math.max(0, 8 - Math.floor((performance.now() - t0) / 1000));
        txt.textContent = sec ? `กำลังฟัง… ${sec} วิ` : "เสร็จแล้ว กดถัดไป";
        if (sec === 0) btn.disabled = false;
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      txt.textContent = "เปิดไมค์ไม่ได้ — อนุญาตไมโครโฟนก่อน แล้วลองใหม่";
      btn.disabled = false;
    }
    btn.onclick = () => { cleanup(); step3(); };
  };

  const step3 = () => {
    const weak = result.level < 0.15;
    const det = s.headset;
    let rec = det;
    let advice = "พร้อมใช้งาน ✨";
    if (!result.heard) advice = "ไม่ได้ยินเสียงชัด — ลองเพิ่มเสียงเครื่อง หรือเชื่อมต่อหูฟังใหม่";
    if (weak) {
      advice = "หูฟังนี้จับเสียงเพื่อนได้น้อย แนะนำ: ใช้หูฟังมีสาย หรือถอดหูฟังแล้วใช้ลำโพงเบาๆ";
      if (det === "bt") rec = "bt";
    }
    root.innerHTML = `
      <div class="step">ขั้นที่ 3 / 3</div>
      <h3>ผลทดสอบ</h3>
      <div class="result ${weak || !result.heard ? "bad" : ""}">${advice}</div>
      <p class="muted">ระดับเสียงที่จับได้สูงสุด: ${Math.round(result.level * 100)}%</p>
      <button class="big-btn hot full" data-act="save">บันทึกและใช้งาน</button>`;
    root.querySelector('[data-act="save"]').onclick = () => {
      ctx.save({ headset: rec, headsetTest: { at: Date.now(), heard: result.heard, level: result.level } });
      ctx.close();
    };
  };

  step1();
  return cleanup;
}
