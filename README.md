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
4. Cloudflare dashboard → **Zero Trust → Access → Applications → Add a
   self-hosted application** for the Pages domain, with an email policy listing
   the team. Free for up to 50 users.

## Testing

There is no test runner, by design. The test suite is this checklist, run in two
browser windows side by side before deploying.

- [ ] Claim from window A → window B updates without a reload
- [ ] Release from A → B updates
- [ ] Both windows claim within the same second → exactly one succeeds, the
      other says "Someone claimed it a moment ago"
- [ ] B sees Force release but not Release while A holds the lock
- [ ] Force release with an empty reason is rejected; with a reason it succeeds
      and logs both names
- [ ] Elapsed timer ticks every second and survives a reload with the same value
- [ ] OS clock shifted ±10 minutes → elapsed time unchanged
- [ ] DevTools → Network → Offline → indicator goes amber and the card dims
- [ ] Back online → indicator recovers and the state resyncs
- [ ] Tab hidden 5 minutes, then refocused → state is current
- [ ] A 41-character name or a 121-character note is rejected and the UI shows a
      sane message rather than throwing
- [ ] Reads correctly on a phone screen
- [ ] A direct write attempt from a logged-out console is rejected by the rules

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
