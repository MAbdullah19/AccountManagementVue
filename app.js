// The board: wiring, rendering and event handlers.
//
// Firebase is imported from the CDN as ES modules — no npm, no build step.
// The version is pinned deliberately; do not switch to a floating tag.
// Startup itself lives in boot.js, which the activity page shares.
import { ref, onValue, get } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { initClock, serverNow, formatElapsed, formatDuration, formatTimeOfDay }
  from './clock.js';
import { claim, release, forceRelease } from './lock.js';
import { joinQueue, leaveQueue, canJoinQueue, msUntilQueueable } from './queue.js';
import { createAccount, renameAccount, deleteAccount } from './accounts.js';
import { loadIdentity } from './identity.js';
import { connect, showBanner, watchConnection, renderWho } from './boot.js';
import { initTheme } from './theme.js';
import { initKineticGrid } from './grid.js';
import { initCardFx } from './cardfx.js';

const el = (id) => document.getElementById(id);

const NAME_KEY = 'account-board:name';
const DEFAULT_MINUTES = 30;

// Below this the cards already are the summary, and a strip saying "1 of 1
// available" above a single card is just the card again in smaller type.
const SUMMARY_MIN_ACCOUNTS = 2;

// How many ghost cards to show while the first snapshot is in flight. Three
// fills a desktop row without promising a number the board may not have.
const SKELETON_CARDS = 3;

// Set once in start(). Handlers are wired per card and would otherwise all have
// to close over it.
let db = null;

// Everything the UI needs to draw itself. Not a state management layer — just
// the last thing each listener told us.
const state = {
  accounts: [],
  accountsLoaded: false,
  locks: {},
  queues: {},
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
  invalid: 'Check the name (1 to 40 characters) and the minutes (1 to 480).',
  error: 'That write was rejected. Check the length of what you typed, then try again.',
};

const ADMIN_MESSAGES = {
  invalid: 'Check the account name (1 to 60 characters) and description (up to 120).',
  error: 'That write was rejected. Try again.',
};

const QUEUE_MESSAGES = {
  'already-queued': 'You are already in the queue for this one.',
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

// Matched on the email where both sides have one — same rule lock.js uses to
// decide whether a release would be accepted. Shared by the release button
// and the queue view, so "can I release" and "am I the one people are
// waiting on" never drift apart.
function isMineLock(lock) {
  if (!isHeld(lock)) return false;
  return state.identity.email && lock.email
    ? lock.email === state.identity.email
    : Boolean(savedName()) && lock.holder === savedName();
}

// Same identity rule, for a queue entry rather than a lock.
function queueEntryIsMine(entry) {
  return state.identity.email && entry.email
    ? entry.email === state.identity.email
    : Boolean(savedName()) && entry.name === savedName();
}

/* ----------------------------------------------------------- reading data */

// Push keys sort chronologically as strings, so the queue reads out in join
// order (FIFO) with no separate ordering field.
function readQueue(node) {
  if (!node || typeof node !== 'object') return [];

  return Object.entries(node)
    .map(([id, val]) => ({
      id,
      name: typeof val?.name === 'string' ? val.name.trim() : '',
      email: typeof val?.email === 'string' ? val.email.trim() : '',
      joinedAt: typeof val?.joinedAt === 'number' ? val.joinedAt : 0,
    }))
    .filter((entry) => entry.name)
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
    const result = await whileBusy(els['claim-btn'], 'Claiming…', () =>
      claim(db, account, { holder, email: state.identity.email, expectedMinutes })
    );
    syncClaimButton(card);

    if (result.ok) {
      // Best-effort: a claimer who was waiting in the queue for this account
      // no longer needs to be. Silent, because the claim itself is already
      // the log line that matters — a "left the queue" line right next to it
      // would just be noise.
      const mine = (card.queue || []).find((entry) => queueEntryIsMine(entry));
      if (mine) leaveQueue(db, account, mine.id, { name: mine.name, email: mine.email, silent: true });
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

  els['queue-join-btn'].addEventListener('click', async () => {
    setMsg(els['queue-msg'], '');

    // Access already knows who this is. The name field only appears for an
    // unrecognised visitor — in practice, local development — same rule as
    // force release's who-field.
    const typed = els['queue-who'].value.trim();
    const name = savedName() || typed;

    if (!name) {
      setMsg(els['queue-msg'], 'Type your name first.', 'error');
      els['queue-who'].focus();
      return;
    }

    if (typed && !savedName()) saveName(typed);

    const result = await whileBusy(els['queue-join-btn'], 'Joining…', () =>
      joinQueue(db, card.account, { name, email: state.identity.email })
    );
    if (!result.ok) setMsg(els['queue-msg'], explainQueue(result), 'error');
  });

  els['queue-leave-btn'].addEventListener('click', async () => {
    setMsg(els['queue-msg'], '');
    const mine = (card.queue || []).find((entry) => queueEntryIsMine(entry));
    if (!mine) return;

    const result = await whileBusy(els['queue-leave-btn'], 'Leaving…', () =>
      leaveQueue(db, card.account, mine.id, { name: mine.name, email: mine.email })
    );
    if (!result.ok) setMsg(els['queue-msg'], explainQueue(result), 'error');
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

function updateCard(card, account, lock, queueNode) {
  card.account = account;
  card.lock = lock || null;
  card.queue = readQueue(queueNode);

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

  if (held) {
    renderHeld(card);
  } else {
    renderFree(card);
    // The queue only ever renders inside the held view; a card that just
    // went free would otherwise keep showing a stale "N waiting" badge from
    // before it was released.
    els['queue-badge'].hidden = true;
  }

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
  renderQueue(card);
}

// Who is waiting, and — depending on who is looking — either the button to
// join or leave that line, or the nudge to the holder that they should not
// have it much longer. Signal only: nothing here is enforced, and claiming
// stays first-come-first-served the moment the lock actually frees up.
function renderQueue(card) {
  const { els } = card;
  const lock = card.lock;
  const queue = card.queue || [];

  els['queue-badge'].hidden = !queue.length;
  els['queue-badge'].textContent = queue.length ? `${queue.length} waiting` : '';
  els['queue-count'].textContent = queue.length ? ` (${queue.length})` : '';

  const list = els['queue-list'];
  list.textContent = '';

  if (!queue.length) {
    const empty = document.createElement('li');
    empty.className = 'queue-empty';
    empty.textContent = 'Nobody waiting yet.';
    list.append(empty);
  } else {
    for (const entry of queue) {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = entry.name;
      li.append(name);

      const since = document.createElement('span');
      since.className = 'queue-since';
      since.textContent = `waiting ${formatDuration(serverNow() - entry.joinedAt)}`;
      li.append(since);

      // Anyone can leave their own spot; the owner can also clear somebody
      // else's.
      if (state.identity.isAdmin || queueEntryIsMine(entry)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'queue-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${entry.name} from the queue`);
        remove.addEventListener('click', async () => {
          setMsg(els['queue-msg'], '');
          const result = await leaveQueue(db, card.account, entry.id, { name: entry.name, email: entry.email });
          if (!result.ok) setMsg(els['queue-msg'], explainQueue(result), 'error');
        });
        li.append(remove);
      }

      list.append(li);
    }
  }

  const holder = isMineLock(lock);

  if (holder) {
    // The holder never joins or leaves their own account's queue — they just
    // get the one line that matters.
    els['queue-who-field'].hidden = true;
    els['queue-join-btn'].hidden = true;
    els['queue-leave-btn'].hidden = true;
    els['queue-wait-note'].hidden = true;
    els['queue-alert'].hidden = !queue.length;
    els['queue-alert'].textContent = queue.length
      ? `${queue.length} ${queue.length === 1 ? 'person is' : 'people are'} waiting — please wrap up when you can.`
      : '';
    return;
  }

  els['queue-alert'].hidden = true;

  const mine = queue.some((entry) => queueEntryIsMine(entry));
  if (mine) {
    els['queue-who-field'].hidden = true;
    els['queue-join-btn'].hidden = true;
    els['queue-leave-btn'].hidden = false;
    els['queue-wait-note'].hidden = true;
    return;
  }

  els['queue-leave-btn'].hidden = true;

  if (canJoinQueue(lock)) {
    els['queue-who-field'].hidden = Boolean(state.identity.email) || Boolean(savedName());
    els['queue-join-btn'].hidden = false;
    els['queue-wait-note'].hidden = true;
  } else {
    els['queue-who-field'].hidden = true;
    els['queue-join-btn'].hidden = true;
    els['queue-wait-note'].hidden = false;
    els['queue-wait-note'].textContent = `You can join the queue in ${formatDuration(msUntilQueueable(lock))}.`;
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

function renderBoard() {
  const board = el('board');
  const seen = new Set();

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
    updateCard(card, account, state.locks[account.id], state.queues[account.id]);
  }

  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    card.root.remove();
    cards.delete(id);
  }

  syncAddCard(board);
  syncOrder(board);
  renderSummary();
  renderEmptyState();
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
  for (const card of cards.values()) {
    if (!isHeld(card.lock)) continue;
    card.root.dataset.state = isOverdue(card.lock) ? 'overdue' : 'held';
    renderHeldMeta(card);
    // Not driven by any snapshot: the queue-eligibility countdown and each
    // entry's "waiting Xm" both move on the clock alone.
    renderQueue(card);
  }

  // Going overdue moves a card from one column of the meter to another, and no
  // snapshot arrives to say so — the clock is the only thing that changed.
  renderSummary();
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
      state.queues = snap.val() || {};
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
    state.queues = queueSnap.val() || {};
    renderBoard();
  } catch (err) {
    console.warn('[board] refetch on focus failed', err);
  }
}

start();
