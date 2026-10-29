const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/app.js', 'utf8');
const mock = { db: new Map(), currentUser: { email: 'crochetamal64@gmail.com', emailVerified: true }, fail: false };
const copy = x => JSON.parse(JSON.stringify(x));
const ctx = vm.createContext({ Blob, console, mock });
vm.runInContext(`
const META_DOC_ID = '__site_meta__';
const FB = {db: mock.db, auth: mock, fs: {
 collection: () => mock.db, doc: (_, id) => id,
 getDocsFromServer: async () => ({docs: Array.from(mock.db, ([id,data]) => ({id, data: () => data}))}),
 runTransaction: async (_, fn) => {
  if (mock.fail) throw Object.assign(new Error('denied'), {code:'permission-denied'});
  const changes = [];
  await fn({get: async id => ({exists: () => mock.db.has(id), data: () => mock.db.get(id)}),
   set: (id,data) => changes.push(() => mock.db.set(id,data)), delete: id => changes.push(() => mock.db.delete(id))});
  changes.forEach(f => f());
 }
}};
let cloudBase = [];
const clone = x => JSON.parse(JSON.stringify(x));
function normalizeImgUrl(x) {return x;}
${source.slice(source.indexOf('function cleanProducts('), source.indexOf('/* ---------- Local Persistence Helpers'))}
${source.slice(source.indexOf('function stableValue('), source.indexOf('/* ---------- WhatsApp'))}
globalThis.api = {fbSave, fbLoad, setBase: x => cloudBase = x};
`, ctx);
(async () => {
 const {fbSave, fbLoad, setBase} = ctx.api;
 const prod = {id:'one',name:'One',price:25, images:['data:image/jpeg;base64,abc'],image:'data:image/jpeg;base64,abc',visible:true};
 let base = await fbSave([prod], {title:'Hello', image:'hero'}); setBase(base);
 assert.equal(mock.db.get('one').images[0], prod.images[0]);
 assert.equal(mock.db.get('__site_meta__').hero.title, 'Hello');
 assert.equal((await fbLoad()).products.length, 1);
 base = await fbSave([{...prod,name:'Edited'}, {...prod,id:'two'}], null); setBase(base);
 assert.equal((await fbLoad()).products[0].name, 'Edited');
 base = await fbSave([{...prod,id:'two'}], null); setBase(base);
 assert(!mock.db.has('one')); assert(mock.db.has('two')); assert(mock.db.has('__site_meta__'));
 mock.db.set('unexpected', {notAProduct:true});
 await assert.rejects(fbSave([prod], null), e => e.code === 'conflict');
 mock.db.delete('unexpected');
 mock.fail = true; await assert.rejects(fbSave([prod], null), e => e.code === 'permission-denied');
 assert(mock.db.has('two')); mock.fail = false;
 base = await fbSave([prod], null); setBase(base); assert.equal(mock.db.size, 2);
 await assert.rejects(fbSave([{...prod,images:['x'.repeat(910000)]}], null), e => e.code === 'document-too-large');
 mock.currentUser.email = 'other@example.com'; await assert.rejects(fbSave([prod], null), e => e.code === 'auth-required');
 console.log('Mock Firestore sync tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
