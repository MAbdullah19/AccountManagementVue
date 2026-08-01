# Shared Account Status Board — Implementation Plan

A build spec for Claude Code. Read this whole document before writing any code.

---

## 1. What we're building

A single-page web app that answers one question for a small team: **is the shared account currently in use, and by whom?**

The workplace has one login for a service, and only one person can use it at a time. There is no technical way to enforce this. The team already understands the rule. This board exists purely to broadcast the current state so nobody logs in on top of someone else.

It is an **honour-system checkout board**, not an access control system.

### Non-goals — do not build these

- No enforcement of the lock. The app never blocks anyone from anything.
- No auto-release on disconnect / tab close. Users stay at their desk while working; they release manually.
- No heartbeat mechanism.
- No user accounts, passwords, or roles. People type their name.
- No integration with the underlying service being shared.
- No queue and no notifications in v1. See §11 for optional later phases.

### Success criteria

A person opens the tab, glances at it, and knows within one second whether the account is free. Claiming takes one click. Releasing takes one click. Two people cannot both hold the lock. The elapsed timer is accurate to the second regardless of whose laptop clock is wrong.

---

## 2. Stack and why

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vanilla HTML + CSS + ES modules | No build step means no toolchain to maintain, and it deploys to any static host unchanged. This app is ~400 lines. A framework is pure overhead here. |
| Realtime state | Firebase Realtime Database (Spark / free tier) | Push-based listeners, server-authoritative clock via `/.info/serverTimeOffset`, atomic transactions. All free at this scale. |
| Auth | Firebase Anonymous Auth | Not for identifying users — purely so database rules can require `auth != null` and block anonymous internet scanners from writing. Invisible to the user. |
| Hosting | Cloudflare Pages | Free, deploys from **private** repos, and Cloudflare Access (free up to 50 users) can gate the site by email with zero code. |
| Access control | Cloudflare Access | Keeps colleagues' names off the public internet. |

**Do not add:** npm, a bundler, React, Tailwind, TypeScript, a CSS framework, or a test runner. If you find yourself wanting one, you have overcomplicated something.

### On GitHub Pages

The user asked about it. It works, but free GitHub accounts only serve Pages from **public** repos, and it has no access-control layer. Since this board displays coworkers' names and activity, use Cloudflare Pages. Note this in the README so the decision isn't relitigated later.

---

## 3. Human prerequisites — cannot be automated

Stop and ask the user to complete these before Phase 1. You cannot do them from the CLI.

1. Create a Firebase project at console.firebase.google.com. Name it something like `account-board`. Google Analytics can be disabled.
2. In **Build → Realtime Database**, create a database. Pick the region closest to the team. Start in **locked mode** — we will paste real rules in Phase 1.
3. In **Build → Authentication → Sign-in method**, enable **Anonymous**.
4. In **Project settings → General → Your apps**, add a **Web app**. Copy the `firebaseConfig` object it shows.
5. Paste that config to me so I can write `firebase-config.js`.

> The Firebase web API key is **not a secret**. It identifies the project, it does not authorise anything. It is designed to ship in client code. Security comes from the database rules in §5. Do not build a scheme to hide it.

Later, for deployment (Phase 8): a Cloudflare account, and the repo pushed to GitHub or GitLab.

---

## 4. Repository layout

```
account-board/
├── index.html          markup + inline critical styles
├── styles.css          all styling
├── app.js              entry point, wiring, event handlers
├── lock.js             claim / release / force-release transactions
├── clock.js            server time offset + elapsed-time formatting
├── firebase-config.js  firebaseConfig object (committed; see note above)
├── README.md           setup, deploy, and "why" notes for whoever inherits this
└── .gitignore
```

Keep it flat. Do not create `src/`, `components/`, or `utils/`.

Import Firebase from the CDN as ES modules — no `npm install`:

```js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, runTransaction, push, get, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
```

Pin the version. Check for a newer stable 10.x/11.x release before starting and use whatever is current, but pin it explicitly rather than using a floating tag.

---

## 5. Data model

Exactly one lock record plus an append-only log. Resist adding more.

```
/lock
  status           "free" | "held"
  holder           string, 1–40 chars        (absent when free)
  note             string, 0–120 chars       (optional, what they're doing)
  claimedAt        number, epoch ms          (absent when free)
  expectedMinutes  number, 1–480             (absent when free)

/log/{pushId}
  name             string
  action           "claimed" | "released" | "force-released"
  at               number, epoch ms
  reason           string, optional — required for force-released
```

Initialise `/lock` to `{ "status": "free" }` manually in the Firebase console once, so the app never has to handle a null root on first load. Also handle null defensively anyway.

### Database rules

Paste these into **Realtime Database → Rules** and publish.

```json
{
  "rules": {
    "lock": {
      ".read": "auth != null",
      ".write": "auth != null",
      "status": {
        ".validate": "newData.isString() && (newData.val() === 'free' || newData.val() === 'held')"
      },
      "holder": { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 40" },
      "note": { ".validate": "newData.isString() && newData.val().length <= 120" },
      "claimedAt": { ".validate": "newData.isNumber()" },
      "expectedMinutes": { ".validate": "newData.isNumber() && newData.val() >= 1 && newData.val() <= 480" },
      "$other": { ".validate": false }
    },
    "log": {
      ".read": "auth != null",
      "$entry": {
        ".write": "auth != null && !data.exists()",
        ".validate": "newData.hasChildren(['name','action','at'])"
      }
    }
  }
}
```

`!data.exists()` makes the log append-only — entries can be created but never edited or deleted from the client. That is the point of having a log.

---

## 6. The three implementation details that matter

Everything else in this app is straightforward. These three are where it goes wrong.

### 6.1 Never trust the browser clock

If one person's laptop is six minutes fast, their `claimedAt` is wrong for everyone reading the board. Read Firebase's server offset once at startup and apply it to every timestamp you write:

```js
// clock.js
let offset = 0;
export function initClock(db) {
  onValue(ref(db, '.info/serverTimeOffset'), snap => { offset = snap.val() || 0; });
}
export const serverNow = () => Date.now() + offset;
```

Use `serverNow()` for every write and every elapsed-time calculation. Never call `Date.now()` directly outside this module.

Do not use the `serverTimestamp()` sentinel inside a transaction — the sentinel does not resolve to a number during the local optimistic run, which makes the transaction callback awkward to reason about. `serverNow()` is accurate to well under a second and is simpler.

### 6.2 Claims must be atomic

Two people clicking Claim in the same second must not both succeed. Read-then-write will eventually produce two holders. Use a transaction:

```js
// lock.js
export async function claim(db, { holder, note, expectedMinutes }) {
  const result = await runTransaction(ref(db, 'lock'), current => {
    if (current && current.status === 'held') return;   // undefined aborts the transaction
    return { status: 'held', holder, note: note || '', claimedAt: serverNow(), expectedMinutes };
  });
  if (!result.committed) return { ok: false, reason: 'taken' };
  await appendLog(db, { name: holder, action: 'claimed' });
  return { ok: true };
}
```

When `ok` is false, show an inline message — "Someone claimed it a moment ago" — and let the listener update the UI naturally. Do not retry automatically and do not use an `alert()`.

Release uses the same pattern in reverse. Two paths:

- **Release** — shown only when the stored `holder` matches the current user's saved name. Sets `{ status: 'free' }`, logs `released`.
- **Force release** — always available, but requires a typed reason before the button enables. Logs `force-released` with the reason and both names. Never hide this behind a confirm dialog; the friction should be the reason field, and the accountability should be the log entry.

### 6.3 The connection indicator must reflect connection, not message age

A frozen page showing "Available" is worse than no board at all, so the user must be able to see at a glance that the data is live.

The obvious approach — "last synced N seconds ago" — is **wrong here**, because `onValue` only fires when data changes. If the account sits free for two hours, no messages arrive and a naive indicator would show a two-hour-old sync while everything is perfectly healthy.

Subscribe to `.info/connected` instead:

```js
onValue(ref(db, '.info/connected'), snap => setConnected(snap.val() === true));
```

Green dot + "live" when true. Amber + "reconnecting…" when false, and dim the status card so a stale reading is visually obviously stale. Also fire a one-off `get()` on `visibilitychange` when the tab becomes visible — cheap insurance against a listener that died while the laptop was asleep.

---

## 7. UI specification

Single column, max-width ~560px, centred. Mobile-friendly by virtue of being one column — do not write media queries beyond what's needed to keep buttons tappable.

**Header** — the account identifier (e.g. `ops@company.com`) and a one-line description, both hardcoded in `index.html`. Connection indicator on the right.

**Status card** — the focal point. Must be readable from across a room.

- *Free*: green tint. "Available" plus a name field, an optional note field, an expected-duration input (default 30 minutes), and a Claim button.
- *Held*: red tint. Holder's name at ~20px, then "Since 2:14 PM · 32m 07s elapsed · est. free by 3:00 PM", then the note if present. Release (conditional) and Force release buttons.
- *Overdue*: when `serverNow() > claimedAt + expectedMinutes * 60000`, switch the card to amber and change the subtitle to "held 2h 14m — still in use?". **Purely visual.** Nothing auto-releases, nothing is blocked. It just makes a forgotten release legible to the room.

**Elapsed timer** — a `setInterval` at 1000ms recomputing from the stored `claimedAt`. The network carries one number; the browser does the ticking. Never poll to update a clock.

**Recent activity** — the last 10 log entries, newest first, as plain text lines. Use `query(ref(db,'log'), limitToLast(10))`.

**Name persistence** — save the name to `localStorage` on first claim and prefill it thereafter. This is the single highest-leverage adoption feature; claiming should be one click for a returning user.

### Visual direction

Flat, high-contrast, no gradients or shadows. System font stack. The status card carries essentially all the visual weight — everything else is quiet. Use colour semantically only (green free / red held / amber overdue) and pair it with text, so it still reads for colourblind users and in a grayscale screenshot.

---

## 8. Build phases

Complete and verify each phase before starting the next. Commit at each boundary.

**Phase 0 — scaffold.** Create the files. `python3 -m http.server 8000` from the repo root; ES modules will not load over `file://`. *Done when:* the page loads with static placeholder content.

**Phase 1 — connect.** Add `firebase-config.js`, initialise the app, sign in anonymously, publish the rules from §5, seed `/lock` to `{status:"free"}`. *Done when:* `onValue` on `/lock` logs the seeded object to the console.

**Phase 2 — read-only display.** Render the free and held states from live data. Test by editing values directly in the Firebase console. *Done when:* console edits appear in the browser within a second, with no page reload.

**Phase 3 — claim and release.** Wire the transactions from §6.2. *Done when:* two browser windows can hand the lock back and forth, and simultaneous claims produce exactly one winner and one "someone claimed it" message.

**Phase 4 — clock.** Add `clock.js`, the server offset, and the ticking elapsed timer. *Done when:* the timer ticks smoothly, and manually setting your OS clock forward ten minutes does **not** change the elapsed time shown.

**Phase 5 — connection and overdue states.** `.info/connected` indicator, `visibilitychange` refetch, amber overdue styling. *Done when:* DevTools offline mode flips the indicator within a few seconds and dims the card.

**Phase 6 — log.** Append on every claim / release / force-release; render the last 10. *Done when:* a full claim-release cycle produces two correctly ordered entries.

**Phase 7 — polish.** `localStorage` name, empty states, disabled-button states, keyboard `Enter` to claim, a `<title>` that shows the status so it's readable in a pinned tab (e.g. `● In use — Muhammad Abdullah`). Write the README.

**Phase 8 — deploy.** Push to a private repo. Connect it to Cloudflare Pages: no build command, output directory `/`. Add the Pages domain to Firebase's **Authentication → Settings → Authorized domains**, or anonymous sign-in will fail in production while working perfectly on localhost. Then set up Cloudflare Access with an email policy for the team.

---

## 9. Testing

There is no test runner. Testing is a manual checklist, run in two browser windows side by side before deploying.

- [ ] Claim from window A → window B updates without reload
- [ ] Release from A → B updates
- [ ] Both windows claim within the same second → exactly one succeeds
- [ ] B sees Force release but not Release while A holds the lock
- [ ] Force release with an empty reason is rejected; with a reason it succeeds and logs both names
- [ ] Elapsed timer ticks every second and survives a page reload with the same value
- [ ] OS clock shifted ±10 minutes → elapsed time unchanged
- [ ] DevTools → Network → Offline → indicator goes amber and the card dims
- [ ] Back online → indicator recovers, state resyncs
- [ ] Tab hidden 5 minutes, then refocused → state is current
- [ ] Name of 41+ characters and note of 121+ characters are rejected by the rules, and the UI shows a sane message rather than throwing
- [ ] Reads correctly on a phone screen
- [ ] Direct write attempt from a logged-out console is rejected by the rules

---

## 10. Gotchas

- **Authorized domains.** The single most common deploy failure. Anonymous auth works on `localhost` by default and silently fails on your Pages domain until you add it in the Firebase console.
- **`runTransaction` runs the callback more than once.** Keep it pure — no logging, no DOM writes, no `await` inside it. Append the log entry after the transaction resolves.
- **`onValue` fires immediately with current data on subscribe**, not only on change. Do not write code that assumes the first callback is a change event.
- **Detach listeners** if you ever add navigation. In a single static page this is moot, but do not create listeners inside event handlers.
- **Spark tier caps at 100 simultaneous connections.** Fine for this team; worth a line in the README so a future maintainer isn't surprised.
- **Rule validation failures reject the whole write** and surface as a permission-denied error. Wrap writes in try/catch and show the user something better than a console stack trace.
- **Don't over-abstract.** Four small modules, plain functions, direct DOM manipulation. No state management layer, no event bus, no component abstraction.

---

## 11. Deliberately deferred

Do not build these now. Listed so the user can decide later, once real usage shows whether they're needed.

- **Queue** — "join the waitlist, see your position". Only worth it if people are actually colliding.
- **Slack or Discord webhook** on release — turns "check the board" into "the board tells me", which is the real adoption unlock. Free, and about 15 lines. Strong candidate for the first addition.
- **Daily usage summary** from the log.
- **Multiple accounts** on one board — a real possibility, but the data model would move from `/lock` to `/locks/{accountId}`. Don't pre-build for it; the migration is small.

---

## 12. Definition of done

The app is deployed at a Cloudflare Pages URL behind Cloudflare Access, the team can reach it, every box in §9 is ticked, and the README explains the Firebase setup, the deploy process, and why the honour-system design was chosen — clearly enough that someone else could take it over without asking questions.
