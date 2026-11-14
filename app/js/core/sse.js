// แยก SSE ฝั่ง client (event/data/คอมเมนต์ ping) — ทนต่อ chunk ขาดกลางบรรทัด

export class SseParser {
  constructor() { this.buf = ""; }
  /** @param {string} text @returns {{event:string, data:any}[]} */
  push(text) {
    this.buf += text.replace(/\r\n/g, "\n");
    const out = [];
    let i;
    while ((i = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = "message";
      const data = [];
      let isPing = false;
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) { isPing = true; continue; }
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) { if (isPing) out.push({ event: "ping", data: null }); continue; }
      let parsed = data.join("\n");
      try { parsed = JSON.parse(parsed); } catch { /* ข้อความดิบ */ }
      out.push({ event, data: parsed });
    }
    return out;
  }
}
