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
import { createAccount, renameAccount, deleteAccount, addUser, removeUser } from './accounts.js';
import { loadIdentity } from './identity.js';

const el = (id) => document.getElementById(id);

const NAME_KEY = 'account-board:name';
const DEFAULT_MINUTES = 30;
const LOG_LIMIT = 12;

// Set once in start(). Handlers are wired per card and would otherwise all have
// to close over it.
let db = null;

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  accounts: [],
  accountsLoaded: false,
  locks: {},
  identity: { email: '', name: '', isAdmin: false, source: 'none' },
  connected: false,
  everConnected: false,
  log: [],
};

// accountId -> card object. Cards are kept and updated in place rather than
// rebuilt, so a lock change on one account cannot wipe what somebody is
// halfway through typing into another.
const cards = new Map();
let addCard = null;

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

function setMsg(node, text, tone = 'info') {
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

const ADMIN_MESSAGES = {
  invalid: 'Check the account name (1–60 characters) and description (up to 120).',
  error: 'That write was rejected. Try again.',
};

const ROSTER_MESSAGES = {
  invalid: 'Check the name (1–40 characters) and note (up to 60).',
  error: 'That write was rejected. Try again.',
};

function explain(result, table = MESSAGES) {
  if (result.reason === 'error' && result.error) console.error('[board] write failed', result.error);
  return table[result.reason] || 'That did not work. Try again.';
}

const explainAdmin = (result) => explain(result, ADMIN_MESSAGES);
const explainRoster = (result) => explain(result, ROSTER_MESSAGES);

/* ------------------------------------------------------------ lock state */

const isHeld = (lock) => Boolean(lock) && lock.status === 'held' && Boolean(lock.holder);

// Overdue is purely visual. Nothing auto-releases and nothing is blocked — it
// just makes a forgotten release legible to the room.
function isOverdue(lock) {
  if (!isHeld(lock)) return false;
  if (typeof lock.claimedAt !== 'number' || typeof lock.expectedMinutes !== 'number') return false;
  return serverNow() > lock.claimedAt + lock.expectedMinutes * 60000;
}

/* ----------------------------------------------------------- reading data */

// Push keys sort chronologically as strings, so sorting by id keeps the roster
// in the order people were added to it.
function readUsers(node) {
  if (!node || typeof node !== 'object') return [];

  return Object.entries(node)
    .map(([id, val]) => ({
      id,
      name: typeof val?.name === 'string' ? val.name.trim() : '',
      note: typeof val?.note === 'string' ? val.note.trim() : '',
    }))
    .filter((user) => user.name)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readAccounts(snap) {
  const list = [];

  snap.forEach((child) => {
    const val = child.val() || {};
    const label = typeof val.label === 'string' ? val.label.trim() : '';
    list.push({
      id: child.key,
      label: label || '(unnamed account)',
      description: typeof val.description === 'string' ? val.description.trim() : '',
      createdAt: typeof val.createdAt === 'number' ? val.createdAt : 0,
      users: readUsers(val.users),
    });
  });

  // Oldest first, so the board does not reshuffle itself as accounts are added.
  list.sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label));
  return list;
}

/* ------------------------------------------------------------------ cards */

function buildCard(accountId) {
  const root = el('card-template').content.firstElementChild.cloneNode(true);
  const els = {};
  for (const node of root.querySelectorAll('[data-el]')) els[node.dataset.el] = node;

  const card = { id: accountId, root, els, account: null, lock: null, lastStatus: null };
  wireCard(card);
  return card;
}

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

const syncClaimButton = (card) => {
  card.els['claim-btn'].disabled = !card.els.name.value.trim();
};

function wireCard(card) {
  const { els } = card;

  els.name.addEventListener('input', () => syncClaimButton(card));

  // A form submit means Enter in any field claims the account.
  els['claim-form'].addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg(els['claim-msg'], '');

    const holder = els.name.value.trim();
    const note = els.note.value.trim();
    // An emptied duration field means "the usual", not an error.
    const minutes = els.minutes.value.trim();
    const expectedMinutes = minutes === '' ? DEFAULT_MINUTES : Number(minutes);

    if (!holder) {
      setMsg(els['claim-msg'], 'Put your name in first.', 'error');
      els.name.focus();
      return;
    }

    // Save the name before claiming, not after. The listener fires during the
    // transaction's local write, so a name saved afterwards would arrive too
    // late for that first render and the holder would not be offered Release
    // until something else redrew the card.
    saveName(holder);

    const account = card.account;
    const result = await whileBusy(els['claim-btn'], 'Claiming…', () =>
      claim(db, account, { holder, note, expectedMinutes })
    );
    syncClaimButton(card);

    if (result.ok) {
      els.note.value = '';
      return; // the listener redraws the card
    }

    // By now the listener has usually redrawn the card. If someone else won the
    // race the free view is hidden, so a message written there would never be
    // seen — put it wherever the reader is actually looking.
    setMsg(isHeld(card.lock) ? els['held-msg'] : els['claim-msg'], explain(result), 'error');
  });

  els['release-btn'].addEventListener('click', async () => {
    setMsg(els['held-msg'], '');
    const result = await whileBusy(els['release-btn'], 'Releasing…', () =>
      release(db, card.account, { holder: savedName() })
    );
    if (!result.ok) setMsg(els['held-msg'], explain(result), 'error');
  });

  // The reason field is the friction; the button unlocks once it has content.
  els['force-reason'].addEventListener('input', (event) => {
    els['force-btn'].disabled = !event.target.value.trim();
  });

  els['force-form'].addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg(els['held-msg'], '');

    const reason = els['force-reason'].value.trim();
    const by = savedName();

    if (!by) {
      setMsg(els['held-msg'], 'Force release records who did it — claim something once so the board knows your name.', 'error');
      return;
    }

    const result = await whileBusy(els['force-btn'], 'Releasing…', () =>
      forceRelease(db, card.account, { by, reason, heldBy: card.lock?.holder })
    );

    if (result.ok) {
      els['force-reason'].value = '';
      els['force-btn'].disabled = true;
      return;
    }
    setMsg(els['held-msg'], explain(result), 'error');
  });

  wireCardRoster(card);
  wireCardAdmin(card);
}

/* ----------------------------------------------------------------- roster */

function wireCardRoster(card) {
  const { els } = card;

  els['roster-form'].addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg(els['roster-msg'], '');

    const name = els['roster-name'].value.trim();
    const note = els['roster-note'].value.trim();

    if (!name) {
      setMsg(els['roster-msg'], 'Type a name first.', 'error');
      els['roster-name'].focus();
      return;
    }

    const result = await whileBusy(els['roster-add'], 'Adding…', () =>
      addUser(db, card.id, { name, note })
    );

    if (result.ok) {
      els['roster-name'].value = '';
      els['roster-note'].value = '';
      els['roster-name'].focus();
      return;
    }
    setMsg(els['roster-msg'], explainRoster(result), 'error');
  });
}

function renderRoster(card, account) {
  const { els } = card;
  const admin = state.identity.isAdmin;
  const users = account.users;

  // For everyone else an empty roster is noise, so the whole block goes away.
  els.roster.hidden = !users.length && !admin;
  els['roster-more'].hidden = !admin;

  const list = els['roster-list'];
  list.textContent = '';

  if (!users.length) {
    const empty = document.createElement('li');
    empty.className = 'roster-empty';
    empty.textContent = 'Nobody listed yet.';
    list.append(empty);
    return;
  }

  // Names and notes are free text typed by the owner, so every node is built
  // with textContent. Nothing here touches innerHTML.
  for (const user of users) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = user.name;
    li.append(name);

    if (user.note) {
      const note = document.createElement('span');
      note.className = 'roster-note';
      note.textContent = user.note;
      li.append(note);
    }

    if (admin) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'roster-remove';
      button.textContent = '×';
      button.setAttribute('aria-label', `Remove ${user.name}`);
      button.addEventListener('click', async () => {
        setMsg(els['roster-msg'], '');
        const result = await removeUser(db, card.id, user.id);
        if (!result.ok) setMsg(els['roster-msg'], explainRoster(result), 'error');
      });
      li.append(button);
    }

    list.append(li);
  }
}

/* ------------------------------------------------------------ owner controls */

function closeRename(card) {
  card.els['rename-form'].hidden = true;
  card.els['admin-links'].hidden = false;
}

function closeDelete(card) {
  card.els['delete-confirm'].hidden = true;
  card.els['admin-links'].hidden = false;
}

function wireCardAdmin(card) {
  const { els } = card;

  els['rename-btn'].addEventListener('click', () => {
    setMsg(els['admin-msg'], '');
    closeDelete(card);
    els['rename-label'].value = card.account?.label || '';
    els['rename-desc'].value = card.account?.description || '';
    els['admin-links'].hidden = true;
    els['rename-form'].hidden = false;
    els['rename-label'].focus();
  });

  els['rename-cancel'].addEventListener('click', () => {
    setMsg(els['admin-msg'], '');
    closeRename(card);
  });

  els['rename-form'].addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg(els['admin-msg'], '');

    const label = els['rename-label'].value.trim();
    const description = els['rename-desc'].value.trim();

    if (!label) {
      setMsg(els['admin-msg'], 'An account needs a name.', 'error');
      els['rename-label'].focus();
      return;
    }

    const result = await whileBusy(els['rename-save'], 'Saving…', () =>
      renameAccount(db, card.id, { label, description })
    );

    if (result.ok) {
      closeRename(card);
      return;
    }
    setMsg(els['admin-msg'], explainAdmin(result), 'error');
  });

  // Two steps rather than a confirm() dialog. Deleting an account is rare and
  // destructive, which is the opposite of force release — there the dialog was
  // wrong precisely because it happens often enough to train people to click
  // through it.
  els['delete-btn'].addEventListener('click', () => {
    setMsg(els['admin-msg'], '');
    closeRename(card);

    const holder = isHeld(card.lock) ? card.lock.holder : '';
    els['delete-warn'].textContent = holder
      ? `${holder} is holding this right now — deleting it will not tell them. The activity log keeps its history either way.`
      : 'The activity log keeps its history. This cannot be undone.';

    els['admin-links'].hidden = true;
    els['delete-confirm'].hidden = false;
  });

  els['delete-no'].addEventListener('click', () => closeDelete(card));

  els['delete-yes'].addEventListener('click', async () => {
    setMsg(els['admin-msg'], '');
    const result = await whileBusy(els['delete-yes'], 'Deleting…', () =>
      deleteAccount(db, card.id)
    );
    // On success the listener removes the card out from under us.
    if (!result.ok) {
      closeDelete(card);
      setMsg(els['admin-msg'], explainAdmin(result), 'error');
    }
  });
}

/* -------------------------------------------------------------- card render */

function updateCard(card, account, lock) {
  card.account = account;
  card.lock = lock || null;

  const { els } = card;

  els.label.textContent = account.label;
  els.description.textContent = account.description;
  els.description.hidden = !account.description;

  const held = isHeld(lock);
  const status = held ? 'held' : 'free';

  // Clear stale inline messages whenever this account actually changes hands.
  // Going overdue is not a change of hands, so it must not wipe a message.
  if (status !== card.lastStatus) {
    setMsg(els['claim-msg'], '');
    setMsg(els['held-msg'], '');
    card.lastStatus = status;
  }

  card.root.dataset.state = held && isOverdue(lock) ? 'overdue' : status;
  card.root.dataset.stale = String(!state.connected && state.everConnected);

  els['view-free'].hidden = held;
  els['view-held'].hidden = !held;

  if (held) renderHeld(card);
  else renderFree(card);

  renderRoster(card, account);

  els.admin.hidden = !state.identity.isAdmin;
  if (!state.identity.isAdmin) {
    closeRename(card);
    closeDelete(card);
  }
}

function renderFree(card) {
  // Prefilling the saved name is what makes claiming one click for a returning
  // user. Never overwrite something they are in the middle of typing.
  if (!card.els.name.value) card.els.name.value = savedName();
  syncClaimButton(card);
}

function renderHeld(card) {
  const { els } = card;
  els.holder.textContent = card.lock.holder;

  els['held-note'].textContent = card.lock.note || '';
  els['held-note'].hidden = !card.lock.note;

  // Release is for the person who holds it. Everyone else gets Force release.
  els['release-btn'].hidden = !savedName() || card.lock.holder !== savedName();

  renderHeldMeta(card);
}

// Split out from renderHeld because the ticking timer re-runs only this part.
function renderHeldMeta(card) {
  const lock = card.lock;
  if (!isHeld(lock) || typeof lock.claimedAt !== 'number') {
    card.els['held-meta'].textContent = '';
    return;
  }

  const overdue = isOverdue(lock);

  // Held and overdue are both red surfaces now, so the word has to carry the
  // difference. In v1 red-vs-amber did that on its own.
  card.els['held-word'].textContent = overdue ? 'Overdue' : 'In use';

  const parts = [`Since ${formatTimeOfDay(lock.claimedAt)}`];

  if (overdue) {
    parts.push(`held ${formatDuration(serverNow() - lock.claimedAt)} — still in use?`);
  } else {
    parts.push(`${formatElapsed(serverNow() - lock.claimedAt)} elapsed`);
    if (typeof lock.expectedMinutes === 'number') {
      const due = lock.claimedAt + lock.expectedMinutes * 60000;
      parts.push(`est. free by ${formatTimeOfDay(due)}`);
    }
  }

  card.els['held-meta'].textContent = parts.join(' · ');
}

/* --------------------------------------------------------- add-account card */

function buildAddCard() {
  const root = el('add-template').content.firstElementChild.cloneNode(true);
  const els = {};
  for (const node of root.querySelectorAll('[data-el]')) els[node.dataset.el] = node;

  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMsg(els['add-msg'], '');

    const label = els['add-label'].value.trim();
    const description = els['add-desc'].value.trim();

    if (!label) {
      setMsg(els['add-msg'], 'Give the account a name.', 'error');
      els['add-label'].focus();
      return;
    }

    const result = await whileBusy(els['add-btn'], 'Adding…', () =>
      createAccount(db, { label, description })
    );

    if (result.ok) {
      els['add-label'].value = '';
      els['add-desc'].value = '';
      setMsg(els['add-msg'], `Added ${label}.`, 'info');
      els['add-label'].focus();
      return;
    }
    setMsg(els['add-msg'], explainAdmin(result), 'error');
  });

  return { root, els };
}

/* ------------------------------------------------------------- board render */

function renderBoard() {
  const board = el('board');
  const seen = new Set();

  for (const account of state.accounts) {
    seen.add(account.id);
    let card = cards.get(account.id);
    if (!card) {
      card = buildCard(account.id);
      cards.set(account.id, card);
      board.append(card.root);
    }
    updateCard(card, account, state.locks[account.id]);
  }

  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    card.root.remove();
    cards.delete(id);
  }

  syncAddCard(board);
  syncOrder(board);
  renderEmptyState();
  updateTitle();
}

function syncAddCard(board) {
  if (state.identity.isAdmin && !addCard) {
    addCard = buildAddCard();
    board.append(addCard.root);
  } else if (!state.identity.isAdmin && addCard) {
    addCard.root.remove();
    addCard = null;
  }
}

// Moving a node blurs whatever is focused inside it, so the DOM is only
// touched when the order is genuinely wrong — which, since cards are appended
// in sorted order as they are created, is close to never.
function syncOrder(board) {
  const wanted = state.accounts.map((account) => cards.get(account.id).root);
  if (addCard) wanted.push(addCard.root);

  const current = Array.from(board.children);
  if (current.length === wanted.length && current.every((node, i) => node === wanted[i])) return;

  board.append(...wanted);
}

function renderEmptyState() {
  const node = el('board-empty');

  // "Not loaded yet" and "genuinely empty" must not look the same — one of them
  // tells the owner to go and create something.
  if (!state.accountsLoaded) {
    node.textContent = 'Loading…';
    node.hidden = false;
    return;
  }

  if (state.accounts.length) {
    node.hidden = true;
    return;
  }

  node.textContent = state.identity.isAdmin
    ? 'No accounts yet — add the first one above.'
    : 'No accounts have been set up on this board yet.';
  node.hidden = false;
}

// The tab title is the board for anyone who keeps it pinned, so it carries the
// status rather than a fixed app name.
function updateTitle() {
  const total = state.accounts.length;
  if (!total) {
    document.title = 'Account board';
    return;
  }

  const free = state.accounts.filter((account) => !isHeld(state.locks[account.id])).length;
  document.title = free
    ? `○ ${free} of ${total} free — Account board`
    : `● All ${total} in use — Account board`;
}

/* -------------------------------------------------------------- identity */

function renderIdentity() {
  const who = el('who');
  if (!state.identity.email) {
    who.hidden = true;
    return;
  }
  // The manual toggle has no email to show, so its label already says "owner
  // mode" on its own — appending "· owner" to that just stutters.
  const named = state.identity.source === 'access';
  who.textContent = state.identity.isAdmin && named
    ? `${state.identity.email} · owner`
    : state.identity.email;
  who.dataset.admin = String(state.identity.isAdmin);
  who.hidden = false;
}

/* -------------------------------------------------------- activity log */

// Names and reasons are free text typed by colleagues, so every line is built
// with textContent. Nothing here touches innerHTML.
function describe(entry) {
  const name = entry.name || 'Someone';
  // v1 entries predate multiple accounts and carry no label.
  const target = entry.accountLabel ? `${entry.accountLabel}` : 'the account';

  switch (entry.action) {
    case 'claimed':
      return `${name} claimed ${target}`;
    case 'released':
      return `${name} released ${target}`;
    case 'force-released': {
      const who = entry.heldBy ? ` (held by ${entry.heldBy})` : '';
      const why = entry.reason ? ` — “${entry.reason}”` : '';
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
  const stale = String(!connected && state.everConnected);
  for (const card of cards.values()) card.root.dataset.stale = stale;
}

/* ------------------------------------------------------------------ tick */

// The network carries one number — claimedAt — and the browser does the
// ticking. Recomputing locally every second means no polling, and the value
// survives a reload because it was never held in a counter.
function tick() {
  for (const card of cards.values()) {
    if (!isHeld(card.lock)) continue;
    card.root.dataset.state = isOverdue(card.lock) ? 'overdue' : 'held';
    renderHeldMeta(card);
  }
}

/* ---------------------------------------------------------------- startup */

// A config object that still has placeholder values would fail deep inside the
// SDK with an unhelpful error. Catch it here and say what to do instead.
function configLooksReal(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId);
}

async function start() {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);

  // Started before sign-in so the two round trips overlap; awaited after, so a
  // sign-in failure still reports itself first.
  const identityPromise = loadIdentity();

  // Anonymous auth is not about identifying people — it exists so the database
  // rules can require `auth != null` and shut out internet scanners. Who the
  // reader *is* comes from Cloudflare Access, in identity.js.
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

  state.identity = await identityPromise;
  renderIdentity();

  // Draw once before any snapshot arrives. Every other renderBoard() call is
  // driven by a listener, so without this the page stays blank until the first
  // one fires — and stays blank forever if the read is refused.
  renderBoard();

  initClock(db);
  setInterval(tick, 1000);

  onValue(ref(db, '.info/connected'), (snap) => setConnected(snap.val() === true));

  // onValue fires immediately with the current value, then again on every
  // change — the first callback is not a change event.
  onValue(
    ref(db, 'accounts'),
    (snap) => {
      state.accounts = readAccounts(snap);
      state.accountsLoaded = true;
      renderBoard();
    },
    (err) => showBanner(
      'Cannot read the board',
      `${err.message} — check the Realtime Database rules have been published.`
    )
  );

  onValue(
    ref(db, 'locks'),
    (snap) => {
      state.locks = snap.val() || {};
      renderBoard();
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
    if (document.visibilityState === 'visible') refresh();
  });
}

async function refresh() {
  try {
    const [accountsSnap, locksSnap, logSnap] = await Promise.all([
      get(ref(db, 'accounts')),
      get(ref(db, 'locks')),
      get(query(ref(db, 'log'), limitToLast(LOG_LIMIT))),
    ]);
    state.accounts = readAccounts(accountsSnap);
    state.accountsLoaded = true;
    state.locks = locksSnap.val() || {};
    state.log = readLog(logSnap);
    renderBoard();
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
