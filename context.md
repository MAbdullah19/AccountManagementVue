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
| Owner / admin email | `bloodstone.08water@gmail.com` |
| Account being tracked | `users@vuepulse.com` |

## Files

```
index.html          markup, card template, inline critical styles
styles.css          all styling and the design tokens
app.js              startup, wiring, board rendering
lock.js             claim / release / force-release transactions
accounts.js         account metadata and roster writes
identity.js         Cloudflare Access identity + admin check
clock.js            server time offset and all time formatting
firebase-config.js  firebaseConfig (committed on purpose — see README)
database.rules.json rules to paste into the Firebase console
plan.md             v2 plan and progress
context.md          this file
README.md           setup, deploy, and the reasoning worth keeping
account-board-implementation-plan.md   v1 spec, kept as history
```

Flat on purpose. No `src/`, no build step, no npm. The Firebase SDK is imported
from the CDN at a **pinned** version (`12.16.0`).

Despite the repo name, there is **no Vue in this project** and none is wanted.
The name is historical.

## Standing constraints

These come from v1 and have not been revisited:

- Nothing is enforced. The board reports, it does not block.
- No auto-release, no heartbeat, no queue.
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
- **The roster is reference text, not permission.** It tells a teammate which
  login is theirs. It does not restrict claiming and must not look like it does.

## Open items

- [ ] Live database still holds the v1 `/lock`; the migration in `plan.md` §3 has
      not been run.
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
