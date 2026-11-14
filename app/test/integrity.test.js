// เทสกันพังตอนขึ้นงานจริง: ไฟล์หาย / import ผิด / id ใน HTML ไม่ตรงกับ JS / id สำรองตอน http
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uid } from "../js/core/id.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(APP, p), "utf8");
const jsFiles = (dir) => readdirSync(join(APP, dir), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? jsFiles(join(dir, d.name)) : d.name.endsWith(".js") ? [join(dir, d.name)] : []);

describe("ความครบของไฟล์ (กัน service worker ติดตั้งไม่ได้ / หน้าโหลดไม่ขึ้น)", () => {
  it("ทุกไฟล์ใน sw.js FILES มีอยู่จริง", () => {
    const list = JSON.parse(read("sw.js").match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
    for (const f of list) if (f !== "./") expect(existsSync(join(APP, f)), f).toBe(true);
  });
  it("ทุกไฟล์ JS ของแอปอยู่ใน sw.js (ใช้ออฟไลน์ได้)", () => {
    const sw = read("sw.js");
    for (const f of jsFiles("js")) expect(sw.includes(`"${f.replace(/\\/g, "/")}"`), f).toBe(true);
  });
  it("ทุก import ชี้ไฟล์ที่มีจริง", () => {
    for (const f of jsFiles("js")) {
      for (const m of read(f).matchAll(/from\s+"(\.[^"]+)"/g)) {
        expect(existsSync(resolve(join(APP, dirname(f)), m[1])), `${f} → ${m[1]}`).toBe(true);
      }
    }
  });
  it("ทุก id ที่ JS เรียก ($(\"#x\")) มีใน index.html", () => {
    const html = read("index.html");
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const f of jsFiles("js")) {
      for (const m of read(f).matchAll(/\$\(\s*["'`]#([\w-]+)["'`]\s*\)/g)) expect(ids.has(m[1]), `${f}: #${m[1]}`).toBe(true);
    }
  });
  it("ไอคอน/manifest ที่อ้างถึงมีครบ", () => {
    const man = JSON.parse(read("manifest.webmanifest"));
    for (const i of man.icons) expect(existsSync(join(APP, i.src)), i.src).toBe(true);
    for (const m of read("index.html").matchAll(/(?:href|src)="((?:icons|css|js)\/[^"]+)"/g)) expect(existsSync(join(APP, m[1])), m[1]).toBe(true);
  });
});

describe("uid (ใช้ได้แม้เปิดผ่าน http ที่ไม่มี crypto.randomUUID)", () => {
  it("รูปแบบ UUID v4 และไม่ซ้ำ", () => {
    const orig = globalThis.crypto.randomUUID;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => { throw new Error("insecure"); });
    const a = uid(), b = uid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    vi.restoreAllMocks();
    expect(typeof orig).toBe("function");
  });
});
