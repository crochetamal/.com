// Firebase web configuration is public; protect data with Firebase Security Rules.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDn3HXYY5wqyx_6D6Ahour2-l-i1yHaoR8",
  authDomain: "amale-crochet.firebaseapp.com",
  databaseURL: "https://amale-crochet-default-rtdb.firebaseio.com",
  projectId: "amale-crochet",
  storageBucket: "amale-crochet.firebasestorage.app",
  messagingSenderId: "1029434187104",
  appId: "1:1029434187104:web:6077fb2a47081df2e51205",
  measurementId: "G-CXK9TCS9NH"
};

// Keep Analytics, Firestore and Authentication on the same SDK version.
window.FIREBASE_SDK_BASE = 'https://www.gstatic.com/firebasejs/13.1.0/';

// Analytics is optional and must never block the storefront or admin panel.
(() => {
  const config = window.FIREBASE_CONFIG;
  if (!config || !config.measurementId) return;

  Promise.all([
    import(window.FIREBASE_SDK_BASE + 'firebase-app.js'),
    import(window.FIREBASE_SDK_BASE + 'firebase-analytics.js')
  ]).then(async ([firebase, analytics]) => {
    if (!(await analytics.isSupported())) return;
    const app = firebase.getApps().find((candidate) => candidate.name === '[DEFAULT]')
      || firebase.initializeApp(config);
    analytics.getAnalytics(app);
  }).catch((error) => {
    console.warn('Firebase Analytics unavailable:', error);
  });
})();
