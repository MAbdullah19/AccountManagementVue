// Creating, renaming and deleting the accounts the board tracks.
//
// These are the owner's writes. They are ordinary writes rather than
// transactions: unlike a claim, two people are never racing to rename the same
// account, and last-write-wins is the right answer if they somehow are.
//
// Nothing here is enforced by the database rules — see identity.js for why.
import { ref, push, update } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { serverNow } from './clock.js';
import { isValidAccountId } from './lock.js';

const MAX_LABEL = 60;
const MAX_DESC = 120;

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

function normalise({ label, description }) {
  const name = trim(label);
  const desc = trim(description);
  if (name.length < 1 || name.length > MAX_LABEL) return null;
  if (desc.length > MAX_DESC) return null;
  return { label: name, description: desc };
}

export async function createAccount(db, { label, description }) {
  const clean = normalise({ label, description });
  if (!clean) return { ok: false, reason: 'invalid' };

  try {
    const created = await push(ref(db, 'accounts'), {
      ...clean,
      createdAt: serverNow(),
    });
    return { ok: true, id: created.key };
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
}

export async function renameAccount(db, accountId, { label, description }) {
  if (!isValidAccountId(accountId)) return { ok: false, reason: 'invalid' };

  const clean = normalise({ label, description });
  if (!clean) return { ok: false, reason: 'invalid' };

  try {
    // update() merges at this path, so createdAt survives.
    await update(ref(db, `accounts/${accountId}`), clean);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
}

// The account and its lock go together, in one atomic multi-path update — a
// lock left behind under a deleted account would be invisible and unclearable.
//
// The log is deliberately untouched. It is append-only by design, and every
// entry carries the account's label denormalised so the history still reads
// after the account is gone.
export async function deleteAccount(db, accountId) {
  if (!isValidAccountId(accountId)) return { ok: false, reason: 'invalid' };

  try {
    await update(ref(db), {
      [`accounts/${accountId}`]: null,
      [`locks/${accountId}`]: null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
}
