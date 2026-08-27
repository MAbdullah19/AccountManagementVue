// Join and leave the queue for a held account.
//
// Unlike lock.js this has nothing to race over: two people joining the queue
// a moment apart is not a correctness problem the way two people claiming the
// same lock is, so there is no runTransaction here — a plain read-then-write
// is enough, the same trade-off force-release already makes.
import { ref, push, remove, get } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { serverNow } from './clock.js';
import { isValidAccountId, appendLog } from './lock.js';

const MAX_NAME = 40;
const MAX_EMAIL = 120;

// The holder's guaranteed uninterrupted stretch. Nobody can join the queue
// for an account until this much time has passed since it was claimed —
// after that, joining opens up and the holder starts seeing who is waiting.
export const QUEUE_ELIGIBLE_AFTER_MS = 2.5 * 60 * 60 * 1000;

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

const cleanEmail = (email) => {
  const value = trim(email).toLowerCase();
  return value.length > 0 && value.length <= MAX_EMAIL ? value : '';
};

const queuePath = (accountId) => `queue/${accountId}`;

// Purely visual, like isOverdue in app.js — nothing here blocks a write the
// rules would otherwise accept. It only decides what the UI offers.
export function canJoinQueue(lock) {
  if (!lock || lock.status !== 'held' || typeof lock.claimedAt !== 'number') return false;
  return serverNow() - lock.claimedAt >= QUEUE_ELIGIBLE_AFTER_MS;
}

export function msUntilQueueable(lock) {
  if (!lock || lock.status !== 'held' || typeof lock.claimedAt !== 'number') return 0;
  return Math.max(0, lock.claimedAt + QUEUE_ELIGIBLE_AFTER_MS - serverNow());
}

// Same identity rule release() uses in lock.js: prefer the email when both
// sides have one, fall back to the name for entries or visitors without one.
function isSameIdentity(entry, name, email) {
  if (email && entry.email) return entry.email === email;
  return Boolean(name) && entry.name === name;
}

export async function joinQueue(db, account, { name, email }) {
  if (!isValidAccountId(account?.id)) return { ok: false, reason: 'invalid' };

  const who = cleanEmail(email);
  const clean = trim(name);
  if (clean.length < 1 || clean.length > MAX_NAME) return { ok: false, reason: 'invalid' };

  let snap;
  try {
    snap = await get(ref(db, queuePath(account.id)));
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  const existing = snap.val() || {};
  const already = Object.values(existing).some((entry) => isSameIdentity(entry, clean, who));
  if (already) return { ok: false, reason: 'already-queued' };

  const entry = { name: clean, joinedAt: serverNow() };
  if (who) entry.email = who;

  try {
    await push(ref(db, queuePath(account.id)), entry);
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  await logQuietly(db, account, { name: clean, email: who, action: 'joined-queue' });
  return { ok: true };
}

export async function leaveQueue(db, account, entryId, { name, email, silent } = {}) {
  if (!isValidAccountId(account?.id)) return { ok: false, reason: 'invalid' };
  if (!entryId) return { ok: false, reason: 'invalid' };

  try {
    await remove(ref(db, `${queuePath(account.id)}/${entryId}`));
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }

  if (!silent) {
    await logQuietly(db, account, {
      name: trim(name) || 'Someone',
      email: cleanEmail(email),
      action: 'left-queue',
    });
  }
  return { ok: true };
}

// Mirrors lock.js's logQuietly: the write has already committed by the time
// we get here, so a failed log entry must not be reported as a failed join
// or leave.
async function logQuietly(db, account, entry) {
  try {
    const clean = { ...entry, accountId: account.id, accountLabel: trim(account.label) || 'an account' };
    if (!clean.email) delete clean.email;
    await appendLog(db, clean);
  } catch (err) {
    console.warn('[board] could not append the log entry', err);
  }
}
