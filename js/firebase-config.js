// Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
  import { getDatabase } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-database.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyBN-Phj91OVhuUx3a2XqDVysHifB_Ycjqc",
    authDomain: "amal-19669.firebaseapp.com",
    databaseURL: "https://amal-19669-default-rtdb.firebaseio.com",
    projectId: "amal-19669",
    storageBucket: "amal-19669.firebasestorage.app",
    messagingSenderId: "842263910623",
    appId: "1:842263910623:web:72bdb017fed74a7bf7316a",
    measurementId: "G-GFTLPJNGX7"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getdatabase(app);
export { getdatabase}
