
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
  getDatabase,
  ref,
  set,
  push,
  onValue
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDpdxSCppxHTjzE1sNMHHGQ2DbZm-Mq-lk",
  authDomain: "melody-magic-auditorium.firebaseapp.com",
  databaseURL: "https://melody-magic-auditorium-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "melody-magic-auditorium",
  storageBucket: "melody-magic-auditorium.firebasestorage.app",
  messagingSenderId: "458186749712",
  appId: "1:458186749712:web:311ecbed0c87367022d795"
};

// INITIALIZE FIREBASE
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// SET PERSISTENT LOGIN
const authReady = setPersistence(auth, browserLocalPersistence);

// PERFORMER LOGIN
async function connectAuditorium() {
  await authReady;

  if (auth.currentUser) {
    return auth.currentUser;
  }

  const result = await signInAnonymously(auth);
  return result.user;
}

// REGISTER SINGER
async function registerSinger(
  name,
  song,
  language,
  sessionId = "",
  performance = ""
) {
  const user = await connectAuditorium();

  await set(push(ref(db, "registrations/" + user.uid)), {
    name,
    song,
    language,
    sessionId,
    performance,
    status: "Waiting",
    createdAt: Date.now()
  });

  return user.uid;
}

// LISTEN TO SINGERS
function listenToSingers(callback) {
  return onValue(ref(db, "registrations"), snapshot => {
    callback(snapshot.val() || {});
  });
}

// HOST REGISTRATION WITH GPS LOCATION
async function registerHost(
  name,
  email,
  mobile,
  plan,
  password,
  locationData
) {
  if (
    !locationData ||
    locationData.locationDetected !== true ||
    typeof locationData.latitude !== "number" ||
    typeof locationData.longitude !== "number" ||
    !locationData.country ||
    !locationData.state ||
    !locationData.city
  ) {
    throw new Error(
      "GPS location detection and Country, State and City are compulsory."
    );
  }

  await authReady;

  const result = await createUserWithEmailAndPassword(
    auth,
    email,
    password
  );

  const user = result.user;

  await set(ref(db, "hostApplications/" + user.uid), {
    name,
    email,
    mobile,
    plan,

    country: locationData.country,
    state: locationData.state,
    city: locationData.city,

    location: [
      locationData.city,
      locationData.state,
      locationData.country
    ].join(", "),

    latitude: locationData.latitude,
    longitude: locationData.longitude,
    accuracy: locationData.accuracy || null,

    locationDetected: true,
    locationDetectionMethod: "Browser GPS",
    locationCapturedAt: Date.now(),

    status: "Pending",
    createdAt: Date.now()
  });

  return user;
}

// HOST LOGIN
async function hostLogin(email, password) {
  await authReady;

  await setPersistence(auth, browserLocalPersistence);

  const result = await signInWithEmailAndPassword(
    auth,
    email,
    password
  );

  return result.user;
}

// HOST LOGOUT
async function hostLogout() {
  await authReady;
  await signOut(auth);
}

// CHECK LOGIN STATUS
function checkLogin(callback) {
  return onAuthStateChanged(auth, callback);
}

// EXPORT FUNCTIONS
export {
  db,
  auth,
  registerSinger,
  registerHost,
  listenToSingers,
  connectAuditorium,
  hostLogin,
  hostLogout,
  checkLogin
};
