# Context

Working state for the Account Board. `plan.md` is what we intend to do;
this file is what is currently true. Update it when a fact changes, not when
work merely progresses — progress lives in `plan.md`'s checkboxes.

Last updated: 2026-09-05.

---

## Where things are

| Thing | Value |
|---|---|
| Repo | `MAbdullah19/AccountManagementVue` (private) |
| Live site | <https://accountmanagementvue.pages.dev> |
| Hosting | Cloudflare Pages, no build step, output directory `/` |
| Access team domain | `vuepulse.cloudflareaccess.com` (account-wide, not per-app) |
| Firebase project | `vue-account-board`, RTDB in `asia-southeast1` |
| Owner / admin email | `abdullahbinsalim.08@gmail.com` — the address Access logs in with, and the one in `ADMIN_EMAILS` |
| Account being tracked | `users@vuepulse.com` |

## Files

```
index.html          markup, card templates, inline critical styles
activity.html       activity summary — "Time held, by day", admin only
log.html            full line-by-line log, admin only, paged
styles.css          all styling and the design tokens
app.js              startup, wiring, board rendering
activity.js         activity summary: pairs log lines into held time
log.js              full log: paged reads of /log
boot.js             Firebase init, sign-in, banner, connection pill, identity chip
lock.js             claim / release / force-release transactions
queue.js            join / leave the board's queue, and whose turn it is
accounts.js         account metadata writes
identity.js         Cloudflare Access identity + admin check
functions/api/identity.js   Pages Function: reads the Access email at the edge
clock.js            server time offset and all time formatting
firebase-config.js  firebaseConfig (committed on purpose — see README)
database.rules.json rules to paste into the Firebase console
preview.html        every card state, rendered without Firebase
plan.md             v2 plan and progress
context.md          this file
README.md           setup, deploy, and the reasoning worth keeping
account-board-implementation-plan.md   v1 spec, kept as history
```

`preview.html` pulls the real `<template>` elements out of `index.html` and
fills them with fixtures, so available / in use / overdue / queued can all
be looked at side by side without touching the live database. It earned its
place immediately: it caught `.admin-form { display: flex }` quietly overriding
the `hidden` attribute, which only worked because of the `!important` in
`index.html`'s inline block.

Flat on purpose. No `src/`, no build step, no npm. The Firebase SDK is imported
from the CDN at a **pinned** version (`12.16.0`).

`functions/` is the one exception to flat, and it is Cloudflare's fixed
convention rather than a choice: a file there becomes a route, so
`functions/api/identity.js` serves `/api/identity`. It exists because the
browser cannot read the Access identity on a `pages.dev` host — reasoning in
README. Still no build step and no dependencies.

Despite the repo name, there is **no Vue.js in this project** and none is
wanted. "Vue" is the company the board is built for — the accounts it tracks are
`@vuepulse.com`. Do not read it as a framework choice, and do not propose
migrating to one.

## Standing constraints

These come from v1 and have not been revisited:

- Nothing is enforced. The board reports, it does not block. The queue's
  seven-minute turn (see below) is the one partial exception, and it is still
  only a hidden button and a client-side refusal — the rules are unchanged.
- No auto-release, no heartbeat. A held account is never taken back by the
  board, however long it has been held.
- Nobody logs into the board itself. People type a display name, remembered in
  `localStorage`. Access at the edge is the only real gate.
- Force release requires a reason and never sits behind a confirm dialog. It
  used to be available to everyone; now it's admin-only — see below.
- Nothing outside `clock.js` calls `Date.now()`.
- Every lock change goes through `runTransaction`, and those callbacks stay pure.

## Decisions specific to v2

- **Red / black / white with gradients**, which reverses v1's "flat, no
  gradients" rule and repurposes red from *held* to *brand + held*. Available is
  now the absence of red rather than green. Reasoning in `plan.md` §2.1.
- **Admin is a UI-level gate, not security.** Identity comes from Cloudflare
  Access; Firebase auth is still anonymous, so the database rules cannot tell the
  owner from anyone else. `plan.md` §2.2.
- **Locks moved out from under accounts** to `/locks/{accountId}`, so
  owner-written metadata and everyone-written transaction paths stay separate.

## The roster: removed (2026-08-27)

v2 shipped a per-account roster ("Who this is for") — reference text, not
permission, naming who an account belonged to. It has since been removed from
the dashboard at the requester's instruction: the card, the owner's add/remove
controls, `accounts.js`'s `addUser`/`removeUser`, and the `users` schema under
`/accounts/{id}` in `database.rules.json` are all gone. Any `users` children
still sitting under old accounts in the live database are inert — nothing
reads or writes them anymore — and were left in place rather than scripted out,
consistent with how this project has always treated stale-node cleanup as a
manual console step (see the lock migration in `plan.md` §3).

## The queue (added after v2, rebuilt 2026-09-05)

**The first version, now gone.** A queue per account, joinable only after the
holder's 2.5-hour protected window, reserving nothing: the moment an account
freed up, claiming was first-come-first-served regardless of who had been
waiting. It lived at `/queue/{accountId}/{entryId}` and rendered inside each
held card.

**What replaced it**, at the requester's instruction:

- **One queue for the whole board**, at `/queue/{entryId}`, rendered in its own
  panel above the card grid rather than inside any card. Push keys sort
  chronologically, so join order is priority order with no rank field.
- **Joinable at any time by anyone**, whether or not anything is held. The
  2.5-hour gate on *joining* is gone.
- **One place each**, deduplicated on `sameIdentity` — the email where both
  sides have one, the typed name otherwise. Name and email are both shown, with
  the position number.
- **Seven minutes to claim.** When an account frees up it is offered to whoever
  is next in line, one offer per free account, oldest-free to
  longest-waiting. `RESERVATION_MS` in `queue.js`.
- **Miss it and you are dropped** from the queue entirely and the account goes
  back to first-come-first-served. Logged as `queue-timeout`.
- **Claiming anything dequeues you**, silently — the claim line is already the
  log entry that matters.
- **Anyone can leave; admins can remove anybody.**

### Two things worth knowing before changing it

**Reservations are derived, never stored.** `computeReservations()` takes the
accounts, the locks and the queue and returns the same answer in every browser.
A `/reservations` subtree would need somebody to write it when an account frees,
clear it when the window closes, and have an answer for the tab that was closed
before it could do either. The one thing this needed from the database was a
timestamp for when an account became free, which is the new `freedAt` on
`/locks/{id}` — a lock freed before that field existed simply never offers a
reservation.

**Expiry has no server behind it.** Whichever browsers have the board open
notice an expired turn and remove the entry, through a transaction, so several
tabs racing is harmless — one commits, the rest read null and abort. With every
tab closed nothing happens until somebody loads the page; the same person is
then offered the next account to free up and times out again, so it self-heals.
`RESERVATION_GRACE_MS` keeps an expired offer in its slot for a minute so the
queue below it does not shuffle before the removal lands.

### The 2.5 hours moved

The number survived, doing a different job: `SESSION_ALERT_AFTER_MS` in
`lock.js`. It no longer gates joining the queue — it is when the holder's own
card asks them to wrap up. Separate from `overdue`, which still fires on the
`expectedMinutes` they chose at claim time and is still what everyone else
sees. Both alerts on a held card are shown to the holder alone.

### Stale nested queue nodes

Old `/queue/{accountId}/{entryId}` data is inert: `readQueue()` requires both
`name` and `joinedAt` on the entry itself, so an old account-level node is
dropped rather than shown as a nameless line, and the new rules reject writes
to it. Left in place rather than scripted out, consistent with how this project
has always treated stale-node cleanup (see the roster above, and the lock
migration in `plan.md` §3) — deleting `/queue` once in the console is the
tidy-up whenever somebody wants it.

## Time held, by day (added after the queue)

Admin-only section on the activity page: who held which account, and for how
long, totalled per person per account per day. Completed time comes from
pairing "claimed" with the next "released"/"force-released" for the same
account in the loaded log window; a still-open hold is read straight from
`/locks` instead of inferred from the log, so "ongoing" is always accurate
even if the matching claim has scrolled out of the log's 200-entry window. A
force-released session is credited to the original holder (from the
`claimed` entry), not to whoever force-released it. Purely a computed view —
no new database schema, so no rules to publish for this one. Recomputes on
every log/lock change, plus a coarse 10-minute timer so an ongoing hold's
elapsed time doesn't go stale between events (deliberately not a per-second
tick — this is a summary to skim, not a stopwatch).

## Force release, restricted to admins (2026-08-27)

Force release used to be open to everyone, matching the "nothing is enforced"
philosophy. At the requester's instruction it is now gated to admins in the
UI: `app.js`'s `renderHeld()` hides `force-form` entirely unless
`state.identity.isAdmin`, and the `not-holder` message shown after a failed
release no longer points a non-admin at a button they can't see. This is
still a UI-level gate, not a rules change — `database.rules.json` still lets
any signed-in (anonymous) client write to `/locks`, same as every other owner
control. Nothing to publish for this one.

## Tab title is static again

The tab title used to carry live status (`○ 3 of 5 free · VuePulse Account
Board`), updated from `updateTitle()` on every board render. At the
requester's instruction it is now just `VuePulse Account Board`, matching
`index.html`'s `<title>` — `updateTitle()` and its call site were removed
since a static title needs no JS to set it.

## The activity page, split in two (2026-08-27)

What was one increasingly crowded page — filters, "Time held, by day", and
the full line-by-line log all stacked on top of each other — is now two,
matching how `index.html` and the activity page already split by concern:

- `activity.html` / `activity.js` — the **summary**. What "Activity" opens to
  now. Filters, then "Time held, by day". Still reads the same `/log` window
  and `/locks` to build it; just no longer renders the raw lines.
- `log.html` / `log.js` — the **full log**. Its own filters (independent of
  the summary's — no state carried across the link), the line-by-line list,
  and a "Load 200 older entries" button.

Nav between all three pages (`index.html`, `activity.html`, `log.html`) is
now a small set of pill-shaped links in the topbar rather than bare inline
text, so "how do I get back" has an obvious answer on every one of them.

**The log now pages.** It used to hard-cap at the most recent 200 entries
with a footnote; now that 200 is just the live window, kept current by
`onValue`, and "Load older" fetches another 200 further back with a one-off
`get()` anchored on `endBefore(oldestKeyLoaded)`. Entries are kept in a
`Map` keyed by push id rather than a plain array, so a live update and a
paged-in batch can never race or gap each other — the log is append-only
(enforced by the rules), so a key already in the map never needs re-fetching.
No rules change needed: ordering by key needs no `.indexOn`.

The summary intentionally still only ever sees the live 200-window — it was
already designed as "a summary to skim, not a stopwatch" (see below), and
pagination there was explicitly out of scope for this round.

## Open items

- [x] ~~`database.rules.json` needed publishing~~ — done 2026-08-27: the
      `"queue"` block and the removed `users` schema are both live.
- [ ] **`database.rules.json` needs publishing again (2026-09-05).** The queue
      rebuild reshaped `"queue"` from `$accountId/$entryId` to a flat `$entryId`
      and added `freedAt` to `"locks"`. Until it is pasted into Realtime
      Database → Rules, joining the queue and releasing an account are both
      rejected — and, per the note at the bottom of this file, that arrives as
      permission-denied rather than as a validation error.
- [ ] **The v2 rules are not published yet, and nothing works until they are.**
      Firebase denies any path the rules do not name, so the board currently
      reports `permission_denied at /locks`. Paste `database.rules.json` into
      Realtime Database → Rules, then run the migration in `plan.md` §3.
- [ ] One-time PIN is enabled and the login page serves an email field, but
      **nobody has completed a real PIN round-trip from a second person's inbox.**
      Do that before telling the team the board is ready.
- [ ] Access session revocation is manual — removing someone from the policy does
      not end their current session. See README.

## Things that have bitten this project before

Kept here so they are not rediscovered the hard way:

- **Firebase authorized domains.** Anonymous sign-in works on `localhost` by
  default and silently fails on the Pages domain until the domain is added under
  Authentication → Settings → Authorized domains.
- **Cloudflare stopped adding One-time PIN automatically.** New Zero Trust
  organisations get the Cloudflare provider instead, which authenticates against
  a Cloudflare dashboard account — useless for a teammate with a plain Gmail
  address.
- **`.assetsignore` is inert on Pages.** It only applies to a Workers deploy. The
  docs and `database.rules.json` really are served; Cloudflare Access is the only
  thing keeping them private.
- **A rule validation failure rejects the entire write** and surfaces as
  permission-denied, which reads like an auth problem and is not.
