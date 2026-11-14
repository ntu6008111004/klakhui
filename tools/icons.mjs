// สร้างไอคอน PNG ทุกขนาดจาก app/icons/logo.svg (favicon, apple-touch, PWA, maskable)
// ใช้: npm run icons
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../app/icons/", import.meta.url);
const logo = readFileSync(new URL("logo.svg", dir), "utf8");

// maskable: พื้นเต็มขอบ + เนื้อหาอยู่ใน safe zone 80%
const maskable = logo
  .replace('<rect width="512" height="512" rx="116" fill="#F5F1EA"/>', '<rect width="512" height="512" fill="#F5F1EA"/><g transform="translate(51.2 51.2) scale(0.8)">')
  .replace("</svg>", "</g></svg>");
writeFileSync(new URL("maskable.svg", dir), maskable);

// iOS ไม่ใช้ความโปร่งใส → apple-touch พื้นเต็ม
const solid = logo.replace('rx="116" ', "");

const out = [
  ["favicon-32.png", logo, 32],
  ["icon-192.png", logo, 192],
  ["icon-512.png", logo, 512],
  ["maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", solid, 180],
];
for (const [name, svg, size] of out) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(new URL(name, dir), png);
  console.log(name, size, png.length + "B");
}
