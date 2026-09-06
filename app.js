// The board: wiring, rendering and event handlers.
//
// Firebase is imported from the CDN as ES modules — no npm, no build step.
// The version is pinned deliberately; do not switch to a floating tag.
// Startup itself lives in boot.js, which the activity page shares.
import { ref, onValue, get } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { initClock, serverNow, formatElapsed, formatDuration, formatTimeOfDay, formatCountdown }
  from './clock.js';
import { claim, release, forceRelease, sameIdentity, SESSION_ALERT_AFTER_MS } from './lock.js';
import { joinQueue, leaveQueue, dropTimedOut, computeReservations } from './queue.js';
import { createAccount, renameAccount, deleteAccount } from './accounts.js';
import { loadIdentity } from './identity.js';
import { connect, showBanner, watchConnection, renderWho } from './boot.js';
import { initTheme } from './theme.js';
import { initKineticGrid } from './grid.js';
import { initCardFx } from './cardfx.js';

const el = (id) => document.getElementById(id);

const NAME_KEY = 'account-board:name';
// What an empty minutes field means. Deliberately the same 2.5 hours as
// lock.js's SESSION_ALERT_AFTER_MS, so somebody who does not fill it in goes
// overdue at the same moment the board asks them to wrap up, rather than
// carrying a red card around for two hours before it.
const DEFAULT_MINUTES = 150;

// Below this the cards already are the summary, and a strip saying "1 of 1
// available" above a single card is just the card again in smaller type.
const SUMMARY_MIN_ACCOUNTS = 2;

// How many ghost cards to show while the first snapshot is in flight. Three
// fills a desktop row without promising a number the board may not have.
const SKELETON_CARDS = 3;

// How long to wait before trying again to remove a queue entry whose seven
// minutes ran out. There is no server here, so whichever browsers have the
// board open are what does this — see sweepTimeouts.
const SWEEP_RETRY_MS = 30000;

// Set once in start(). Handlers are wired per card and would otherwise all have
// to close over it.
let db = null;

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  accounts: [],
  accountsLoaded: false,
  locks: {},
  // The whole board's queue, in join order. One line, not one per account.
  queue: [],
  // Derived from the three above on every render and every tick — never read
  // from the database, never written to it. See computeReservations.
  reservations: { byAccount: new Map(), byEntryId: new Map() },
  identity: { email: '', name: '', isAdmin: false, source: 'none' },
  connected: false,
  everConnected: false,
};

// accountId -> card object. Cards are kept and updated in place rather than
// rebuilt, so a lock change on one account cannot wipe what somebody is
// halfway through typing into another.
const cards = new Map();
let addCard = null;
let skeletons = [];

// entryId -> row object, for the same reason: the queue's countdowns move every
// second and rebuilding the list that often would blow away anybody's focus.
const queueRows = new Map();
let queueSignature = '';

// entryId -> when this tab last tried to remove it. Only to stop every open tab
// hammering the same delete once a second while the write is in flight.
const sweeps = new Map();

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
  'not-holder': 'The board says someone else holds it now. Use Force release.',
  'already-free': 'It was already free.',
  'no-reason': 'Type a reason first.',
  reserved: 'Somebody in the queue has first refusal on this one for a few more minutes.',
  invalid: 'Check the name (1 to 40 characters) and the minutes (1 to 480).',
  error: 'That write was rejected. Check the length of what you typed, then try again.',
};

const ADMIN_MESSAGES = {
  invalid: 'Check the account name (1 to 60 characters) and description (up to 120).',
  error: 'That write was rejected. Try again.',
};

const QUEUE_MESSAGES = {
  'already-queued': 'You are already in the queue.',
  invalid: 'Check the name (1 to 40 characters).',
  error: 'That write was rejected. Try again.',
};

function explain(result, table = MESSAGES) {
  if (result.reason === 'error' && result.error) console.error('[board] write failed', result.error);
  // The stock message points at Force release, which only admins can even
  // see now — don't send everyone else looking for a button that isn't there.
  if (result.reason === 'not-holder' && table === MESSAGES && !state.identity.isAdmin) {
    return 'The board says someone else holds it now.';
  }
  return table[result.reason] || 'That did not work. Try again.';
}

const explainAdmin = (result) => explain(result, ADMIN_MESSAGES);
const explainQueue = (result) => explain(result, QUEUE_MESSAGES);

/* ------------------------------------------------------------ lock state */

const isHeld = (lock) => Boolean(lock) && lock.status === 'held' && Boolean(lock.holder);

// Overdue is purely visual. Nothing auto-releases and nothing is blocked — it
// just makes a forgotten release legible to the room.
function isOverdue(lock) {
  if (!isHeld(lock)) return false;
  if (typeof lock.claimedAt !== 'number' || typeof lock.expectedMinutes !== 'number') return false;
  return serverNow() > lock.claimedAt + lock.expectedMinutes * 60000;
}

// Who the board thinks is reading it: the Access email where there is one, and
// the name typed into this browser otherwise. Every "is this mine?" question on
// the page goes through lock.js's sameIdentity with this on one side, so the
// release button, the queue and the reservation all answer it identically.
const me = () => ({ name: savedName(), email: state.identity.email });

function isMineLock(lock) {
  if (!isHeld(lock)) return false;
  return sameIdentity({ name: lock.holder, email: lock.email }, me());
}

const entryIsMine = (entry) => sameIdentity(entry, me());

// The account this card is being held open for, if that offer is still live.
// An expired one is deliberately not returned: the account is claimable by
// anyone again the moment the seven minutes are up, whether or not the entry
// behind it has been swept yet.
function activeReservation(accountId) {
  const reservation = state.reservations.byAccount.get(accountId);
  return reservation && !reservation.expired ? reservation : null;
}

/* ----------------------------------------------------------- reading data */

// Push keys sort chronologically as strings, so the queue reads out in join
// order — which, since there is one queue for the whole board, is also the
// priority order. No separate rank field, and nothing to renumber when
// somebody leaves from the middle.
//
// `joinedAt` is required as well as `name` because the queue used to be nested
// one level deeper, under an account id. Any of those left in the database read
// back here as a node with neither field and are dropped rather than shown as a
// nameless line. See context.md.
function readQueue(node) {
  if (!node || typeof node !== 'object') return [];

  return Object.entries(node)
    .map(([id, val]) => ({
      id,
      name: typeof val?.name === 'string' ? val.name.trim() : '',
      email: typeof val?.email === 'string' ? val.email.trim() : '',
      joinedAt: typeof val?.joinedAt === 'number' ? val.joinedAt : 0,
    }))
    .filter((entry) => entry.name && entry.joinedAt)
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
    });
  });

  // Oldest first, so the board does not reshuffle itself as accounts are added.
  list.sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label));
  return list;
}

/* ----------------------------------------------------------------- motion */

// The entrance is filled `both`, so the card keeps the animation's final
// transform after it has run — which would then beat the hover lift, because a
// filled animation outranks a plain declaration. Dropping the class once it is
// done hands the card back to CSS.
//
// The target check matters: animationend bubbles, and everything inside a card
// that fades in would otherwise strip the class mid-flight.
function playEntrance(root, index) {
  root.style.setProperty('--i', String(index));
  root.classList.add('card-enter');

  root.addEventListener('animationend', function done(event) {
    if (event.target !== root) return;
    root.classList.remove('card-enter');
    root.removeEventListener('animationend', done);
  });
}

// Restarting a CSS animation needs the class gone for one frame. Reading
// offsetWidth is what forces that reflow, so the read is the point and not a
// leftover — it must not be tidied away.
function flash(root) {
  root.classList.remove('card-changed');
  void root.offsetWidth;
  root.classList.add('card-changed');
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
    // An empty duration field means "the usual", not an error. It is optional,
    // so that is the common case rather than the exception.
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

    // Read at submit time rather than from whatever the card was last drawn
    // with: a reservation can start or expire while somebody sits with the
    // form open.
    const reservation = activeReservation(card.id);

    const result = await whileBusy(els['claim-btn'], 'Claiming…', () =>
      claim(db, account, {
        holder,
        email: state.identity.email,
        expectedMinutes,
        reservedFor: reservation ? reservation.entry : null,
      })
    );
    syncClaimButton(card);

    if (result.ok) {
      // Best-effort: a claimer who was waiting in the queue no longer needs to
      // be, whether or not this was the account reserved for them. Silent,
      // because the claim itself is already the log line that matters — a
      // "left the queue" line right next to it would just be noise.
      const mine = state.queue.find(entryIsMine);
      if (mine) leaveQueue(db, mine.id, { name: mine.name, email: mine.email, silent: true });
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
      release(db, card.account, { holder: savedName(), email: state.identity.email })
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

    // lock.js prefers the email and falls back to the typed name, so the only
    // thing to check here is that at least one of them exists.
    const typed = els['force-who'].value.trim();
    const by = savedName() || typed;

    if (!by && !state.identity.email) {
      // Only reachable with no Access identity — i.e. running locally.
      setMsg(els['held-msg'], 'Force release records who did it, so the board needs your name.', 'error');
      els['force-who'].focus();
      return;
    }

    if (typed && !state.identity.email) saveName(typed);

    const result = await whileBusy(els['force-btn'], 'Releasing…', () =>
      forceRelease(db, card.account, {
        by,
        email: state.identity.email,
        reason,
        heldBy: card.lock?.holder,
      })
    );

    if (result.ok) {
      els['force-reason'].value = '';
      els['force-who'].value = '';
      els['force-btn'].disabled = true;
      return;
    }
    setMsg(els['held-msg'], explain(result), 'error');
  });

  wireCardAdmin(card);
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
      ? `${holder} is holding this right now, and deleting it will not tell them. The activity log keeps its history either way.`
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
    // An account changing hands is the one event this page exists to report,
    // and it can land while the reader is looking at a different card. Not on
    // the very first render, though: a board that flashes every card on load
    // teaches people to ignore the flash that means something.
    if (card.lastStatus !== null) flash(card.root);
    card.lastStatus = status;
  }

  card.root.dataset.state = held && isOverdue(lock) ? 'overdue' : status;
  card.root.dataset.stale = String(!state.connected && state.everConnected);

  els['view-free'].hidden = held;
  els['view-held'].hidden = !held;

  if (held) renderHeld(card);
  else renderFree(card);

  renderBadge(card);

  els.admin.hidden = !state.identity.isAdmin;
  if (!state.identity.isAdmin) {
    closeRename(card);
    closeDelete(card);
  }
}

// The one thing about a card worth knowing before reading any of it. Only ever
// a reservation now — "who is waiting" moved to the board's own queue panel,
// where a single line for the whole board belongs.
function renderBadge(card) {
  // No held check needed: computeReservations never offers a held account, so
  // this is empty for exactly the cards that should not carry it.
  const reservation = activeReservation(card.id);
  const badge = card.els['card-badge'];

  badge.hidden = !reservation;
  if (!reservation) {
    badge.textContent = '';
    return;
  }
  badge.textContent = entryIsMine(reservation.entry) ? 'Your turn' : 'Reserved';
}

function renderFree(card) {
  const { els } = card;
  const reservation = activeReservation(card.id);
  const mine = Boolean(reservation) && entryIsMine(reservation.entry);

  els.reserved.hidden = !reservation;
  els['free-sub'].hidden = Boolean(reservation);

  // Whoever it is reserved for still gets the form — for everyone else it is
  // not there to click. lock.js refuses the write either way; this is what
  // stops anyone having to find that out by being told no.
  els['claim-form'].hidden = Boolean(reservation) && !mine;

  if (reservation) {
    const left = formatCountdown(reservation.expiresAt - serverNow());
    card.root.dataset.reserved = mine ? 'mine' : 'other';

    if (mine) {
      els['reserved-word'].textContent = `Your turn — ${left} left`;
      els['reserved-sub'].textContent =
        'Claim it now. If the time runs out it goes to the next person and you lose your place in the queue.';
    } else {
      els['reserved-word'].textContent = `Reserved for ${reservation.entry.name} — ${left} left`;
      els['reserved-sub'].textContent = reservation.entry.email
        || 'First in the queue when this came free.';
    }
  } else {
    delete card.root.dataset.reserved;
  }

  // Prefilling the saved name is what makes claiming one click for a returning
  // user. Once per card: this now runs on every tick, and refilling a field
  // somebody has deliberately cleared once a second is its own small hell.
  if (!card.prefilled) {
    if (!els.name.value) els.name.value = savedName();
    card.prefilled = true;
  }
  syncClaimButton(card);
}

function renderHeld(card) {
  const { els } = card;
  els.holder.textContent = card.lock.holder;

  els['held-note'].textContent = card.lock.note || '';
  els['held-note'].hidden = !card.lock.note;

  // Release is for the person who holds it. Force release is an admin-only
  // override for everyone else's stuck accounts.
  els['release-btn'].hidden = !isMineLock(card.lock);
  els['force-form'].hidden = !state.identity.isAdmin;

  // Access already knows who this is, so there is nothing to ask and nothing to
  // get wrong. The name is only asked of an unrecognised visitor — in practice
  // that means local development.
  const verified = state.identity.email;
  els['force-who-field'].hidden = Boolean(verified) || Boolean(savedName());
  els['force-as'].textContent = verified ? `Recorded as ${verified}` : '';
  els['force-as'].hidden = !verified;

  renderHeldMeta(card);
  renderHeldAlerts(card);
}

// The two things the board says to a holder and to nobody else: that they have
// had this a long time, and that people are waiting. Both only on their own
// card — a nudge on somebody else's card is just noise to the person reading
// it, since they cannot act on it.
function renderHeldAlerts(card) {
  const { els } = card;
  const lock = card.lock;
  const mine = isMineLock(lock);

  const long = mine
    && typeof lock.claimedAt === 'number'
    && serverNow() - lock.claimedAt >= SESSION_ALERT_AFTER_MS;

  els['session-alert'].hidden = !long;
  els['session-alert'].textContent = long
    ? `You have had this for ${formatDuration(serverNow() - lock.claimedAt)}. Please finish up and release it.`
    : '';

  const waiting = state.queue.length;
  const nudge = mine && waiting > 0;

  els['queue-alert'].hidden = !nudge;
  els['queue-alert'].textContent = nudge
    ? `${waiting} ${waiting === 1 ? 'person is' : 'people are'} in the queue — please release when you can.`
    : '';

  els['card-alerts'].hidden = !long && !nudge;
}

/* -------------------------------------------------------------- the queue */

// One line for the whole board, above the cards. Everyone in it, in order,
// with their name and the email Access authenticated — a queue whose order is
// visible is the only kind that settles an argument.
function renderQueuePanel() {
  const panel = el('queue-panel');

  // Nothing to be next in line for until the board itself has arrived.
  if (!state.accountsLoaded) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const queue = state.queue;
  el('queue-count').textContent = queue.length ? ` (${queue.length})` : '';
  el('queue-empty').hidden = queue.length > 0;

  syncQueueRows(queue);

  const mine = queue.find(entryIsMine) || null;
  el('queue-leave-btn').hidden = !mine;
  el('queue-join-btn').hidden = Boolean(mine);

  // Access already knows who this is, so there is nothing to ask and nothing to
  // get wrong. The name is only asked of an unrecognised visitor — in practice
  // that means local development. Same rule as force release's who-field.
  el('queue-who-field').hidden =
    Boolean(mine) || Boolean(state.identity.email) || Boolean(savedName());
}

// The list is rebuilt only when its membership or order actually changes;
// everything that moves on the clock is written into the existing nodes. A
// queue redrawn from scratch once a second cannot be tabbed through.
function syncQueueRows(queue) {
  const signature = queue.map((entry) => entry.id).join(',');

  if (signature !== queueSignature) {
    queueSignature = signature;
    queueRows.clear();

    const list = el('queue-list');
    list.textContent = '';

    for (const entry of queue) {
      const row = buildQueueRow(entry);
      queueRows.set(entry.id, row);
      list.append(row.li);
    }
  }

  queue.forEach((entry, index) => updateQueueRow(queueRows.get(entry.id), entry, index));
}

function buildQueueRow(entry) {
  const li = el('queue-row-template').content.firstElementChild.cloneNode(true);
  const els = {};
  for (const node of li.querySelectorAll('[data-el]')) els[node.dataset.el] = node;

  // Names and emails are free text typed by colleagues; textContent throughout.
  els.name.textContent = entry.name;
  els.email.textContent = entry.email;
  els.email.hidden = !entry.email;

  els.remove.setAttribute('aria-label', `Remove ${entry.name} from the queue`);
  els.remove.addEventListener('click', async () => {
    setMsg(el('queue-msg'), '');
    const result = await leaveQueue(db, entry.id, { name: entry.name, email: entry.email });
    if (!result.ok) setMsg(el('queue-msg'), explainQueue(result), 'error');
  });

  return { li, els };
}

function updateQueueRow(row, entry, index) {
  if (!row) return;
  const { els } = row;

  els.pos.textContent = String(index + 1);

  const reservation = state.reservations.byEntryId.get(entry.id);
  const offered = Boolean(reservation) && !reservation.expired;

  // While somebody is being offered an account, how long they have left is the
  // only thing about their line worth reading.
  els.turn.hidden = !offered;
  els.turn.textContent = offered
    ? `${reservation.accountLabel} · ${formatCountdown(reservation.expiresAt - serverNow())} to claim`
    : '';

  els.wait.hidden = offered;
  els.wait.textContent = `waiting ${formatDuration(serverNow() - entry.joinedAt)}`;

  // Anyone can give up their own place; an admin can also clear somebody else's.
  els.remove.hidden = !(state.identity.isAdmin || entryIsMine(entry));

  row.li.dataset.mine = String(entryIsMine(entry));
  row.li.dataset.turn = String(offered);
}

function wireQueuePanel() {
  el('queue-join-btn').addEventListener('click', async () => {
    setMsg(el('queue-msg'), '');

    const typed = el('queue-who').value.trim();
    const name = savedName() || typed;

    if (!name) {
      setMsg(el('queue-msg'), 'Type your name first.', 'error');
      el('queue-who').focus();
      return;
    }

    if (typed && !savedName()) saveName(typed);

    const result = await whileBusy(el('queue-join-btn'), 'Joining…', () =>
      joinQueue(db, { name, email: state.identity.email })
    );
    if (!result.ok) setMsg(el('queue-msg'), explainQueue(result), 'error');
  });

  el('queue-leave-btn').addEventListener('click', async () => {
    setMsg(el('queue-msg'), '');
    const mine = state.queue.find(entryIsMine);
    if (!mine) return;

    const result = await whileBusy(el('queue-leave-btn'), 'Leaving…', () =>
      leaveQueue(db, mine.id, { name: mine.name, email: mine.email })
    );
    if (!result.ok) setMsg(el('queue-msg'), explainQueue(result), 'error');
  });
}

// Nobody's seven minutes can expire on the server, because there is no server
// here — so whichever browsers have the board open are what enforces it. The
// delete is a transaction, so several tabs noticing at once is harmless: one
// commits, the rest read null and abort. This tab's own retry gate only stops
// it firing the same write once a second while the first is still in flight.
function sweepTimeouts() {
  if (!db) return;
  const now = serverNow();

  for (const reservation of state.reservations.byEntryId.values()) {
    if (!reservation.expired) continue;

    const { entry } = reservation;
    if (now - (sweeps.get(entry.id) || 0) < SWEEP_RETRY_MS) continue;
    sweeps.set(entry.id, now);

    dropTimedOut(db, entry.id, {
      name: entry.name,
      email: entry.email,
      accountId: reservation.accountId,
      accountLabel: reservation.accountLabel,
    }).catch((err) => console.warn('[board] could not drop a timed-out queue entry', err));
  }

  // An entry with no reservation against it cannot time out, so there is
  // nothing left to remember about it.
  for (const id of sweeps.keys()) {
    if (!state.reservations.byEntryId.has(id)) sweeps.delete(id);
  }
}

// How much of the claimed time has gone, as a bar. Nothing here is information
// held-meta does not already spell out — it is for the glance from across the
// room, which is why the markup is aria-hidden.
function renderTimebar(card) {
  const lock = card.lock;
  const bar = card.els.timebar;

  // No estimate, no bar. An empty track would imply a deadline nobody set.
  const expected = typeof lock?.expectedMinutes === 'number' ? lock.expectedMinutes : 0;
  if (!expected || typeof lock.claimedAt !== 'number') {
    bar.hidden = true;
    return;
  }

  const ratio = (serverNow() - lock.claimedAt) / (expected * 60000);
  bar.hidden = false;
  card.els['timebar-fill'].style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

// Split out from renderHeld because the ticking timer re-runs only this part.
function renderHeldMeta(card) {
  const lock = card.lock;
  if (!isHeld(lock) || typeof lock.claimedAt !== 'number') {
    card.els['held-meta'].textContent = '';
    card.els.timebar.hidden = true;
    return;
  }

  const overdue = isOverdue(lock);

  // Held and overdue are both red surfaces now, so the word has to carry the
  // difference. In v1 red-vs-amber did that on its own.
  card.els['held-word'].textContent = overdue ? 'Overdue' : 'In use';

  const parts = [`Since ${formatTimeOfDay(lock.claimedAt)}`];

  if (overdue) {
    parts.push(`held ${formatDuration(serverNow() - lock.claimedAt)}, still in use?`);
  } else {
    parts.push(`${formatElapsed(serverNow() - lock.claimedAt)} elapsed`);
    if (typeof lock.expectedMinutes === 'number') {
      const due = lock.claimedAt + lock.expectedMinutes * 60000;
      parts.push(`est. free by ${formatTimeOfDay(due)}`);
    }
  }

  card.els['held-meta'].textContent = parts.join(' · ');
  renderTimebar(card);
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

// Reservations are a function of the accounts, the locks, the queue and the
// clock, so they are recomputed rather than stored — every client works out the
// same answer, and there is no third snapshot that can be stale. Called from
// the one place every render starts, and again on every tick.
function recomputeReservations() {
  state.reservations = computeReservations(state.accounts, state.locks, state.queue);
}

function renderBoard() {
  const board = el('board');
  const seen = new Set();

  recomputeReservations();
  syncSkeleton();

  // Counted separately from the loop index so the stagger is over the cards
  // that are actually new. On the first load that is all of them; on the
  // hundredth it is the one account somebody just added, which should arrive
  // immediately rather than after five slots of empty delay.
  let fresh = 0;

  for (const account of state.accounts) {
    seen.add(account.id);
    let card = cards.get(account.id);
    if (!card) {
      card = buildCard(account.id);
      cards.set(account.id, card);
      board.append(card.root);
      playEntrance(card.root, fresh);
      fresh += 1;
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
  renderQueuePanel();
  renderSummary();
  renderEmptyState();
  sweepTimeouts();
}

// Card-shaped ghosts for as long as there is no board to show yet. They are not
// tracked per id like real cards because there is nothing to track: they go up
// once and come down once.
function showSkeleton() {
  if (skeletons.length) return;
  const board = el('board');
  const template = el('skeleton-template');

  for (let i = 0; i < SKELETON_CARDS; i += 1) {
    const node = template.content.firstElementChild.cloneNode(true);
    skeletons.push(node);
    board.append(node);
  }
}

function clearSkeleton() {
  for (const node of skeletons) node.remove();
  skeletons = [];
}

const syncSkeleton = () => (state.accountsLoaded ? clearSkeleton() : showSkeleton());

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
  const wanted = skeletons.concat(state.accounts.map((account) => cards.get(account.id).root));
  if (addCard) wanted.push(addCard.root);

  const current = Array.from(board.children);
  if (current.length === wanted.length && current.every((node, i) => node === wanted[i])) return;

  board.append(...wanted);
}

// One line for the whole board, above it: how many accounts you could walk up
// to right now. The cards answer that one at a time; this answers it before
// any of them have been read.
function renderSummary() {
  const node = el('summary');
  const total = state.accounts.length;

  if (!state.accountsLoaded || total < SUMMARY_MIN_ACCOUNTS) {
    node.hidden = true;
    return;
  }

  let held = 0;
  let overdue = 0;

  for (const account of state.accounts) {
    const lock = state.locks[account.id];
    if (!isHeld(lock)) continue;
    if (isOverdue(lock)) overdue += 1;
    else held += 1;
  }

  const free = total - held - overdue;

  node.hidden = false;
  // Nothing free is the one state worth colouring, and it gets the same red
  // that means "in use" on every card.
  node.dataset.full = String(free === 0);

  el('summary-count').textContent = String(free);
  el('summary-of').textContent = `of ${total} accounts free`;

  el('legend-free').textContent = String(free);
  el('legend-held').textContent = String(held);
  el('legend-overdue').textContent = String(overdue);
  // A permanent "Overdue 0" is a legend entry for a colour that is not on the
  // page. It appears when there is something to explain.
  el('legend-overdue-item').hidden = overdue === 0;

  const counts = { free, held, overdue };
  for (const seg of el('meter').children) {
    seg.style.width = `${(counts[seg.dataset.kind] / total) * 100}%`;
  }
}

function renderEmptyState() {
  const node = el('board-empty');

  // "Not loaded yet" and "genuinely empty" must not look the same — one of them
  // tells the owner to go and create something. The skeleton cards are now what
  // says "not loaded yet", so there is nothing to add in words.
  if (!state.accountsLoaded) {
    node.hidden = true;
    return;
  }

  if (state.accounts.length) {
    node.hidden = true;
    return;
  }

  node.textContent = state.identity.isAdmin
    ? 'No accounts yet. Add the first one above.'
    : 'No accounts have been set up on this board yet.';
  node.hidden = false;
}

/* ------------------------------------------------------------ connection */

// A frozen page showing "Available" is worse than no board at all, so a stale
// reading has to look stale. boot.js owns the indicator itself; this is the
// board's own reaction to it.
function setConnected(connected, everConnected) {
  state.connected = connected;
  state.everConnected = everConnected;

  const stale = String(!connected && everConnected);
  for (const card of cards.values()) card.root.dataset.stale = stale;
}

/* ------------------------------------------------------------------ tick */

// The network carries one number — claimedAt — and the browser does the
// ticking. Recomputing locally every second means no polling, and the value
// survives a reload because it was never held in a counter.
function tick() {
  // A reservation both starts and ends on the clock alone: no snapshot arrives
  // to say that somebody's seven minutes are up.
  recomputeReservations();

  for (const card of cards.values()) {
    if (isHeld(card.lock)) {
      card.root.dataset.state = isOverdue(card.lock) ? 'overdue' : 'held';
      renderHeldMeta(card);
      renderHeldAlerts(card);
    } else {
      renderFree(card);
    }
    renderBadge(card);
  }

  renderQueuePanel();

  // Going overdue moves a card from one column of the meter to another, and no
  // snapshot arrives to say so — the clock is the only thing that changed.
  renderSummary();

  sweepTimeouts();
}

/* ---------------------------------------------------------------- startup */

async function start() {
  // First, and before any await: neither of these needs Firebase, and both have
  // to work on a page that never reached it.
  initTheme();
  initKineticGrid();

  // Delegated on the board, so it is wired once and covers every card this page
  // will ever build — including the ones that do not exist yet.
  initCardFx();

  // Also before the awaits. The wait a reader actually sits through is the
  // sign-in round trip, not the snapshot that follows it, so a board that only
  // starts looking busy after sign-in has missed the part worth covering.
  showSkeleton();

  // Started before sign-in so the two round trips overlap; awaited after, so a
  // sign-in failure still reports itself first.
  const identityPromise = loadIdentity();

  db = await connect();
  if (!db) {
    // boot.js has already said why on the page. Ghosts of a board that is not
    // going to arrive would be promising a second thing that never happens.
    clearSkeleton();
    return;
  }

  state.identity = await identityPromise;
  renderWho(state.identity);

  // The activity page is the owner's, so its link is too.
  el('nav').hidden = !state.identity.isAdmin;

  // Wired once, before the first render: the panel's controls are page-level
  // ids rather than per-card, so there is nothing to re-wire later.
  wireQueuePanel();

  // Draw once before any snapshot arrives. Every other renderBoard() call is
  // driven by a listener, so without this the page stays blank until the first
  // one fires — and stays blank forever if the read is refused.
  renderBoard();

  initClock(db);
  setInterval(tick, 1000);

  watchConnection(db, setConnected);

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
      `${err.message}. Check that the Realtime Database rules have been published.`
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
      `${err.message}. Check that the Realtime Database rules have been published.`
    )
  );

  onValue(
    ref(db, 'queue'),
    (snap) => {
      state.queue = readQueue(snap.val());
      renderBoard();
    },
    (err) => showBanner(
      'Cannot read the board',
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
    const [accountsSnap, locksSnap, queueSnap] = await Promise.all([
      get(ref(db, 'accounts')),
      get(ref(db, 'locks')),
      get(ref(db, 'queue')),
    ]);
    state.accounts = readAccounts(accountsSnap);
    state.accountsLoaded = true;
    state.locks = locksSnap.val() || {};
    state.queue = readQueue(queueSnap.val());
    renderBoard();
  } catch (err) {
    console.warn('[board] refetch on focus failed', err);
  }
}

start();
