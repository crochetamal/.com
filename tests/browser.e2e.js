// اختبار متصفح حقيقي (Chromium) للوحة الإدارة والصفحة الرئيسية، مع Firebase SDK مُستبدل بمحاكٍ
// يمرّ عبر خادم Node يفرض صلاحيات الكتابة وحد حجم المستند. ليس بديلًا عن اختبار Firebase الحقيقي.
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const ADMIN = 'crochetamal64@gmail.com';
const BASE = process.env.BASE || 'http://localhost:8765';

const store = new Map();
const mode = { failCommit: null };
const errJson = (code, message) => ({ error: { code, message } });

const STUB_APP = `export const getApps=()=>[]; export const initializeApp=()=>({});`;
const STUB_AUTH = `
let user=null;
export const getAuth=()=>({ get currentUser(){return user;} });
export const onAuthStateChanged=(a,cb)=>{ setTimeout(()=>cb(user),0); return ()=>{}; };
export const signInWithEmailAndPassword=async(a,e,p)=>{ if(p!=='pw') throw Object.assign(new Error('bad'),{code:'auth/invalid-credential'}); user={email:e}; window.__fbUser=user; return {user}; };
export const signOut=async()=>{ user=null; window.__fbUser=null; };`;
const STUB_FS = `
const call=async(op,body)=>{ const r=await fetch('/__fs/'+op,{method:'POST',headers:{'x-user':(window.__fbUser&&window.__fbUser.email)||''},body:JSON.stringify(body)}); const j=await r.json(); if(j.error) throw Object.assign(new Error(j.error.message),{code:j.error.code}); return j; };
export const initializeFirestore=()=>({});
export const collection=(db,name)=>({name});
export const doc=(col,id)=>({id});
export const getDocs=async()=>{ const j=await call('getDocs',{}); return {docs:j.docs.map(d=>({id:d.id,data:()=>d.data,ref:{id:d.id}}))}; };
export const getDocFromServer=async(ref)=>{ const j=await call('getDoc',{id:ref.id}); return {exists:()=>j.exists,data:()=>j.data}; };
export const writeBatch=()=>{ const ops=[]; return { set:(r,d)=>ops.push({t:'set',id:r.id,data:d}), delete:(r)=>ops.push({t:'del',id:r.id}), commit:()=>call('commit',{ops}) }; };`;

async function newPage(browser, errors) {
  const ctx = await browser.newContext();
  await ctx.route('**/fonts.g*/**', (r) => r.abort());
  await ctx.route('https://www.gstatic.com/firebasejs/**', (r) => {
    const u = r.request().url();
    const body = u.includes('app') ? STUB_APP : u.includes('auth') ? STUB_AUTH : STUB_FS;
    r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body });
  });
  await ctx.route('**/__fs/**', async (route) => {
    const op = route.request().url().split('/__fs/')[1];
    const body = JSON.parse(route.request().postData() || '{}');
    const user = route.request().headers()['x-user'];
    const out = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (op === 'getDocs') return out({ docs: [...store].map(([id, data]) => ({ id, data })) });
    if (op === 'getDoc') return out({ exists: store.has(body.id), data: store.get(body.id) });
    if (op === 'commit') {
      if (mode.failCommit) return out(errJson(mode.failCommit, 'injected'));
      if (user !== ADMIN) return out(errJson('permission-denied', 'Missing or insufficient permissions.'));
      for (const o of body.ops) if (o.data && Buffer.byteLength(JSON.stringify(o.data)) > 1048576) return out(errJson('invalid-argument', 'document exceeds the maximum allowed size'));
      body.ops.forEach((o) => (o.t === 'set' ? store.set(o.id, o.data) : store.delete(o.id)));
      return out({ ok: true });
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  return { ctx, page };
}

async function login(page, email) {
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('#loginDlg[open] #em');
  await page.fill('#em', email);
  await page.fill('#pw', 'pw');
  await page.click('#loginGo');
  await page.waitForSelector('#admin:not([hidden])');
}
const pill = (page) => page.locator('#syncPill').innerText();
const waitPill = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('syncPill').textContent), re.source, { timeout: 15000 });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const results = [];
  const ok = (name) => { results.push(name); console.log('✔', name); };

  const A = await newPage(browser, errors);
  await login(A.page, ADMIN);
  await waitPill(A.page, /منشور سحابيًا|غير منشورة/);
  ok('1) تسجيل الدخول بالحساب الإداري');

  // أول نشر: يرفع الكتالوج الأصلي (README الخطوة 8)
  await A.page.click('#aPub');
  await waitPill(A.page, /منشور سحابيًا/);
  const baseCount = [...store.keys()].filter((k) => k !== '__site_meta__').length;
  assert.ok(baseCount >= 4 && store.has('__site_meta__'));
  ok('2) نشر الكتالوج الحالي بنجاح (' + baseCount + ' منتج + __site_meta__)');

  // إضافة منتج جديد برابط صورة محلي
  await A.page.click('#aAdd');
  await A.page.click('#aForm summary');
  await A.page.fill('#fUrlInput', 'assets/images/tote-bag.jpg');
  await A.page.click('#fUrlAddBtn');
  await A.page.fill('#fName', 'منتج اختبار');
  await A.page.fill('#fDesc', 'وصف اختبار');
  await A.page.fill('#fPrice', '123');
  await A.page.click('#fSave');
  await waitPill(A.page, /منشور سحابيًا/);
  const added = [...store.values()].find((d) => d.name === 'منتج اختبار');
  assert.ok(added && added.price === 123);
  ok('5) إضافة منتج جديد والتأكد من وجوده في Firestore');

  // رفع صورة حقيقية (تُضغط وتُحفظ داخل المستند)
  await A.page.click('#aAdd');
  await A.page.setInputFiles('#fFile', '/home/claude/work/.com-main/assets/images/headscarf.jpg');
  await A.page.waitForFunction(() => document.querySelectorAll('#upGallery .up-item').length === 1, null, { timeout: 15000 });
  await A.page.fill('#fName', 'منتج بصورة مرفوعة');
  await A.page.fill('#fDesc', 'وصف');
  await A.page.fill('#fPrice', '77');
  await A.page.click('#fSave');
  await waitPill(A.page, /منشور سحابيًا/);
  const withImg = [...store.values()].find((d) => d.name === 'منتج بصورة مرفوعة');
  assert.match(withImg.image, /^data:image\/(webp|jpeg)/);
  console.log('   حجم مستند الصورة:', Buffer.byteLength(JSON.stringify(withImg)), 'بايت');
  ok('8a) رفع صورة وحفظها داخل Firestore');

  // الزائر من "جهاز آخر" (سياق جديد، لا IndexedDB مشتركة)
  const V = await newPage(browser, errors);
  await V.page.goto(BASE + '/index.html');
  await V.page.waitForFunction(() => document.body.innerText.includes('منتج بصورة مرفوعة'), null, { timeout: 15000 });
  const src = await V.page.locator('#grid img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  assert.ok(src.some((s) => /^data:image\/(webp|jpeg)/.test(s)));
  ok('4/8b) الزائر الجديد يقرأ المنتجات والصورة دون تسجيل دخول');

  // الواجهة الرئيسية
  await A.page.click('#tabBtnHero');
  await A.page.fill('#heroTitleInput', 'عنوان واجهة جديد');
  await A.page.fill('#heroTextInput', 'نص جديد');
  await A.page.click('#heroSaveBtn');
  await waitPill(A.page, /منشور سحابيًا/);
  assert.equal(store.get('__site_meta__').hero.title, 'عنوان واجهة جديد');
  const V2 = await newPage(browser, errors);
  await V2.page.goto(BASE + '/index.html');
  await V2.page.waitForFunction(() => document.getElementById('hTitle').textContent === 'عنوان واجهة جديد', null, { timeout: 15000 });
  ok('9) إعدادات الواجهة في products/__site_meta__ وتظهر للزائر');

  // فشل الصلاحيات: لا نجاح كاذب، التعديل يبقى محليًا
  await A.page.click('#tabBtnProducts');
  mode.failCommit = 'permission-denied';
  const before = JSON.stringify([...store]);
  await A.page.locator('#aList li', { hasText: 'منتج اختبار' }).getByText('تعديل').click();
  await A.page.fill('#fPrice', '999');
  await A.page.click('#fSave');
  await waitPill(A.page, /فشل النشر/);
  assert.equal(JSON.stringify([...store]), before);
  assert.ok(await A.page.locator('#rulesAlert').isVisible());
  const toastTxt = await A.page.locator('#toast').innerText();
  assert.ok(!/تم النشر سحابيًا/.test(toastTxt), 'لا رسالة نجاح كاذبة: ' + toastTxt);
  ok('10/12) فشل الكتابة يُظهر "فشل النشر" ولا رسالة نجاح، وFirestore لم يتغيّر');

  // إعادة تحميل: التعديل غير المنشور يبقى ولا تكتب السحابة فوقه
  await A.page.close();
  const A2 = await newPage(browser, errors);
  mode.failCommit = null;
  // نعيد استعمال نفس سياق التخزين عبر فتح صفحة ثانية في السياق نفسه
  await A2.ctx.close();
  const p2 = await A.ctx.newPage();
  p2.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p2.on('dialog', (d) => d.accept());
  await p2.goto(BASE + '/admin.html');
  await p2.waitForSelector('#loginDlg[open] #em');
  await p2.fill('#em', ADMIN); await p2.fill('#pw', 'pw'); await p2.click('#loginGo');
  await p2.waitForSelector('#admin:not([hidden])');
  await waitPill(p2, /غير منشورة|تعارض/);
  assert.match(await p2.locator('#aList').innerText(), /999 درهم/);
  ok('6) التعديلات غير المنشورة تبقى بعد إعادة تحميل الصفحة ولا تُستبدل بالسحابة');

  // إعادة المحاولة بعد زوال السبب: لا تكرار
  const countBefore = store.size;
  await p2.click('#aPub');
  await waitPill(p2, /منشور سحابيًا/);
  assert.equal(store.size, countBefore);
  assert.equal([...store.values()].find((d) => d.name === 'منتج اختبار').price, 999);
  ok('11) إعادة المحاولة تنشر التعديل دون تكرار المنتجات');

  // حذف منتج واحد
  await p2.locator('#aList li', { hasText: 'منتج اختبار' }).getByText('حذف').click();
  await waitPill(p2, /منشور سحابيًا/);
  assert.ok(![...store.values()].some((d) => d.name === 'منتج اختبار'));
  assert.ok(store.has('__site_meta__') && [...store.values()].some((d) => d.name === 'منتج بصورة مرفوعة'));
  ok('7) حذف منتج محدد دون المساس بالبقية ولا بمستند الإعدادات');

  // حساب غير مصرّح
  const B = await newPage(browser, errors);
  await login(B.page, 'other@example.com');
  await B.page.click('#aPub');
  await waitPill(B.page, /فشل النشر/);
  assert.match(await B.page.locator('#syncErrMsg').innerText(), /other@example\.com/);
  ok('3) حساب مسجّل غير مصرّح يُرفض ويظهر سبب واضح');

  assert.deepEqual(errors, [], 'أخطاء JS غير معالجة: ' + errors.join(' | '));
  ok('13) لا أخطاء JavaScript غير معالجة');
  await browser.close();
  console.log('\nكل السيناريوهات نجحت:', results.length);
})().catch((e) => { console.error('فشل الاختبار:', e); process.exit(1); });
