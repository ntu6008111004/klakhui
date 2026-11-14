# กล้าคุย — ล่ามพกพา (ไทย ⇄ จีน / อังกฤษ / ญี่ปุ่น / เกาหลี)

แอปสำหรับคนไม่มั่นใจภาษา วางมือถือบนโต๊ะแล้วผลัดกันพูด แอปจะแปลให้ทันที และบอกด้วยว่าอีกฝ่าย **พูดเล่น แซว ประชด หรือใช้สำนวน** พร้อมอธิบายเป็นภาษาไทย มี **ประโยคตอบกลับแนะนำ** ให้กดพูดตอบได้เลย

```
app/      หน้าเว็บ PWA (HTML + CSS + JS ล้วน ไม่มี build step)
worker/   Cloudflare Worker (TypeScript) — ซ่อน API key, แปล, stream, เสียง
docs/     คู่มือนี้
tools/    สคริปต์ช่วย: serve, icons, limit-test, loop-test
```

---

## 1. รันในเครื่อง (dev)

```bash
npm install
npm --prefix worker install
```

สร้างไฟล์ `worker/.dev.vars` (ไฟล์นี้อยู่ใน .gitignore — **ห้าม commit**):

```
THAILLM_API_KEY=คีย์ ThaiLLM
APP_TOKEN=สุ่มยาวอย่างน้อย 24 ตัว
ALLOWED_ORIGIN=*
# (แนะนำ) LLM สำรองฟรี: Typhoon 2.5 30B — สมัครที่ https://playground.opentyphoon.ai/api-key
FALLBACK_LLM_URL=https://api.opentyphoon.ai/v1/chat/completions
FALLBACK_LLM_KEY=คีย์ Typhoon
FALLBACK_LLM_MODEL=typhoon-v2.5-30b-a3b-instruct
```

> ⚠️ บันทึกไฟล์แบบ **UTF-8 ไม่มี BOM** (PowerShell `Set-Content -Encoding utf8` จะใส่ BOM ให้ → wrangler อ่านตัวแปรแรกผิด) แนะนำใช้ VS Code/Notepad

เปิด 2 หน้าต่าง:

```bash
npm run dev:api
```

```bash
npm run dev:app
```

แล้วเปิด http://localhost:5173 → กรอก APP_TOKEN ครั้งแรกครั้งเดียว

## 2. เทส

| คำสั่ง | ทำอะไร |
|---|---|
| `npm test` | unit + fault-injection ทั้ง client และ worker (mock upstream: 429, 500, timeout, JSON เสีย, stream ตัดกลางคัน, `<think>`, ยาวเกิน, `finish_reason: length`) |
| `npm run accuracy` | ยิงเคสความแม่นหัวข้อ 11 ไปที่ worker จริง + วัด latency p50/p90 |
| `node tools/limit-test.mjs` | ยิงรัว 30 คำขอ ต้องไม่เกิน 4/วิ และไม่โดน 429 |
| `npm run loop -- 3` | **loop test ก่อนส่งมอบ**: รันทุกอย่างข้างบน + เสียง 5 ภาษา + stream วน 3 รอบ ต้องผ่านทุกรอบ |

## 3. ทำไมไว: เส้นทางเร็ว `/api/translate/fast`

- รุ่นที่ดีที่สุดตอบเป็น stream และสั่งให้พิมพ์ **"คำแปล" เป็นอย่างแรก** → ทันทีที่คำแปลมาครบ แอปแสดง + **เริ่มพูดทันที** (event `partial`)
  ส่วนป้ายน้ำเสียง / คำอธิบาย / ประโยคตอบกลับ ตามมาทีหลัง (event `result`)
- **Hedging:** รุ่นแรกยังไม่ได้คำแปลใน 1.8 วิ (เคสแพทย์ 2.5 วิ) → ยิงรุ่นถัดไปคู่ขนาน ใครได้คำแปล **ถูกภาษา** ก่อนชนะ ผู้แพ้ถูกยกเลิก
- คำแปลผิดภาษา (เช่นตอบเป็นจีนแทนไทย) → ไม่ส่งให้ผู้ใช้ ข้ามไปรุ่นถัดไปทันที
- ใช้ไม่ได้/หลุด → แอปถอยไปใช้ `/api/translate` แบบเดิมเอง

ผลวัดจริง (14 พ.ย. 2569, 24 ครั้ง, ประโยคสั้น): **คำแปลขึ้นจอ p50 0.81 วิ, p90 2.27 วิ, ภายใน 3 วิ 24/24** — รายละเอียดครบ p50 ~4.6 วิ
วัดเองได้: `node worker/scripts/fast-bench.mjs`

## 4. ลำดับการเลือกโมเดล (สลับอัตโนมัติ ไม่ต้องแก้โค้ด)

1. **qwen3.6-35b-a3b** (ThaiLLM) — รุ่นหลักตามสเปก (ปิด thinking)
2. **typhoon-v2.5-30b-a3b-instruct** (opentyphoon, ฟรี) — ถ้าตั้ง `FALLBACK_LLM_*`
3. **Typhoon-S-ThaiLLM-8B** → **OpenThaiGPT 8B** (ThaiLLM)

รุ่นไหนล่ม/ช้า → สลับรุ่นถัดไปทันทีและพักรุ่นนั้น 60 วิ (เช็กเบื้องหลังว่ากลับมาหรือยัง) — การ์ดคำแปลจะมีป้ายเล็กๆ "โหมดสำรอง"

> สถานะ ณ 14 พ.ย. 2569: qwen3.6-35b-a3b และ qwen3.5-9b อยู่ในรายชื่อ `/models` แต่เรียกไม่ได้ (504 หลัง 60 วิ) — รุ่น 8B ไทยทั้ง 4 ตัวใช้ได้

## 5. Deploy จริง (GitHub → Cloudflare)

ต้องใช้ **API Token** ของบัญชีบริษัท (ห้ามใช้รหัสผ่านบัญชี) สิทธิ์ขั้นต่ำ:
- Account → *Workers Scripts: Edit*, *Cloudflare Pages: Edit*
- Zone `dentcos.com` → *Workers Routes: Edit* (+ *DNS: Edit* เฉพาะตอนผูกโดเมน แล้วถอดออก)

### 5.1 Worker → `api-translate.dentcos.com`
1. แก้ `worker/wrangler.toml` เปิดบรรทัด `routes = [{ pattern = "api-translate.dentcos.com", custom_domain = true }]`
2. ตั้ง secret (ทีละตัว ระบบจะถามค่า):
   ```bash
   npx --prefix worker wrangler secret put THAILLM_API_KEY
   npx --prefix worker wrangler secret put APP_TOKEN
   npx --prefix worker wrangler secret put FALLBACK_LLM_KEY
   ```
   และใส่ `FALLBACK_LLM_URL`, `FALLBACK_LLM_MODEL` ใน `[vars]` ของ wrangler.toml
3. `npm --prefix worker run deploy`

> **ห้ามแตะ DNS record เดิมของ dentcos.com** — Custom Domain ของ Worker จะสร้างเฉพาะ `api-translate` ให้เอง
> ห้ามใช้ `*.workers.dev` เป็นหลัก (อาจเข้าไม่ได้ในจีน)

### 5.2 แอป → `translate.dentcos.com` (Cloudflare Pages)
1. Pages → Create → Connect to Git → เลือก repo
2. Build command: *(เว้นว่าง)* — Output directory: `app`
3. Custom domains → เพิ่ม `translate.dentcos.com`
4. แอปจะเรียก `https://api-translate.dentcos.com` ให้อัตโนมัติเมื่อเปิดจากโดเมนนี้ (เปลี่ยนได้ในตั้งค่า → ที่อยู่ API)

### 5.3 GitHub Actions (push `main` → test ผ่าน → deploy)
ไฟล์ `.github/workflows/deploy.yml` — ตั้ง repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — **test ไม่ผ่าน = ไม่ deploy**

## 6. เปิดบน iPhone

1. Safari → `https://translate.dentcos.com` → กรอกรหัสแอป
2. แตะปุ่มแชร์ → **เพิ่มลงหน้าจอโฮม**
3. ถ้าเปิดจากหน้าจอโฮมแล้วไมค์ไม่ทำงาน (iOS บางรุ่นไม่ให้ Web Speech ในโหมดนี้) → แอปจะบอกให้เปิดผ่าน Safari แทน
4. ตั้งค่า → **ทดสอบหูฟัง** (30 วิ) ครั้งแรก

## 7. Soak test บนเครื่องจริง (ทำตามนี้ แล้วติ๊ก)

- [ ] โหมด **ฟังตลอด** 30 นาที เปิดคลิปพูดจีนจาก YouTube → ไม่หลุด ไม่ต้องกดใหม่ (ไฟเขียวค้าง ถ้าเหลืองจะกลับเขียวเอง)
- [ ] ระหว่างนั้น สลับ Wi-Fi ↔ 4G → ทำงานต่อเอง
- [ ] ล็อกจอแล้วเปิด → กลับมาฟังต่อเอง
- [ ] ถอด/ใส่หูฟัง Bluetooth กลางทาง → ทำงานต่อเองภายใน 3 วิ
- [ ] หูฟัง 4 แบบ: มีสาย / AirPods / บลูทูธราคาถูก / ไม่ใส่ — จดว่าแบบไหนจับเสียงเพื่อนได้ดี
- [ ] บลูทูธ: พยางค์แรกของเสียงไทยไม่หาย
- [ ] ไม่ใส่หูฟัง → แอปไม่วนแปลเสียงตัวเอง
- [ ] ปิดเน็ตกลางการแปล → แถบแดง → เปิดเน็ต → ส่งต่ออัตโนมัติ
- [ ] ปิดเน็ต → ประโยคด่วนยังพูดได้ (ต้องเคยเปิดแอปตอนมีเน็ตก่อน 1 ครั้ง)
- [ ] ไม่มี error สีแดงใน console (Safari → Develop → iPhone)

## 8. ข้อมูลส่วนตัว
- ประวัติสนทนาและคลังคำ **เก็บในเครื่องผู้ใช้เท่านั้น** (IndexedDB) ล้างได้ในตั้งค่า
- Worker ไม่เก็บข้อความ log แค่ endpoint / status / latency / รุ่นที่ใช้
- ⚠️ ถ้าเปิด Typhoon (opentyphoon) ข้อความจะถูกส่งไปผู้ให้บริการนั้นด้วย — อ่านข้อตกลงของเขาก่อนใช้กับเรื่องสุขภาพ/ส่วนตัว
