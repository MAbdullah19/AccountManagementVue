// Who is reading the board, according to Cloudflare Access.
//
// READ THIS BEFORE TRUSTING IT. This is a UI-level gate, not security.
//
// Access authenticates a real email address at the edge before the page loads,
// so only people in the Access policy can reach this file at all. What is *not*
// enforced is what the board then does with that email: Firebase auth here is
// anonymous, so the database rules cannot tell the owner from anyone else, and
// anyone who is already past Access can write to /accounts with devtools.
//
// That is consistent with how the rest of this board already works — force
// release is deliberately available to everyone — but it means the owner
// controls are a tidy-up, not a permission. If the roster ever becomes
// load-bearing, swap this for Firebase Google sign-in so `auth.token.email`
// can be checked in the rules. See plan.md §2.2.

// EDIT ME: who may manage accounts. Compared lowercased.
const ADMIN_EMAILS = [
  'abdullahbinsalim.08@gmail.com',
];

// EDIT ME: the Zero Trust team domain, without the scheme.
const TEAM_DOMAIN = 'abdullahs-studio.cloudflareaccess.com';

// Three places to ask, in descending order of how well they actually work.
//
// 1. `/api/identity` — our own Pages Function, which reads the identity out of
//    the request Access already authorised. Same origin, so no CORS and no
//    third-party cookie to be blocked. This is the one that works.
// 2. Cloudflare's own endpoint on this hostname. Verified 2026-08-02: on a
//    *.pages.dev host it answers `{"err":"no app token set"}` without a cookie
//    and serves the team domain's "Unable to find your Access organization"
//    404 page with one. Kept for a future custom domain, where it does work.
// 3. The team domain, which is what Cloudflare documents. Cross-origin, so the
//    browser will not send the Access session cookie to it, and the
//    application's CORS settings do not cover the team domain's /cdn-cgi paths.
//    Enabling CORS on the application was tried and did not help.
const IDENTITY_URLS = [
  '/api/identity',
  '/cdn-cgi/access/get-identity',
  `https://${TEAM_DOMAIN}/cdn-cgi/access/get-identity`,
];

// Development only. None of the endpoints above exist off the Access edge, so
// there would otherwise be no way to see the owner UI while building.
// Deliberately scoped to loopback so it cannot be reached on the deployed site.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);
const LOCAL_ADMIN_KEY = 'account-board:local-admin';

const isLocal = () => LOCAL_HOSTS.has(location.hostname);

const anonymous = () => ({ email: '', name: '', isAdmin: false, source: 'none' });

// Access replies with a JSON identity when a session cookie is present, and
// 404s, redirects or serves HTML when there is none — including on localhost,
// where this endpoint does not exist at all.
async function fromAccess() {
  for (const url of IDENTITY_URLS) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) continue;

      const data = await res.json();
      const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
      if (!email) continue;

      return { email, name: typeof data.name === 'string' ? data.name : '' };
    } catch {
      // An HTML error page lands here on res.json(), as do CORS rejections and
      // being offline. None is worth a console warning on every load.
    }
  }
  return null;
}

// `?admin=1` turns the owner controls on for the session, `?admin=0` turns them
// off. sessionStorage rather than localStorage, so it cannot outlive the tab.
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
