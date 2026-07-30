// Entry point: wiring, rendering and event handlers.
//
// Firebase is imported from the CDN as ES modules — no npm, no build step.
// The version is pinned deliberately; do not switch to a floating tag.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { initClock, serverNow, formatElapsed, formatTimeOfDay } from './clock.js';
import { claim, release, forceRelease } from './lock.js';

const el = (id) => document.getElementById(id);

const NAME_KEY = 'account-board:name';

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  lock: null,
  lastStatus: null,
};

/* ---------------------------------------------------------------- banner */

function showBanner(title, body) {
  el('banner-title').textContent = title;
  el('banner-body').textContent = body;
  el('banner').hidden = false;
}

/* ------------------------------------------------------------ saved name */

// localStorage throws rather than returning null in some privacy modes.
function savedName() {
  try {
    return (localStorage.getItem(NAME_KEY) || '').trim();
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* not important enough to bother the user about */
  }
}

/* -------------------------------------------------------------- messages */

function setMsg(id, text, tone = 'info') {
  const node = el(id);
  node.textContent = text;
  if (text) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

const MESSAGES = {
  taken: 'Someone claimed it a moment ago.',
  'not-holder': 'The board says someone else holds it now — use Force release.',
  'already-free': 'It was already free.',
  'no-reason': 'Type a reason first.',
  invalid: 'Check the name (1–40 characters), note (up to 120) and minutes (1–480).',
  error: 'That write was rejected. Check the name and note lengths, then try again.',
};

function explain(result) {
  if (result.reason === 'error' && result.error) console.error('[board] write failed', result.error);
  return MESSAGES[result.reason] || 'That did not work. Try again.';
}

/* ---------------------------------------------------------------- render */

const VIEWS = ['loading', 'free', 'held'];

function setView(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
}

function render() {
  const lock = state.lock;
  const held = Boolean(lock) && lock.status === 'held' && Boolean(lock.holder);
  const status = held ? 'held' : 'free';

  // Clear stale inline messages whenever the board actually changes state.
  if (status !== state.lastStatus) {
    setMsg('claim-msg', '');
    setMsg('held-msg', '');
    state.lastStatus = status;
  }

  el('card').dataset.state = status;
  setView(status);

  if (held) renderHeld(lock);
  else renderFree();
}

function renderFree() {
  const name = el('name');
  if (!name.value) name.value = savedName();
}

function renderHeld(lock) {
  el('holder').textContent = lock.holder;

  const note = el('held-note');
  note.textContent = lock.note || '';
  note.hidden = !lock.note;

  // Release is for the person who holds it. Everyone else gets Force release.
  el('release-btn').hidden = !savedName() || lock.holder !== savedName();

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

/* ---------------------------------------------------------------- events */

// Buttons stay disabled for the round trip so a double click cannot fire two
// transactions.
async function whileBusy(button, label, fn) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function wireEvents(db) {
  // A form submit means Enter in any field claims the account.
  el('claim-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg('claim-msg', '');

    const holder = el('name').value.trim();
    const note = el('note').value.trim();
    const expectedMinutes = Number(el('minutes').value);

    if (!holder) {
      setMsg('claim-msg', 'Put your name in first.', 'error');
      el('name').focus();
      return;
    }

    const result = await whileBusy(el('claim-btn'), 'Claiming…', () =>
      claim(db, { holder, note, expectedMinutes })
    );

    if (result.ok) {
      saveName(result.holder);
      el('note').value = '';
      return; // the listener redraws the card
    }
    setMsg('claim-msg', explain(result), 'error');
  });

  el('release-btn').addEventListener('click', async () => {
    setMsg('held-msg', '');
    const result = await whileBusy(el('release-btn'), 'Releasing…', () =>
      release(db, { holder: savedName() })
    );
    if (!result.ok) setMsg('held-msg', explain(result), 'error');
  });

  // The reason field is the friction; the button unlocks once it has content.
  el('force-reason').addEventListener('input', (event) => {
    el('force-btn').disabled = !event.target.value.trim();
  });

  el('force-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg('held-msg', '');

    const reason = el('force-reason').value.trim();
    const by = savedName() || el('name').value.trim();

    if (!by) {
      setMsg('held-msg', 'Force release records who did it — claim once, or type your name above.', 'error');
      return;
    }

    const result = await whileBusy(el('force-btn'), 'Releasing…', () =>
      forceRelease(db, { by, reason, heldBy: state.lock?.holder })
    );

    if (result.ok) {
      el('force-reason').value = '';
      el('force-btn').disabled = true;
      return;
    }
    setMsg('held-msg', explain(result), 'error');
  });
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
  wireEvents(db);

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
