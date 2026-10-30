/* Crochet.Amal — منطق المزامنة مع Firestore (قابل للاختبار خارج المتصفح).
 *
 * البنية المعتمدة (دون تغيير عن التصميم الحالي):
 *   products/{productId}      مستند لكل منتج (الحقول + order + updatedAt)
 *   products/__site_meta__    إعدادات الصفحة الرئيسية: { hero, revision, productIds, updatedAt, schema }
 *
 * المبادئ:
 *  - لا نجاح كاذب: أي فشل في أي دفعة يُرمى كخطأ (SyncError) ولا يُعتبر النشر مكتملًا.
 *  - لا حذف لمستند الإعدادات أبدًا، ولا حذف لمنتج لم نره عند التحميل.
 *  - كشف التعارض عبر حقل revision في مستند الإعدادات.
 *  - إعادة المحاولة آمنة: المعرفات ثابتة والكتابة set، فلا تتكرر المنتجات.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrochetSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const META_DOC_ID = '__site_meta__';
  const COLLECTION = 'products';
  // الحد الفعلي في Firestore هو 1,048,576 بايت للمستند؛ نترك هامشًا لحقول النظام.
  const DOC_BYTE_LIMIT = 1000000;
  const BATCH_BYTE_BUDGET = 6000000;   // حد الطلب الواحد في Firestore ≈ 10MiB
  const BATCH_MAX_OPS = 100;           // الحد الأقصى 500؛ نستعمل أقل لتقليل زمن الطلب الواحد

  class SyncError extends Error {
    constructor(code, message, detail) {
      super(message || code);
      this.name = 'SyncError';
      this.code = code;
      this.detail = detail || {};
    }
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SyncError('timeout', 'timeout: ' + (label || 'operation'), { label })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // JSON مستقر (ترتيب المفاتيح أبجديًا) لأن Firestore لا يضمن ترتيب الحقول عند القراءة.
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function byteLength(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    return Buffer.byteLength(str, 'utf8');
  }

  function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16) + '-' + s.length;
  }

  // يحذف updatedAt ويطبّع القيم (undefined تُحذف لأن Firestore يرفضها).
  function docHash(data) {
    const copy = { ...data };
    delete copy.updatedAt;
    return hashString(canonical(copy));
  }

  function stripUndefined(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function revisionKey(meta) {
    if (!meta) return 'none';
    return String(meta.revision || ('legacy-' + Number(meta.updatedAt || 0)));
  }

  function newRevision() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- القراءة ---------- */
  async function load(deps) {
    const { fs, db, cleanProducts } = deps;
    const snap = await fs.getDocs(fs.collection(db, COLLECTION));
    let meta = null;
    const items = [];
    const ids = [];
    const hashes = {};
    let maxUpdatedAt = 0;

    snap.docs.forEach((d) => {
      const data = d.data() || {};
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(data.updatedAt || 0));
      if (d.id === META_DOC_ID) { meta = data; return; }
      ids.push(d.id);
      hashes[d.id] = docHash(data);
      items.push({ ...data, id: d.id });
    });

    items.sort((a, b) => Number(a.order ?? 9999) - Number(b.order ?? 9999));
    const products = cleanProducts(items);
    // مستندات غير صالحة (اسم/سعر ناقص) لا يعرضها المتجر؛ نتركها كما هي ولا نضعها ضمن ما يُحذف عند النشر.
    const valid = new Set(products.map((p) => p.id));
    const skipped = ids.filter((id) => !valid.has(id));
    const safeIds = ids.filter((id) => valid.has(id));
    return {
      products,
      skipped,
      hero: meta && meta.hero ? meta.hero : null,
      hasMeta: Boolean(meta),
      revision: revisionKey(meta),
      ids: safeIds,
      hashes,
      updatedAt: maxUpdatedAt
    };
  }

  /* ---------- الكتابة ---------- */
  function buildProductPayload(p, idx) {
    const payload = stripUndefined({ ...p, order: idx });
    if (Array.isArray(payload.images)) payload.image = payload.images[0] || payload.image || '';
    return payload;
  }

  function checkDocSize(id, label, data) {
    const bytes = byteLength(JSON.stringify(data));
    if (bytes > DOC_BYTE_LIMIT) {
      throw new SyncError('doc-too-large',
        'doc-too-large: ' + id + ' (' + bytes + ' bytes)',
        { id, label, bytes, limit: DOC_BYTE_LIMIT });
    }
    return bytes;
  }

  function planBatches(ops) {
    const batches = [];
    let cur = [];
    let curBytes = 0;
    ops.forEach((op) => {
      const sz = op.bytes || 100;
      if (cur.length && (cur.length >= BATCH_MAX_OPS || curBytes + sz > BATCH_BYTE_BUDGET)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(op);
      curBytes += sz;
    });
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * base:  { revision, ids[], hashes{} }  ← نتيجة آخر load() ناجح (أو آخر publish ناجح)
   * opts:  { force, allowEmpty, ownRevisions[], onProgress, batchTimeoutMs, checkTimeoutMs }
   */
  async function publish(deps, list, hero, base, opts) {
    const { fs, db } = deps;
    opts = opts || {};
    if (!base || typeof base.revision !== 'string') {
      throw new SyncError('no-baseline', 'no-baseline: cloud state has not been loaded yet');
    }
    const col = fs.collection(db, COLLECTION);
    const now = Date.now();

    // 1) تحقق محلي كامل قبل أي كتابة (لا كتابة جزئية بسبب حجم أو بيانات)
    const sets = [];
    const keep = new Set();
    list.forEach((p, idx) => {
      if (!p || !p.id || p.id === META_DOC_ID) {
        throw new SyncError('bad-id', 'bad-id: invalid product id', { id: p && p.id });
      }
      if (keep.has(p.id)) throw new SyncError('duplicate-id', 'duplicate-id: ' + p.id, { id: p.id });
      keep.add(p.id);
      const payload = buildProductPayload(p, idx);
      const bytes = checkDocSize(p.id, p.name, payload);
      sets.push({ id: p.id, payload, bytes, hash: docHash(payload) });
    });

    const metaData = stripUndefined({
      hero: hero || null,
      revision: newRevision(),
      productIds: list.map((p) => p.id),
      schema: 1
    });
    checkDocSize(META_DOC_ID, 'hero', metaData);

    const knownIds = new Set(base.ids || []);
    if (list.length === 0 && knownIds.size > 0 && !opts.allowEmpty) {
      throw new SyncError('empty-list', 'empty-list: publishing would delete every product', { count: knownIds.size });
    }

    // 2) كشف التعارض: نقرأ مستند الإعدادات من الخادم (صغير) ونقارن النسخة
    let freshMeta;
    try {
      const snap = await withTimeout(fs.getDocFromServer(fs.doc(col, META_DOC_ID)), opts.checkTimeoutMs || 20000, 'check-meta');
      freshMeta = snap.exists() ? (snap.data() || {}) : null;
    } catch (err) {
      err.stage = err.stage || 'check-meta';
      throw err;
    }
    const remoteRevision = revisionKey(freshMeta);
    const own = new Set(opts.ownRevisions || []);
    if (!opts.force && remoteRevision !== base.revision && !own.has(remoteRevision)) {
      throw new SyncError('conflict', 'conflict: cloud revision changed', { remoteRevision, baseRevision: base.revision });
    }

    // 3) خطة العمليات
    const baseHashes = base.hashes || {};
    const ops = [];
    sets.forEach((s) => {
      if (opts.force || baseHashes[s.id] !== s.hash) {
        ops.push({ type: 'set', id: s.id, ref: fs.doc(col, s.id), data: { ...s.payload, updatedAt: now }, bytes: s.bytes });
      }
    });

    const deleteCandidates = new Set(knownIds);
    if (freshMeta && Array.isArray(freshMeta.productIds)) freshMeta.productIds.forEach((id) => deleteCandidates.add(id));
    deleteCandidates.forEach((id) => {
      if (id === META_DOC_ID || keep.has(id)) return;   // لا نحذف الإعدادات ولا ما نريد إبقاءه
      ops.push({ type: 'del', id, ref: fs.doc(col, id), bytes: 100 });
    });

    const metaOp = {
      type: 'set', id: META_DOC_ID, ref: fs.doc(col, META_DOC_ID),
      data: { ...metaData, updatedAt: now }, bytes: byteLength(JSON.stringify(metaData))
    };

    // الإعدادات تُكتب في آخر دفعة؛ فإن انقطع النشر في المنتصف يبقى مستند الإعدادات على نسخته القديمة
    const batches = planBatches(ops);
    const lastOps = batches.length ? batches[batches.length - 1] : [];
    if (lastOps.length >= BATCH_MAX_OPS || !batches.length) batches.push([metaOp]);
    else lastOps.push(metaOp);

    const total = batches.length;
    let done = 0;
    if (opts.onProgress) opts.onProgress({ done, total });
    for (const group of batches) {
      const batch = fs.writeBatch(db);
      group.forEach((op) => {
        if (op.type === 'del') batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      try {
        await withTimeout(batch.commit(), opts.batchTimeoutMs || 45000, 'commit');
      } catch (err) {
        err.stage = 'commit';
        err.attemptRevision = metaData.revision;
        err.progress = { done, total };
        throw err;
      }
      done++;
      if (opts.onProgress) opts.onProgress({ done, total });
    }

    const hashes = {};
    sets.forEach((s) => { hashes[s.id] = s.hash; });
    return {
      revision: metaData.revision,
      ids: list.map((p) => p.id),
      hashes,
      written: ops.filter((o) => o.type === 'set').length,
      deleted: ops.filter((o) => o.type === 'del').length
    };
  }

  /* ---------- وصف الأخطاء للمستخدم (دون بيانات حساسة) ---------- */
  function classifyError(err) {
    const code = String((err && err.code) || '').replace(/^firestore\//, '');
    const msg = String((err && err.message) || '');
    if (code === 'doc-too-large') return 'doc-too-large';
    if (code === 'conflict' || code === 'empty-list' || code === 'no-baseline' || code === 'duplicate-id' || code === 'bad-id') return code;
    if (code === 'timeout' || /timeout|deadline-exceeded/i.test(code + msg)) return 'timeout';
    if (/permission-denied|insufficient permissions/i.test(code + ' ' + msg)) return 'permission-denied';
    if (/unauthenticated/i.test(code)) return 'unauthenticated';
    if (/resource-exhausted|quota/i.test(code + ' ' + msg)) return 'quota';
    if (/unavailable|failed-to-get|network|offline|client is offline/i.test(code + ' ' + msg)) return 'network';
    if (/invalid-argument|too large|exceeds the maximum/i.test(code + ' ' + msg)) return 'invalid-data';
    return 'unknown';
  }

  return {
    META_DOC_ID, COLLECTION, DOC_BYTE_LIMIT, BATCH_BYTE_BUDGET, BATCH_MAX_OPS,
    SyncError, withTimeout, canonical, docHash, byteLength, revisionKey, newRevision,
    load, publish, classifyError, planBatches
  };
});
