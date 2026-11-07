import shutil, sys

p = 'app.js'
shutil.copy(p, 'app.js.bak-before-supabase')
s = open(p, encoding='utf-8').read()
done = 0
total = 0

def rep(name, old, new):
    global s, done, total
    total += 1
    if new in s:
        print('سبق تطبيقه:', name)
        done += 1
        return
    if old not in s:
        print('لم أجد المقطع:', name)
        return
    s = s.replace(old, new, 1)
    done += 1
    print('تم:', name)

# 0) إرجاع أسطر fbLoad إن كانت معدّلة بـ sed سابقًا (غير ضرورية، لا تضر)

# 1) قراءة الزوار من Supabase
rep('visitors-load',
"""  READY = (async () => {
    await FB_INIT_PROMISE;
    if (!FB.on) {""",
"""  READY = (async () => {
    if (!IS_ADMIN && window.SupabaseSync) {
      try {
        const r = await withTimeout(SupabaseSync.load(), 12000);
        if (r.products.length > 0) {
          state.published = r.products;
          state.heroOverride = r.hero || null;
          renderSite();
          renderStore();
          goHash();
        }
      } catch (e) {
        console.error('[Supabase] load failed', e);
      }
      return;
    }
    if (IS_ADMIN && window.SupabaseSync) {
      try {
        SB_USER = await SupabaseSync.currentUser();
        const r = await withTimeout(SupabaseSync.load(), 12000);
        if (r.products.length) {
          state.published = r.products;
          state.heroOverride = r.hero || null;
          state.syncedToCloud = true;
          state.sync.loaded = true;
        }
        if (SB_USER && $('admin').hidden) openAdmin();
        else refreshAdminConnectionNotice();
      } catch (e) { console.error('[Supabase admin]', e); }
      return;
    }
    await FB_INIT_PROMISE;
    if (!FB.on) {""")

# 2) حالة الاتصال
rep('cloud-state',
"const cloudConfigured = () => Boolean(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);\nconst cloudSession = () => Boolean(FB.on && FB.auth && FB.auth.currentUser);",
"let SB_USER = null;\nconst cloudConfigured = () => Boolean(window.SUPABASE_URL);\nconst cloudSession = () => Boolean(SB_USER);")

# 3) تسجيل الدخول
rep('login',
"""        await FB_INIT_PROMISE;
        if (!(await ensureFirebase())) {
          err.textContent = 'تعذّر الاتصال بـ Firebase حاليًا. اضغطي الزر أدناه للدخول بالوضع المحلي فورًا.';
          return;
        }
        try {
          await withTimeout(
            FB.au.signInWithEmailAndPassword(FB.auth, $('em').value.trim(), $('pw').value),
            12000
          );
          await READY;""",
"""        try {
          await withTimeout(SupabaseSync.signIn($('em').value.trim(), $('pw').value), 12000);
          SB_USER = await SupabaseSync.currentUser();
          const r0 = await withTimeout(SupabaseSync.load(), 12000);
          if (r0.products.length) { state.published = r0.products; state.heroOverride = r0.hero || null; }
          state.syncedToCloud = true;
          state.sync.loaded = true;""")

rep('login-error-text',
"/invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/",
"/Invalid login|invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/")

# 4) النشر
rep('no-baseline',
"""      const remote = await CrochetSync.withTimeout(fbLoad(), 20000, 'load');
      applyRemoteBaseline(remote);
    } catch (err) {
      const d = describeSyncError({ code: 'no-baseline' });""",
"""      state.sync.loaded = true;
    } catch (err) {
      const d = describeSyncError({ code: 'no-baseline' });""")

rep('publish-call',
"      const result = await fbSave(state.draft, state.heroOverride, opts);",
"      await SupabaseSync.publish(state.draft, state.heroOverride);\n      const result = { revision: 'sb' };")

rep('size-check',
"""  const docBytes = CrochetSync.byteLength(JSON.stringify({ ...data, id: 'x', order: 0 }));
  if (docBytes > CrochetSync.DOC_BYTE_LIMIT) {""",
"""  const docBytes = 0;
  if (docBytes > 1000000) {""")

# 5) الخروج وفتح اللوحة
rep('signout',
"""  if (FB.on && FB.auth && FB.auth.currentUser) {
    FB.au.signOut(FB.auth).catch(() => {});
  }""",
"  SB_USER = null;\n  SupabaseSync.signOut().catch(() => {});")

rep('open-admin-btn',
"    if ((FB.on && FB.auth && FB.auth.currentUser) || sessionStorage.getItem(SESSION) === '1') {",
"    if (SB_USER || sessionStorage.getItem(SESSION) === '1') {")

open(p, 'w', encoding='utf-8').write(s)
print('\nالنتيجة:', done, 'من', total)
if done != total:
    print('تحذير: بعض المقاطع لم تُطبّق، أرسلي لي هذا الناتج.')
    sys.exit(1)
