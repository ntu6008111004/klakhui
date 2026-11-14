# klakhui — กล้าคุย

Portable real-time interpreter PWA: **Thai ⇄ Chinese / English / Japanese / Korean**, built for people who aren't confident in other languages.
Place the phone on the table and take turns talking — the app translates instantly and tells you whether the other person is **joking, teasing, being sarcastic, or using an idiom**, with a short Thai explanation and easy reply suggestions.

ล่ามพกพาสำหรับคนไม่มั่นใจภาษา — แปลไว บอกด้วยว่าเขาพูดเล่น แซว หรือประชด และแนะนำประโยคตอบกลับ

- คู่มือภาษาไทยฉบับเต็ม (รัน / เทส / deploy / soak test): [docs/README.th.md](docs/README.th.md)
- Stack: Vanilla JS PWA (`app/`) + Cloudflare Worker TypeScript (`worker/`) + ThaiLLM / Typhoon + edge-tts

```bash
npm install && npm --prefix worker install
npm test          # unit + fault-injection (client + worker)
npm run dev:api   # worker → http://127.0.0.1:8787  (needs worker/.dev.vars)
npm run dev:app   # app    → http://localhost:5173
npm run loop -- 3 # pre-release loop test against the running worker
```
