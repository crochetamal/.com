'use strict';
const KEY = 'crochetAmal.products.v1';
const SESSION = 'crochetAmal.admin';
// Convenience lock only: the hash is visible to anyone who inspects the code.
const PW_HASH = 'bb1b5ca296dc3ffab66629a6bb46eb7a44cab90dd8b18897244418a7ead55e07';
const FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#efdfc8"/><text x="100" y="108" font-size="16" text-anchor="middle" fill="#5b2f1f" font-family="sans-serif">Crochet.Amal</text></svg>');
const $ = (id) => document.getElementById(id);
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
  $('yr').textContent = new Date().getFullYear();
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
  const sel = $('fCat'); sel.replaceChildren(...Object.entries(state.site.categories).map(([k, v]) => el('option', { value: k }, [v])));
}
function closeAdmin() {
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
      btn(p.visible ? 'إخفاء' : 'إظهار', () => { p.visible = !p.visible; renderList(); }),
      btn('تعديل', () => editForm(p)),
      btn('حذف', () => { if (confirm('حذف المنتج «' + p.name + '»؟')) { state.draft.splice(i, 1); renderList(); $('aForm').hidden = true; toast('تم حذف المنتج (انشري التغييرات لحفظها)'); } }, 'del')
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
function validImgUrl(u) { return /^(https?:\/\/\S+|(\.\/)?[\w\-./%]+\.(jpe?g|png|webp|gif|svg|avif))$/i.test(u); }
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
  $('aForm').hidden = true; renderList(); toast('تم حفظ المنتج في المسودة. اضغطي «نشر التغييرات».');
}
function publish() {
  if (!confirm('نشر التغييرات في هذا المتصفح؟')) return;
  try { localStorage.setItem(KEY, JSON.stringify(state.draft)); } catch (e) { toast('تعذّر الحفظ: التخزين ممتلئ أو مُعطّل.', true); return; }
  state.published = clone(state.draft); renderStore(); toast('تم النشر في هذا المتصفح. صدّري JSON لنشرها للجميع.');
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
  if (!confirm('حذف التعديلات المحفوظة والرجوع إلى المنتجات الأصلية؟')) return;
  localStorage.removeItem(KEY); state.published = clone(state.base); state.draft = clone(state.base);
  $('aForm').hidden = true; renderList(); renderStore(); toast('تم الرجوع إلى الكتالوج الأصلي.');
}
function wireAdmin() {
  const dlg = $('loginDlg');
  $('admBtn').onclick = () => { $('pw').value = ''; $('loginErr').textContent = ''; dlg.showModal(); $('pw').focus(); };
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!crypto.subtle) { $('loginErr').textContent = 'يتطلب الدخول اتصالًا آمنًا (https).'; return; }
    if ((await sha256($('pw').value)) === PW_HASH) { dlg.close(); sessionStorage.setItem(SESSION, '1'); openAdmin(); toast('مرحبًا أمال'); }
    else $('loginErr').textContent = 'كلمة المرور غير صحيحة.';
  };
  $('aAdd').onclick = () => editForm(null);
  $('fCancel').onclick = () => ($('aForm').hidden = true);
  $('aForm').onsubmit = saveForm; $('fImg').oninput = showPrev;
  $('fPrev').onerror = () => { if ($('fPrev').src !== FALLBACK) $('fPrev').src = FALLBACK; };
  $('aPrev').onclick = () => { const p = $('aPreview'); p.hidden = !p.hidden; if (!p.hidden) { fill($('pGrid'), state.draft, 'all'); p.scrollIntoView(); } };
  $('aPub').onclick = publish; $('aExp').onclick = exportJson; $('aImp').onchange = importJson;
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
    $('grid').replaceChildren(el('p', { className: 'empty' }, ['تعذّر تحميل البيانات. افتحي الموقع عبر رابط الاستضافة وليس كملف مباشر.']));
    return;
  }
  state.published = load(); renderSite(); renderStore(); wireAdmin();
  if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
}
init();
