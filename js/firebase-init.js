import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCLJG-ExZC7dVOcSL0Tfzdv965ewCj_uGs",
  authDomain: "flipcard-318f3.firebaseapp.com",
  projectId: "flipcard-318f3",
  storageBucket: "flipcard-318f3.firebasestorage.app",
  messagingSenderId: "517432601240",
  appId: "1:517432601240:web:9df881ed3f3c3b3bbb3eed",
  measurementId: "G-BGE5TKN2QP"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
