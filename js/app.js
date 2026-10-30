'use strict';

const KEY = 'crochetAmal.products.v1';
const CACHE = 'crochetAmal.cache.v1';
const HERO_KEY = 'crochetAmal.hero.v1';
const CART_KEY = 'crochetAmal.cart.v1';
const SESSION = 'crochetAmal.admin';
const META_DOC_ID = CrochetSync.META_DOC_ID;
// للعرض في رسائل الخطأ فقط؛ الحماية الفعلية في firestore.rules
const ADMIN_EMAIL = 'crochetamal64@gmail.com';

// Convenience lock only for offline/local device mode: real security is enforced by Firestore rules.
const PW_HASH = 'bb1b5ca296dc3ffab66629a6bb46eb7a44cab90dd8b18897244418a7ead55e07';

const FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f8efe3"/><stop offset="100%" stop-color="#ead8c3"/></linearGradient></defs>' +
  '<rect width="400" height="400" fill="url(#g)"/>' +
  '<circle cx="200" cy="175" r="46" fill="#f9e6e4" stroke="#cf827e" stroke-width="2.5"/>' +
  '<text x="200" y="184" font-size="28" text-anchor="middle" fill="#7d1e3d">🧶</text>' +
  '<text x="200" y="255" font-size="22" font-weight="bold" text-anchor="middle" fill="#452216" font-family="sans-serif">Crochet.Amal</text>' +
  '<text x="200" y="282" font-size="14" text-anchor="middle" fill="#785b4f" font-family="sans-serif">صُنع يدوي بحب</text>' +
  '</svg>'
);

const $ = (id) => document.getElementById(id);
const IS_ADMIN = document.body.dataset.page === 'admin';
const clone = (o) => JSON.parse(JSON.stringify(o));
const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
]);

const FB = { on: false, db: null, auth: null, fs: null, au: null };
let FB_INIT_PROMISE = Promise.resolve();
let READY = Promise.resolve();
let publishRunning = null;
let publishQueued = null;
const syncBusy = () => Boolean(publishRunning || publishQueued);

const state = {
  site: null,
  heroOverride: null,
  base: [],
  published: [],
  draft: [],
  filter: 'all',
  search: '',
  sort: 'default',
  editing: null,
  formImages: [],
  cart: [],
  localUpdatedAt: 0,
  syncedToCloud: true,
  forceLocalLogin: false,
  adminDirty: false,
  // حالة المزامنة: idle | publishing | published | failed | conflict
  sync: {
    status: 'idle', loaded: false, baseRevision: null, remoteRevision: null,
    ids: [], hashes: {}, attempts: [], progressText: '', localBaseRevision: undefined
  }
};

/* ---------- IndexedDB Unlimited Local Storage (for Base64 Photos) ---------- */
const idb = (() => {
  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('no-idb')); return; }
      const req = indexedDB.open('crochetAmalDB', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb-open-failed'));
    });
    return dbPromise;
  }
  return {
    async get(key) {
      try {
        const db = await open();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readonly');
          const r = tx.objectStore('kv').get(key);
          r.onsuccess = () => resolve(r.result ?? null);
          r.onerror = () => reject(r.error);
        });
      } catch (_) { return null; }
    },
    async set(key, val) {
      try {
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(val, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
        return true;
      } catch (_) { return false; }
    },
    async del(key) {
      try {
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').delete(key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (_) { /* ignore */ }
    }
  };
})();

/* ---------- Image URL Normalization & Safari/Android-Safe Compression ---------- */
function normalizeImgUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let u = raw.trim();
  if (!u) return '';

  // Data URL (uploaded photos)
  if (/^data:image\//i.test(u)) {
    return u.replace(/\s+/g, '');
  }

  // Google Drive shared file link -> direct thumbnail image URL
  const gFile = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i)
    || u.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/i)
    || u.match(/drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/i);
  if (gFile && gFile[1]) {
    return 'https://drive.google.com/thumbnail?id=' + gFile[1] + '&sz=w1200';
  }

  // Dropbox shared link -> raw direct image
  if (/^https?:\/\/(www\.)?dropbox\.com\//i.test(u)) {
    return u.replace(/([?&])dl=0\b/, '$1raw=1');
  }

  // External HTTP/HTTPS URL
  if (/^https?:\/\//i.test(u)) {
    return u;
  }

  // Relative local path: strip leading "/" so GitHub Pages subpath (/.com/) works properly
  u = u.replace(/^\/+/, '');
  return u;
}

function validImgUrl(raw) {
  const u = normalizeImgUrl(raw);
  if (!u) return false;
  if (/^data:image\/[a-zA-Z0-9.+-]+(?:;[^,]*)?,[A-Za-z0-9+/=%]+$/i.test(u)) return true;
  if (/^https?:\/\/\S+$/i.test(u)) return true;
  if (/\.(jpe?g|png|webp|gif|svg|avif)(\?.*)?$/i.test(u)) return true;
  return false;
}

function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file);
    const im = new Image();
    im.onload = async () => {
      if (typeof im.decode === 'function') {
        try { await im.decode(); } catch (_) { /* continue */ }
      }
      resolve({ img: im, cleanup: () => URL.revokeObjectURL(objUrl) });
    };
    im.onerror = () => {
      URL.revokeObjectURL(objUrl);
      // Fallback via FileReader DataURL
      const reader = new FileReader();
      reader.onload = () => {
        const im2 = new Image();
        im2.onload = async () => {
          if (typeof im2.decode === 'function') {
            try { await im2.decode(); } catch (_) { /* continue */ }
          }
          resolve({ img: im2, cleanup: () => {} });
        };
        im2.onerror = () => reject(new Error('decode-failed'));
        im2.src = reader.result;
      };
      reader.onerror = () => reject(new Error('read-failed'));
      reader.readAsDataURL(file);
    };
    im.src = objUrl;
  });
}

async function processImageFile(file, maxSide = 880, maxChars = 155000) {
  let source = null;
  let cleanup = () => {};
  let width = 0;
  let height = 0;

  try {
    try {
      const res = await decodeImageFile(file);
      source = res.img;
      cleanup = res.cleanup;
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    } catch (_) {
      if (window.createImageBitmap) {
        const bmp = await createImageBitmap(file);
        source = bmp;
        cleanup = () => { if (typeof bmp.close === 'function') bmp.close(); };
        width = bmp.width;
        height = bmp.height;
      } else {
        throw new Error('تعذّر فك ترميز الصورة');
      }
    }

    if (!width || !height) throw new Error('أبعاد الصورة غير صالحة');

    const scale = Math.min(1, maxSide / Math.max(width, height));
    let cw = Math.max(1, Math.round(width * scale));
    let ch = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const renderAt = (w, h, quality) => {
      canvas.width = w;
      canvas.height = h;
      // Fill warm porcelain background so transparent PNGs never turn black
      ctx.fillStyle = '#fffdf9';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/webp', quality);
      if (!/^data:image\/webp/i.test(dataUrl)) {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      if (!/^data:image\/(webp|jpeg)/i.test(dataUrl)) {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      return dataUrl;
    };

    let quality = 0.84;
    let out = renderAt(cw, ch, quality);

    while (out.length > maxChars && quality > 0.44) {
      quality -= 0.08;
      out = renderAt(cw, ch, quality);
    }
    while (out.length > maxChars && Math.max(cw, ch) > 420) {
      cw = Math.round(cw * 0.82);
      ch = Math.round(ch * 0.82);
      out = renderAt(cw, ch, 0.76);
    }

    return out;
  } finally {
    // Only revoke blob URL AFTER drawImage has completed (critical for iOS/macOS Safari!)
    cleanup();
  }
}

/* ---------- DOM & Resilient Image Rendering ---------- */
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  kids.forEach((c) => { if (c !== null && c !== undefined) e.append(c); });
  return e;
}

function smartImg(rawSrc, alt, extra = {}, bgImgEl = null) {
  const normalized = normalizeImgUrl(rawSrc);
  const initialSrc = normalized || FALLBACK;
  const isExternal = /^https?:\/\//i.test(initialSrc);
  const props = { alt: alt || '', loading: 'lazy', ...extra };
  if (isExternal) {
    props.referrerPolicy = 'no-referrer';
  }
  const i = el('img', props);
  if (bgImgEl && isExternal) {
    bgImgEl.referrerPolicy = 'no-referrer';
  }
  let triedAssetsFolder = false;

  const syncBg = () => {
    if (!bgImgEl) return;
    if (i.src && i.src !== FALLBACK) {
      bgImgEl.src = i.currentSrc || i.src;
      bgImgEl.hidden = false;
    } else {
      bgImgEl.hidden = true;
    }
  };

  i.addEventListener('load', syncBg);
  i.addEventListener('error', () => {
    // If bare filename like "tote-bag.jpg" failed at root, try "assets/images/tote-bag.jpg"
    if (
      !triedAssetsFolder &&
      normalized &&
      !/^(data:|https?:|assets\/images\/)/i.test(normalized) &&
      !normalized.includes('/')
    ) {
      triedAssetsFolder = true;
      i.src = 'assets/images/' + normalized;
      return;
    }
    if (i.src !== FALLBACK) {
      i.src = FALLBACK;
      if (bgImgEl) bgImgEl.hidden = true;
    }
  });

  i.src = initialSrc;
  if (bgImgEl) {
    if (initialSrc !== FALLBACK) bgImgEl.src = initialSrc;
    else bgImgEl.hidden = true;
  }
  return i;
}

function toast(msg, bad = false) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast'; }, bad ? 9000 : 3600);
}

/* ---------- Data Sanitization ---------- */
function cleanProducts(list) {
  if (!Array.isArray(list)) throw new Error('الملف لا يحتوي على قائمة منتجات صالحة');
  const out = [];
  list.forEach((p, n) => {
    if (!p || p.id === META_DOC_ID) return;
    const name = String(p.name || '').trim();
    const price = Number(p.price);
    if (!name || !(price > 0)) return;

    const rawImages = Array.isArray(p.images) ? p.images : [];
    const primary = normalizeImgUrl(String(p.image || rawImages[0] || ''));
    const gallery = [];
    if (primary) gallery.push(primary);
    rawImages.forEach((u) => {
      const nu = normalizeImgUrl(String(u || ''));
      if (nu && !gallery.includes(nu)) gallery.push(nu);
    });

    out.push({
      id: String(p.id || 'p-' + Date.now().toString(36) + '-' + n),
      name,
      description: String(p.description || '').trim(),
      price,
      category: String(p.category || 'gifts'),
      image: gallery[0] || '',
      images: gallery,
      badge: String(p.badge || '').trim(),
      visible: p.visible !== false
    });
  });
  return out;
}

/* ---------- Local Persistence Helpers ---------- */
// 'catalog'       = النسخة العاملة للمشرفة (قد تحتوي تعديلات غير منشورة)
// 'cloudSnapshot' = آخر نسخة مؤكدة من Firestore (هي ما يراه الزوار)
async function saveLocalState(products, heroOverride, syncedToCloud, extra = {}) {
  const updatedAt = Date.now();
  state.localUpdatedAt = updatedAt;
  state.syncedToCloud = syncedToCloud;
  const baseRevision = extra.baseRevision !== undefined ? extra.baseRevision : state.sync.baseRevision;

  let ok = await idb.set('catalog', { products: clone(products), updatedAt, syncedToCloud, baseRevision });

  if (heroOverride) {
    await idb.set('heroOverride', { ...clone(heroOverride), updatedAt });
    try { localStorage.setItem(HERO_KEY, JSON.stringify({ ...heroOverride, updatedAt })); } catch (_) { /* quota */ }
  } else {
    await idb.del('heroOverride');
    try { localStorage.removeItem(HERO_KEY); } catch (_) { /* ignore */ }
  }

  try {
    const serialized = JSON.stringify(products);
    localStorage.setItem(CACHE, serialized);
    localStorage.setItem(KEY, serialized);
    ok = true;
  } catch (_) {
    try { localStorage.removeItem(CACHE); localStorage.removeItem(KEY); } catch (_2) { /* ignore */ }
  }
  return ok;
}

async function saveCloudSnapshot(remote) {
  return idb.set('cloudSnapshot', {
    products: clone(remote.products),
    hero: remote.hero ? clone(remote.hero) : null,
    revision: remote.revision,
    savedAt: Date.now()
  });
}

async function loadLocalState() {
  const idbCat = await idb.get('catalog');
  const idbHero = await idb.get('heroOverride');
  const snap = await idb.get('cloudSnapshot');
  const snapshot = snap && Array.isArray(snap.products)
    ? { products: cleanProducts(snap.products), hero: snap.hero || null, revision: snap.revision }
    : null;

  let hero = idbHero || null;
  if (!hero) {
    try {
      const rawH = localStorage.getItem(HERO_KEY);
      if (rawH) hero = JSON.parse(rawH);
    } catch (_) { /* ignore */ }
  }

  if (idbCat && Array.isArray(idbCat.products) && idbCat.products.length) {
    return {
      products: cleanProducts(idbCat.products),
      updatedAt: Number(idbCat.updatedAt || 0),
      syncedToCloud: idbCat.syncedToCloud !== false,
      baseRevision: idbCat.baseRevision,   // undefined في النسخ القديمة
      hero,
      snapshot
    };
  }

  for (const k of [KEY, CACHE]) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        const parsed = cleanProducts(JSON.parse(raw));
        if (parsed.length) {
          return { products: parsed, updatedAt: 1, syncedToCloud: true, baseRevision: undefined, hero, snapshot };
        }
      }
    } catch (_) { /* ignore */ }
  }

  return { products: null, updatedAt: 0, syncedToCloud: true, baseRevision: undefined, hero, snapshot };
}

/* ---------- Firebase Firestore Sync (المنطق في js/sync-core.js) ---------- */
async function fbInit() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.projectId) return;
  const base = window.FIREBASE_SDK_BASE || 'https://www.gstatic.com/firebasejs/13.1.0/';
  const [appMod, fsMod, auMod] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-firestore.js'),
    import(base + 'firebase-auth.js')
  ]);
  const app = appMod.getApps().find((candidate) => candidate.name === '[DEFAULT]')
    || appMod.initializeApp(cfg);
  const db = fsMod.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const auth = auMod.getAuth(app);

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const unsub = auMod.onAuthStateChanged(auth, () => {
      if (typeof unsub === 'function') unsub();
      finish();
    }, () => finish());
    setTimeout(finish, 1500);
  });

  Object.assign(FB, { db, auth, fs: fsMod, au: auMod, on: true });
}

// إعادة محاولة التهيئة (مثلًا عند تسجيل الدخول بعد بطء الشبكة)
async function ensureFirebase(ms = 15000) {
  if (FB.on) return true;
  try {
    await withTimeout(fbInit(), ms);
  } catch (e) {
    FB.on = false;
    logSyncError('init', e);
  }
  return FB.on;
}

const syncDeps = () => ({ fs: FB.fs, db: FB.db, cleanProducts });

async function fbLoad() {
  return CrochetSync.load(syncDeps());
}

function applyRemoteBaseline(remote, keepRevision = false) {
  const s = state.sync;
  s.ids = remote.ids.slice();
  s.hashes = { ...remote.hashes };
  s.remoteRevision = remote.revision;
  if (!keepRevision) s.baseRevision = remote.revision;
  s.loaded = true;
}

async function fbSave(list, heroOverride, extra = {}) {
  const s = state.sync;
  try {
    const result = await CrochetSync.publish(
      syncDeps(), list, heroOverride,
      { revision: s.baseRevision, ids: s.ids, hashes: s.hashes },
      {
        ownRevisions: s.attempts,
        onProgress: ({ done, total }) => {
          s.progressText = '⏳ جارٍ النشر ' + done + '/' + total + '…';
          renderSyncStatus();
        },
        ...extra
      }
    );
    s.baseRevision = result.revision;
    s.remoteRevision = result.revision;
    s.ids = result.ids;
    s.hashes = result.hashes;
    s.attempts = [];
    return result;
  } catch (err) {
    if (err && err.attemptRevision) s.attempts.push(err.attemptRevision);
    throw err;
  }
}

// تسجيل مفيد دون كلمات مرور أو رموز مصادقة
function logSyncError(op, err, extra) {
  console.error('[Crochet.Amal sync] فشلت العملية: ' + op, {
    kind: CrochetSync.classifyError(err),
    code: err && err.code,
    stage: err && err.stage,
    message: String((err && err.message) || err).slice(0, 300),
    ...(extra || {})
  });
}

function describeSyncError(err) {
  const kind = CrochetSync.classifyError(err);
  const user = FB.auth && FB.auth.currentUser;
  const email = user && user.email;
  const d = (err && err.detail) || {};
  const texts = {
    'permission-denied': () => (email && email.toLowerCase() === ADMIN_EMAIL
      ? 'رفض Firebase الكتابة (permission-denied) رغم أن الحساب هو حساب الإدارة. الأرجح أن القواعد المنشورة في Firebase Console لا تطابق ملف firestore.rules؛ انسخي القواعد أدناه وانشريها.'
      : 'رفض Firebase الكتابة (permission-denied). الحساب الحالي ' + (email || '(غير معروف)') + ' ليس حساب الإدارة (' + ADMIN_EMAIL + ')؛ سجّلي الخروج وادخلي بحساب الإدارة.'),
    unauthenticated: () => 'انتهت جلسة تسجيل الدخول في Firebase. سجّلي الخروج ثم ادخلي مجددًا بالبريد وكلمة المرور.',
    timeout: () => 'انتهت مهلة الاتصال أثناء النشر (الشبكة بطيئة). تعديلاتكِ محفوظة على جهازكِ؛ اضغطي «إعادة محاولة النشر».',
    network: () => 'تعذّر الوصول إلى خوادم Firebase (لا اتصال أو الاتصال مقطوع). تعديلاتكِ محفوظة على جهازكِ؛ أعيدي المحاولة عند عودة الاتصال.',
    quota: () => 'تجاوزتِ الحصة اليومية المجانية لـ Firestore (خطة Spark). أعيدي المحاولة لاحقًا؛ تعديلاتكِ محفوظة على جهازكِ.',
    'doc-too-large': () => 'حجم بيانات «' + (d.label || d.id) + '» (' + (d.bytes / 1048576).toFixed(2) + ' MB) يتجاوز حد Firestore للمستند الواحد (1 MB). احذفي بعض صور هذا العنصر أو استبدليها بصور أصغر ثم انشري من جديد.',
    'invalid-data': () => 'رفض Firestore البيانات المرسلة (حجم أو تنسيق غير مقبول). راجعي صور المنتج الأخيرة ثم أعيدي المحاولة.',
    conflict: () => 'النسخة السحابية تغيّرت بعد آخر مرة حمّلتِها (ربما من جهاز آخر). لم يُنشر شيء، وتعديلاتكِ محفوظة محليًا.',
    'no-baseline': () => 'تعذّرت قراءة النسخة السحابية الحالية، ولا يمكن النشر بأمان قبل ذلك. تحققي من الاتصال ثم أعيدي المحاولة.',
    'empty-list': () => 'لم يُنشر: القائمة فارغة وسيؤدي النشر إلى حذف كل المنتجات.',
    'duplicate-id': () => 'يوجد منتجان بالمعرّف نفسه؛ لم يُنشر شيء.',
    'bad-id': () => 'منتج بمعرّف غير صالح؛ لم يُنشر شيء.',
    unknown: () => 'حدث خطأ غير متوقع أثناء النشر (' + String((err && (err.code || err.message)) || '').slice(0, 80) + '). تعديلاتكِ محفوظة على جهازكِ.'
  };
  return { kind, text: (texts[kind] || texts.unknown)() };
}

/* ---------- WhatsApp Links & Cart ---------- */
const waBase = () => 'https://wa.me/' + (state.site ? state.site.whatsapp : '212700278798');
const waLink = (text) => waBase() + (text ? '?text=' + encodeURIComponent(text) : '');

function waProductMessage(p) {
  const link = new URL('#' + p.id, location.href.split('#')[0]).href;
  return `السلام عليكم أمال 🌸\nأود طلب القطعة التالية:\n• المنتج: ${p.name}\n• الثمن: ${p.price} درهم\n• الرابط: ${link}`;
}

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.cart = arr.filter((x) => x && x.id && x.qty > 0);
    }
  } catch (_) { state.cart = []; }
}

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (_) { /* ignore */ }
  renderCart();
}

function addToCart(p) {
  const found = state.cart.find((x) => x.id === p.id);
  if (found) found.qty += 1;
  else state.cart.push({ id: p.id, name: p.name, price: p.price, image: p.image, qty: 1 });
  saveCart();
  toast(`تمت إضافة «${p.name}» إلى سلة الطلب ✓`);
}

function changeCartQty(id, delta) {
  const idx = state.cart.findIndex((x) => x.id === id);
  if (idx < 0) return;
  state.cart[idx].qty += delta;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  saveCart();
}

function renderCart() {
  const countEl = $('cartCount');
  if (!countEl) return;
  const totalQty = state.cart.reduce((s, x) => s + x.qty, 0);
  countEl.textContent = String(totalQty);

  const itemsBox = $('cartItems');
  const totalEl = $('cartTotal');
  const checkoutBtn = $('cartCheckoutBtn');
  if (!itemsBox) return;

  itemsBox.replaceChildren();
  if (!state.cart.length) {
    itemsBox.append(el('p', { className: 'empty', style: 'margin:auto 0' }, [
      'سلة الطلب فارغة حاليًا. أضيفي قطعكِ المفضلة لإرسالها في طلب واحد عبر واتساب.'
    ]));
    totalEl.textContent = '0 درهم';
    checkoutBtn.href = waLink('السلام عليكم أمال، أود الاستفسار عن منتجات الكروشيه المتوفرة.');
    return;
  }

  let sum = 0;
  state.cart.forEach((item) => {
    const live = state.published.find((p) => p.id === item.id);
    const name = live ? live.name : item.name;
    const price = live ? live.price : item.price;
    const imgSrc = live ? live.image : item.image;
    sum += price * item.qty;

    const minus = el('button', { type: 'button', textContent: '−', 'aria-label': 'تقليل الكمية' });
    minus.onclick = () => changeCartQty(item.id, -1);
    const plus = el('button', { type: 'button', textContent: '+', 'aria-label': 'زيادة الكمية' });
    plus.onclick = () => changeCartQty(item.id, 1);

    itemsBox.append(el('div', { className: 'cart-item' }, [
      smartImg(imgSrc, name, { width: 60, height: 60 }),
      el('div', { className: 'cart-item-info' }, [
        el('strong', {}, [name]),
        el('span', {}, [`${price} درهم × ${item.qty}`])
      ]),
      el('div', { className: 'qty-box' }, [minus, el('span', {}, [String(item.qty)]), plus])
    ]));
  });

  totalEl.textContent = `${sum} درهم`;
  updateCartCheckoutLink(sum);
}

function updateCartCheckoutLink(sumOverride) {
  const checkoutBtn = $('cartCheckoutBtn');
  if (!checkoutBtn || !state.cart.length) return;
  const sum = sumOverride ?? state.cart.reduce((s, item) => {
    const live = state.published.find((p) => p.id === item.id);
    return s + (live ? live.price : item.price) * item.qty;
  }, 0);

  const lines = ['السلام عليكم أمال 🌸، أود طلب القطع التالية:'];
  state.cart.forEach((item, idx) => {
    const live = state.published.find((p) => p.id === item.id);
    const name = live ? live.name : item.name;
    const price = live ? live.price : item.price;
    lines.push(`${idx + 1}. ${name} (الكمية: ${item.qty}) — ${price * item.qty} درهم`);
  });
  lines.push(`\nالمجموع: ${sum} درهم`);
  const city = $('cartCity') && $('cartCity').value.trim();
  const note = $('cartNote') && $('cartNote').value.trim();
  if (city) lines.push(`المدينة: ${city}`);
  if (note) lines.push(`ملاحظة: ${note}`);

  checkoutBtn.href = waLink(lines.join('\n'));
}

/* ---------- Quick View / Full Image Lightbox ---------- */
function openQuickView(p) {
  const dlg = $('qvDlg');
  if (!dlg) return;
  const cats = (state.site && state.site.categories) || {};
  $('qvCat').textContent = cats[p.category] || 'قطعة يدوية';
  $('qvTitle').textContent = p.name;
  $('qvPrice').textContent = `${p.price} درهم`;
  $('qvDesc').textContent = p.description;
  $('qvWa').href = waLink(waProductMessage(p));

  $('qvAddCart').onclick = () => {
    addToCart(p);
    dlg.close();
  };

  const photos = (Array.isArray(p.images) && p.images.length) ? p.images : [p.image];
  const mainWrap = $('qvImg').parentElement;
  const thumbs = $('qvThumbs');
  thumbs.replaceChildren();

  const setMain = (src, idx) => {
    const newImg = smartImg(src, p.name, { id: 'qvImg', loading: 'eager' });
    mainWrap.replaceChildren(newImg);
    [...thumbs.children].forEach((b, j) => b.classList.toggle('active', j === idx));
  };

  setMain(photos[0], 0);
  if (photos.length > 1) {
    photos.forEach((src, idx) => {
      const b = el('button', { type: 'button', className: 'qv-thumb' + (idx === 0 ? ' active' : '') }, [
        smartImg(src, `${p.name} ${idx + 1}`, { width: 58, height: 58 })
      ]);
      b.onclick = () => setMain(src, idx);
      thumbs.append(b);
    });
  }

  if (!dlg.open) dlg.showModal();
}

/* ---------- Storefront Rendering ---------- */
function card(p, previewOnly = false) {
  const cats = (state.site && state.site.categories) || {};
  const bgImg = el('img', { className: 'card-media-bg', alt: '', 'aria-hidden': 'true', loading: 'lazy' });
  const mainPhoto = (Array.isArray(p.images) && p.images[0]) || p.image;
  const photoEl = smartImg(mainPhoto, p.name, { className: 'card-main-img', width: 420, height: 460 }, bgImg);

  const zoomBtn = el('button', {
    type: 'button',
    className: 'card-zoom-btn',
    'aria-label': 'تكبير ومعاينة ' + p.name
  }, ['🔍 معاينة']);

  const mediaKids = [
    bgImg,
    photoEl,
    el('span', { className: 'card-cat-pill' }, [cats[p.category] || 'كروشيه'])
  ];
  if (p.badge) {
    mediaKids.push(el('span', { className: 'card-badge' }, [p.badge]));
  }
  if (Array.isArray(p.images) && p.images.length > 1) {
    mediaKids.push(el('span', { className: 'card-photos-count' }, [`📷 ${p.images.length}`]));
  }
  if (!previewOnly) {
    mediaKids.push(zoomBtn);
  }

  const mediaBox = el('div', { className: 'card-media' }, mediaKids);
  if (!previewOnly) {
    mediaBox.onclick = () => openQuickView(p);
  }

  const waBtn = el('a', {
    className: 'btn wa',
    target: '_blank',
    rel: 'noopener',
    href: waLink(waProductMessage(p))
  }, ['اطلبي عبر واتساب']);
  waBtn.setAttribute('aria-label', 'اطلبي ' + p.name + ' عبر واتساب');

  const addBtn = el('button', {
    type: 'button',
    className: 'add-cart-btn',
    'aria-label': 'أضيفي ' + p.name + ' إلى سلة الطلب'
  }, ['+ للسلة']);
  addBtn.onclick = () => addToCart(p);

  return el('article', { className: 'card', id: previewOnly ? undefined : p.id }, [
    mediaBox,
    el('div', { className: 'card-body' }, [
      el('h3', {}, [p.name]),
      el('p', { className: 'card-desc' }, [p.description]),
      el('div', { className: 'card-price-row' }, [
        el('span', { className: 'price' }, [String(p.price), ' ', el('small', {}, ['درهم'])]),
        el('span', { className: 'stock-pill' }, ['متوفر للطلب'])
      ]),
      previewOnly ? waBtn : el('div', { className: 'card-actions' }, [waBtn, addBtn])
    ])
  ]);
}

function getFilteredProducts(list) {
  const q = state.search.trim().toLowerCase();
  let shown = list.filter((p) => {
    if (!p.visible) return false;
    if (state.filter !== 'all' && p.category !== state.filter) return false;
    if (q && !(p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))) return false;
    return true;
  });

  if (state.sort === 'price-asc') shown = [...shown].sort((a, b) => a.price - b.price);
  else if (state.sort === 'price-desc') shown = [...shown].sort((a, b) => b.price - a.price);
  return shown;
}

function fill(grid, list, previewOnly = false) {
  if (!grid) return;
  grid.replaceChildren();
  const shown = previewOnly ? list.filter((p) => p.visible) : getFilteredProducts(list);
  if ($('resultsCount') && !previewOnly) {
    $('resultsCount').textContent = `${shown.length} قطعة`;
  }
  if (!shown.length) {
    grid.append(el('div', { className: 'empty' }, [
      el('p', { style: 'margin:0 0 10px;font-weight:700;color:var(--cocoa)' }, ['لا توجد قطع مطابقة لبحثكِ حاليًا.']),
      el('p', { style: 'margin:0;font-size:.92rem' }, ['جرّبي اختيار قسم آخر أو راسلينا عبر واتساب لتصميم قطعتكِ الخاصة.'])
    ]));
    return;
  }
  shown.forEach((p) => grid.append(card(p, previewOnly)));
}

function renderStore() {
  if (!$('grid') || !state.site) return;
  fill($('grid'), state.published, false);

  const cats = state.site.categories || {};
  const box = $('chips');
  if (box) {
    box.replaceChildren();
    [['all', 'كل القطع'], ...Object.entries(cats)].forEach(([k, label]) => {
      const n = state.published.filter((p) => p.visible && (k === 'all' || p.category === k)).length;
      const b = el('button', { className: 'chip', type: 'button' }, [
        el('span', {}, [label]),
        el('span', { className: 'chip-count' }, [String(n)])
      ]);
      b.setAttribute('aria-pressed', String(state.filter === k));
      b.onclick = () => {
        state.filter = k;
        renderStore();
      };
      box.append(b);
    });
  }
  renderCart();
}

function getEffectiveHero() {
  const baseHero = (state.site && state.site.hero) || {};
  const ov = state.heroOverride || {};
  return {
    title: ov.title || baseHero.title || 'كروشيه مصنوع بيد أمال، بحبّ في كل غرزة',
    text: ov.text || baseHero.text || '',
    cta: baseHero.cta || 'اطلبي عبر واتساب',
    image: ov.image || baseHero.image || 'assets/images/tote-bag.jpg'
  };
}

function renderSite() {
  if (!state.site || IS_ADMIN) return;
  const s = state.site;
  const hero = getEffectiveHero();
  const generalWa = waLink('السلام عليكم أمال 🌸، أود الاستفسار عن منتجات الكروشيه المتوفرة.');

  if ($('hTitle')) $('hTitle').textContent = hero.title;
  if ($('hText')) $('hText').textContent = hero.text;
  if ($('hCtaText')) $('hCtaText').textContent = hero.cta;
  if ($('hCta')) $('hCta').href = generalWa;
  if ($('cCta')) $('cCta').href = generalWa;
  if ($('waFloat')) $('waFloat').href = generalWa;

  // Render Hero image cleanly with shared-bitmap blurred ambient backdrop & smart fallback
  const hFrame = $('hImg') && $('hImg').parentElement;
  if (hFrame) {
    const bgImg = el('img', { className: 'hero-frame-bg', id: 'hImgBg', alt: '', 'aria-hidden': 'true' });
    const newHeroImg = smartImg(hero.image, 'قطعة كروشيه مميزة من Crochet.Amal', {
      className: 'hero-main-img',
      id: 'hImg',
      width: 600,
      height: 600,
      loading: 'eager'
    }, bgImg);
    hFrame.replaceChildren(bgImg, newHeroImg);
  }

  if ($('cText')) $('cText').textContent = s.contact.text;
  if ($('cPhone')) $('cPhone').textContent = s.contact.phoneDisplay;
  if ($('instaCta') && s.social && s.social.instagram) {
    $('instaCta').href = s.social.instagram;
  }

  const whyIcons = ['🧶', '🌿', '🎨', '🎁'];
  if ($('why') && Array.isArray(s.why)) {
    $('why').replaceChildren(...s.why.map((x, idx) =>
      el('div', { className: 'why-card' }, [
        el('div', { className: 'why-icon', 'aria-hidden': 'true' }, [whyIcons[idx % whyIcons.length]]),
        el('h3', {}, [x.title]),
        el('p', {}, [x.text])
      ])
    ));
  }

  if ($('reviews') && Array.isArray(s.testimonials)) {
    $('reviews').replaceChildren(...s.testimonials.map((t) =>
      el('blockquote', { className: 'review-card' }, [
        el('div', { className: 'review-stars', 'aria-label': '5 نجوم' }, ['★★★★★']),
        el('p', {}, [`«${t.text}»`]),
        el('footer', { className: 'review-author' }, [
          el('div', { className: 'review-avatar', 'aria-hidden': 'true' }, [String(t.name || 'ز').charAt(0)]),
          el('div', {}, [
            el('strong', {}, [t.name]),
            el('span', {}, [t.city])
          ])
        ])
      ])
    ));
  }

  const names = { instagram: 'إنستغرام', facebook: 'فيسبوك', tiktok: 'تيك توك' };
  if ($('social') && s.social) {
    $('social').replaceChildren(...Object.entries(s.social).map(([k, u]) =>
      el('a', { href: u, target: '_blank', rel: 'noopener' }, [names[k] || k])
    ));
  }
}

function wireStorefrontUI() {
  if (IS_ADMIN) return;
  loadCart();

  const menuBtn = $('menuBtn');
  const navLinks = $('navLinks');
  if (menuBtn && navLinks) {
    menuBtn.onclick = () => {
      const open = navLinks.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(open));
    };
    navLinks.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        navLinks.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  if ($('searchInput')) {
    $('searchInput').oninput = (e) => {
      state.search = e.target.value;
      fill($('grid'), state.published, false);
    };
  }
  if ($('sortSelect')) {
    $('sortSelect').onchange = (e) => {
      state.sort = e.target.value;
      fill($('grid'), state.published, false);
    };
  }

  const qvDlg = $('qvDlg');
  if (qvDlg && $('qvClose')) {
    $('qvClose').onclick = () => qvDlg.close();
    qvDlg.addEventListener('click', (e) => {
      if (e.target === qvDlg) qvDlg.close();
    });
  }

  const toggleCart = (open) => {
    if (!$('cartDrawer') || !$('cartBackdrop')) return;
    $('cartDrawer').hidden = !open;
    $('cartBackdrop').hidden = !open;
    document.body.style.overflow = open ? 'hidden' : '';
  };
  if ($('openCartBtn')) $('openCartBtn').onclick = () => toggleCart(true);
  if ($('closeCartBtn')) $('closeCartBtn').onclick = () => toggleCart(false);
  if ($('cartBackdrop')) $('cartBackdrop').onclick = () => toggleCart(false);
  if ($('cartCity')) $('cartCity').oninput = () => updateCartCheckoutLink();
  if ($('cartNote')) $('cartNote').oninput = () => updateCartCheckoutLink();
}

/* ---------- Admin Panel Logic ---------- */
async function sha256(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cloudConfigured = () => Boolean(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);
const cloudSession = () => Boolean(FB.on && FB.auth && FB.auth.currentUser);

function updateSyncPill(status, text) {
  const pill = $('syncPill');
  if (!pill) return;
  pill.className = 'sync-pill' + (status === 'ok' ? ' ok' : status === 'warn' ? ' warn' : status === 'bad' ? ' bad' : '');
  pill.textContent = text;
}

// الحالات: محفوظ محليًا | جارٍ النشر | منشور سحابيًا | فشل النشر
function renderSyncStatus() {
  const s = state.sync;
  if (s.status === 'publishing') return updateSyncPill('warn', s.progressText || '⏳ جارٍ النشر…');
  if (s.status === 'failed') return updateSyncPill('bad', '✕ فشل النشر · محفوظ على جهازكِ فقط');
  if (s.status === 'conflict') return updateSyncPill('bad', '⚠ نسخة سحابية أحدث · لم يُنشر شيء');
  if (!cloudConfigured()) return updateSyncPill('warn', 'حفظ محلي على هذا الجهاز');
  if (!cloudSession()) return updateSyncPill('warn', 'غير متصلة بحساب Firebase · لا نشر سحابي');
  if (!state.syncedToCloud) return updateSyncPill('warn', '● تعديلات محفوظة محليًا وغير منشورة');
  return updateSyncPill('ok', '✓ منشور سحابيًا للجميع');
}

function setSyncStatus(status) {
  state.sync.status = status;
  state.sync.progressText = '';
  renderSyncStatus();
}

let rulesTextCache = null;
async function loadRulesText() {
  if (rulesTextCache) return rulesTextCache;
  try {
    const r = await fetch('firestore.rules', { cache: 'no-store' });
    if (r.ok) rulesTextCache = await r.text();
  } catch (_) { /* ignore */ }
  return rulesTextCache;
}

async function showSyncProblem(kind, text) {
  const box = $('rulesAlert');
  if (!box) return;
  if ($('syncErrMsg')) $('syncErrMsg').textContent = text;
  const help = $('rulesHelp');
  if (help) help.hidden = kind !== 'permission-denied';
  if ($('loadCloudBtn')) $('loadCloudBtn').hidden = kind !== 'conflict';
  box.hidden = false;

  if (kind === 'permission-denied' && $('rulesCode')) {
    // نعرض محتوى firestore.rules نفسه (مصدر واحد)، لا قواعد مولّدة حسب بريد من سجّل الدخول
    const rulesText = (await loadRulesText()) || 'تعذّر تحميل firestore.rules؛ انسخي محتوى الملف من المستودع.';
    $('rulesCode').textContent = rulesText;
    if ($('copyRulesBtn')) {
      $('copyRulesBtn').onclick = async () => {
        try {
          await navigator.clipboard.writeText(rulesText);
          toast('تم نسخ قواعد Firestore ✓ الصقيها في Firebase Console > Firestore > Rules ثم Publish');
        } catch (_) {
          toast('انسخي النص الموجود في المربع الأسود يدويًا.');
        }
      };
    }
  }
}

function hideSyncProblem() {
  if ($('rulesAlert')) $('rulesAlert').hidden = true;
}

function refreshAdminConnectionNotice() {
  if (!$('admin') || $('admin').hidden) return;
  renderSyncStatus();
  if (cloudSession()) {
    $('notice').textContent = 'أنتِ متصلة بـ Firebase (' + (FB.auth.currentUser.email || 'حساب المسؤولة') + '): كل تعديل يُنشر لكل الزوار بعد التأكد من حفظه في السحابة. راقبي حالة النشر في الشارة أعلاه؛ إن فشل النشر تبقى تعديلاتكِ على جهازكِ ويمكنكِ إعادة المحاولة.';
  } else if (cloudConfigured()) {
    $('notice').textContent = 'أنتِ في الوضع المحلي: التعديلات محفوظة على هذا الجهاز فقط ولن تظهر للزوار. للنشر سجّلي الخروج ثم ادخلي بالبريد وكلمة المرور.';
  } else {
    $('notice').textContent = 'الوضع المحلي مفعّل: الصور والتعديلات تُحفظ فورًا في متصفحكِ وتظهر مباشرة في صفحة الهبوط على هذا الجهاز.';
  }
}

function openAdmin() {
  state.draft = clone(state.published);
  state.editing = null;
  state.adminDirty = false;
  if ($('loginDlg') && $('loginDlg').open) $('loginDlg').close();
  if ($('gateBox')) $('gateBox').hidden = true;
  $('admin').hidden = false;
  $('aForm').hidden = true;
  $('aPreview').hidden = true;

  refreshAdminConnectionNotice();

  const sel = $('fCat');
  sel.replaceChildren(...Object.entries(state.site.categories).map(([k, v]) => el('option', { value: k }, [v])));
  populateHeroForm();
  renderList();
}

function closeAdmin() {
  if (FB.on && FB.auth && FB.auth.currentUser) {
    FB.au.signOut(FB.auth).catch(() => {});
  }
  sessionStorage.removeItem(SESSION);
  $('admin').hidden = true;
  if ($('gateBox')) $('gateBox').hidden = false;
}

function renderList() {
  const ul = $('aList');
  if (!ul) return;
  ul.replaceChildren();
  if ($('admCount')) $('admCount').textContent = String(state.draft.length);

  state.draft.forEach((p, i) => {
    const btn = (txt, fn, cls = '', label = '') => {
      const b = el('button', { type: 'button', className: cls }, [txt]);
      b.setAttribute('aria-label', label || txt);
      b.onclick = fn;
      return b;
    };

    const photoCount = (Array.isArray(p.images) && p.images.length) ? p.images.length : (p.image ? 1 : 0);
    const li = el('li', { className: state.editing === p ? 'editing-now' : '' }, [
      smartImg(p.image, p.name, { width: 60, height: 60 }),
      el('span', { className: 'nm' + (p.visible ? '' : ' off') }, [
        p.name + (p.visible ? '' : ' (مخفي)'),
        el('small', {}, [`${p.price} درهم · ${photoCount} صورة${p.badge ? ' · ' + p.badge : ''}`])
      ]),
      el('div', { className: 'alist-btns' }, [
        btn('▲', () => move(i, -1), '', 'تحريك للأعلى'),
        btn('▼', () => move(i, 1), '', 'تحريك للأسفل'),
        btn(p.visible ? 'إخفاء' : 'إظهار', () => {
          state.adminDirty = true;
          p.visible = !p.visible;
          renderList();
          publish(true);
        }),
        btn('تعديل', () => editForm(p)),
        btn('حذف', () => {
          if (confirm('هل تريدين حذف المنتج «' + p.name + '»؟')) {
            state.adminDirty = true;
            if (state.editing === p) { state.editing = null; $('aForm').hidden = true; }
            state.draft.splice(i, 1);
            renderList();
            publish(true);
          }
        }, 'del')
      ])
    ]);
    ul.append(li);
  });

  if (!state.draft.length) {
    ul.append(el('li', {}, ['لا توجد منتجات حاليًا. اضغطي «+ إضافة منتج جديد» للبدء.']));
  }
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.draft.length) return;
  state.adminDirty = true;
  [state.draft[i], state.draft[j]] = [state.draft[j], state.draft[i]];
  renderList();
  publish(true);
}

function renderFormGallery() {
  const box = $('upGallery');
  if (!box) return;
  box.replaceChildren();

  state.formImages.forEach((src, idx) => {
    const thumb = smartImg(src, `صورة ${idx + 1}`, { width: 92, height: 92 });
    thumb.title = idx === 0 ? 'الصورة الرئيسية' : 'اضغطي لجعلها الصورة الرئيسية';
    thumb.onclick = () => {
      if (idx === 0) return;
      const [picked] = state.formImages.splice(idx, 1);
      state.formImages.unshift(picked);
      renderFormGallery();
      toast('تم تعيينها كصورة رئيسية للمنتج ✓');
    };

    const delBtn = el('button', { type: 'button', className: 'up-del-btn', 'aria-label': 'حذف الصورة' }, ['✕']);
    delBtn.onclick = (e) => {
      e.stopPropagation();
      state.formImages.splice(idx, 1);
      renderFormGallery();
    };

    const kids = [thumb, delBtn];
    if (idx === 0) {
      kids.push(el('span', { className: 'up-main-tag' }, ['الرئيسية']));
    }
    box.append(el('div', { className: 'up-item' + (idx === 0 ? ' is-main' : '') }, kids));
  });

  if ($('upStatusTitle')) {
    $('upStatusTitle').textContent = state.formImages.length
      ? `تم إرفاق ${state.formImages.length} صورة بنجاح (اضغطي لإضافة المزيد)`
      : 'اضغطي هنا لاختيار صورة من هاتفكِ أو حاسوبكِ';
  }
}

function editForm(p) {
  state.editing = p;
  state.adminDirty = true;
  const f = $('aForm');
  f.hidden = false;
  $('fErr').textContent = '';
  $('fTitle').textContent = p ? `تعديل: ${p.name}` : 'إضافة منتج جديد';
  $('fName').value = p ? p.name : '';
  $('fDesc').value = p ? p.description : '';
  $('fPrice').value = p ? p.price : '';
  $('fCat').value = p ? p.category : Object.keys(state.site.categories)[0];
  $('fBadge').value = (p && p.badge) ? p.badge : '';
  $('fVis').checked = p ? p.visible !== false : true;
  if ($('fUrlInput')) $('fUrlInput').value = '';

  if (p) {
    const imgs = Array.isArray(p.images) && p.images.length ? [...p.images] : (p.image ? [p.image] : []);
    state.formImages = imgs;
  } else {
    state.formImages = [];
  }
  renderFormGallery();
  renderList();
  f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function collectAndApplyOpenForm(silentIfEmpty = false) {
  const f = $('aForm');
  if (!f || f.hidden) return true;

  const pendingUrl = $('fUrlInput') ? normalizeImgUrl($('fUrlInput').value) : '';
  if (pendingUrl && validImgUrl(pendingUrl) && !state.formImages.includes(pendingUrl)) {
    state.formImages.push(pendingUrl);
    $('fUrlInput').value = '';
    renderFormGallery();
  }

  const name = $('fName').value.trim();
  const desc = $('fDesc').value.trim();
  const price = Number($('fPrice').value);

  if (silentIfEmpty && !state.editing && !name && !desc && !price && !state.formImages.length) {
    return true;
  }

  const err = !name ? 'يرجى كتابة اسم المنتج.'
    : !desc ? 'يرجى كتابة وصف قصير للمنتج.'
    : !(price > 0) ? 'يرجى إدخال ثمن صحيح أكبر من 0.'
    : !state.formImages.length ? 'يرجى رفع صورة للمنتج من جهازكِ أو إضافة رابط صورة صالح.'
    : '';

  if (err) {
    $('fErr').textContent = err;
    toast(err, true);
    return false;
  }

  const cleanImgs = state.formImages.map(normalizeImgUrl).filter(Boolean);
  const data = {
    name,
    description: desc,
    price,
    category: $('fCat').value,
    badge: $('fBadge') ? $('fBadge').value.trim() : '',
    image: cleanImgs[0],
    images: cleanImgs,
    visible: $('fVis').checked
  };

  // لا نُسقط أي صورة بصمت: نمنع الحفظ إن تجاوز المستند حد Firestore
  const docBytes = CrochetSync.byteLength(JSON.stringify({ ...data, id: 'x', order: 0 }));
  if (docBytes > CrochetSync.DOC_BYTE_LIMIT) {
    const msg = 'حجم صور هذا المنتج (' + (docBytes / 1048576).toFixed(2) + ' MB) يتجاوز حد Firestore (1 MB للمنتج). احذفي صورة أو أكثر ثم احفظي.';
    $('fErr').textContent = msg;
    toast(msg, true);
    return false;
  }

  if (state.editing) {
    Object.assign(state.editing, data);
  } else {
    state.draft.unshift({ id: 'p-' + Date.now().toString(36), ...data });
  }

  state.adminDirty = true;
  state.editing = null;
  f.hidden = true;
  renderList();
  return true;
}

async function saveForm(e) {
  e.preventDefault();
  if (!collectAndApplyOpenForm(false)) return;
  await publish(true);
}

function populateHeroForm() {
  if (!$('heroTitleInput')) return;
  const h = getEffectiveHero();
  $('heroTitleInput').value = h.title;
  $('heroTextInput').value = h.text;
  $('heroUrlInput').value = /^data:image\//i.test(h.image) ? '' : h.image;
  $('heroPrev').src = normalizeImgUrl(h.image) || FALLBACK;
  $('heroPrev').dataset.currentImg = h.image;
}

// نشر واحد في كل مرة؛ الطلبات التي تصل أثناء النشر تُدمج في تشغيل لاحق واحد يستعمل أحدث مسودة
function publish(auto = false) {
  if (!publishRunning) {
    publishRunning = doPublish(auto).finally(() => { publishRunning = null; });
    return publishRunning;
  }
  if (!publishQueued) {
    publishQueued = publishRunning.catch(() => {}).then(() => {
      publishQueued = null;
      return publish(auto);
    });
  }
  return publishQueued;
}

async function failPublish(op, err, kind, text) {
  logSyncError(op, err);
  setSyncStatus(kind === 'conflict' ? 'conflict' : 'failed');
  await showSyncProblem(kind, text);
  toast('لم يُنشر سحابيًا: ' + text, true);
  return false;
}

async function doPublish(auto) {
  if (!auto && !collectAndApplyOpenForm(true)) return false;

  // 1) نسخة محلية احتياطية فقط، وليست دليلًا على النشر
  setSyncStatus('publishing');
  const localOk = await saveLocalState(state.draft, state.heroOverride, false);
  state.published = clone(state.draft);
  if (!$('aPreview').hidden && $('pGrid')) fill($('pGrid'), state.draft, true);
  if (!localOk) console.warn('[Crochet.Amal sync] تعذّر الحفظ المحلي (IndexedDB/localStorage)');

  // وضع محلي بحت (Firebase غير مُعدّ)
  if (!cloudConfigured()) {
    await saveLocalState(state.draft, state.heroOverride, true);
    setSyncStatus('idle');
    toast('تم الحفظ على هذا الجهاز (الوضع المحلي) ✓');
    return true;
  }

  // Firebase مُعدّ لكن لا توجد جلسة: لا نعرض أي نجاح
  if (!cloudSession()) {
    return failPublish('auth', { code: 'unauthenticated' }, 'unauthenticated',
      'لم تسجّلي الدخول بحساب Firebase، لذا حُفظت التعديلات على جهازكِ فقط ولم تُنشر. سجّلي الخروج ثم ادخلي بالبريد وكلمة المرور.');
  }

  // لا نشر دون قراءة ناجحة للنسخة السحابية (أساس كشف التعارض والحذف الآمن)
  if (!state.sync.loaded) {
    try {
      const remote = await CrochetSync.withTimeout(fbLoad(), 20000, 'load');
      applyRemoteBaseline(remote);
    } catch (err) {
      const d = describeSyncError({ code: 'no-baseline' });
      return failPublish('load-before-publish', err, 'no-baseline', d.text);
    }
  }

  // 2) النشر الفعلي إلى Firestore
  const opts = { force: false, allowEmpty: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await fbSave(state.draft, state.heroOverride, opts);
      await saveLocalState(state.draft, state.heroOverride, true, { baseRevision: result.revision });
      await saveCloudSnapshot({ products: state.draft, hero: state.heroOverride, revision: result.revision });
      state.adminDirty = false;
      hideSyncProblem();
      setSyncStatus('published');
      toast('تم النشر سحابيًا للجميع ✓');
      return true;
    } catch (err) {
      const d = describeSyncError(err);
      if (d.kind === 'empty-list' && !opts.allowEmpty &&
          confirm('قائمة المنتجات فارغة. النشر سيحذف كل المنتجات من المتجر لجميع الزوار. هل أنتِ متأكدة؟')) {
        opts.allowEmpty = true;
        continue;
      }
      if (d.kind === 'conflict' && !opts.force &&
          confirm('تم نشر تغييرات أحدث على السحابة من جهاز آخر بعد آخر تحميل لكِ.\n\nموافق = استبدال النسخة السحابية بنسختكِ الحالية.\nإلغاء = عدم النشر مع بقاء تعديلاتكِ محفوظة محليًا.')) {
        opts.force = true;
        continue;
      }
      return failPublish('publish', err, d.kind, d.text);
    }
  }
  return false;
}

// تحميل النسخة السحابية بدل المحلية (بعد حفظ نسخة احتياطية من المحلية)
async function adoptCloudVersion() {
  if (!cloudSession()) { toast('سجّلي الدخول بحساب Firebase أولًا.', true); return; }
  if (!confirm('سيتم استبدال مسودتكِ الحالية بالنسخة السحابية. ستُحفظ نسخة احتياطية من مسودتكِ على هذا الجهاز. متابعة؟')) return;
  try {
    await idb.set('catalogBackup', { products: clone(state.draft), hero: state.heroOverride ? clone(state.heroOverride) : null, savedAt: Date.now() });
    const remote = await CrochetSync.withTimeout(fbLoad(), 20000, 'load');
    applyRemoteBaseline(remote);
    state.draft = clone(remote.products.length ? remote.products : state.base);
    state.heroOverride = remote.hero || null;
    state.published = clone(state.draft);
    await saveLocalState(state.draft, state.heroOverride, true, { baseRevision: remote.revision });
    await saveCloudSnapshot(remote);
    state.adminDirty = false;
    hideSyncProblem();
    setSyncStatus('published');
    populateHeroForm();
    renderList();
    toast('تم تحميل النسخة السحابية ✓');
  } catch (err) {
    const d = describeSyncError(err);
    logSyncError('adopt-cloud', err);
    toast(d.text, true);
  }
}

function exportJson() {
  const payload = {
    version: 1,
    hero: state.heroOverride || undefined,
    products: state.draft
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'products.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('تم تصدير ملف products.json بنجاح ✓');
}

async function importJson(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const list = cleanProducts(Array.isArray(j) ? j : j.products);
    if (!list.length) throw new Error('لا توجد منتجات صالحة في الملف');
    if (!confirm(`استيراد ${list.length} منتج واستبدال القائمة الحالية؟`)) return;
    state.adminDirty = true;
    state.draft = list;
    if (j && j.hero) state.heroOverride = j.hero;
    $('aForm').hidden = true;
    populateHeroForm();
    renderList();
    await publish(true);
  } catch (err) {
    toast('ملف غير صالح: ' + err.message, true);
  }
}

async function resetAll() {
  if (!confirm('هل تريدين استرجاع الكتالوج الأصلي الافتراضي؟')) return;
  state.adminDirty = true;
  state.draft = clone(state.base);
  state.heroOverride = null;
  $('aForm').hidden = true;
  populateHeroForm();
  renderList();
  await publish(true);
}

function wireAdmin() {
  const dlg = $('loginDlg');

  const updateLoginModalMode = () => {
    const useCloudLogin = Boolean(window.FIREBASE_CONFIG && !state.forceLocalLogin);
    $('emW').hidden = !useCloudLogin;
    if ($('localModeWrap')) {
      $('localModeWrap').hidden = !window.FIREBASE_CONFIG;
      $('useLocalBtn').textContent = state.forceLocalLogin
        ? 'الدخول بحساب Firebase (البريد الإلكتروني)'
        : 'أو الدخول بالوضع المحلي (كلمة المرور فقط)';
    }
  };

  if ($('useLocalBtn')) {
    $('useLocalBtn').onclick = () => {
      state.forceLocalLogin = !state.forceLocalLogin;
      $('loginErr').textContent = '';
      updateLoginModalMode();
      (state.forceLocalLogin ? $('pw') : $('em')).focus();
    };
  }

  // Open login dialog INSTANTLY without blocking on slow network requests
  $('admBtn').onclick = () => {
    if ((FB.on && FB.auth && FB.auth.currentUser) || sessionStorage.getItem(SESSION) === '1') {
      openAdmin();
      return;
    }
    updateLoginModalMode();
    $('pw').value = '';
    $('loginErr').textContent = '';
    if (!dlg.open) dlg.showModal();
    (($('emW').hidden ? $('pw') : $('em'))).focus();
  };

  dlg.querySelector('[data-close]').onclick = () => dlg.close();

  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const go = $('loginGo');
    const err = $('loginErr');
    go.disabled = true;
    err.textContent = 'جارٍ التحقق…';
    try {
      const wantCloud = Boolean(window.FIREBASE_CONFIG && !state.forceLocalLogin);
      if (wantCloud) {
        await FB_INIT_PROMISE;
        if (!(await ensureFirebase())) {
          err.textContent = 'تعذّر الاتصال بـ Firebase حاليًا. اضغطي الزر أدناه للدخول بالوضع المحلي فورًا.';
          return;
        }
        try {
          await withTimeout(
            FB.au.signInWithEmailAndPassword(FB.auth, $('em').value.trim(), $('pw').value),
            12000
          );
          await READY;
          dlg.close();
          openAdmin();
          toast('مرحبًا بكِ أمال 🌸');
          return;
        } catch (ex) {
          const c = String((ex && (ex.code || ex.message)) || '');
          err.textContent = /invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/.test(c)
            ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'
            : /unauthorized-domain/.test(c)
            ? 'هذا النطاق غير مضاف في Firebase (Authentication > Settings > Authorized domains).'
            : /operation-not-allowed/.test(c)
            ? 'الدخول بالبريد غير مفعّل في Firebase (Authentication > Sign-in method).'
            : /too-many-requests/.test(c)
            ? 'محاولات كثيرة، انتظري قليلًا أو ادخلي بالوضع المحلي.'
            : 'تعذّر الاتصال بـ Firebase (' + c + '). يمكنكِ الدخول بالوضع المحلي أدناه.';
          return;
        }
      }

      if (!crypto.subtle) {
        err.textContent = 'يتطلب الدخول اتصالًا آمنًا (HTTPS أو localhost).';
        return;
      }
      if ((await sha256($('pw').value)) === PW_HASH) {
        dlg.close();
        sessionStorage.setItem(SESSION, '1');
        openAdmin();
        toast('مرحبًا بكِ أمال 🌸');
      } else {
        err.textContent = 'كلمة المرور غير صحيحة.';
      }
    } catch (ex) {
      err.textContent = 'حدث خطأ: ' + (ex.message || ex);
    } finally {
      go.disabled = false;
    }
  };

  if ($('tabBtnProducts') && $('tabBtnHero')) {
    $('tabBtnProducts').onclick = () => {
      $('tabBtnProducts').classList.add('active');
      $('tabBtnHero').classList.remove('active');
      $('panelProducts').hidden = false;
      $('panelHero').hidden = true;
    };
    $('tabBtnHero').onclick = () => {
      $('tabBtnHero').classList.add('active');
      $('tabBtnProducts').classList.remove('active');
      $('panelHero').hidden = false;
      $('panelProducts').hidden = true;
      populateHeroForm();
    };
  }

  // Accept all picked files (even when Android/iOS sets file.type === "") and decode directly
  const handleProductFiles = async (fileList) => {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return;
    $('upStatusTitle').textContent = '⏳ جارٍ معالجة وتجهيز الصور…';
    let added = 0;
    for (const f of files) {
      try {
        const dataUrl = await processImageFile(f, 880, 155000);
        state.formImages.push(dataUrl);
        added++;
      } catch (err) {
        console.warn('Image process error:', err);
      }
    }
    renderFormGallery();
    if (added) {
      state.adminDirty = true;
      $('fErr').textContent = '';
      toast(`تم تجهيز ${added} صورة بوضوح عالٍ ✓ اضغطي «حفظ ونشر المنتج»`);
    } else {
      toast('تعذّر قراءة الصورة. جرّبي صورة بصيغة JPG أو PNG.', true);
    }
  };

  if ($('dropZone')) {
    $('dropZone').onclick = () => $('fFile').click();
    $('dropZone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fFile').click(); } };
    $('dropZone').ondragover = (e) => { e.preventDefault(); $('dropZone').classList.add('dragover'); };
    $('dropZone').ondragleave = () => $('dropZone').classList.remove('dragover');
    $('dropZone').ondrop = (e) => {
      e.preventDefault();
      $('dropZone').classList.remove('dragover');
      handleProductFiles(e.dataTransfer.files);
    };
  }

  $('fFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await handleProductFiles(files);
  };

  if ($('fUrlAddBtn')) {
    $('fUrlAddBtn').onclick = () => {
      const u = normalizeImgUrl($('fUrlInput').value);
      if (!validImgUrl(u)) {
        toast('الرابط غير صالح. ضعي رابط صورة مباشر أو مسارًا مثل assets/images/tote-bag.jpg', true);
        return;
      }
      state.adminDirty = true;
      state.formImages.push(u);
      $('fUrlInput').value = '';
      renderFormGallery();
      toast('تمت إضافة رابط الصورة ✓');
    };
  }

  if ($('heroDropZone')) {
    $('heroDropZone').onclick = () => $('heroFile').click();
    $('heroFile').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      $('heroUpStatus').textContent = '⏳ جارٍ تجهيز صورة الواجهة…';
      try {
        const dataUrl = await processImageFile(f, 960, 185000);
        $('heroPrev').src = dataUrl;
        $('heroPrev').dataset.currentImg = dataUrl;
        $('heroUrlInput').value = '';
        $('heroUpStatus').textContent = '✓ تم تجهيز صورة الواجهة بنجاح';
        toast('تم تجهيز صورة الواجهة! اضغطي «حفظ وتحديث الواجهة»');
      } catch (_) {
        $('heroUpStatus').textContent = 'اضغطي لرفع صورة جديدة لواجهة الهبوط';
        toast('تعذّر قراءة الصورة.', true);
      }
    };
    $('heroUrlInput').oninput = () => {
      const u = normalizeImgUrl($('heroUrlInput').value);
      if (validImgUrl(u)) {
        $('heroPrev').src = u;
        $('heroPrev').dataset.currentImg = u;
      }
    };
    $('heroForm').onsubmit = async (e) => {
      e.preventDefault();
      const title = $('heroTitleInput').value.trim();
      const text = $('heroTextInput').value.trim();
      const typedUrl = normalizeImgUrl($('heroUrlInput').value);
      const imgVal = typedUrl || $('heroPrev').dataset.currentImg || state.site.hero.image;
      if (!title || !text) {
        toast('يرجى ملء العنوان والنص الترحيبي.', true);
        return;
      }
      state.adminDirty = true;
      state.heroOverride = { title, text, image: imgVal };
      await publish(true);
    };
    $('heroResetBtn').onclick = async () => {
      if (!confirm('استعادة صورة وعنوان الواجهة الافتراضية؟')) return;
      state.adminDirty = true;
      state.heroOverride = null;
      populateHeroForm();
      await publish(true);
    };
  }

  $('aAdd').onclick = () => editForm(null);
  $('fCancel').onclick = () => { state.editing = null; $('aForm').hidden = true; renderList(); };
  $('aForm').onsubmit = saveForm;

  $('aPrev').onclick = () => {
    const p = $('aPreview');
    p.hidden = !p.hidden;
    if (!p.hidden) {
      fill($('pGrid'), state.draft, true);
      p.scrollIntoView({ behavior: 'smooth' });
    }
  };

  $('aPub').onclick = () => publish(false);
  if ($('retryPubBtn')) $('retryPubBtn').onclick = () => publish(true);
  if ($('loadCloudBtn')) $('loadCloudBtn').onclick = adoptCloudVersion;
  $('aExp').onclick = exportJson;
  $('aImp').onchange = importJson;
  $('aReset').onclick = resetAll;
  $('aOut').onclick = () => {
    if (confirm('الخروج من لوحة التحكم؟')) closeAdmin();
  };

  if ($('goStoreBtn')) {
    $('goStoreBtn').onclick = async (e) => {
      if (syncBusy()) {
        e.preventDefault();
        toast('انتظري ثانية ريثما يكتمل النشر…');
        while (syncBusy()) {
          await new Promise((r) => setTimeout(r, 200));
        }
        location.href = './';
      }
    };
  }

  window.addEventListener('beforeunload', (e) => {
    if (syncBusy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ---------- Application Bootstrap ---------- */
async function init() {
  try {
    const [sRes, pRes] = await Promise.all([fetch('data/site.json'), fetch('data/products.json')]);
    if (!sRes.ok || !pRes.ok) throw new Error('fetch failed');
    state.site = await sRes.json();
    state.base = cleanProducts((await pRes.json()).products);
  } catch (e) {
    if ($('grid')) {
      $('grid').replaceChildren(el('p', { className: 'empty' }, [
        'تعذّر تحميل بيانات المتجر. افتحي الموقع عبر رابط الاستضافة (HTTPS أو خادم محلي).'
      ]));
    }
    return;
  }

  wireStorefrontUI();

  // 1. الحالة المحلية فورًا: للمشرفة = النسخة العاملة، وللزائر = آخر نسخة سحابية مؤكدة
  const local = await loadLocalState();
  const cloudOn = cloudConfigured();
  const useWorking = IS_ADMIN || !cloudOn;
  if (useWorking && local.products) {
    state.published = clone(local.products);
    state.heroOverride = local.hero || null;
  } else if (useWorking && local.snapshot) {
    state.published = clone(local.snapshot.products);
    state.heroOverride = local.snapshot.hero || null;
  } else if (local.snapshot) {
    state.published = clone(local.snapshot.products);
    state.heroOverride = local.snapshot.hero || null;
  } else if (local.products && local.syncedToCloud) {
    state.published = clone(local.products);      // نسخة قديمة كانت متزامنة
    state.heroOverride = local.hero || null;
  } else {
    state.published = clone(state.base);          // تعديلات غير منشورة لا تُعرض كأنها منشورة
    state.heroOverride = null;
  }
  state.localUpdatedAt = local.updatedAt;
  state.syncedToCloud = local.syncedToCloud;
  state.sync.localBaseRevision = local.baseRevision;
  state.sync.baseRevision = local.baseRevision === undefined ? null : local.baseRevision;

  const goHash = () => {
    if (location.hash) {
      const t = document.getElementById(location.hash.slice(1));
      if (t) t.scrollIntoView({ behavior: 'smooth' });
    }
  };

  if (!IS_ADMIN) {
    renderSite();
    renderStore();
    goHash();
  } else {
    wireAdmin();
    if (sessionStorage.getItem(SESSION) === '1') {
      openAdmin();
    } else {
      $('admBtn').click();
    }
  }

  // 2. الاتصال بـ Firebase في الخلفية ومطابقة النسخة السحابية
  FB_INIT_PROMISE = (async () => {
    try {
      await withTimeout(fbInit(), 12000);
    } catch (e) {
      FB.on = false;
      logSyncError('init', e);
    }
  })();

  READY = (async () => {
    await FB_INIT_PROMISE;
    if (!FB.on) {
      if (IS_ADMIN) refreshAdminConnectionNotice();
      return;
    }

    let remote;
    try {
      try {
        remote = await withTimeout(fbLoad(), 12000);
      } catch (_) {
        remote = await withTimeout(fbLoad(), 12000);
      }
    } catch (e) {
      // فشل القراءة: لا نغيّر شيئًا ولا نستبدل أي نسخة بأخرى
      logSyncError('load', e);
      if (IS_ADMIN) refreshAdminConnectionNotice();
      return;
    }

    if (remote.skipped && remote.skipped.length) {
      console.warn('[Crochet.Amal sync] مستندات غير صالحة تُركت دون تعديل:', remote.skipped.length);
    }
    const initialised = remote.hasMeta || remote.products.length > 0;
    if (initialised) await saveCloudSnapshot(remote);

    if (!IS_ADMIN) {
      applyRemoteBaseline(remote);
      if (initialised) {
        state.published = remote.products;
        state.heroOverride = remote.hero || null;     // قد تكون الإعدادات حُذفت عمدًا
        renderSite();
        renderStore();
        goHash();
      }
      return;
    }

    // لوحة الإدارة
    const unsynced = !state.syncedToCloud;
    if (!initialised) {
      applyRemoteBaseline(remote);                    // السحابة فارغة: أول نشر سيرفع الكتالوج
    } else if (!unsynced) {
      applyRemoteBaseline(remote);
      state.published = remote.products;
      state.heroOverride = remote.hero || null;
      await saveLocalState(state.published, state.heroOverride, true, { baseRevision: remote.revision });
      if (!$('admin').hidden && !state.adminDirty) {
        state.draft = clone(state.published);
        populateHeroForm();
        renderList();
      }
    } else {
      // تعديلات محلية غير منشورة: نحتفظ بها دائمًا، ونكشف التعارض بدل الكتابة فوق السحابة
      const lb = state.sync.localBaseRevision;
      const legacy = lb === undefined || lb === null;   // نسخة محلية قديمة بلا رقم نسخة
      const legacyAdopt = legacy && state.localUpdatedAt > remote.updatedAt;
      if (lb === remote.revision || legacyAdopt) {
        applyRemoteBaseline(remote);
      } else {
        applyRemoteBaseline(remote, true);
        if (legacy) state.sync.baseRevision = '__unknown__';
        state.sync.status = 'conflict';
        await showSyncProblem('conflict', describeSyncError({ code: 'conflict' }).text +
          ' اختاري: نشر نسختكِ (استبدال السحابة) أو تحميل النسخة السحابية.');
      }
    }

    if (!$('admin').hidden || (FB.auth && FB.auth.currentUser)) {
      if ($('admin').hidden && FB.auth && FB.auth.currentUser) openAdmin();
      else refreshAdminConnectionNotice();
    } else {
      refreshAdminConnectionNotice();
    }
  })();

  await READY;
}

init();

// ضبط قياس البانر الإعلاني 728×90 على الشاشات الصغيرة
function fitAd() {
  const box = $('adBox');
  const frame = $('adFrame');
  if (!box || !frame || !box.parentElement) return;
  const k = Math.min(1, box.parentElement.clientWidth / 728);
  frame.style.transform = 'scale(' + k + ')';
  box.style.height = Math.round(90 * k) + 'px';
}
addEventListener('resize', fitAd);
addEventListener('load', fitAd);
fitAd();
