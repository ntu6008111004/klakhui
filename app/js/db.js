// IndexedDB เล็กๆ: history (ประวัติ), words (คลังคำของฉัน), outbox (คิวรอส่งตอนเน็ตหลุด)
// ถ้า IndexedDB ใช้ไม่ได้ (โหมดส่วนตัว) → ใช้หน่วยความจำแทน แอปยังทำงานได้

const NAME = "klakhui";
const STORES = ["history", "words", "outbox"];
let dbp = null;
const mem = { history: new Map(), words: new Map(), outbox: new Map() };

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const reqP = (r) => new Promise((res) => { r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });

export const db = {
  async put(store, value) {
    mem[store].set(value.id, value);
    await tx(store, "readwrite", (s) => s && s.put(value));
  },
  async del(store, id) {
    mem[store].delete(id);
    await tx(store, "readwrite", (s) => s && s.delete(id));
  },
  async all(store) {
    const r = await tx(store, "readonly", (s) => (s ? reqP(s.getAll()) : undefined));
    return Array.isArray(r) ? r : [...mem[store].values()];
  },
  async clear(store) {
    mem[store].clear();
    await tx(store, "readwrite", (s) => s && s.clear());
  },
};
