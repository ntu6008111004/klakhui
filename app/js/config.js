// ตั้งค่า (localStorage — ห่อ try/catch ทุกครั้ง เพราะบางโหมดเข้าถึงไม่ได้)

export const LANGS = {
  zh: { name: "จีน", native: "中文", stt: "zh-CN", flag: "中", talk: "按住说话", hint: "按住按钮说话，我会翻译成泰语", type: "在这里输入…", heard: "对方会听到：" },
  en: { name: "อังกฤษ", native: "English", stt: "en-US", flag: "En", talk: "Hold to talk", hint: "Hold the button and speak — I'll translate to Thai", type: "Type here…", heard: "" },
  ja: { name: "ญี่ปุ่น", native: "日本語", stt: "ja-JP", flag: "あ", talk: "押して話す", hint: "ボタンを押しながら話してください。タイ語に翻訳します", type: "ここに入力…", heard: "" },
  ko: { name: "เกาหลี", native: "한국어", stt: "ko-KR", flag: "한", talk: "누르고 말하기", hint: "버튼을 누른 채로 말하세요. 태국어로 번역해 드려요", type: "여기에 입력…", heard: "" },
};

const DEFAULTS = {
  lang: "zh",
  domain: "general",
  gender: "female",
  rate: 8,
  pitch: -3,
  headset: "none",
  listenVoice: "device",
  listenRead: "latest",
  layout: "face",
  token: "",
  api: "",
  onboarded: false,
};

const KEY = "klakhui.settings.v1";

export function defaultApi() {
  const h = location.hostname;
  if (h === "translate.dentcos.com") return "https://api-translate.dentcos.com";
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost")) return `http://${h}:8787`;
  return "";
}

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ไม่มี storage */ }
  return { ...DEFAULTS, ...saved };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const apiBase = (s) => (s.api || defaultApi()).replace(/\/+$/, "");
export const fmtRate = (n) => `${n >= 0 ? "+" : ""}${n}%`;
export const fmtPitch = (n) => `${n >= 0 ? "+" : ""}${n}Hz`;
