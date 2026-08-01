# Runbook

Everything needed to stand this board up, deploy it, and keep it running. The
[README](README.md) covers what the app is and why it is built this way; this
file is the operational half, split out so the README stays readable.

Most of it is console work in Firebase and Cloudflare. None of it can be
scripted from this repo.

---

## Firebase setup

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
   Google Analytics can be disabled.
2. **Build → Realtime Database → Create database.** Pick the region closest to
   the team. Start in **locked mode**; the real rules go in at step 5.
3. **Build → Authentication → Sign-in method →** enable **Anonymous**.
4. **Project settings → General → Your apps →** add a **Web app**, and copy the
   `firebaseConfig` object into `firebase-config.js`:

   ```js
   export const firebaseConfig = {
     apiKey: '…',
     authDomain: '…',
     databaseURL: 'https://….firebasedatabase.app',
     projectId: '…',
     storageBucket: '…',
     messagingSenderId: '…',
     appId: '…',
   };
   ```

   `databaseURL` is required. If it is missing from the snippet the console gave
   you, the Realtime Database was not created yet — go back to step 2.
5. **Realtime Database → Rules →** paste the contents of `database.rules.json`
   and publish. **Nothing works before this.** Firebase denies every path the
   rules do not name, so the board reports `permission_denied at /locks` and
   shows an empty grid until the rules are live.
6. Set your address in `ADMIN_EMAILS` at the top of `identity.js`, lowercase.
7. Open the board and add your accounts with the **Add an account** card.
   Nothing is seeded by hand.

### Upgrading a v1 board

v1 kept a single lock at `/lock`. Account ids are push keys now, so there is no
sensible id to move that node to — and all it holds is who has it *right now*,
which is worth nothing tomorrow. Do not migrate it:

1. Publish the new rules (step 5).
2. Add the accounts through the UI.
3. Delete the stale `/lock` node under **Realtime Database → Data**.

Old `/log` entries are kept and still render. They predate multiple accounts and
carry no `accountLabel`, so they read "claimed the account" rather than naming
one.

---

## Deploying

Live at **<https://accountmanagementvue.pages.dev>**, behind Cloudflare Access on
the team domain `abdullahs-studio.cloudflareaccess.com`. Deployed 2026-08-01.

The team domain is **account-wide, not per-application** — there is one Zero Trust
organisation per Cloudflare account, and every Access app in it shares that login
domain. That is why it is named after the account rather than after this board.

The steps are written out because the Cloudflare UI was renamed mid-2026 and the
older instructions no longer match anything on screen.

1. Push to a **private** GitHub or GitLab repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
   Pick the repo. **Build command: none. Build output directory: `/`.** There is
   nothing to build.
3. **This is the step everyone forgets:** back in Firebase, go to
   **Authentication → Settings → Authorized domains** and add the Pages domain
   (`your-project.pages.dev`, plus any custom domain). Anonymous sign-in works on
   `localhost` by default and **silently fails in production** until you do this.
   The symptom is the "Could not sign in" banner on the deployed site while
   localhost works perfectly.
4. Cloudflare dashboard → **Zero Trust → Access controls → Applications → Create
   new application → Self-hosted and private → Public DNS**. The current UI splits
   this into three parts:

   - **Destinations** — leave *Subdomain* blank and pick the whole hostname
     `accountmanagementvue.pages.dev` from the *Domain* dropdown. Cloudflare lists
     `.pages.dev` hostnames there even though the zone is not yours. Leave *Path*
     empty; that is what makes the app cover every URL rather than one page.
   - **Policies** — action **Allow**, Include → **Emails**, each person's address
     as its own entry. Free for up to 50 users.
   - **Sources** — auto-fills to *All authenticated users*. The policy is what
     narrows it.

   > Use `Emails` with explicit addresses, **not** `Emails ending in` →
   > `@gmail.com`. The latter admits every Gmail account on earth, which is the
   > exact opposite of the intent.

   The team does not need company email addresses — Access authenticates by
   address, not by domain. But see the One-time PIN gotcha below before adding
   anyone; personal Gmail only works if that login method is switched on.

   Cloudflare Access and Firebase's authorized domains are unrelated: Access
   gates the page by the reader's email, authorized domains is about the site's
   own hostname.

### What Access actually covers

Everything on the hostname, not just `index.html`. Verified 2026-08-01 from an
unauthenticated client: `/`, `/README.md`,
`/account-board-implementation-plan.md`, `/database.rules.json`, `/.gitignore`,
`/firebase-config.js` and `/app.js` all return **302 to the Access login**.

This matters because Pages uploads the repo verbatim — the docs and the rules
file are genuinely served, and before Access was configured they were readable by
anyone with the URL. None of it is a credential leak, but `database.rules.json`
hands a reader the exact shape of the database. Access is the only thing closing
that. `.assetsignore` does **not**; it is inert on Pages and only applies to a
Workers deploy. See the comments in that file.

### Adding and removing people

**Access controls → Policies → Team**, edit the Include rule, save. No redeploy,
nothing to change in this repo.

The two directions are not symmetric, and this is the thing to know:

- **Adding** takes effect at the person's next login — effectively immediately.
- **Removing** does not end an existing session. They keep access until their
  session expires, which is the *Session Duration* set on the application. To cut
  it off now, revoke the session under **Team & Resources → Users**.

So a long session duration means fewer PIN emails and slower revocation. Note
also that a session duration set on the *policy* overrides the one on the
application, which is easy to miss.

### Making someone else an owner

Owner is a list in code, not a setting, because it should be rare:

1. Add their address **lowercase** to `ADMIN_EMAILS` in `identity.js`. The
   comparison is against an already-lowercased Access email, so a capital letter
   silently never matches.
2. Commit and push. Pages redeploys on its own.
3. Make sure they are also on the Access policy, or they cannot load the page at
   all.

It takes effect on their next page load. Remember it decides who *sees* the
owner controls, not who can write — see the README on what the owner check is
and is not.

---

## Why the email comes from `/api/identity`

Cloudflare's own `get-identity` endpoint cannot be reached from the page on a
`*.pages.dev` host. Both routes were tried and both fail:

- **Same origin,** `/cdn-cgi/access/get-identity` — returns
  `{"err":"no app token set"}` with no cookie, and serves the team domain's
  "Unable to find your Access organization" 404 page once there *is* one.
- **The team domain,** which is what Cloudflare documents — cross-origin from
  the board, so the browser never sends the Access session cookie to it.
  Enabling CORS on the application (Settings → CORS headers, with
  `Access-Control-Allow-Credentials` and an explicit methods list, since
  wildcards are illegal alongside credentials) was tried and did not help: those
  settings govern the application's own responses, not the team domain's
  `/cdn-cgi` paths.

So `functions/api/identity.js`, a Pages Function, answers it from the edge
instead. By the time it runs, Access has already authorised the request, and the
request carries proof of who it authorised — either the header Access injects or
the session cookie itself. Same origin, so nothing is left for CORS or
third-party cookie rules to block.

**This is why there is a `functions/` directory,** and why the deploy is no
longer purely static. It still needs no build step and has no dependencies.

`identity.js` tries `/api/identity` first and keeps both Cloudflare endpoints as
fallbacks, because on a custom domain the same-origin one does work.

On `localhost` none of the three exist, so there is a development fallback:
`?admin=1` turns the owner controls on for the session and `?admin=0` turns them
off. It is scoped to loopback hostnames and cannot be triggered on the deployed
site. The activity page needs it too, since that page shows the log to the owner
only.

---

## Testing

There is no test runner, by design. The checklist below is the test suite. It has
been run against the live Firebase project in two real Chrome profiles driven
over the DevTools Protocol — separate profiles rather than two tabs, because tabs
share `localStorage` and cannot represent two people with different saved names.

> **Read this before trusting the ticks below.** Everything in the first list was
> verified against the **v1 single-account** code. The multi-account rewrite
> touched every one of these paths — `lock.js` now takes an account, and the
> board renders cloned cards rather than one hardcoded card. The behaviour is
> meant to be identical and the transactions are unchanged in shape, but *these
> boxes have not been re-run since*. The current checklist is in `plan.md` §5.

Verified end to end against the live database, against v1:

- [x] Claim from window A → window B updates without a reload
- [x] Release from A → B updates
- [x] Both windows claim in the same instant → exactly one succeeds, the other is
      told "Someone claimed it a moment ago", and only the winner is logged
- [x] B sees Force release but not Release while A holds the lock
- [x] Force release with an empty reason is rejected; with a reason it succeeds
      and logs both names
- [x] Elapsed timer ticks every second, and keeps counting across a reload from
      the same start time rather than restarting
- [x] Offline → indicator changes, reads "reconnecting…", and the card dims
- [x] Back online → indicator recovers and the state resyncs to whatever changed
      while the window was blind
- [x] An over-long name or note, an out-of-range duration, a bad status, an
      invented field and a write outside the schema are all rejected by the rules
- [x] A direct write attempt without a token is rejected by the rules
- [x] The whole `/log` node cannot be deleted by a client

Verified, but not in the literal way the box describes — worth a human eye if you
want the box fully closed:

- [~] **OS clock shifted ±10 minutes → elapsed unchanged.** The mechanism is
      verified: `serverNow()` stays put when the local clock jumps ten minutes
      and Firebase reports a compensating offset. Nobody has actually changed a
      real machine's clock.
- [~] **Tab hidden five minutes, then refocused.** The recovery path is verified
      by killing the listeners outright and firing `visibilitychange`, which is
      harsher than a sleeping laptop — but no laptop was actually slept.
- [~] **Reads correctly on a phone screen.** Verified at a true 360px viewport,
      not on a physical device.

The `Setup A` / `Setup B` entries in the activity log are from that verification
run.

Verified against the deployed site on 2026-08-01:

- [x] The board loads on `accountmanagementvue.pages.dev`, anonymous sign-in
      succeeds, and the activity log renders — i.e. deploy step 3 worked
- [x] Every path on the hostname 302s to the Access login when unauthenticated
- [~] **A teammate who is not the account owner can log in.** The mechanism is
      verified — after enabling One-time PIN the login page serves an email field
      (`name="email"`) instead of only the Cloudflare account button. Nobody has
      actually completed a PIN round-trip from a second person's inbox. Do that
      before telling the team the board is ready.

Verified on 2026-08-02, after the two-page split:

- [x] Both pages connect, render live data and log no console errors
- [x] The owner sees the log; a non-owner sees the explanation instead, and no
      Firebase connection is opened for them at all
- [x] No horizontal overflow at a 380px viewport

---

## Limits and gotchas

- **Firebase denies any path the rules do not name.** Upgrading the app without
  publishing the matching `database.rules.json` does not degrade gracefully — the
  board loads, signs in, reports `live`, and then shows an empty grid with
  `permission_denied at /locks`. It looks like a data problem and is a rules
  problem.
- **Authorized domains** — see deploy step 3. The single most common failure.
- **The Access login page must offer One-time PIN.** As of 2026-08-01 the login
  screen for this app offers only **Cloudflare** as a sign-in method, which
  authenticates against a *Cloudflare dashboard account* — so a teammate with a
  plain Gmail address and no Cloudflare account cannot get in, no matter that
  their address is on the policy. Fix it under **Zero Trust → Integrations →
  Identity providers → Add new identity provider → One-time PIN**, which emails a
  six-digit code to any address. Cloudflare stopped adding OTP automatically —
  new organisations get the Cloudflare provider instead — so this will catch
  anyone following older instructions. Test with a real teammate's address in a
  private window before telling the team the board is ready.

  Related: if you rename the team, do it **before** adding a Google or Okta
  identity provider. Those register a redirect URI containing the team domain,
  so renaming afterwards means editing the OAuth config on the IdP's side too.
  One-time PIN has no external callback and is unaffected.
- **Spark tier allows 100 simultaneous connections.** Fine for a team; worth
  knowing before this gets shared more widely.
- **A rule validation failure rejects the whole write** and surfaces as a
  permission-denied error. Writes are wrapped and shown as inline messages, and
  input is validated client-side against the same limits as the rules so the
  common mistakes never get that far.
- **`onValue` fires immediately with current data on subscribe**, not only on
  change. Nothing here assumes the first callback is a change event.
