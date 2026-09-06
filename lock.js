// Claim, release and force-release, per account.
//
// Every state change goes through runTransaction, because read-then-write will
// eventually let two people hold the lock at once. The transaction callbacks
// here are pure: Firebase may run them several times, so no logging, no DOM
// writes and no await inside them. Log entries are appended afterwards.
//
// Each function takes an `account` — `{ id, label }` — rather than an id alone.
// The label is only used for the log entry, which stores it denormalised so a
// line still reads after the account it refers to has been deleted.
import { ref, runTransaction, push } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { serverNow } from './clock.js';

// Kept in step with the database rules in database.rules.json. Validating here
// too means the common mistakes get a readable message instead of a
// permission-denied error from a rejected write.
const MAX_NAME = 40;
const MAX_NOTE = 120;
const MAX_EMAIL = 120;
const MIN_MINUTES = 1;
const MAX_MINUTES = 480;

// How long somebody may hold an account before the board asks them, on their
// own card, to wrap up. Unrelated to `expectedMinutes`, which is the estimate
// they gave when claiming and which drives the (softer) overdue state: this one
// is the same number for everybody and does not move.
//
// Nothing enforces it. There is no auto-release and no heartbeat — see
// context.md's standing constraints — so this only decides what the card says.
export const SESSION_ALERT_AFTER_MS = 2.5 * 60 * 60 * 1000;

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

// A key that reaches the database has to be a legal path segment. Nothing in
// the UI can produce a bad one — ids are push keys — but this builds a path
// from data, so it is checked rather than assumed.
const BAD_KEY = /[.#$[\]/]/;

export function isValidAccountId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !BAD_KEY.test(id);
}

const lockPath = (accountId) => `locks/${accountId}`;

// The display name is typed and can be anything. The email comes from
// Cloudflare Access, which authenticated it before the page loaded, so it is
// the field to trust when the two disagree. Absent only on localhost, where
// there is no Access edge to ask — hence every use of it tolerates ''.
const cleanEmail = (email) => {
  const value = trim(email).toLowerCase();
  return value.length > 0 && value.length <= MAX_EMAIL ? value : '';
};

// Written into both the lock and the log rather than the log alone, so "may I
// release this?" can be answered from the lock without a second lookup.
const withEmail = (entry, email) => (email ? { ...entry, email } : entry);

// The board's single rule for "are these two the same person": the email when
// both sides have one, because Access authenticated it, and the typed display
// name otherwise. Both arguments are `{ name, email }` — a lock's `holder` has
// to be handed in as `name`.
//
// Exported and shared on purpose. Release, the queue's "you are already in it"
// check, the reservation guard below and the board's "is this mine?" rendering
// all answer the same question, and they must never drift apart: a rule that
// says a release is allowed but the button is hidden is worse than either
// answer on its own.
export function sameIdentity(a, b) {
  const emailA = cleanEmail(a?.email);
  const emailB = cleanEmail(b?.email);
  if (emailA && emailB) return emailA === emailB;

  const nameA = trim(a?.name);
  return Boolean(nameA) && nameA === trim(b?.name);
}

// Returns cleaned values, or null if the rules would reject them.
function normalise({ holder, note, expectedMinutes }) {
  const name = trim(holder);
  const text = trim(note);
  const minutes = Number(expectedMinutes);

  if (name.length < 1 || name.length > MAX_NAME) return null;
  if (text.length > MAX_NOTE) return null;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;

  return { holder: name, note: text, expectedMinutes: minutes };
}

export async function appendLog(db, entry) {
  await push(ref(db, 'log'), { ...entry, at: serverNow() });
}

// The lock change has already committed by the time we get here, so a failed
// log write must not be reported to the user as a failed claim or release.
async function logQuietly(db, account, entry) {
  try {
    await appendLog(db, {
      ...entry,
      accountId: account.id,
      accountLabel: trim(account.label) || 'an account',
    });
  } catch (err) {
    console.warn('[board] could not append the log entry', err);
  }
}

// `reservedFor` is `{ name, email }` when the queue has handed this account to
// somebody for their seven minutes, and null otherwise. app.js works out who
// that is — the derivation needs the whole board, which this module does not
// see — but the refusal lives here so that a new call site cannot claim past a
// reservation by forgetting to ask.
//
// Client-side, like every other gate on this board (see identity.js): the rules
// still let any signed-in client write to /locks. It is the button that is
// gone, not the permission.
export async function claim(db, account, { holder, email, note, expectedMinutes, reservedFor }) {
  if (!isValidAccountId(account?.id)) return { ok: false, reason: 'invalid' };

  const clean = normalise({ holder, note, expectedMinutes });
  if (!clean) return { ok: false, reason: 'invalid' };

  const who = cleanEmail(email);

  if (reservedFor && !sameIdentity(reservedFor, { name: clean.holder, email: who })) {
    return { ok: false, reason: 'reserved', reservedFor };
  }

  let result;
  try {
    result = await runTransaction(ref(db, lockPath(account.id)), (current) => {
      if (current && current.status === 'held') return; // undefined aborts
      return withEmail({
        status: 'held',
        holder: clean.holder,
        note: clean.note,
        claimedAt: serverNow(),
        expectedMinutes: clean.expectedMinutes,
      }, who);
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) return { ok: false, reason: 'taken' };

  await logQuietly(db, account, withEmail({ name: clean.holder, action: 'claimed' }, who));
  return { ok: true, holder: clean.holder };
}

// What a freed lock looks like. `freedAt` is the whole reason it is a shape
// rather than a literal: the queue's seven-minute reservation window has to
// start from the moment the account actually became available, and nothing
// else on the board records that. A lock freed before this field existed
// simply never offers a reservation, which is the safe way to be wrong.
const freed = () => ({ status: 'free', freedAt: serverNow() });

export async function release(db, account, { holder, email }) {
  if (!isValidAccountId(account?.id)) return { ok: false, reason: 'invalid' };

  const name = trim(holder);
  const who = cleanEmail(email);
  if (!name && !who) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, lockPath(account.id)), (current) => {
      if (!current || current.status !== 'held') return;

      // Prefer the email when both sides have one: it is exact, where the name
      // is a string typed twice and easily typed differently the second time.
      // Locks claimed before this field existed still fall back to the name.
      if (!sameIdentity({ name: current.holder, email: current.email }, { name, email: who })) return;

      return freed();
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) {
    // Work out why from the post-transaction snapshot rather than from a
    // variable captured inside the callback.
    const current = result.snapshot.val();
    if (!current || current.status !== 'held') return { ok: false, reason: 'already-free' };
    return { ok: false, reason: 'not-holder' };
  }

  // The snapshot is `{ status: 'free' }` by now, so the name has to come from
  // the caller rather than from the lock we just cleared.
  await logQuietly(db, account, withEmail({ name: name || who, action: 'released' }, who));
  return { ok: true };
}

// Always available to anyone. The friction is the required reason, and the
// accountability is the log entry naming both people — not a confirm dialog.
export async function forceRelease(db, account, { by, email, reason, heldBy }) {
  if (!isValidAccountId(account?.id)) return { ok: false, reason: 'invalid' };

  const who = cleanEmail(email);
  const typed = trim(by);
  const why = trim(reason);

  if (typed.length > MAX_NAME) return { ok: false, reason: 'invalid' };

  // The email leads here, unlike everywhere else on the board: this line is a
  // record of something done to somebody else, so it names the account Access
  // authenticated rather than a display name anyone can pick. The typed name is
  // the fallback for local development, where there is no Access identity.
  const name = who || typed;
  if (!name) return { ok: false, reason: 'invalid' };
  if (!why) return { ok: false, reason: 'no-reason' };
  if (why.length > MAX_NOTE) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, lockPath(account.id)), (current) => {
      if (!current || current.status !== 'held') return;
      return freed();
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) return { ok: false, reason: 'already-free' };

  const entry = withEmail({ name, action: 'force-released', reason: why }, who);
  if (trim(heldBy)) entry.heldBy = trim(heldBy);
  await logQuietly(db, account, entry);
  return { ok: true };
}
