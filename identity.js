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

// Two places to ask, because neither is reliable on its own.
//
// The same-origin path is the convenient one, but on a *.pages.dev host it
// answers `{"err":"no app token set"}` without a cookie and serves the team
// domain's "Unable to find your Access organization" 404 page with one. The
// documented endpoint is the team domain, which works — but it is cross-origin
// from the board, so the browser blocks the read unless CORS is enabled on the
// Access application (Settings → CORS: allow this origin, allow credentials).
//
// Try both, take whichever answers. Verified 2026-08-02: the same-origin path
// is the one that fails on this deployment.
const IDENTITY_URLS = [
  '/cdn-cgi/access/get-identity',
  `https://${TEAM_DOMAIN}/cdn-cgi/access/get-identity`,
];

// The manual override. See `manualAdmin` below for why it is not loopback-only.
const ADMIN_KEY = 'account-board:admin';

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

// `?admin=1` turns the owner controls on and remembers it, `?admin=0` turns
// them off again.
//
// This used to be scoped to localhost, on the reasoning that the deployed site
// had Access to identify the owner properly. It does not — see IDENTITY_URLS —
// so on the live site there was no way to reach the owner controls at all.
//
// The honest cost: the owner controls now go from "a teammate needs devtools to
// reveal them" to "a teammate needs to know a URL". That is a smaller drop than
// it sounds, because this gate never protected the data underneath it and the
// docs have always said so. Everyone who can load this page is already inside
// the Access policy. Delete this and rely on `fromAccess` alone if CORS is ever
// enabled on the Access application.
function manualAdmin() {
  try {
    const flag = new URLSearchParams(location.search).get('admin');
    if (flag === '1') localStorage.setItem(ADMIN_KEY, '1');
    if (flag === '0') localStorage.removeItem(ADMIN_KEY);
    return localStorage.getItem(ADMIN_KEY) === '1';
  } catch {
    return false; // localStorage throws in some privacy modes
  }
}

export async function loadIdentity() {
  const override = manualAdmin();
  const access = await fromAccess();

  if (access) {
    return {
      ...access,
      isAdmin: ADMIN_EMAILS.includes(access.email) || override,
      source: 'access',
    };
  }

  if (override) {
    return { email: 'owner mode', name: '', isAdmin: true, source: 'manual' };
  }

  return anonymous();
}
