// อ่าน .dev.vars (KEY=VALUE) — ไม่พิมพ์ค่าออกจอ
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadDevVars() {
  const p = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  const out = { ...process.env };
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

export const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
