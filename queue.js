// The board's one queue, and the reservations it hands out.
//
// There is a single line for the whole board rather than one per account: you
// join once, from anywhere, and you are offered the next account that frees up.
// Push keys sort chronologically as strings, so the order people joined in *is*
// the priority order — there is no rank field to keep correct, and no way for
// two clients to disagree about who is next.
//
// Joining and leaving have nothing to race over — two people joining a moment
// apart is not a correctness problem the way two people claiming the same lock
// is — so they are plain reads and writes, the same trade-off force release
// already makes. `dropTimedOut` is the one exception, and it is a transaction
// only so that the log line is written once rather than once per open tab.
import { ref, push, remove, get, runTransaction }
  from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { serverNow } from './clock.js';
import { appendLog, sameIdentity } from './lock.js';

const MAX_NAME = 40;
const MAX_EMAIL = 120;

// How long the person at the front of the queue has to claim an account that
// has just been freed for them. Miss it and they lose their place entirely —
// see `expired` below and app.js's sweep.
export const RESERVATION_MS = 7 * 60 * 1000;

// An expired reservation keeps its slot in the assignment for this much longer,
// so that the queue below it does not shuffle up in the second or two between
// somebody's window closing and their entry actually being removed. Without it
// the person in position 2 would briefly watch their own offer jump to the
// person who just timed out above them.
export const RESERVATION_GRACE_MS = 60 * 1000;

const QUEUE_PATH = 'queue';

// A key that reaches the database has to be a legal path segment. Entry ids are
// push keys read back out of a snapshot, so nothing in the UI can produce a bad
// one — but this builds a path from data, so it is checked rather than assumed.
const BAD_KEY = /[.#$[\]/]/;
const isValidEntryId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 200 && !BAD_KEY.test(id);

const entryPath = (entryId) => `${QUEUE_PATH}/${entryId}`;

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

const cleanEmail = (email) => {
  const value = trim(email).toLowerCase();
  return value.length > 0 && value.length <= MAX_EMAIL ? value : '';
};

/* ------------------------------------------------------------ join / leave */

export async function joinQueue(db, { name, email }) {
  const who = cleanEmail(email);
  const clean = trim(name);
  if (clean.length < 1 || clean.length > MAX_NAME) return { ok: false, reason: 'invalid' };

  let snap;
  try {
    snap = await get(ref(db, QUEUE_PATH));
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  // One place each, so the order on the board is a queue rather than a list of
  // attempts. Checked here rather than in the rules for the same reason
  // everything else on this board is: the rules cannot tell one anonymous
  // client from another.
  const existing = snap.val() || {};
  const already = Object.values(existing)
    .some((entry) => sameIdentity(entry, { name: clean, email: who }));
  if (already) return { ok: false, reason: 'already-queued' };

  const entry = { name: clean, joinedAt: serverNow() };
  if (who) entry.email = who;

  try {
    await push(ref(db, QUEUE_PATH), entry);
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  await logQuietly(db, { name: clean, email: who, action: 'joined-queue' });
  return { ok: true };
}

export async function leaveQueue(db, entryId, { name, email, silent } = {}) {
  if (!isValidEntryId(entryId)) return { ok: false, reason: 'invalid' };

  try {
    await remove(ref(db, entryPath(entryId)));
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!silent) {
    await logQuietly(db, {
      name: trim(name) || 'Someone',
      email: cleanEmail(email),
      action: 'left-queue',
    });
  }
  return { ok: true };
}

// Removing somebody who let their seven minutes run out. Any client that has
// the board open can notice this and act on it — there is no server here to do
// it — so it goes through a transaction: whoever gets there first deletes the
// entry, everyone else re-reads null and aborts, and only the client that
// actually committed writes the log line.
//
// If nobody has the board open the entry simply stays, which is not a leak: the
// same person is offered the next account to free up, times out again, and is
// removed by whoever is watching then.
export async function dropTimedOut(db, entryId, { name, email, accountId, accountLabel } = {}) {
  if (!isValidEntryId(entryId)) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, entryPath(entryId)), (current) => {
      if (current === null) return; // undefined aborts — somebody else got here first
      return null;                  // null deletes
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) return { ok: false, reason: 'gone' };

  const entry = {
    name: trim(name) || 'Someone',
    email: cleanEmail(email),
    action: 'queue-timeout',
  };
  if (accountId) entry.accountId = accountId;
  if (accountLabel) entry.accountLabel = accountLabel;

  await logQuietly(db, entry);
  return { ok: true };
}

/* ----------------------------------------------------------- reservations */

// Who currently has first refusal on what, worked out from the queue and the
// locks rather than stored.
//
// Deriving it is the whole design. A `/reservations` subtree would need somebody
// to write it when an account frees, somebody to clear it when the window
// closes, and a story for what happens when the tab that owed those writes was
// closed — three ways for the board to end up holding an account for a person
// who is no longer waiting. Every client computes the same answer from the same
// two snapshots and the shared server clock instead, so there is nothing to go
// stale and nothing to repair.
//
// The assignment: free accounts that have a `freedAt` inside the window, oldest
// free first, zipped against the queue in join order. One offer per account, one
// offer per person, and nobody is offered anything while a longer-freed account
// is still spoken for.
//
// `accounts` is the board's `[{ id, label }]`, `locks` the raw /locks object,
// `queue` the sorted array of entries.
export function computeReservations(accounts, locks, queue, now = serverNow()) {
  const byAccount = new Map();
  const byEntryId = new Map();
  if (!queue.length) return { byAccount, byEntryId };

  const pool = [];
  for (const account of accounts) {
    const lock = locks?.[account.id];
    if (!lock || lock.status === 'held') continue;
    if (typeof lock.freedAt !== 'number') continue;
    if (now - lock.freedAt >= RESERVATION_MS + RESERVATION_GRACE_MS) continue;
    pool.push({ id: account.id, label: account.label, freedAt: lock.freedAt });
  }

  // Longest-free first, so the account somebody has been waiting on goes to the
  // person who has been waiting longest. The id breaks ties, only so that two
  // browsers reading the same millisecond agree.
  pool.sort((a, b) => a.freedAt - b.freedAt || a.id.localeCompare(b.id));

  for (let i = 0; i < pool.length && i < queue.length; i += 1) {
    const account = pool[i];
    const entry = queue[i];
    const expiresAt = account.freedAt + RESERVATION_MS;

    const reservation = {
      accountId: account.id,
      accountLabel: account.label,
      entry,
      expiresAt,
      // Past this the account is claimable by anyone again and the entry is
      // waiting to be swept. It still occupies its slot here — that is what
      // RESERVATION_GRACE_MS buys.
      expired: now >= expiresAt,
    };

    byAccount.set(account.id, reservation);
    byEntryId.set(entry.id, reservation);
  }

  return { byAccount, byEntryId };
}

/* -------------------------------------------------------------------- log */

// Mirrors lock.js's logQuietly: the write has already committed by the time we
// get here, so a failed log entry must not be reported as a failed join, leave
// or timeout. Queue entries name no account — the queue is the board's, not an
// account's — except a timeout, which names the account that was missed.
async function logQuietly(db, entry) {
  try {
    const clean = { ...entry };
    if (!clean.email) delete clean.email;
    await appendLog(db, clean);
  } catch (err) {
    console.warn('[board] could not append the log entry', err);
  }
}
