const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const base = 'https://www.gstatic.com/firebasejs/13.1.0/';
const expectedConfig = {
  apiKey: 'AIzaSyDn3HXYY5wqyx_6D6Ahour2-l-i1yHaoR8',
  authDomain: 'amale-crochet.firebaseapp.com',
  databaseURL: 'https://amale-crochet-default-rtdb.firebaseio.com',
  projectId: 'amale-crochet',
  storageBucket: 'amale-crochet.firebasestorage.app',
  messagingSenderId: '1029434187104',
  appId: '1:1029434187104:web:6077fb2a47081df2e51205',
  measurementId: 'G-CXK9TCS9NH'
};

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Run the real scripts in a VM, replacing only import() with a mock module loader.
// A real browser exercises the network imports; these tests stay completely offline.
function mockImports(source) {
  return source.replaceAll('import(', 'loadFirebaseModule(');
}

function fixture({ support = true, supportError, analyticsError, failModule, existingApps = [] } = {}) {
  const calls = { imports: [], initialized: [], analytics: [], warnings: [], firestore: [], auth: [] };
  const apps = [...existingApps];
  const appModule = {
    getApps: () => [...apps],
    initializeApp(config) {
      if (apps.some((app) => app.name === '[DEFAULT]')) throw new Error('duplicate default app');
      const app = { name: '[DEFAULT]', options: JSON.parse(JSON.stringify(config)) };
      apps.push(app);
      calls.initialized.push(app);
      return app;
    }
  };
  const analyticsModule = {
    async isSupported() {
      if (supportError) throw new Error('support check failed');
      return await support;
    },
    getAnalytics(app) {
      if (analyticsError) throw new Error('analytics initialization failed');
      calls.analytics.push(app);
    }
  };
  const firestoreModule = {
    initializeFirestore(app, settings) {
      const db = { app, settings };
      calls.firestore.push(db);
      return db;
    }
  };
  const authModule = {
    getAuth(app) {
      const auth = { app };
      calls.auth.push(auth);
      return auth;
    },
    onAuthStateChanged(auth, callback) {
      queueMicrotask(() => callback(null));
      return () => {};
    }
  };
  const modules = {
    [base + 'firebase-app.js']: appModule,
    [base + 'firebase-analytics.js']: analyticsModule,
    [base + 'firebase-firestore.js']: firestoreModule,
    [base + 'firebase-auth.js']: authModule
  };
  const context = vm.createContext({
    window: {},
    FB: { on: false, db: null, auth: null, fs: null, au: null },
    console: { warn: (...args) => calls.warnings.push(args) },
    // Auth's callback resolves immediately in the mock, so its fallback timer is not needed.
    setTimeout: () => 0,
    loadFirebaseModule(url) {
      calls.imports.push(url);
      if (url.endsWith(failModule || '\0')) return Promise.reject(new Error('network unavailable'));
      if (!modules[url]) return Promise.reject(new Error('unexpected module: ' + url));
      return Promise.resolve(modules[url]);
    }
  });
  return { context, calls };
}

function runConfig(context, filename = 'js/firebase-config.js', transform = (s) => s) {
  const source = transform(read(filename));
  new vm.Script(source, { filename }); // The unmodified source must parse as a classic script.
  vm.runInContext(mockImports(source), context, { filename });
}

function runFirestoreInit(context, filename = 'js/app.js') {
  const source = read(filename);
  const start = source.indexOf('async function fbInit() {');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start !== -1 && end !== -1, 'Firebase initializer exists');
  const initializer = source.slice(start, end + 2);
  new vm.Script(initializer, { filename });
  vm.runInContext(mockImports(initializer), context, { filename });
  return context.fbInit();
}

for (const prefix of ['', 'crochet-amal/']) {
  const configFile = prefix + 'js/firebase-config.js';
  const appFile = prefix + 'js/app.js';

  test(`${prefix || 'root/'} loads the supplied config synchronously and initializes Analytics`, async () => {
    const { context, calls } = fixture();
    runConfig(context, configFile);
    assert.deepEqual(JSON.parse(JSON.stringify(context.window.FIREBASE_CONFIG)), expectedConfig);
    assert.equal(context.window.FIREBASE_SDK_BASE, base);
    await flush();
    assert.equal(calls.initialized.length, 1);
    assert.equal(calls.analytics.length, 1);
    assert.equal(calls.analytics[0], calls.initialized[0]);
    assert.deepEqual(calls.imports.sort(), [base + 'firebase-analytics.js', base + 'firebase-app.js']);
    assert.equal(calls.warnings.length, 0);
  });

  test(`${prefix || 'root/'} reuses the Analytics app for Firestore and Auth`, async () => {
    const { context, calls } = fixture();
    runConfig(context, configFile);
    await flush();
    await runFirestoreInit(context, appFile);
    assert.equal(calls.initialized.length, 1);
    assert.equal(context.FB.on, true);
    assert.equal(context.FB.db.app, calls.analytics[0]);
    assert.equal(context.FB.auth.app, calls.analytics[0]);
    assert.equal(context.FB.db.settings.experimentalAutoDetectLongPolling, true);
    assert.ok(calls.imports.includes(base + 'firebase-firestore.js'));
    assert.ok(calls.imports.includes(base + 'firebase-auth.js'));
  });

  test(`${prefix || 'root/'} reuses the Firestore app when Analytics starts later`, async () => {
    const supported = deferred();
    const { context, calls } = fixture({ support: supported.promise });
    runConfig(context, configFile);
    await flush();
    assert.equal(calls.initialized.length, 0);
    await runFirestoreInit(context, appFile);
    supported.resolve(true);
    await flush();
    assert.equal(calls.initialized.length, 1);
    assert.equal(calls.analytics[0], context.FB.db.app);
    assert.equal(context.FB.auth.app, calls.analytics[0]);
  });

  test(`${prefix || 'root/'} skips Analytics in unsupported browsers without disabling Firestore`, async () => {
    const { context, calls } = fixture({ support: false });
    runConfig(context, configFile);
    await flush();
    assert.equal(calls.analytics.length, 0);
    await runFirestoreInit(context, appFile);
    assert.equal(context.FB.on, true);
    assert.equal(calls.warnings.length, 0);
  });

  test(`${prefix || 'root/'} keeps Firestore working if Analytics cannot load`, async () => {
    const { context, calls } = fixture({ failModule: 'firebase-analytics.js' });
    runConfig(context, configFile);
    await flush();
    assert.equal(calls.warnings.length, 1);
    assert.equal(calls.analytics.length, 0);
    await runFirestoreInit(context, appFile);
    assert.equal(context.FB.on, true);
  });

  test(`${prefix || 'root/'} handles errors during the Analytics support check or initialization`, async () => {
    for (const option of [{ supportError: true }, { analyticsError: true }]) {
      const { context, calls } = fixture(option);
      runConfig(context, configFile);
      await flush();
      assert.equal(calls.warnings.length, 1);
      assert.equal(calls.analytics.length, 0);
      await runFirestoreInit(context, appFile);
      assert.equal(context.FB.on, true);
    }
  });

  test(`${prefix || 'root/'} can use Analytics even when Firestore cannot load`, async () => {
    const { context, calls } = fixture({ failModule: 'firebase-firestore.js' });
    runConfig(context, configFile);
    await assert.rejects(runFirestoreInit(context, appFile), /network unavailable/);
    await flush();
    assert.equal(calls.analytics.length, 1);
    assert.equal(context.FB.on, false);
  });

  test(`${prefix || 'root/'} uses the default app rather than an unrelated named app`, async () => {
    const otherApp = { name: 'other-project' };
    const { context, calls } = fixture({ existingApps: [otherApp] });
    runConfig(context, configFile);
    await flush();
    await runFirestoreInit(context, appFile);
    assert.equal(calls.initialized.length, 1);
    assert.notEqual(context.FB.db.app, otherApp);
    assert.equal(context.FB.db.app, calls.analytics[0]);
  });

  test(`${prefix || 'root/'} does not load Analytics when its measurement ID is removed`, async () => {
    const { context, calls } = fixture();
    runConfig(context, configFile, (source) => source.replace('  measurementId: "G-CXK9TCS9NH"', ''));
    await flush();
    assert.equal(context.window.FIREBASE_CONFIG.measurementId, undefined);
    assert.equal(calls.imports.length, 0);
    assert.equal(calls.analytics.length, 0);
    await runFirestoreInit(context, appFile);
    assert.equal(context.FB.on, true);
  });

  test(`${prefix || 'root/'} stays local and loads no SDK when Firebase is disabled`, async () => {
    const { context, calls } = fixture();
    runConfig(context, configFile, (source) => source.replace(
      /window\.FIREBASE_CONFIG = \{[\s\S]*?\};/,
      'window.FIREBASE_CONFIG = null;'
    ));
    await flush();
    await runFirestoreInit(context, appFile);
    assert.equal(context.FB.on, false);
    assert.equal(calls.imports.length, 0);
  });

  test(`${prefix || 'root/'} loads the classic config before the application on both pages`, () => {
    for (const page of ['index.html', 'admin.html']) {
      const html = read(prefix + page);
      const config = html.indexOf('<script src="js/firebase-config.js"></script>');
      const app = html.indexOf('<script src="js/app.js"></script>');
      assert.ok(config !== -1 && app > config, `${page} loads config first`);
    }
  });

  test(`${prefix || 'root/'} Firestore rules do not grant write access to every signed-in user`, () => {
    const rules = read(prefix + 'firestore.rules');
    assert.doesNotMatch(rules, /request\.auth\.uid\s*!=\s*null/);
    assert.equal((rules.match(/request\.auth\.token\.email\s*==\s*'crochetamal64@gmail\.com'/g) || []).length, 1);
    assert.match(rules, /function isAdmin\(\)/);
    assert.equal((rules.match(/allow create, update, delete: if isAdmin\(\);/g) || []).length, 2);
  });
}
