# Crochet.Amal: متجر كروشيه (GitHub Pages)

موقع ثابت (HTML + CSS + JavaScript) بدون خادم أو قاعدة بيانات. الطلبات تتم عبر واتساب: https://wa.me/212700278798

## الملفات
- `index.html`, `css/style.css`, `js/app.js`: الموقع ولوحة التحكم
- `data/products.json`: كتالوج المنتجات الأصلي (عدّليه بدون لمس الكود)
- `data/site.json`: نصوص الصفحة، الأقسام، الآراء، روابط التواصل، رقم واتساب
- `assets/images/`: الصور

## النشر على GitHub Pages
1. أنشئي حسابًا على github.com ثم مستودعًا جديدًا (مثلًا `crochet-amal`) بوضع Public.
2. اضغطي **Add file > Upload files** وارفعي **محتويات** المجلد (index.html و css و js و data و assets) ثم **Commit changes**.
3. من **Settings > Pages**: اختاري Source = **Deploy from a branch**، Branch = `main`، المجلد `/ (root)`، ثم **Save**.
4. بعد دقيقة يظهر الموقع على `https://USERNAME.github.io/crochet-amal/`. كل المسارات نسبية فتعمل تحت هذا الرابط.

## لوحة التحكم
افتحي صفحة المشرفة المنفصلة: `https://crochetamal.github.io/.com/admin.html` (لا يوجد أي زر لها في المتجر، احفظي الرابط) ثم أدخلي كلمة المرور المتفق عليها. 
من اللوحة: إضافة منتج، تعديل الاسم والوصف والثمن (بالدرهم) ورابط الصورة (مع معاينة)، حذف، ترتيب (▲▼)، إخفاء/إظهار، معاينة، ونشر.

## مهم: حدود الاستضافة الثابتة
- GitHub Pages لا يحفظ شيئًا من المتصفح. تعديلات اللوحة تُحفظ في **localStorage لهذا المتصفح فقط** ولا يراها الزوار الآخرون.
- كلمة المرور **ليست حماية حقيقية**: الكود يمكن فحصه (يُخزَّن فقط بصمتها SHA-256). هي قفل للراحة فقط. لا تُخزَّن أي بيانات دفع أو بيانات شخصية.
- لتغيير كلمة المرور: احسبي SHA-256 للكلمة الجديدة وضعيها في `PW_HASH` داخل `js/app.js`.

## كيف تظهر تعديلاتك لكل الزوار
1. عدّلي المنتجات في اللوحة ثم **نشر التغييرات**.
2. اضغطي **تصدير JSON** (ينزل `products.json`).
3. في GitHub افتحي `data/products.json` > Edit (أو Upload files لاستبدال الملف) > Commit.
4. صور جديدة: ارفعيها إلى `assets/images/` واستعملي `assets/images/اسم.jpg` كرابط الصورة، أو رابطًا خارجيًا يبدأ بـ https.
5. بعد النشر، اضغطي **استرجاع الأصل** في لوحتك حتى لا تتجاوز نسخة المتصفح القديمة الملف المنشور.

## النسخ الاحتياطي والاستعادة
- **تصدير JSON** = نسخة احتياطية. **استيراد JSON** = استعادتها (تدخل المسودة ثم انشريها).

## تجربة محلية
افتحي الطرفية في المجلد وشغّلي `python3 -m http.server 8000` ثم زوري http://localhost:8000 (فتح الملف مباشرة لا يعمل بسبب `fetch`).

## ملاحظة
رابط إنستغرام في `data/site.json` ضمن `social`. لإضافة فيسبوك أو تيك توك أضيفي `"facebook"` أو `"tiktok"` مع الرابط الصحيح.

## ربط Firebase (نشر مباشر لكل الزوار)
بهذا الربط تصبح التعديلات والصور المرفوعة من لوحة التحكم ظاهرة لكل الزبائن فور الحفظ دون أي زر نشر. الخطة المجانية (Spark) تكفي. لا نستعمل Firebase Storage لأنه يتطلب خطة مدفوعة؛ بدلًا من ذلك تُصغَّر الصورة المرفوعة تلقائيًا وتُحفظ داخل Firestore.

1. افتحي https://console.firebase.google.com وأنشئي مشروعًا (يمكن إيقاف Analytics).
2. **Build > Firestore Database > Create database** (موقع قريب مثل `eur3`)، وضع Production.
3. **Build > Authentication > Get started > Email/Password > Enable**. ثم تبويب **Users > Add user** وأنشئي حساب المسؤولة (بريد وكلمة مرور قوية).
4. **Authentication > Settings > Authorized domains > Add domain** وأضيفي `crochetamal.github.io`.
5. **Firestore > Rules**: الصقي محتوى `firestore.rules` واستبدلي `ADMIN_EMAIL@example.com` ببريد المسؤولة ثم **Publish**. هذه القواعد هي الحماية الحقيقية: القراءة للجميع والكتابة لحسابك فقط.
6. **Project settings > Your apps > Web (</>)** سجّلي تطبيقًا وانسخي `firebaseConfig`.
7. افتحي `js/firebase-config.js` واستبدلي `null` بالإعدادات، مثل:
   `window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };`
8. ارفعي الملفات إلى GitHub. ثم ادخلي من «© 2026» بالبريد وكلمة المرور، واضغطي **نشر الآن** مرة واحدة ليُرفع الكتالوج الحالي إلى Firebase. بعدها كل تعديل يُنشر تلقائيًا.

ملاحظات: عند تفعيل Firebase لا تُستعمل كلمة المرور المحلية القديمة (الدخول بالبريد). ما دام `FIREBASE_CONFIG` يساوي `null` يعمل الموقع بالوضع المحلي السابق. إن فشل الاتصال بـ Firebase يعرض الموقع كتالوج `data/products.json`.
