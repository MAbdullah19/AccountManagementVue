// Entry point: wiring, rendering and event handlers.
//
// Firebase is imported from the CDN as ES modules — no npm, no build step.
// The version is pinned deliberately; do not switch to a floating tag.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getDatabase, ref, onValue, get, query, limitToLast }
  from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';
import { initClock, serverNow, formatElapsed, formatDuration, formatTimeOfDay, formatLogTime }
  from './clock.js';
import { claim, release, forceRelease } from './lock.js';

const el = (id) => document.getElementById(id);

const NAME_KEY = 'account-board:name';
const DEFAULT_MINUTES = 30;

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  lock: null,
  lastStatus: null,
  connected: false,
  everConnected: false,
  log: [],
};

const LOG_LIMIT = 10;

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

// Overdue is purely visual. Nothing auto-releases and nothing is blocked — it
// just makes a forgotten release legible to the room.
function isOverdue(lock) {
  if (!lock || lock.status !== 'held') return false;
  if (typeof lock.claimedAt !== 'number' || typeof lock.expectedMinutes !== 'number') return false;
  return serverNow() > lock.claimedAt + lock.expectedMinutes * 60000;
}

function render() {
  const lock = state.lock;
  const held = Boolean(lock) && lock.status === 'held' && Boolean(lock.holder);
  const status = held ? 'held' : 'free';

  // Clear stale inline messages whenever the board actually changes hands.
  // Going overdue is not a change of hands, so it must not wipe a message.
  if (status !== state.lastStatus) {
    setMsg('claim-msg', '');
    setMsg('held-msg', '');
    state.lastStatus = status;
  }

  el('card').dataset.state = held && isOverdue(lock) ? 'overdue' : status;
  setView(status);

  if (held) renderHeld(lock);
  else renderFree();

  updateTitle();
}

function renderFree() {
  const name = el('name');
  // Prefilling the saved name is what makes claiming one click for a returning
  // user. Never overwrite something they are in the middle of typing.
  if (!name.value) name.value = savedName();
  syncClaimButton();
}

function syncClaimButton() {
  el('claim-btn').disabled = !el('name').value.trim();
}

// The tab title is the board for anyone who keeps it pinned, so it carries the
// status rather than a fixed app name.
let accountLabel = '';

function updateTitle() {
  if (!accountLabel) accountLabel = el('account-id').textContent.trim() || 'shared account';

  const lock = state.lock;
  if (!lock || lock.status !== 'held' || !lock.holder) {
    document.title = `○ Free — ${accountLabel}`;
    return;
  }
  document.title = `${isOverdue(lock) ? '⚠' : '●'} In use — ${lock.holder}`;
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

  if (isOverdue(lock)) {
    parts.push(`held ${formatDuration(serverNow() - lock.claimedAt)} — still in use?`);
  } else {
    parts.push(`${formatElapsed(serverNow() - lock.claimedAt)} elapsed`);
    if (typeof lock.expectedMinutes === 'number') {
      const due = lock.claimedAt + lock.expectedMinutes * 60000;
      parts.push(`est. free by ${formatTimeOfDay(due)}`);
    }
  }

  el('held-meta').textContent = parts.join(' · ');
}

/* -------------------------------------------------------- activity log */

// Names and reasons are free text typed by colleagues, so every line is built
// with textContent. Nothing here touches innerHTML.
function describe(entry) {
  const name = entry.name || 'Someone';
  switch (entry.action) {
    case 'claimed':
      return `${name} claimed the account`;
    case 'released':
      return `${name} released it`;
    case 'force-released': {
      const who = entry.heldBy ? ` (held by ${entry.heldBy})` : '';
      const why = entry.reason ? ` — “${entry.reason}”` : '';
      return `${name} force-released it${who}${why}`;
    }
    default:
      return `${name} ${entry.action || 'did something'}`;
  }
}

function logLine(entry) {
  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = typeof entry.at === 'number' ? formatLogTime(entry.at) : '—';
  li.append(time, document.createTextNode(` — ${describe(entry)}`));
  return li;
}

function renderLog() {
  const list = el('log-list');
  list.textContent = '';

  if (!state.log.length) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = 'No activity yet.';
    list.append(empty);
    return;
  }

  for (const entry of state.log) list.append(logLine(entry));
}

// limitToLast hands entries back oldest-first; the board reads newest-first.
function readLog(snap) {
  const entries = [];
  snap.forEach((child) => {
    entries.push(child.val());
  });
  return entries.reverse();
}

/* ------------------------------------------------------------ connection */

// This must reflect the connection, not the age of the last message. onValue
// only fires on change, so an account sitting free for two hours is perfectly
// healthy and a "last synced" indicator would libel it.
function setConnected(connected) {
  state.connected = connected;
  if (connected) state.everConnected = true;

  const conn = el('conn');
  conn.dataset.state = connected ? 'live' : state.everConnected ? 'offline' : 'connecting';
  el('conn-label').textContent = connected
    ? 'live'
    : state.everConnected
      ? 'reconnecting…'
      : 'connecting…';

  // A frozen page showing "Available" is worse than no board at all, so a
  // stale reading has to look stale.
  el('card').dataset.stale = String(!connected && state.everConnected);
}

/* ------------------------------------------------------------------ tick */

// The network carries one number — claimedAt — and the browser does the
// ticking. Recomputing locally every second means no polling, and the value
// survives a reload because it was never held in a counter.
function tick() {
  if (!state.lock || state.lock.status !== 'held') return;
  el('card').dataset.state = isOverdue(state.lock) ? 'overdue' : 'held';
  renderHeldMeta();
  updateTitle();
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
  el('name').addEventListener('input', syncClaimButton);

  // A form submit means Enter in any field claims the account.
  el('claim-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg('claim-msg', '');

    const holder = el('name').value.trim();
    const note = el('note').value.trim();
    // An emptied duration field means "the usual", not an error.
    const minutes = el('minutes').value.trim();
    const expectedMinutes = minutes === '' ? DEFAULT_MINUTES : Number(minutes);

    if (!holder) {
      setMsg('claim-msg', 'Put your name in first.', 'error');
      el('name').focus();
      return;
    }

    // Save the name before claiming, not after. The listener fires during the
    // transaction's local write, so a name saved afterwards would arrive too
    // late for that first render and the holder would not be offered Release
    // until something else redrew the card.
    saveName(holder);

    const result = await whileBusy(el('claim-btn'), 'Claiming…', () =>
      claim(db, { holder, note, expectedMinutes })
    );
    syncClaimButton();

    if (result.ok) {
      el('note').value = '';
      return; // the listener redraws the card
    }

    // By now the listener has usually redrawn the card. If someone else won the
    // race the free view is hidden, so a message written there would never be
    // seen — put it wherever the reader is actually looking.
    const visible = state.lock && state.lock.status === 'held' ? 'held-msg' : 'claim-msg';
    setMsg(visible, explain(result), 'error');
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
  setInterval(tick, 1000);

  onValue(ref(db, '.info/connected'), (snap) => setConnected(snap.val() === true));

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

  onValue(
    query(ref(db, 'log'), limitToLast(LOG_LIMIT)),
    (snap) => {
      state.log = readLog(snap);
      renderLog();
    },
    (err) => console.warn('[board] cannot read the log', err)
  );

  // Cheap insurance against a listener that died while the laptop was asleep.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(db);
  });
}

async function refresh(db) {
  try {
    const [lockSnap, logSnap] = await Promise.all([
      get(ref(db, 'lock')),
      get(query(ref(db, 'log'), limitToLast(LOG_LIMIT))),
    ]);
    state.lock = lockSnap.val();
    state.log = readLog(logSnap);
    render();
    renderLog();
  } catch (err) {
    console.warn('[board] refetch on focus failed', err);
  }
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
