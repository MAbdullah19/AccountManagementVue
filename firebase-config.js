// Firebase project config, from the Firebase console
// (Project settings -> General -> Your apps -> Web app).
//
// This file is committed on purpose, and the repo is private. The web API key is
// not a secret: it identifies the project, it does not authorise anything.
// Security comes from the Realtime Database rules in database.rules.json, and
// from Cloudflare Access in front of the site. Do not build a scheme to hide it.
//
// It also has to be committed for deployment to work at all: Cloudflare Pages
// serves this repo as-is with no build step, so if this file is missing the
// import in app.js 404s and nothing runs.
export const firebaseConfig = {
  apiKey: 'AIzaSyABw9VkJ1-CfOFaJp1JjNtMdnbS1PW7MgY',
  authDomain: 'vue-account-board.firebaseapp.com',
  databaseURL: 'https://vue-account-board-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'vue-account-board',
  storageBucket: 'vue-account-board.firebasestorage.app',
  messagingSenderId: '814265643519',
  appId: '1:814265643519:web:4c0d097bf3b38d13c877ca',
};
