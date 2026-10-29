// Firestore وهمي في الذاكرة لاختبار منطق المزامنة (ليس بديلًا عن Emulator لقواعد الأمان).
// يفرض: صلاحيات الكتابة (admin فقط)، حد 1MiB للمستند، 500 عملية للدفعة، 10MiB للطلب، رفض undefined، حقن أعطال.
const ADMIN = 'crochetamal64@gmail.com';
function createFake() {
  const store = new Map();                 // id -> data
  const db = { auth: { user: null }, failNext: null, latencyMs: 0, commits: 0, writesSeen: [] };
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const size = (o) => Buffer.byteLength(JSON.stringify(o));
  const hasUndef = (v) => v === undefined || (v && typeof v === 'object' && Object.values(v).some(hasUndef));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const maybeFail = async () => {
    if (db.latencyMs) await sleep(db.latencyMs);
    if (db.failNext) { const f = db.failNext; db.failNext = null; if (f.times > 1) { db.failNext = { ...f, times: f.times - 1 }; } throw err(f.code, f.message); }
  };
  const fs = {
    collection: (_db, name) => ({ name }),
    doc: (col, id) => ({ col, id }),
    async getDocs() {
      await maybeFail();
      return { docs: [...store.entries()].map(([id, data]) => ({ id, data: () => JSON.parse(JSON.stringify(data)), ref: { id } })) };
    },
    async getDocFromServer(ref) {
      await maybeFail();
      const has = store.has(ref.id);
      return { exists: () => has, data: () => (has ? JSON.parse(JSON.stringify(store.get(ref.id))) : undefined) };
    },
    writeBatch() {
      const ops = [];
      return {
        set: (ref, data) => ops.push({ t: 'set', ref, data }),
        delete: (ref) => ops.push({ t: 'del', ref }),
        async commit() {
          await maybeFail();
          const u = db.auth.user;
          if (!u || u.email !== ADMIN) throw err('permission-denied', 'Missing or insufficient permissions.');
          if (ops.length > 500) throw err('invalid-argument', 'maximum 500 writes');
          if (ops.reduce((n, o) => n + (o.data ? size(o.data) : 100), 0) > 10 * 1048576) throw err('invalid-argument', 'request too large');
          for (const o of ops) {
            if (o.data && hasUndef(o.data)) throw err('invalid-argument', 'Unsupported field value: undefined');
            if (o.data && size(o.data) > 1048576) throw err('invalid-argument', 'document exceeds the maximum allowed size');
          }
          ops.forEach((o) => { if (o.t === 'set') store.set(o.ref.id, JSON.parse(JSON.stringify(o.data))); else store.delete(o.ref.id); db.writesSeen.push(o.t + ':' + o.ref.id); });
          db.commits++;
        }
      };
    }
  };
  return { fs, db, store, signIn: (email) => { db.auth.user = email ? { email } : null; } };
}
module.exports = { createFake, ADMIN };
