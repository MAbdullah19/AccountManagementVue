// Entry point: wiring, rendering and event handlers.
//
// Firebase is imported from the CDN as ES modules — no npm, no build step.
// The version is pinned deliberately; do not switch to a floating tag.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { initClock, serverNow, formatElapsed, formatTimeOfDay } from './clock.js';

const el = (id) => document.getElementById(id);

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  lock: null,
};

/* ---------------------------------------------------------------- banner */

function showBanner(title, body) {
  el('banner-title').textContent = title;
  el('banner-body').textContent = body;
  el('banner').hidden = false;
}

/* ---------------------------------------------------------------- render */

const VIEWS = ['loading', 'free', 'held'];

function setView(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
}

function render() {
  const lock = state.lock;
  const held = Boolean(lock) && lock.status === 'held' && Boolean(lock.holder);

  el('card').dataset.state = held ? 'held' : 'free';
  setView(held ? 'held' : 'free');

  if (held) renderHeld(lock);
}

function renderHeld(lock) {
  el('holder').textContent = lock.holder;

  const note = el('held-note');
  note.textContent = lock.note || '';
  note.hidden = !lock.note;

  renderHeldMeta();
}

// Split out from renderHeld because the ticking timer re-runs only this part.
function renderHeldMeta() {
  const lock = state.lock;
  if (!lock || lock.status !== 'held' || typeof lock.claimedAt !== 'number') {
    el('held-meta').textContent = '';
    return;
  }

  const parts = [`Since ${formatTimeOfDay(lock.claimedAt)}`];
  parts.push(`${formatElapsed(serverNow() - lock.claimedAt)} elapsed`);

  if (typeof lock.expectedMinutes === 'number') {
    const due = lock.claimedAt + lock.expectedMinutes * 60000;
    parts.push(`est. free by ${formatTimeOfDay(due)}`);
  }

  el('held-meta').textContent = parts.join(' · ');
}

/* ---------------------------------------------------------------- startup */

// A config object that still has placeholder values would fail deep inside the
// SDK with an unhelpful error. Catch it here and say what to do instead.
function configLooksReal(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId);
}

async function start() {
  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);

  // Anonymous auth is not about identifying people — it exists so the database
  // rules can require `auth != null` and shut out internet scanners.
  try {
    await signInAnonymously(getAuth(app));
  } catch (err) {
    showBanner(
      'Could not sign in',
      `Anonymous sign-in failed (${err.code || err.message}). ` +
      'Check that Anonymous is enabled under Firebase → Authentication → Sign-in method, ' +
      'and that this domain is listed under Authentication → Settings → Authorized domains.'
    );
    return;
  }

  initClock(db);

  // onValue fires immediately with the current value, then again on every
  // change — the first callback is not a change event.
  onValue(
    ref(db, 'lock'),
    (snap) => {
      state.lock = snap.val();
      render();
    },
    (err) => showBanner(
      'Cannot read the board',
      `${err.message} — check the Realtime Database rules have been published.`
    )
  );
}

if (configLooksReal(firebaseConfig)) {
  start();
} else {
  showBanner(
    'Setup incomplete',
    'firebase-config.js has no project config yet. Copy the firebaseConfig object from ' +
    'the Firebase console (Project settings → General → Your apps → Web app) into ' +
    'firebase-config.js. See the README.'
  );
}
