// The activity page: the whole log, on its own, so the board stays one screen.
//
// Read-only. Nothing on this page writes, which is why it needs neither lock.js
// nor accounts.js.
import { ref, onValue, get, query, limitToLast }
  from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { initClock, formatLogTime } from './clock.js';
import { loadIdentity } from './identity.js';
import { connect, showBanner, watchConnection, renderWho } from './boot.js';

const el = (id) => document.getElementById(id);

// Deeper than the board's old twelve, because scrolling back is the entire
// reason this page exists. Still bounded: the log is append-only and grows
// forever, and nobody reads the thousandth line.
const LOG_LIMIT = 200;

let db = null;

/* ------------------------------------------------------------------ lines */

// Names and reasons are free text typed by colleagues, so every line is built
// with textContent. Nothing here touches innerHTML.
function describe(entry) {
  // The name is typed and the email is not, so the email is shown alongside it:
  // the line has to say who really did this, not only who said they did.
  // Omitted when they are the same string, which is how force-release entries
  // are written, and absent entirely from anything logged before this existed.
  const shown = entry.name || 'Someone';
  const name = entry.email && entry.email !== entry.name
    ? `${shown} (${entry.email})`
    : shown;

  // v1 entries predate multiple accounts and carry no label.
  const target = entry.accountLabel ? `${entry.accountLabel}` : 'the account';

  switch (entry.action) {
    case 'claimed':
      return `${name} claimed ${target}`;
    case 'released':
      return `${name} released ${target}`;
    case 'force-released': {
      const who = entry.heldBy ? ` (held by ${entry.heldBy})` : '';
      const why = entry.reason ? `: “${entry.reason}”` : '';
      return `${name} force-released ${target}${who}${why}`;
    }
    default:
      return `${name} ${entry.action || 'did something'}`;
  }
}

function logLine(entry) {
  const li = document.createElement('li');

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = typeof entry.at === 'number' ? formatLogTime(entry.at) : '';

  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = describe(entry);

  li.append(time, text);
  return li;
}

function render(entries) {
  const list = el('log-list');
  list.textContent = '';

  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = 'No activity yet.';
    list.append(empty);
    el('log-foot').hidden = true;
    return;
  }

  for (const entry of entries) list.append(logLine(entry));

  // Only worth saying once the window is actually cutting something off.
  const foot = el('log-foot');
  foot.textContent = entries.length >= LOG_LIMIT
    ? `Showing the most recent ${LOG_LIMIT} entries.`
    : '';
  foot.hidden = !foot.textContent;
}

// limitToLast hands entries back oldest-first; the page reads newest-first.
function readLog(snap) {
  const entries = [];
  snap.forEach((child) => {
    entries.push(child.val());
  });
  return entries.reverse();
}

/* ---------------------------------------------------------------- startup */

async function start() {
  // Started before sign-in so the two round trips overlap.
  const identityPromise = loadIdentity();

  db = await connect();
  if (!db) return;

  renderWho(await identityPromise);

  initClock(db);
  watchConnection(db);

  onValue(
    query(ref(db, 'log'), limitToLast(LOG_LIMIT)),
    (snap) => render(readLog(snap)),
    (err) => showBanner(
      'Cannot read the log',
      `${err.message}. Check that the Realtime Database rules have been published.`
    )
  );

  // Cheap insurance against a listener that died while the laptop was asleep.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function refresh() {
  try {
    const snap = await get(query(ref(db, 'log'), limitToLast(LOG_LIMIT)));
    render(readLog(snap));
  } catch (err) {
    console.warn('[board] refetch on focus failed', err);
  }
}

start();
