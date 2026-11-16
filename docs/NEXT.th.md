# ทำต่อที่ออฟฟิศ (อัปเดต 16 พ.ย. 2569)

## 1. เตรียมเครื่อง (ครั้งแรก)

```bash
git clone https://github.com/ntu6008111004/klakhui.git
cd klakhui
npm install
npm --prefix worker install
```

สร้างไฟล์ `worker/.dev.vars` เอง (ไม่อยู่ใน git — ใส่ key จริง, บันทึกแบบ UTF-8 ไม่มี BOM):

```
THAILLM_API_KEY=...
APP_TOKEN=...
ALLOWED_ORIGIN=*
FALLBACK_LLM_URL=https://api.opentyphoon.ai/v1/chat/completions
FALLBACK_LLM_KEY=...
FALLBACK_LLM_MODEL=typhoon-v2.5-30b-a3b-instruct
```

รัน (2 หน้าต่าง):

```bash
npm run dev:api
```

```bash
npm run dev:app
```

เปิด http://localhost:5173 — เทสทั้งหมด: `npm test` (180 ข้อ)

## 2. งานค้าง: OCR ของเราเอง บนเซิร์ฟเวอร์ (มือถือแค่เปิดเว็บ)

เป้าหมาย: แทน/เสริม Typhoon OCR (จำกัด 20 ครั้ง/นาที, ไม่บอกตำแหน่งตัวอักษร) ด้วยเซิร์ฟเวอร์ OCR ของเรา
→ ได้ตำแหน่งตัวอักษร = **แปลทับบนภาพแบบ Google Lens** + กล้องสดไม่จำกัดครั้ง

แผน (ยังไม่ได้เริ่มเขียนโค้ด):
1. `ocr-server/` — Python 3.10 + **RapidOCR** (`rapidocr-onnxruntime`, PaddleOCR แบบ ONNX) + FastAPI
   `POST /ocr` รับรูป → คืน `[{text, box:[[x,y]×4], score}]`; รองรับจีน+อังกฤษก่อน แล้วค่อยเพิ่มญี่ปุ่น/เกาหลี
2. Dockerfile → ขึ้นเซิร์ฟเวอร์ฟรี (เช่น Hugging Face Spaces) หรือเครื่องที่มี
3. Worker `/api/ocr`: ถ้ามี env `OCR_SERVER_URL` → เรียกเซิร์ฟเวอร์เรา, ล่ม → สลับ Typhoon OCR อัตโนมัติ (โค้ด Typhoon อยู่ใน `worker/src/ocr.ts`)
4. แอป `app/js/camera.js`: วาดคำแปลทับตามตำแหน่ง box บนรูป/วิดีโอ, กล้องสดอ่านทุก ~1 วิ (ตอนนี้ทุก 4 วิ)
5. วัดความเร็ว/ความแม่นเทียบ Typhoon OCR ด้วยรูปทดสอบหลายภาษา

สั่ง Claude ต่อได้เลยด้วยข้อความนี้:

> อ่าน docs/NEXT.th.md แล้วทำงานค้างข้อ 2 (OCR server ของเราเองด้วย RapidOCR + แปลทับแบบ Lens) ต่อให้เสร็จ เทสให้ผ่าน แล้ว push

## 3. Deploy

- ลิงก์ทดสอบชั่วคราว (`*.workers.dev` แบบ `--temporary`) **อยู่ได้ 60 นาที** ถ้าไม่ Claim → deploy ใหม่ได้ด้วย:

```bash
npx --prefix worker wrangler deploy --temporary --config worker/wrangler.temp.toml --secrets-file <ไฟล์ JSON ที่มี THAILLM_API_KEY, APP_TOKEN, FALLBACK_LLM_KEY>
```

- ใช้ถาวร: `npx --prefix worker wrangler login` (บัญชีบริษัท) แล้ว `npm --prefix worker run deploy` → `api-translate.dentcos.com` + Pages `translate.dentcos.com` (ดู README.th.md หัวข้อ 5)

## 4. สถานะล่าสุด

- Qwen 3.6 บน ThaiLLM ยังเรียกไม่ได้ (504) → ใช้ Typhoon 2.5 30B แทนอัตโนมัติ
- เทส 180 ข้อผ่าน, ชุดความแม่น 56/56, ทดสอบ 500 ประโยค: ผิดร้ายแรงลด 11 → 1
- ยังไม่ได้ทดสอบบน iPhone จริง (ไมค์/หูฟัง/กล้องสด)
