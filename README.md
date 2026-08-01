# Shared Account Status Board

A single page that answers one question for a small team: **is the shared account
currently in use, and by whom?**

The workplace has one login for a service and only one person can use it at a
time. There is no technical way to enforce that, and the team already
understands the rule. This board exists purely to broadcast the current state so
nobody logs in on top of someone else.

It is an **honour-system checkout board, not an access control system.**

## Why it works this way

This is the part most likely to be relitigated by whoever inherits it, so:

- **Nothing is enforced.** The app never blocks anyone from anything. It cannot —
  it has no connection to the service being shared. Adding a lock that looks
  enforcing but is not would be worse than an honest sign.
- **No auto-release on disconnect, and no heartbeat.** People sit at their desks
  while working and release when they are done. Auto-release would free the
  account out from under someone whose Wi-Fi blipped, which is the exact failure
  the board exists to prevent.
- **No accounts, passwords or roles.** People type their name; it is remembered
  in `localStorage` afterwards. Anyone who can reach the page is already trusted
  — access is handled at the edge by Cloudflare Access, not by this code.
- **Force release is always available and never behind a confirm dialog.** The
  friction is the required reason field, and the accountability is the log entry
  naming both people. A dialog would train everyone to click through it.
- **Overdue is only a colour change.** When a hold runs past its estimate the
  card turns amber and says "still in use?". Nothing auto-releases and nothing is
  blocked. It just makes a forgotten release legible to the room.

## How the team uses it

Free: type your name, optionally what you are doing, and how long you expect to
need it. One click on **Claim**. Your name is remembered, so next time claiming
is one click.

Held: the card is red with the holder's name, when they started, a live elapsed
timer, and their estimated finish. If it is you, there is a **Release** button.
If it is not, there is **Force release** — type why, and both names go into the
activity log.

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vanilla HTML + CSS + ES modules | No build step means no toolchain to maintain, and it deploys to any static host unchanged. The whole app is a few hundred lines. |
| Realtime state | Firebase Realtime Database (Spark / free tier) | Push listeners, a server-authoritative clock via `/.info/serverTimeOffset`, and atomic transactions. Free at this scale. |
| Auth | Firebase Anonymous Auth | Not to identify people — purely so the database rules can require `auth != null` and shut out internet scanners. Invisible to the user. |
| Hosting | Cloudflare Pages | Free, deploys from **private** repos, and pairs with Cloudflare Access. |
| Access control | Cloudflare Access | Keeps colleagues' names off the public internet, with no code. |

There is deliberately **no npm, bundler, framework, CSS framework, TypeScript or
test runner.** If you find yourself wanting one, something has been
overcomplicated. The Firebase SDK is loaded from the CDN as ES modules at a
**pinned version** (`12.16.0`) — pin any upgrade explicitly rather than using a
floating tag.

### Why not GitHub Pages

It works, but free GitHub accounts only serve Pages from **public** repos, and it
has no access-control layer. This board displays coworkers' names and activity,
so it goes on Cloudflare Pages behind Cloudflare Access instead. This decision is
recorded here so it does not need to be had again.

## Layout

```
index.html          markup + inline critical styles
styles.css          all styling
app.js              entry point, wiring, rendering, event handlers
lock.js             claim / release / force-release transactions
clock.js            server time offset + all time formatting
firebase-config.js  firebaseConfig object (committed — see below)
database.rules.json the rules to paste into the Firebase console
```

Flat on purpose. No `src/`, no `components/`, no `utils/`.

> **The Firebase web API key is not a secret.** It identifies the project; it does
> not authorise anything, and it is designed to ship in client code. Security
> comes from the database rules below. Do not build a scheme to hide it.

## Firebase setup

All of this is console work — none of it can be scripted from this repo.

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
   and publish.
6. **Realtime Database → Data →** create `/lock` with a single child
   `status` = `"free"` (a string). The app handles a missing `/lock` anyway, but
   seeding it means the first person to open the board sees the right thing.
7. Edit the account name and description at the top of `index.html` — they are
   hardcoded there, marked with an `EDIT ME` comment.

## Data model

Exactly one lock record plus an append-only log. Resist adding more.

```
/lock
  status           "free" | "held"
  holder           string, 1–40 chars       (absent when free)
  note             string, 0–120 chars      (optional — what they're doing)
  claimedAt        number, epoch ms         (absent when free)
  expectedMinutes  number, 1–480            (absent when free)

/log/{pushId}
  name             string    — who performed the action
  action           "claimed" | "released" | "force-released"
  at               number, epoch ms
  reason           string    — required for force-released, absent otherwise
  heldBy           string    — force-released only: who was holding it
```

`heldBy` is the one addition to the model as originally specified. A force
release has to record both names to be accountable, and the log entry is the only
place that information survives.

In the rules, `!data.exists()` on `/log/$entry` makes the log **append-only**:
entries can be created but never edited or deleted from the client. That is the
entire point of having a log. `$other: { ".validate": false }` on `/lock` means a
client cannot invent fields there.

## Running locally

ES modules will not load over `file://`, so serve the directory:

```
python -m http.server 8000
```

Then open <http://localhost:8000>. `localhost` is an authorized domain in
Firebase by default, so anonymous sign-in works with no extra setup.

If the config is missing or sign-in fails, the page shows an amber banner
explaining what to fix rather than failing silently.

## Deploying

Live at **<https://accountmanagementvue.pages.dev>**, behind Cloudflare Access on
the team domain `abdullahs-studio.cloudflareaccess.com`. Deployed 2026-08-01.

The team domain is **account-wide, not per-application** — there is one Zero Trust
organisation per Cloudflare account, and every Access app in it shares that login
domain. That is why it is named after the account rather than after this board.

All three steps below are done. They are written out because the Cloudflare UI
was renamed mid-2026 and the old instructions no longer match anything on screen.

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
   own hostname. The board itself never sees anyone's email address — people type
   a display name.

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

## Testing

There is no test runner, by design. The checklist below is the test suite. It has
been run once against the live Firebase project, in two real Chrome profiles
driven over the DevTools Protocol — separate profiles rather than two tabs,
because tabs share `localStorage` and cannot represent two people with different
saved names.

Verified end to end against the live database:

- [x] Claim from window A → window B updates without a reload
- [x] Release from A → B updates
- [x] Both windows claim in the same instant → exactly one succeeds, the other is
      told "Someone claimed it a moment ago", and only the winner is logged
- [x] B sees Force release but not Release while A holds the lock
- [x] Force release with an empty reason is rejected; with a reason it succeeds
      and logs both names
- [x] Elapsed timer ticks every second, and keeps counting across a reload from
      the same start time rather than restarting
- [x] Offline → indicator goes amber, reads "reconnecting…", and the card dims
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
run. They scroll off once there are ten real entries.

Verified against the deployed site on 2026-08-01:

- [x] The board loads on `accountmanagementvue.pages.dev`, anonymous sign-in
      succeeds, and the activity log renders — i.e. deploy step 3 worked
- [x] Every path on the hostname 302s to the Access login when unauthenticated
- [ ] **A teammate who is not the account owner can actually log in.** Blocked on
      the One-time PIN gotcha below. Do not skip this one.

## The three things that actually matter

Everything else here is straightforward. These three are where this kind of app
goes wrong.

**Never trust the browser clock.** If one person's laptop is six minutes fast,
their `claimedAt` is wrong for everyone reading the board. `clock.js` reads
Firebase's server offset once at startup and `serverNow()` applies it to every
timestamp written and every elapsed time computed. Nothing outside `clock.js`
calls `Date.now()`. The `serverTimestamp()` sentinel is deliberately not used
inside transactions — it does not resolve to a number during the local
optimistic run, which makes the callback awkward to reason about.

**Claims must be atomic.** Two people clicking Claim in the same second must not
both succeed, and read-then-write will eventually produce two holders. Every
state change in `lock.js` goes through `runTransaction`. Firebase may run a
transaction callback several times, so those callbacks are pure — no logging, no
DOM writes, no `await` — and log entries are appended after the transaction
resolves. A refused claim returns `{ok: false, reason: 'taken'}` and shows inline
text; it never retries automatically and never uses `alert()`.

**The connection indicator reflects the connection, not message age.** A frozen
page showing "Available" is worse than no board at all. The obvious approach —
"last synced N seconds ago" — is wrong here, because `onValue` only fires when
data changes: an account sitting free for two hours is perfectly healthy and
would look two hours stale. The indicator subscribes to `.info/connected`
instead, and the card visibly dims when the connection drops. A one-off `get()`
on `visibilitychange` covers a listener that died while the laptop was asleep.

## Limits and gotchas

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
- **Don't over-abstract.** Three small modules, plain functions, direct DOM
  manipulation. No state management layer, no event bus, no components.

## Deliberately deferred

Not built, listed so the decision is visible once real usage shows whether any
of it is needed.

- **A queue** — "join the waitlist, see your position". Only worth it if people
  are actually colliding.
- **A Slack or Discord webhook on release** — turns "check the board" into "the
  board tells me", which is the real adoption unlock. About 15 lines, and the
  strongest candidate for the first addition.
- **A daily usage summary** from the log.
- **Multiple accounts on one board** — plausible, but the data model would move
  from `/lock` to `/locks/{accountId}`. Don't pre-build for it; the migration is
  small.
