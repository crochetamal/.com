const assert = require('node:assert/strict');
const test = require('node:test');
const S = require('../js/sync-core.js');
const { createFake, ADMIN } = require('./fake-firestore.js');

const clean = (list) => list.filter((p) => p && p.id !== '__site_meta__' && p.name && Number(p.price) > 0)
  .map((p) => ({ ...p, price: Number(p.price) }));
const prod = (id, extra = {}) => ({ id, name: 'منتج ' + id, description: 'وصف', price: 50, category: 'bags', image: 'data:image/webp;base64,AAAA', images: ['data:image/webp;base64,AAAA'], badge: '', visible: true, ...extra });
const mk = () => { const f = createFake(); f.signIn(ADMIN); return { f, deps: { fs: f.fs, db: f.db, cleanProducts: clean } }; };
const baseOf = (r) => ({ revision: r.revision, ids: r.ids, hashes: r.hashes });

test('3/5: إضافة منتجات ونشرها ثم قراءتها من "جلسة جديدة"', async () => {
  const { f, deps } = mk();
  let remote = await S.load(deps);
  assert.equal(remote.revision, 'none');
  const res = await S.publish(deps, [prod('a'), prod('b')], { title: 'T', text: 'x', image: 'i' }, baseOf(remote));
  assert.equal(res.written, 2);
  assert.ok(f.store.has('a') && f.store.has('b') && f.store.has('__site_meta__'));
  const fresh = await S.load(deps);
  assert.deepEqual(fresh.products.map((p) => p.id), ['a', 'b']);
  assert.equal(fresh.hero.title, 'T');
});

test('6/9: تعديل منتج وتعديل الواجهة يُحفظان في products/__site_meta__ ويكتبان المتغيّر فقط', async () => {
  const { f, deps } = mk();
  let r = await S.load(deps);
  const first = await S.publish(deps, [prod('a'), prod('b')], null, baseOf(r));
  f.db.writesSeen.length = 0;
  const res = await S.publish(deps, [prod('a', { price: 99 }), prod('b')], { title: 'جديد', text: 't', image: 'i' }, first);
  assert.equal(res.written, 1);               // المنتج a فقط (b لم يتغير)
  assert.deepEqual([...f.db.writesSeen].sort(), ['set:__site_meta__', 'set:a']);
  assert.equal(f.store.get('a').price, 99);
  assert.equal(f.store.get('__site_meta__').hero.title, 'جديد');
});

test('7: حذف منتج محدد لا يحذف غيره ولا مستند الإعدادات (حتى عند hero=null)', async () => {
  const { f, deps } = mk();
  let r = await S.load(deps);
  const first = await S.publish(deps, [prod('a'), prod('b'), prod('c')], { title: 'T', text: 'x', image: 'i' }, baseOf(r));
  const res = await S.publish(deps, [prod('a'), prod('c')], null, first);
  assert.equal(res.deleted, 1);
  assert.deepEqual([...f.store.keys()].sort(), ['__site_meta__', 'a', 'c']);
  assert.equal(f.store.get('__site_meta__').hero, null);
});

test('3: رفض الكتابة من مستخدم مسجّل غير مصرّح، وعدم تغيّر البيانات', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  f.signIn('other@example.com');
  await assert.rejects(S.publish(deps, [prod('a')], null, baseOf(r)), (e) => S.classifyError(e) === 'permission-denied');
  assert.equal(f.store.size, 0);
  f.signIn(null);
  await assert.rejects(S.publish(deps, [prod('a')], null, baseOf(r)), (e) => S.classifyError(e) === 'permission-denied');
});

test('10/11: فشل الشبكة في منتصف النشر ثم إعادة المحاولة دون تكرار ولا فقدان', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  const list = Array.from({ length: 250 }, (_, i) => prod('p' + i));   // عدة دفعات
  // نفشل عند ثاني commit (بعد نجاح الأول): يظهر كخطأ ولا نجاح
  let calls = 0;
  const realBatch = f.fs.writeBatch;
  f.fs.writeBatch = (d) => { const b = realBatch(d); const c = b.commit; b.commit = async () => { if (++calls === 2) throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); return c(); }; return b; };
  let failure;
  await assert.rejects(S.publish(deps, list, null, baseOf(r)), (e) => { failure = e; return S.classifyError(e) === 'network'; });
  assert.ok(!f.store.has('__site_meta__'), 'لا يُكتب مستند الإعدادات قبل اكتمال الدفعات');
  f.fs.writeBatch = realBatch;
  const res = await S.publish(deps, list, null, baseOf(r), { ownRevisions: [failure.attemptRevision] });
  assert.equal(f.store.size, 251);            // 250 منتج + الإعدادات، دون تكرار
  assert.equal(res.ids.length, 250);
});

test('11: انتهاء المهلة بعد نجاح الكتابة فعليًا لا يُعتبر تعارضًا عند إعادة المحاولة', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  const real = f.fs.writeBatch;
  f.fs.writeBatch = (d) => { const b = real(d); const c = b.commit; b.commit = async () => { await c(); await new Promise((x) => setTimeout(x, 200)); }; return b; };
  let failure;
  await assert.rejects(S.publish(deps, [prod('a')], null, baseOf(r), { batchTimeoutMs: 50 }), (e) => { failure = e; return S.classifyError(e) === 'timeout'; });
  f.fs.writeBatch = real;
  await new Promise((x) => setTimeout(x, 300));
  await S.publish(deps, [prod('a')], null, baseOf(r), { ownRevisions: [failure.attemptRevision] });
  assert.equal(f.store.size, 2);
});

test('كشف التعارض: نسخة سحابية أحدث من جهاز آخر لا تُكتب فوقها بصمت', async () => {
  const { f, deps } = mk();
  const r0 = await S.load(deps);
  const deviceA = await S.publish(deps, [prod('a')], null, baseOf(r0));
  const stale = baseOf(r0);                                   // جهاز B ما زال على النسخة القديمة
  await S.publish(deps, [prod('a'), prod('new-from-A')], null, deviceA);
  await assert.rejects(S.publish(deps, [prod('b')], null, stale), (e) => e.code === 'conflict');
  assert.ok(f.store.has('new-from-A'));
  const forced = await S.publish(deps, [prod('b')], null, stale, { force: true });
  assert.deepEqual([...f.store.keys()].sort(), ['__site_meta__', 'b']);   // الاستبدال الصريح فقط يحذف ما أضافه الجهاز الآخر
  assert.ok(forced.revision);
});

test('حماية: لا نشر بقائمة فارغة دون تأكيد، ولا حذف لمستندات لم نرها/غير صالحة', async () => {
  const { f, deps } = mk();
  f.store.set('legacy-bad', { name: 'بلا سعر', price: 0 });
  f.store.set('a', { ...prod('a'), order: 0 });
  const r = await S.load(deps);
  assert.deepEqual(r.skipped, ['legacy-bad']);
  await assert.rejects(S.publish(deps, [], null, baseOf(r)), (e) => e.code === 'empty-list');
  await S.publish(deps, [], null, baseOf(r), { allowEmpty: true });
  assert.ok(f.store.has('legacy-bad'), 'مستند غير صالح لم يُحذف');
  assert.ok(f.store.has('__site_meta__'));
  assert.ok(!f.store.has('a'));
});

test('5: صورة/مستند يتجاوز الحد يرفع خطأ واضحًا ولا يسقط الصور بصمت ولا يكتب شيئًا', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(1100000);
  await assert.rejects(S.publish(deps, [prod('ok'), prod('big', { images: [huge], image: huge })], null, baseOf(r)),
    (e) => e.code === 'doc-too-large' && e.detail.id === 'big');
  assert.equal(f.store.size, 0);
});

test('5: منتج بعدة صور مقبولة الحجم يصل كاملًا', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  const img = (n) => 'data:image/webp;base64,' + String(n).repeat(150000);
  const p = prod('multi', { images: [img(1), img(2), img(3), img(4)], image: img(1) });
  await S.publish(deps, [p], null, baseOf(r));
  const back = await S.load(deps);
  assert.equal(back.products[0].images.length, 4);
});

test('12: لا نجاح كاذب — أي فشل commit يرمي خطأ ولا يُرجع نتيجة', async () => {
  const { f, deps } = mk();
  const r = await S.load(deps);
  f.db.failNext = { code: 'permission-denied', message: 'x', times: 1 };
  // أول استدعاء لـ getDocFromServer يستهلك الفشل المحقون
  await assert.rejects(S.publish(deps, [prod('a')], null, baseOf(r)));
  assert.equal(f.store.size, 0);
});

test('بلا خط أساس (لم تُقرأ السحابة) لا نشر', async () => {
  const { deps } = mk();
  await assert.rejects(S.publish(deps, [prod('a')], null, null), (e) => e.code === 'no-baseline');
});

test('الهاش مستقر مهما كان ترتيب الحقول (Firestore يُرجعها مرتبة)', () => {
  assert.equal(S.docHash({ b: 1, a: [2, { y: 1, x: 2 }], updatedAt: 5 }), S.docHash({ a: [2, { x: 2, y: 1 }], b: 1, updatedAt: 9 }));
});
