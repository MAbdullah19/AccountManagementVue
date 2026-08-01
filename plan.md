# Account Board v2 — Plan

Tracks the second round of work: a visual rebuild plus multiple accounts and an
admin who can manage them. `account-board-implementation-plan.md` is the v1 spec
and is kept as history — **where the two disagree, this document wins.**

Progress lives in the checkboxes. `[ ]` not started, `[~]` in progress, `[x]`
done and verified.

---

## 1. What changes and why

v1 is a board for exactly one shared login. It works, it is deployed, and the
team can reach it. Three things are being added:

1. **Real account name.** The header still says the placeholder `ops@company.com`.
   It becomes `users@vuepulse.com`.
2. **A visual rebuild.** Red / black / white with gradients, minimal, and a
   layout that holds more than one account without becoming a wall.
3. **Multiple accounts, and an owner who manages them.** The board grows from one
   lock to a dashboard of accounts. The owner can add accounts. Each account
   carries a roster of the people who are supposed to use it, shown to everyone
   as reference so a teammate knows which login is theirs.

### Non-goals — still true, do not build these

Everything in v1 §1 stands. Nothing is enforced, there is no queue, no
heartbeat, no auto-release, no integration with the services being shared. The
roster is **reference text, not permission** — it does not stop anyone claiming
anything, and it must not look like it does.

---

## 2. Decisions taken before writing code

### 2.1 The palette reverses a v1 decision, deliberately

v1 §7 says *"flat, high-contrast, no gradients or shadows"* and assigns colour
semantically: **green = free, red = held, amber = overdue.** A red/black/white
palette collides with that head-on, because red currently means *someone is
using this*.

The resolution:

| State | Treatment |
|---|---|
| Available | White / near-white card, graphite text, thin dark rule. Calm and empty-looking. |
| In use | Red gradient, white text. The loudest thing on the page. |
| Overdue | Deep red → near-black gradient, plus the words "still in use?". |

Red keeps meaning *occupied* — it is promoted to the brand accent rather than
reassigned. Available becomes *the absence of red* instead of green.

The v1 rule that survives untouched: **colour is never the only signal.** Every
state still spells itself out in words, so the board reads in grayscale and for
colourblind users. Gradients stay confined to surfaces; text sits on flat
colour, never on a gradient mid-stop, so contrast stays checkable.

### 2.2 Admin identity comes from Cloudflare Access

The site already sits behind Access, which authenticates a real email address
before anything loads. The app reads that address from
`/cdn-cgi/access/get-identity` and compares it to an allowlist in the code.

**This is a UI-level gate and the code must say so.** Firebase auth is still
anonymous, so the database rules cannot tell the owner from anyone else — a
teammate with devtools could still write to `/accounts`. That is consistent with
how the rest of the board already works (force-release is deliberately available
to everyone), but it must never be described as security.

The alternative — Firebase Google sign-in, which *could* be enforced in the
rules — was considered and rejected for now: it adds a second auth path through
the whole app for one person's convenience. Recorded here so it is not
relitigated silently; if the roster ever becomes load-bearing, this is the thing
to revisit.

`get-identity` does not exist on `localhost`, so local development needs a
fallback. It is scoped strictly to `localhost` / `127.0.0.1` hostnames.

### 2.3 Layout: every account is a card

A responsive grid of cards, each with its own state, timer and controls, so one
glance answers *"is anything free"* for the whole team. Good to roughly a dozen
accounts; past that this wants the list-and-detail layout instead.

---

## 3. Data model

v1 §11 predicted this migration and it is the shape it predicted, with the lock
kept in its own subtree rather than nested under the account.

```
/accounts/{accountId}
  label          string, 1–60    e.g. "users@vuepulse.com"
  description    string, 0–120   optional, one line about the account
  createdAt      number, epoch ms
  users/{userId}
    name         string, 1–40    a person who should be using this account
    note         string, 0–60    optional — role, team, "primary"

/locks/{accountId}
  status           "free" | "held"
  holder           string, 1–40             (absent when free)
  note             string, 0–120            (absent when free)
  claimedAt        number, epoch ms         (absent when free)
  expectedMinutes  number, 1–480            (absent when free)

/log/{pushId}
  accountId      string   — which account this happened to
  accountLabel   string   — denormalised, so the line still reads if the account is deleted
  name           string
  action         "claimed" | "released" | "force-released"
  at             number, epoch ms
  reason         string   — force-released only
  heldBy         string   — force-released only
```

**Locks live outside `/accounts` on purpose.** Account metadata is owner-written
and rarely changes; locks are written by everyone, constantly, through
transactions. Nesting them would tangle the two under one `.write` rule and put
a transaction path inside a node the owner also rewrites.

`accountLabel` is denormalised into the log for the same reason `heldBy` was in
v1: the log has to stay readable after the thing it refers to is gone.

### Migration of the live database

There is real data in `/lock` on the deployed project. Console work, once:

- [ ] Create `/accounts/primary` with `label: "users@vuepulse.com"` and a
      `createdAt` number.
- [ ] Move the existing `/lock` object to `/locks/primary`.
- [ ] Delete the old `/lock`.
- [ ] Publish the updated `database.rules.json`.

Until this is done the deployed board shows the empty state. The app does not
migrate anything itself — a client-side migration racing across several browsers
is a worse problem than four clicks in the console.

---

## 4. Phases

Each phase ends with the app working and a commit. Do not start the next one
until the current one is verified.

### Phase 1 — header and docs
- [ ] `ops@company.com` → `users@vuepulse.com` in `index.html`
- [ ] Write `plan.md` and `context.md`
- [ ] Commit

### Phase 2 — visual system
- [ ] Design tokens: red/black/white ramp, gradients, radii, spacing, type scale
- [ ] Restyle the existing board against the new tokens
- [ ] Header, banner, card, forms, buttons, log, footer all rebuilt
- [ ] Focus states survive — every control keeps a visible focus ring
- [ ] Contrast checked on red-on-white and white-on-red
- [ ] *Done when:* the single-account board looks new and behaves identically
- [ ] Commit

### Phase 3 — multiple accounts
- [ ] `accounts.js` — read accounts, create, rename, delete
- [ ] `lock.js` takes an `accountId`; every path becomes `locks/{id}`
- [ ] `<template>` for a card, cloned per account
- [ ] **Cards update in place.** A lock change on one card must not rebuild the
      others — someone typing their name into card B must not lose it because
      card A changed hands. This is the main correctness risk in the rewrite.
- [ ] Per-card claim / release / force-release, per-card messages
- [ ] Log lines name their account
- [ ] Empty state when there are no accounts yet
- [ ] *Done when:* two accounts can be held independently in two windows
- [ ] Commit

### Phase 4 — the owner
- [ ] `identity.js` — `get-identity`, allowlist, localhost fallback
- [ ] Admin-only "Add account" form
- [ ] Rename and delete an account, delete guarded when the account is held
- [ ] Nothing admin-shaped renders at all for a non-admin
- [ ] *Done when:* the controls appear for the owner and are absent otherwise
- [ ] Commit

### Phase 5 — the roster
- [ ] Allowed-user list per account, visible to everyone
- [ ] Owner can add and remove people
- [ ] Reads as reference, not as permission
- [ ] *Done when:* a teammate can see which account is theirs without asking
- [ ] Commit

### Phase 6 — rules, docs, verification
- [ ] `database.rules.json` covers `/accounts`, `/locks`, the new `/log` fields
- [ ] README: new data model, migration steps, the admin caveat from §2.2
- [ ] Work the testing checklist (§5) in two browser profiles
- [ ] Commit and push

---

## 5. Testing

Same approach as v1: no test runner, the checklist is the suite, run in two real
browser profiles rather than two tabs, because tabs share `localStorage`.

Carried over from v1 and still required, now per-account:

- [ ] Claim in window A → window B updates without a reload
- [ ] Simultaneous claims on the *same* account → exactly one winner
- [ ] Release, force-release with and without a reason
- [ ] Elapsed timer ticks and survives a reload
- [ ] Offline → indicator and dimming; back online → resync
- [ ] Over-long names, notes and out-of-range durations rejected by the rules

New, and the ones most likely to actually break:

- [ ] Simultaneous claims on **different** accounts → both succeed
- [ ] Typing a name into card B, then card A changes hands → B's text survives
- [ ] Adding an account makes it appear in the other window with no reload
- [ ] Deleting an account removes its card and leaves its log lines readable
- [ ] A non-admin sees no admin controls anywhere in the DOM
- [ ] The roster renders for a non-admin and is not editable
- [ ] Reads correctly at 360px with several accounts
- [ ] Grid reflows sensibly at 1, 2, 3 and 7 accounts

---

## 6. Deferred again

- **A queue.** Still only worth it if people actually collide.
- **Slack / Discord webhook on release.** Still the strongest candidate for the
  next addition, and multi-account makes it more useful, not less.
- **Enforced admin via Firebase Google sign-in.** See §2.2.
- **Per-account activity history.** The log is global and filtering it by
  account is a display change, not a model change. Wait for someone to ask.
