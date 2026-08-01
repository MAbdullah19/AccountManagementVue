// GET /api/identity -> { "email": "..." }
//
// A Cloudflare Pages Function: it runs at the edge, on this site's own origin,
// and exists because the browser cannot get this answer for itself.
//
// The board needs to know which email Access authenticated. The obvious route,
// fetching /cdn-cgi/access/get-identity from the page, does not work on a
// *.pages.dev host — see README. The documented endpoint lives on the team
// domain, which is cross-origin, so the browser will not send the Access
// session cookie to it and CORS settings on the application do not cover it.
//
// From here, though, the request has already been through Access. Whatever
// reaches this function was authorised at the edge, and it arrives carrying
// proof of who authorised it. No cross-origin call, no third-party cookie.

// Access injects this header into requests it forwards to the origin. It is the
// cheapest answer when it is present, but it is reported missing on some Pages
// deployments, hence the cookie fallback below.
const EMAIL_HEADER = 'cf-access-authenticated-user-email';

// The Access session cookie: a JWT whose payload carries the email.
const COOKIE = 'CF_Authorization';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The answer is specific to the caller's session, so it must never be
      // held in a shared cache.
      'cache-control': 'no-store',
    },
  });

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

// Reads the payload without checking the signature, which is safe *here* and
// nowhere else: Access validates this token at the edge and refuses the request
// outright when it does not hold up, so a forged cookie never reaches this
// code. Do not copy this into anything that is reachable without Access in
// front of it.
function emailFromToken(token) {
  const payload = token.split('.')[1];
  if (!payload) return '';

  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  try {
    const claims = JSON.parse(atob(padded));
    return typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return '';
  }
}

export function onRequestGet({ request }) {
  const headers = request.headers;

  const email =
    headers.get(EMAIL_HEADER) ||
    emailFromToken(readCookie(headers.get('cookie'), COOKIE));

  if (!email) {
    // Running without Access in front — locally, or if the application is ever
    // removed. Same shape as Cloudflare's own endpoint so the client can treat
    // the two identically.
    return json({ err: 'no app token set' }, 400);
  }

  return json({ email: email.trim().toLowerCase() });
}
