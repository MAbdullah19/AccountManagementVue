# Context

Working state for the Account Board. `plan.md` is what we intend to do;
this file is what is currently true. Update it when a fact changes, not when
work merely progresses — progress lives in `plan.md`'s checkboxes.

Last updated: 2026-08-01.

---

## Where things are

| Thing | Value |
|---|---|
| Repo | `MAbdullah19/AccountManagementVue` (private) |
| Live site | <https://accountmanagementvue.pages.dev> |
| Hosting | Cloudflare Pages, no build step, output directory `/` |
| Access team domain | `abdullahs-studio.cloudflareaccess.com` (account-wide, not per-app) |
| Firebase project | `vue-account-board`, RTDB in `asia-southeast1` |
| Owner / admin email | `abdullahbinsalim.08@gmail.com` — the address Access logs in with, and the one in `ADMIN_EMAILS` |
| Account being tracked | `users@vuepulse.com` |

## Files

```
index.html          markup, card templates, inline critical styles
styles.css          all styling and the design tokens
app.js              startup, wiring, board rendering
lock.js             claim / release / force-release transactions
queue.js            join / leave the per-account queue
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

- Nothing is enforced. The board reports, it does not block.
- No auto-release, no heartbeat. The queue (see below) is a signal, same rule.
- Nobody logs into the board itself. People type a display name, remembered in
  `localStorage`. Access at the edge is the only real gate.
- Force release stays available to everyone, with a required reason, and never
  behind a confirm dialog.
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

## The queue (added after v2)

Once an account has been held for **2.5 hours**, anyone else can join a queue
for it — visible to everyone, and it's what tells the holder "people are
waiting, please wrap up." Same honour-system rule as everything else: joining
the queue reserves nothing, and the moment the account actually frees up,
claiming is first-come-first-served regardless of queue position. Lives in
`queue.js`, at `/queue/{accountId}/{entryId}` in the database, alongside
`/accounts`, `/locks` and `/log`.

## Open items

- [ ] **`database.rules.json` is not published yet** — it has a new `"queue"`
      block, and the `users` schema under `/accounts/{id}` has been removed
      along with the roster. Paste the updated file into Realtime Database →
      Rules — until then, joining or leaving a queue reads as
      `permission_denied at /queue`.
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
