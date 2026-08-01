// Startup shared by the two pages: Firebase init, anonymous sign-in, the setup
// banner, the connection indicator and the "who you are" chip.
//
// This exists because there are now two entry points — the board and the
// activity page — and both need exactly this and nothing more. It is not a
// framework. Everything page-specific stays in app.js and activity.js.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

const el = (id) => document.getElementById(id);

export function showBanner(title, body) {
  el('banner-title').textContent = title;
  el('banner-body').textContent = body;
  el('banner').hidden = false;
}

// A config object that still has placeholder values would fail deep inside the
// SDK with an unhelpful error. Catch it here and say what to do instead.
function configLooksReal(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId);
}

// Returns the database handle, or null once it has explained on the page why
// there is not one. Callers stop on null.
export async function connect() {
  if (!configLooksReal(firebaseConfig)) {
    showBanner(
      'Setup incomplete',
      'firebase-config.js has no project config yet. Copy the firebaseConfig object from ' +
      'the Firebase console (Project settings → General → Your apps → Web app) into ' +
      'firebase-config.js. See the README.'
    );
    return null;
  }

  const app = initializeApp(firebaseConfig);

  // Anonymous auth is not about identifying people. It exists so the database
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
    return null;
  }

  return getDatabase(app);
}

// This must reflect the connection, not the age of the last message. onValue
// only fires on change, so an account sitting free for two hours is perfectly
// healthy and a "last synced" indicator would libel it.
export function watchConnection(db, onChange) {
  let everConnected = false;

  onValue(ref(db, '.info/connected'), (snap) => {
    const connected = snap.val() === true;
    if (connected) everConnected = true;

    el('conn').dataset.state = connected ? 'live' : everConnected ? 'offline' : 'connecting';
    el('conn-label').textContent = connected
      ? 'live'
      : everConnected
        ? 'reconnecting…'
        : 'connecting…';

    // A frozen page showing "Available" is worse than no board at all, so a
    // stale reading has to look stale. The page decides how to show that.
    onChange?.(connected, everConnected);
  });
}

// Who Cloudflare Access says you are. Proof the gate is working, and the only
// place the owner's extra powers are announced.
export function renderWho(identity) {
  const who = el('who');
  if (!identity.email) {
    who.hidden = true;
    return;
  }
  // The manual toggle has no email to show, so its label already says "local
  // development" on its own. Appending "· owner" to that just stutters.
  const named = identity.source === 'access';
  who.textContent = identity.isAdmin && named
    ? `${identity.email} · owner`
    : identity.email;
  who.dataset.admin = String(identity.isAdmin);
  who.hidden = false;
}
