// Claim, release and force-release.
//
// Every state change goes through runTransaction, because read-then-write will
// eventually let two people hold the lock at once. The transaction callbacks
// here are pure: Firebase may run them several times, so no logging, no DOM
// writes and no await inside them. Log entries are appended afterwards.
import { ref, runTransaction, push } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { serverNow } from './clock.js';

// Kept in step with the database rules in database.rules.json. Validating here
// too means the common mistakes get a readable message instead of a
// permission-denied error from a rejected write.
const MAX_NAME = 40;
const MAX_NOTE = 120;
const MIN_MINUTES = 1;
const MAX_MINUTES = 480;

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

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
async function logQuietly(db, entry) {
  try {
    await appendLog(db, entry);
  } catch (err) {
    console.warn('[board] could not append the log entry', err);
  }
}

export async function claim(db, { holder, note, expectedMinutes }) {
  const clean = normalise({ holder, note, expectedMinutes });
  if (!clean) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, 'lock'), (current) => {
      if (current && current.status === 'held') return; // undefined aborts
      return {
        status: 'held',
        holder: clean.holder,
        note: clean.note,
        claimedAt: serverNow(),
        expectedMinutes: clean.expectedMinutes,
      };
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) return { ok: false, reason: 'taken' };

  await logQuietly(db, { name: clean.holder, action: 'claimed' });
  return { ok: true, holder: clean.holder };
}

export async function release(db, { holder }) {
  const name = trim(holder);
  if (!name) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, 'lock'), (current) => {
      if (!current || current.status !== 'held') return;
      if (current.holder !== name) return;
      return { status: 'free' };
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

  await logQuietly(db, { name, action: 'released' });
  return { ok: true };
}

// Always available to anyone. The friction is the required reason, and the
// accountability is the log entry naming both people — not a confirm dialog.
export async function forceRelease(db, { by, reason, heldBy }) {
  const name = trim(by);
  const why = trim(reason);

  if (!name || name.length > MAX_NAME) return { ok: false, reason: 'invalid' };
  if (!why) return { ok: false, reason: 'no-reason' };
  if (why.length > MAX_NOTE) return { ok: false, reason: 'invalid' };

  let result;
  try {
    result = await runTransaction(ref(db, 'lock'), (current) => {
      if (!current || current.status !== 'held') return;
      return { status: 'free' };
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!result.committed) return { ok: false, reason: 'already-free' };

  const entry = { name, action: 'force-released', reason: why };
  if (trim(heldBy)) entry.heldBy = trim(heldBy);
  await logQuietly(db, entry);
  return { ok: true };
}
