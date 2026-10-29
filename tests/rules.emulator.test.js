// يُشغَّل عندكِ فقط (يحتاج Java + Firebase Emulator + حزمة @firebase/rules-unit-testing):
//   npm i -D @firebase/rules-unit-testing firebase-tools
//   npx firebase emulators:exec --only firestore --project demo-crochet "node --test tests/rules.emulator.test.js"
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

let env;
test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-crochet', firestore: { rules: fs.readFileSync(__dirname + '/../firestore.rules', 'utf8') } });
});
test.after(async () => env && env.cleanup());

const admin = () => env.authenticatedContext('admin-uid', { email: 'crochetamal64@gmail.com' }).firestore();
const other = () => env.authenticatedContext('other-uid', { email: 'other@example.com' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('الزائر يقرأ المنتجات والإعدادات', async () => {
  await env.withSecurityRulesDisabled(async (c) => { await c.firestore().doc('products/a').set({ name: 'x' }); await c.firestore().doc('products/__site_meta__').set({ hero: null }); });
  await assertSucceeds(anon().doc('products/a').get());
  await assertSucceeds(anon().doc('products/__site_meta__').get());
});
test('حساب الإدارة يكتب ويعدّل ويحذف المنتجات والإعدادات', async () => {
  await assertSucceeds(admin().doc('products/n1').set({ name: 'n' }));
  await assertSucceeds(admin().doc('products/__site_meta__').set({ hero: { title: 't' } }));
  await assertSucceeds(admin().doc('products/n1').delete());
});
test('مستخدم مسجّل غير مصرّح لا يكتب ولا يعدّل ولا يحذف', async () => {
  await assertFails(other().doc('products/n2').set({ name: 'n' }));
  await assertFails(other().doc('products/a').update({ name: 'hack' }));
  await assertFails(other().doc('products/a').delete());
  await assertFails(other().doc('products/__site_meta__').set({ hero: null }));
});
test('الزائر غير المسجّل لا يكتب، والمسارات الأخرى مغلقة', async () => {
  await assertFails(anon().doc('products/n3').set({ name: 'n' }));
  await assertFails(anon().doc('other/x').get());
  await assertFails(admin().doc('other/x').set({ a: 1 }));
});
