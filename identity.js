// Who is reading the board, according to Cloudflare Access.
//
// READ THIS BEFORE TRUSTING IT. This is a UI-level gate, not security.
//
// Access authenticates a real email address at the edge before the page loads,
// and /cdn-cgi/access/get-identity hands that address to the page. So the email
// is genuine. What is *not* enforced is what the board then does with it:
// Firebase auth here is anonymous, so the database rules cannot tell the owner
// from anyone else, and a teammate with devtools can still write to /accounts.
//
// That is consistent with how the rest of this board already works — force
// release is deliberately available to everyone — but it means the admin
// controls are a tidy-up, not a permission. If the roster ever becomes
// load-bearing, swap this for Firebase Google sign-in so `auth.token.email`
// can be checked in the rules. See plan.md §2.2.

// EDIT ME: who may manage accounts. Compared lowercased.
const ADMIN_EMAILS = [
  'abdullahbinsalim.08@gmail.com',
];

const IDENTITY_URL = '/cdn-cgi/access/get-identity';

// Development only. get-identity does not exist off the Access edge, so there
// would otherwise be no way to see the admin UI while building. Deliberately
// scoped to loopback hostnames so it cannot be triggered on the deployed site.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);
const LOCAL_ADMIN_KEY = 'account-board:local-admin';

const anonymous = () => ({ email: '', name: '', isAdmin: false, source: 'none' });

const isLocal = () => LOCAL_HOSTS.has(location.hostname);

// Access replies with a JSON identity when a session cookie is present, and
// 404s or redirects when there is none — including on localhost and on a
// Pages deploy that is not behind Access.
async function fromAccess() {
  try {
    const res = await fetch(IDENTITY_URL, { credentials: 'include' });
    if (!res.ok) return null;

    const data = await res.json();
    const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!email) return null;

    return { email, name: typeof data.name === 'string' ? data.name : '' };
  } catch {
    // A 404 that returns HTML lands here on res.json(), as does being offline.
    // Neither is worth a console warning on every load.
    return null;
  }
}

// ?admin=1 turns it on for the session, ?admin=0 turns it off again.
function localAdmin() {
  try {
    const flag = new URLSearchParams(location.search).get('admin');
    if (flag === '1') sessionStorage.setItem(LOCAL_ADMIN_KEY, '1');
    if (flag === '0') sessionStorage.removeItem(LOCAL_ADMIN_KEY);
    return sessionStorage.getItem(LOCAL_ADMIN_KEY) === '1';
  } catch {
    return false; // sessionStorage throws in some privacy modes
  }
}

export async function loadIdentity() {
  const access = await fromAccess();

  if (access) {
    return {
      ...access,
      isAdmin: ADMIN_EMAILS.includes(access.email),
      source: 'access',
    };
  }

  if (isLocal() && localAdmin()) {
    return { email: 'local development', name: '', isAdmin: true, source: 'local' };
  }

  return anonymous();
}
