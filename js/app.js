'use strict';
const KEY = 'crochetAmal.products.v1';
const CACHE = 'crochetAmal.cache.v1';
const SESSION = 'crochetAmal.admin';
// Convenience lock only: the hash is visible to anyone who inspects the code.
const PW_HASH = 'bb1b5ca296dc3ffab66629a6bb46eb7a44cab90dd8b18897244418a7ead55e07';
const FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#efdfc8"/><text x="100" y="108" font-size="16" text-anchor="middle" fill="#5b2f1f" font-family="sans-serif">Crochet.Amal</text></svg>');
const $ = (id) => document.getElementById(id);
const FB = { on: false };
async function fbInit() {
  const cfg = window.FIREBASE_CONFIG; if (!cfg || !cfg.projectId) return;
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [app, fs, au] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-firestore.js'), import(base + 'firebase-auth.js')]);
  const a = app.initializeApp(cfg);
  Object.assign(FB, { db: fs.initializeFirestore(a, { experimentalAutoDetectLongPolling: true }), auth: au.getAuth(a), fs, au, on: true });
}
async function fbLoad() {
  const { collection, getDocs, query, orderBy } = FB.fs;
  const snap = await getDocs(query(collection(FB.db, 'products'), orderBy('order')));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}
async function fbSave(list) {
  const { collection, getDocs, writeBatch, doc } = FB.fs;
  const col = collection(FB.db, 'products'), old = await getDocs(col), b = writeBatch(FB.db), keep = new Set(list.map((p) => p.id));
  old.docs.forEach((d) => { if (!keep.has(d.id)) b.delete(d.ref); });
  list.forEach((p, i) => b.set(doc(col, p.id), { ...p, order: i }));
  await b.commit();
}
async function shrink(file) {
  const bmp = await createImageBitmap(file), s = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.82, u = c.toDataURL('image/jpeg', q);
  while (u.length > 90000 && q > 0.35) { q -= 0.1; u = c.toDataURL('image/jpeg', q); }
  return u;
}
const IS_ADMIN = document.body.dataset.page === 'admin';
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
let READY = Promise.resolve();
const state = { site: null, base: [], published: [], draft: [], filter: 'all', editing: null };

const clone = (o) => JSON.parse(JSON.stringify(o));
const waBase = () => 'https://wa.me/' + state.site.whatsapp;
const waLink = (text) => waBase() + (text ? '?text=' + encodeURIComponent(text) : '');
function waMessage(p) {
  const link = new URL('#' + p.id, location.href.split('#')[0]).href;
  return `السلام عليكم أمال، أريد طلب المنتج: ${p.name}، الثمن: ${p.price} درهم.\nرابط المنتج: ${link}`;
}
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3200);
}
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k in e ? (e[k] = v) : e.setAttribute(k, v);
  kids.forEach((c) => e.append(c));
  return e;
}
function img(src, alt, extra = {}) {
  const i = el('img', { src, alt, loading: 'lazy', ...extra });
  i.addEventListener('error', () => { if (i.src !== FALLBACK) i.src = FALLBACK; });
  return i;
}
function cleanProducts(list) {
  if (!Array.isArray(list)) throw new Error('الملف لا يحتوي على قائمة منتجات');
  return list.map((p, n) => {
    const price = Number(p.price);
    if (!p || !String(p.name || '').trim() || !(price > 0)) throw new Error('منتج غير صالح رقم ' + (n + 1));
    return { id: String(p.id || 'p-' + Date.now() + n), name: String(p.name).trim(), description: String(p.description || '').trim(),
      price, category: String(p.category || 'gifts'), image: String(p.image || ''), visible: p.visible !== false };
  });
}
function load() {
  try { const s = localStorage.getItem(KEY); if (s) return cleanProducts(JSON.parse(s)); } catch (e) { /* ignore broken storage */ }
  return clone(state.base);
}

/* ---------- storefront ---------- */
function card(p) {
  const a = el('a', { className: 'btn wa', target: '_blank', rel: 'noopener', href: waLink(waMessage(p)) }, ['اطلبي عبر واتساب']);
  a.setAttribute('aria-label', 'اطلبي ' + p.name + ' عبر واتساب');
  return el('article', { className: 'card', id: p.id }, [
    img(p.image, p.name, { width: 400, height: 400 }),
    el('div', { className: 'b' }, [el('h3', {}, [p.name]), el('p', {}, [p.description]), el('span', { className: 'price' }, [p.price + ' درهم']), a])
  ]);
}
function fill(grid, list, filter) {
  grid.replaceChildren();
  const shown = list.filter((p) => p.visible && (filter === 'all' || p.category === filter));
  if (!shown.length) grid.append(el('p', { className: 'empty' }, ['لا توجد منتجات في هذا القسم حاليًا.']));
  shown.forEach((p) => grid.append(card(p)));
}
function renderStore() {
  if (!$('grid')) return;
  fill($('grid'), state.published, state.filter);
  const cats = state.site.categories, box = $('chips');
  box.replaceChildren();
  [['all', 'الكل'], ...Object.entries(cats)].forEach(([k, label]) => {
    const n = state.published.filter((p) => p.visible && (k === 'all' || p.category === k)).length;
    const b = el('button', { className: 'chip', type: 'button' }, [`${label} (${n})`]);
    b.setAttribute('aria-pressed', String(state.filter === k));
    b.onclick = () => { state.filter = k; renderStore(); if (k !== 'all') $('products').scrollIntoView(); };
    box.append(b);
  });
}
function renderSite() {
  const s = state.site, w = waLink('السلام عليكم أمال، أريد الاستفسار عن منتجاتكم.');
  $('hTitle').textContent = s.hero.title; $('hText').textContent = s.hero.text;
  $('hCta').textContent = s.hero.cta; $('hCta').href = w; $('cCta').href = w;
  const hi = $('hImg'); hi.onerror = () => { hi.onerror = null; hi.src = FALLBACK; }; hi.src = s.hero.image;
  $('cText').textContent = s.contact.text; $('cPhone').textContent = s.contact.phoneDisplay;
  $('why').replaceChildren(...s.why.map((x) => el('div', {}, [el('h3', {}, [x.title]), el('p', {}, [x.text])])));
  $('reviews').replaceChildren(...s.testimonials.map((t) => el('blockquote', {}, [el('p', {}, [t.text]), el('footer', {}, [`${t.name}، ${t.city}`])])));
  const names = { instagram: 'إنستغرام', facebook: 'فيسبوك', tiktok: 'تيك توك' };
  $('social').replaceChildren(...Object.entries(s.social).map(([k, u]) => el('a', { href: u, target: '_blank', rel: 'noopener' }, [names[k] || k])));
}

/* ---------- admin ---------- */
async function sha256(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function openAdmin() {
  state.draft = clone(state.published); state.editing = null;
  $('admin').hidden = false; document.body.style.overflow = 'hidden';
  $('aForm').hidden = true; $('aPreview').hidden = true; renderList();
  if (FB.on) $('notice').textContent = 'متصل بـ Firebase: عند الضغط على «نشر التغييرات» تظهر التعديلات والصور لكل الزوار فورًا.';
  const sel = $('fCat'); sel.replaceChildren(...Object.entries(state.site.categories).map(([k, v]) => el('option', { value: k }, [v])));
}
function closeAdmin() {
  if (FB.on) FB.au.signOut(FB.auth);
  sessionStorage.removeItem(SESSION); $('admin').hidden = true; document.body.style.overflow = '';
}
function renderList() {
  const ul = $('aList'); ul.replaceChildren();
  state.draft.forEach((p, i) => {
    const btn = (txt, fn, cls = '', label) => { const b = el('button', { type: 'button', className: cls }, [txt]); b.setAttribute('aria-label', label || txt); b.onclick = fn; return b; };
    ul.append(el('li', {}, [
      img(p.image, '', { width: 54, height: 54 }),
      el('span', { className: 'nm' + (p.visible ? '' : ' off') }, [p.name + (p.visible ? '' : ' (مخفي)') + ' · ' + p.price + ' د']),
      btn('▲', () => move(i, -1), '', 'تحريك للأعلى'), btn('▼', () => move(i, 1), '', 'تحريك للأسفل'),
      btn(p.visible ? 'إخفاء' : 'إظهار', () => { p.visible = !p.visible; renderList(); publish(true); }),
      btn('تعديل', () => editForm(p)),
      btn('حذف', () => { if (confirm('حذف المنتج «' + p.name + '»؟')) { state.draft.splice(i, 1); renderList(); $('aForm').hidden = true; publish(true); } }, 'del')
    ]));
  });
  if (!state.draft.length) ul.append(el('li', {}, ['لا توجد منتجات. أضيفي أول منتج.']));
}
function move(i, d) {
  const j = i + d; if (j < 0 || j >= state.draft.length) return;
  [state.draft[i], state.draft[j]] = [state.draft[j], state.draft[i]]; renderList();
}
function editForm(p) {
  state.editing = p; const f = $('aForm'); f.hidden = false; $('fErr').textContent = '';
  $('fTitle').textContent = p ? 'تعديل المنتج' : 'منتج جديد';
  $('fName').value = p ? p.name : ''; $('fDesc').value = p ? p.description : '';
  $('fPrice').value = p ? p.price : ''; $('fCat').value = p ? p.category : Object.keys(state.site.categories)[0];
  $('fImg').value = p ? p.image : ''; $('fVis').checked = p ? p.visible : true; showPrev();
  $('fName').focus();
}
function validImgUrl(u) { return /^(https?:\/\/\S+|data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+|(\.\/)?[\w\-./%]+\.(jpe?g|png|webp|gif|svg|avif))$/i.test(u); }
function showPrev() {
  const u = $('fImg').value.trim(), i = $('fPrev');
  i.src = validImgUrl(u) ? u : FALLBACK;
}
function saveForm(e) {
  e.preventDefault();
  const name = $('fName').value.trim(), desc = $('fDesc').value.trim(), price = Number($('fPrice').value), image = $('fImg').value.trim();
  const err = !name ? 'اكتبي اسم المنتج.' : !desc ? 'اكتبي وصفًا قصيرًا.' : !(price > 0) ? 'الثمن يجب أن يكون رقمًا أكبر من 0.' : !validImgUrl(image) ? 'رابط الصورة غير صالح. استعملي رابطًا يبدأ بـ https:// أو مسارًا مثل assets/images/x.jpg' : '';
  if (err) { $('fErr').textContent = err; toast(err, true); return; }
  const data = { name, description: desc, price, category: $('fCat').value, image, visible: $('fVis').checked };
  if (state.editing) Object.assign(state.editing, data); else state.draft.push({ id: 'p-' + Date.now().toString(36), ...data });
  $('aForm').hidden = true; renderList(); publish(true);
}
async function publish(auto) {
  if (!auto && !confirm(FB.on ? 'نشر التغييرات لكل الزوار؟' : 'نشر التغييرات في هذا المتصفح؟')) return false;
  if (FB.on) {
    toast('جارٍ النشر…');
    try { await withTimeout(fbSave(state.draft), 20000); } catch (e) { toast('فشل النشر: تأكدي من الاتصال ومن قواعد Firestore (بريد المسؤولة).', true); return false; }
    state.published = clone(state.draft); renderStore(); toast('تم النشر لكل الزوار فورًا.'); return true;
  }
  try { localStorage.setItem(KEY, JSON.stringify(state.draft)); } catch (e) { toast('تعذّر الحفظ: التخزين ممتلئ أو مُعطّل.', true); return false; }
  state.published = clone(state.draft); renderStore(); toast('تم النشر في هذا المتصفح. صدّري JSON لنشرها للجميع.'); return true;
}
function exportJson() {
  const blob = new Blob([JSON.stringify({ version: 1, products: state.draft }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'products.json' }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('تم تصدير products.json');
}
async function importJson(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const list = cleanProducts(Array.isArray(j) ? j : j.products);
    if (!confirm('استيراد ' + list.length + ' منتج واستبدال المسودة الحالية؟')) return;
    state.draft = list; $('aForm').hidden = true; renderList(); toast('تم الاستيراد. اضغطي «نشر التغييرات» لتطبيقه.');
  } catch (err) { toast('ملف غير صالح: ' + err.message, true); }
}
function resetAll() {
  if (FB.on) {
    if (!confirm('تحميل الكتالوج الأصلي (من الملف) في المسودة؟ لن يُنشر قبل الضغط على «نشر التغييرات».')) return;
    state.draft = clone(state.base); $('aForm').hidden = true; renderList(); toast('تم تحميل الكتالوج الأصلي في المسودة.'); return;
  }
  if (!confirm('حذف التعديلات المحفوظة والرجوع إلى المنتجات الأصلية؟')) return;
  localStorage.removeItem(KEY); state.published = clone(state.base); state.draft = clone(state.base);
  $('aForm').hidden = true; renderList(); renderStore(); toast('تم الرجوع إلى الكتالوج الأصلي.');
}
function wireAdmin() {
  const dlg = $('loginDlg');
  $('admBtn').onclick = () => {
    if (FB.on && FB.auth.currentUser) { openAdmin(); return; }
    $('emW').hidden = !window.FIREBASE_CONFIG; $('pw').value = ''; $('loginErr').textContent = '';
    if (!dlg.open) dlg.showModal(); (window.FIREBASE_CONFIG ? $('em') : $('pw')).focus(); };
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const go = $('loginGo'), err = $('loginErr');
    go.disabled = true; err.textContent = 'جارٍ التحقق…';
    try {
      await READY; // انتظار تحميل Firebase والكتالوج قبل الدخول حتى لا يُستبدل الكتالوج بنسخة قديمة
      if (window.FIREBASE_CONFIG && !FB.on) { err.textContent = 'تعذّر الاتصال بـ Firebase. تحققي من الإنترنت وأعيدي تحميل الصفحة.'; return; }
      if (FB.on) {
        try { await withTimeout(FB.au.signInWithEmailAndPassword(FB.auth, $('em').value.trim(), $('pw').value), 15000); }
        catch (ex) {
          const c = ex && ex.code || ex.message;
          err.textContent = /invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/.test(c) ? 'البريد أو كلمة المرور غير صحيحة.'
            : /unauthorized-domain/.test(c) ? 'هذا النطاق غير مسموح في Firebase (Authentication > Settings > Authorized domains).'
            : /operation-not-allowed/.test(c) ? 'تسجيل الدخول بالبريد غير مفعّل في Firebase (Authentication > Sign-in method).'
            : /too-many-requests/.test(c) ? 'محاولات كثيرة. انتظري قليلًا ثم أعيدي المحاولة.'
            : /network|timeout/.test(c) ? 'مشكلة في الاتصال بالإنترنت. أعيدي المحاولة.' : 'تعذّر الدخول (' + c + ')';
          return;
        }
        dlg.close(); openAdmin(); toast('مرحبًا أمال'); return;
      }
      if (!crypto.subtle) { err.textContent = 'يتطلب الدخول اتصالًا آمنًا (https).'; return; }
      if ((await sha256($('pw').value)) === PW_HASH) { dlg.close(); sessionStorage.setItem(SESSION, '1'); openAdmin(); toast('مرحبًا أمال'); }
      else err.textContent = 'كلمة المرور غير صحيحة.';
    } catch (ex) { err.textContent = 'حدث خطأ: ' + (ex.message || ex); }
    finally { go.disabled = false; }
  };
  $('aAdd').onclick = () => editForm(null);
  $('fCancel').onclick = () => ($('aForm').hidden = true);
  $('fFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { $('fImg').value = await shrink(f); showPrev(); toast('تم تجهيز الصورة. اضغطي «حفظ المنتج» لنشرها مباشرة.'); }
    catch (err) { toast('تعذّر قراءة الصورة.', true); }
  };
  $('aForm').onsubmit = saveForm; $('fImg').oninput = showPrev;
  $('fPrev').onerror = () => { if ($('fPrev').src !== FALLBACK) $('fPrev').src = FALLBACK; };
  $('aPrev').onclick = () => { const p = $('aPreview'); p.hidden = !p.hidden; if (!p.hidden) { fill($('pGrid'), state.draft, 'all'); p.scrollIntoView(); } };
  $('aPub').onclick = () => publish(false); $('aExp').onclick = exportJson; $('aImp').onchange = importJson;
  $('aReset').onclick = resetAll;
  $('aOut').onclick = () => { if (confirm('الخروج من لوحة التحكم؟ المسودة غير المنشورة ستضيع.')) closeAdmin(); };
}

/* ---------- init ---------- */
async function init() {
  try {
    const [s, p] = await Promise.all([fetch('data/site.json'), fetch('data/products.json')]);
    if (!s.ok || !p.ok) throw new Error('fetch failed');
    state.site = await s.json(); state.base = cleanProducts((await p.json()).products);
  } catch (e) {
    if ($('grid')) $('grid').replaceChildren(el('p', { className: 'empty' }, ['تعذّر تحميل البيانات. افتحي الموقع عبر رابط الاستضافة وليس كملف مباشر.']));
    return;
  }
  // اعرض الكتالوج فورًا، ثم حدّثه من Firebase إن توفر
  state.published = window.FIREBASE_CONFIG ? clone(state.base) : load();
  if (window.FIREBASE_CONFIG && !IS_ADMIN) { try { const c = localStorage.getItem(CACHE); if (c) state.published = cleanProducts(JSON.parse(c)); } catch (e) { /* ignore */ } }
  const goHash = () => { if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); } };
  if (!IS_ADMIN) { renderSite(); renderStore(); goHash(); }
  // الأزرار تعمل فورًا؛ الدخول ينتظر READY (Firebase + الكتالوج)
  READY = (async () => {
    try { await withTimeout(fbInit(), 10000); } catch (e) { FB.on = false; console.warn('Firebase init:', e.message); }
    if (FB.on) {
      try {
        let l; try { l = await withTimeout(fbLoad(), 20000); } catch (e1) { l = await withTimeout(fbLoad(), 20000); }
        if (l.length) { state.published = cleanProducts(l); try { localStorage.setItem(CACHE, JSON.stringify(state.published)); } catch (e2) { /* ignore */ } if (!IS_ADMIN) { renderStore(); goHash(); } }
      } catch (e) { console.warn('Firestore:', e.message); }
    } else if (window.FIREBASE_CONFIG) { console.warn('Firebase غير متاح'); }
  })();
  if (IS_ADMIN) { wireAdmin(); $('admBtn').click(); }
  await READY;
}
init();

// تصغير البانر 728×90 على الشاشات الضيقة
function fitAd() {
  const box = $('adBox'); if (!box) return;
  const k = Math.min(1, box.parentElement.clientWidth / 728);
  $('adFrame').style.transform = 'scale(' + k + ')'; box.style.height = Math.round(90 * k) + 'px';
}
addEventListener('resize', fitAd); addEventListener('load', fitAd); fitAd();
