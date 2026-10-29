// فحص ساكن لملف القواعد (لا يغني عن اختبار Emulator أدناه).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const rules = fs.readFileSync(__dirname + '/../firestore.rules', 'utf8').replace(/\/\/.*$/gm, '');

test('لا شرط uid != null ولا allow write: if true', () => {
  assert.ok(!/uid\s*!=\s*null/.test(rules));
  assert.ok(!/allow[^;]*:\s*if\s+true/.test(rules.replace(/allow read: if true;/g, '')));
});
test('الكتابة عبر isAdmin() فقط، والبريد المعتمد مذكور مرة واحدة', () => {
  assert.equal((rules.match(/crochetamal64@gmail\.com/g) || []).length, 1);
  const writes = rules.match(/allow\s+(create|update|delete|write)[^;]*;/g) || [];
  assert.ok(writes.length >= 2);
  writes.forEach((w) => { if (!/if false/.test(w)) assert.match(w, /isAdmin\(\)/); });
});
test('القراءة العامة لـ products، وحظر ما سواه', () => {
  assert.match(rules, /match \/products\/\{id\}\s*\{\s*allow read: if true;/);
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
});
test('النسخ المكررة من القواعد متطابقة', () => {
  const dup = __dirname + '/../crochet-amal/firestore.rules';
  if (fs.existsSync(dup)) assert.equal(fs.readFileSync(dup, 'utf8'), fs.readFileSync(__dirname + '/../firestore.rules', 'utf8'));
});
