// The activity page: the whole log, on its own, so the board stays one screen.
//
// Read-only. Nothing on this page writes, which is why it needs neither lock.js
// nor accounts.js.
import { ref, onValue, get, query, limitToLast }
  from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { initClock, formatLogTime, formatDuration, serverNow } from './clock.js';
import { loadIdentity } from './identity.js';
import { connect, showBanner, watchConnection, renderWho } from './boot.js';
import { initTheme } from './theme.js';
import { initKineticGrid } from './grid.js';

const el = (id) => document.getElementById(id);

// Deeper than the board's old twelve, because scrolling back is the entire
// reason this page exists. Still bounded: the log is append-only and grows
// forever, and nobody reads the thousandth line.
const LOG_LIMIT = 200;

let db = null;

/* ------------------------------------------------------------------ lines */

// Names and reasons are free text typed by colleagues, so every line is built
// with textContent. Nothing here touches innerHTML.
function describe(entry) {
  // The name is typed and the email is not, so the email is shown alongside it:
  // the line has to say who really did this, not only who said they did.
  // Omitted when they are the same string, which is how force-release entries
  // are written, and absent entirely from anything logged before this existed.
  const shown = entry.name || 'Someone';
  const name = entry.email && entry.email !== entry.name
    ? `${shown} (${entry.email})`
    : shown;

  // v1 entries predate multiple accounts and carry no label.
  const target = entry.accountLabel ? `${entry.accountLabel}` : 'the account';

  switch (entry.action) {
    case 'claimed':
      return `${name} claimed ${target}`;
    case 'released':
      return `${name} released ${target}`;
    case 'force-released': {
      const who = entry.heldBy ? ` (held by ${entry.heldBy})` : '';
      const why = entry.reason ? `: “${entry.reason}”` : '';
      return `${name} force-released ${target}${who}${why}`;
    }
    case 'joined-queue':
      return `${name} joined the queue for ${target}`;
    case 'left-queue':
      return `${name} left the queue for ${target}`;
    default:
      return `${name} ${entry.action || 'did something'}`;
  }
}

function logLine(entry) {
  const li = document.createElement('li');

  // Which of the three things happened, before the sentence has been read.
  // Styling only — the line still says it in words, and an entry from a future
  // version with an action nobody here has heard of just gets the empty dot.
  if (typeof entry.action === 'string') li.dataset.action = entry.action;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = typeof entry.at === 'number' ? formatLogTime(entry.at) : '';

  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = describe(entry);

  li.append(time, text);
  return li;
}

/* ---------------------------------------------------------------- filters */

// Narrowing happens in the browser, over the window already on the page. The
// log is keyed by push id, so a server-side date query would need an index and
// a fresh listener on every change of mind; sifting two hundred lines costs
// nothing and keeps the page to one subscription. The price is that filters
// cannot see past the window, which is why the foot line says so.
const filters = { accountId: '', from: '', to: '' };

// The window, newest first, exactly as the log gave it to us.
let entries = [];

// The accounts that still exist, live from /accounts. Only for naming and
// ordering the dropdown — the filter itself matches on the accountId stored in
// each log entry, so deleting an account does not rewrite its history.
const roster = new Map();

// Live from /locks — the authoritative source for "still going" in the held
// summary below, rather than an inference from a log window that might not
// reach back to the matching claim.
let locks = {};

// Completed and ongoing hold sessions, recomputed whenever entries or locks
// change. Kept separate from the filtered view of them so the filters can be
// re-applied without re-pairing the log.
let allSessions = [];

const anyFilter = () => Boolean(filters.accountId || filters.from || filters.to);

/* A date input hands back "YYYY-MM-DD", read in the reader's own timezone —
   the same timezone formatLogTime prints in, so the day on screen and the day
   in the box are the same day. Built field by field rather than with
   Date.parse, which reads a bare date string as UTC. */
function dayBounds(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;

  const [, y, m, d] = parts.map(Number);
  const start = new Date(y, m - 1, d);
  // The next midnight minus a millisecond, rather than +24h: on the two days a
  // year the clocks move, the day is not 24 hours long.
  const end = new Date(y, m - 1, d + 1);
  return { start: start.getTime(), end: end.getTime() - 1 };
}

const isoDay = (ms) => {
  const at = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

// The day `back` days ago, in the same YYYY-MM-DD a date input speaks.
function dayAgo(back) {
  const at = new Date(serverNow());
  at.setDate(at.getDate() - back);
  return isoDay(at.getTime());
}

function matches(entry, from, to) {
  // v1 entries predate multiple accounts and carry no accountId, so picking a
  // specific account hides them. That is the honest answer: nothing records
  // which account they were about.
  if (filters.accountId && entry.accountId !== filters.accountId) return false;

  if (from === null && to === null) return true;

  // Same reasoning for an entry with no timestamp: it cannot be shown to fall
  // inside a range, so a range excludes it.
  if (typeof entry.at !== 'number') return false;
  if (from !== null && entry.at < from) return false;
  if (to !== null && entry.at > to) return false;
  return true;
}

// Every account the dropdown can offer: the ones that still exist, plus any the
// log remembers that have since been deleted. Their entries are still on the
// page, so they still have to be selectable.
function accountOptions() {
  const options = new Map();

  for (const [id, label] of roster) options.set(id, { id, label, gone: false });

  for (const entry of entries) {
    const id = entry.accountId;
    if (typeof id !== 'string' || !id || options.has(id)) continue;
    options.set(id, { id, label: entry.accountLabel || 'a deleted account', gone: true });
  }

  return [...options.values()].sort((a, b) =>
    a.gone !== b.gone
      ? Number(a.gone) - Number(b.gone)
      : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function syncAccountOptions() {
  const select = el('filter-account');
  const options = accountOptions();

  select.textContent = '';

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All accounts';
  select.append(all);

  for (const account of options) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.gone ? `${account.label} (deleted)` : account.label;
    select.append(option);
  }

  // A selection that no longer has entries or an account behind it has nothing
  // left to filter, so it goes back to showing everything rather than silently
  // filtering to nothing.
  if (filters.accountId && !options.some((a) => a.id === filters.accountId)) {
    filters.accountId = '';
  }
  select.value = filters.accountId;
}

// A preset is "on" when the two dates say what it says, so hand-editing a date
// releases the chip rather than leaving it lit and lying.
function syncPresets() {
  const today = dayAgo(0);
  const wanted = {
    today: { from: today, to: today },
    7: { from: dayAgo(6), to: today },
    30: { from: dayAgo(29), to: today },
  };

  for (const btn of document.querySelectorAll('.filter-presets .chip')) {
    const range = wanted[btn.dataset.range];
    const on = Boolean(range) && filters.from === range.from && filters.to === range.to;
    btn.setAttribute('aria-pressed', String(on));
  }
}

/* ------------------------------------------------------- time held, by day */

// Pairs each "claimed" with the next "released" or "force-released" for the
// same account, walking the window in chronological order (the log itself is
// newest-first). A claim with no closing entry in the window is dropped
// rather than guessed at — an account currently held shows up instead as an
// ongoing session below, read straight from /locks, which is authoritative
// and does not depend on the claim still being inside the window.
function pairSessions(list) {
  const chronological = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const open = new Map(); // accountId -> the "claimed" entry that opened it
  const sessions = [];

  for (const entry of chronological) {
    if (typeof entry.accountId !== 'string' || !entry.accountId) continue;

    if (entry.action === 'claimed') {
      open.set(entry.accountId, entry);
      continue;
    }

    if (entry.action !== 'released' && entry.action !== 'force-released') continue;

    const start = open.get(entry.accountId);
    if (!start) continue; // the claim that opened this fell outside the window
    open.delete(entry.accountId);
    if (typeof start.at !== 'number' || typeof entry.at !== 'number') continue;

    // A force-release's own "name" is whoever force-released it, not the
    // holder — the session belongs to the person named in the claim.
    sessions.push({
      day: isoDay(start.at),
      accountId: entry.accountId,
      accountLabel: entry.accountLabel || start.accountLabel || 'a deleted account',
      holderKey: (start.email || start.name || '').toLowerCase(),
      holderName: start.name || 'Someone',
      durationMs: Math.max(0, entry.at - start.at),
      ongoing: false,
    });
  }

  return sessions;
}

// Every currently-held account, straight from /locks rather than inferred
// from the log — so "ongoing" is never a guess about a claim the window
// might not reach back to.
function ongoingSessions() {
  const sessions = [];

  for (const [accountId, lock] of Object.entries(locks)) {
    if (!lock || lock.status !== 'held' || typeof lock.claimedAt !== 'number') continue;

    sessions.push({
      day: isoDay(lock.claimedAt),
      accountId,
      accountLabel: roster.get(accountId) || 'a deleted account',
      holderKey: (lock.email || lock.holder || '').toLowerCase(),
      holderName: lock.holder || 'Someone',
      durationMs: Math.max(0, serverNow() - lock.claimedAt),
      ongoing: true,
    });
  }

  return sessions;
}

function recomputeSessions() {
  allSessions = [...pairSessions(entries), ...ongoingSessions()];
}

// Same two filters as the log above, applied to a session's day rather than
// to a single timestamp.
function sessionMatchesFilters(session, from, to) {
  if (filters.accountId && session.accountId !== filters.accountId) return false;
  if (from === null && to === null) return true;

  const bounds = dayBounds(session.day);
  if (!bounds) return false;
  if (from !== null && bounds.end < from) return false;
  if (to !== null && bounds.start > to) return false;
  return true;
}

// One row per person per account per day, totalled — not one row per
// session, so someone claiming and releasing the same account five times in
// an afternoon reads as one line, not five.
function summariseHeldTime(from, to) {
  const days = new Map(); // day -> Map(accountId::holderKey -> row)

  for (const session of allSessions) {
    if (!sessionMatchesFilters(session, from, to)) continue;

    if (!days.has(session.day)) days.set(session.day, new Map());
    const rows = days.get(session.day);
    const key = `${session.accountId}::${session.holderKey}`;

    const row = rows.get(key) || {
      accountId: session.accountId,
      accountLabel: session.accountLabel,
      holderName: session.holderName,
      totalMs: 0,
      sessionCount: 0,
      ongoingCount: 0,
    };

    row.totalMs += session.durationMs;
    row.sessionCount += 1;
    if (session.ongoing) row.ongoingCount += 1;
    // Free text can drift in spelling between sessions; the most recent one
    // wins rather than the first.
    row.holderName = session.holderName;

    rows.set(key, row);
  }

  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // newest day first
    .map(([day, rows]) => ({
      day,
      rows: [...rows.values()].sort((a, b) =>
        a.accountLabel.localeCompare(b.accountLabel, undefined, { sensitivity: 'base' })
        || a.holderName.localeCompare(b.holderName, undefined, { sensitivity: 'base' })),
    }));
}

function dayHeading(day) {
  if (day === dayAgo(0)) return 'Today';
  if (day === dayAgo(1)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function heldRow(row) {
  const li = document.createElement('li');
  li.className = 'held-row';

  const account = document.createElement('span');
  account.className = 'held-account';
  account.textContent = row.accountLabel;
  li.append(account);

  const holder = document.createElement('span');
  holder.className = 'held-holder';
  holder.textContent = row.holderName;
  li.append(holder);

  const duration = document.createElement('span');
  duration.className = 'held-duration';
  duration.textContent = formatDuration(row.totalMs);
  li.append(duration);

  if (row.sessionCount > 1) {
    const count = document.createElement('span');
    count.className = 'held-count';
    count.textContent = `across ${row.sessionCount} sessions`;
    li.append(count);
  }

  if (row.ongoingCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'held-ongoing';
    badge.textContent = 'ongoing';
    li.append(badge);
  }

  return li;
}

function renderHeldSummary(groups, total) {
  const container = el('held-summary-list');
  container.textContent = '';

  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'held-empty';
    empty.textContent = anyFilter()
      ? 'No completed or ongoing holds match these filters.'
      : 'No completed or ongoing holds yet.';
    container.append(empty);
  } else {
    for (const group of groups) {
      const day = document.createElement('div');
      day.className = 'held-day';

      const heading = document.createElement('h3');
      heading.className = 'held-day-head';
      heading.textContent = dayHeading(group.day);
      day.append(heading);

      const list = document.createElement('ul');
      list.className = 'held-rows';
      for (const row of group.rows) list.append(heldRow(row));
      day.append(list);

      container.append(day);
    }
  }

  // Only the completed side of this is bounded by the log window — an
  // ongoing hold always comes straight from /locks regardless of how far
  // back the log reaches.
  const foot = el('held-summary-foot');
  foot.textContent = total >= LOG_LIMIT
    ? `Completed sessions are limited to the log's most recent ${LOG_LIMIT} entries. Ongoing holds are always current.`
    : '';
  foot.hidden = !foot.textContent;
}

/* ----------------------------------------------------------------- render */

function render(shown, total, note) {
  const list = el('log-list');
  list.textContent = '';

  if (!shown.length) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = note || (total
      ? 'Nothing in the window matches these filters.'
      : 'No activity yet.');
    list.append(empty);
  } else {
    for (const entry of shown) list.append(logLine(entry));
  }

  // Only worth saying once the window is actually cutting something off — and
  // once it is, anyone filtering has to know the filters cannot reach past it.
  const foot = el('log-foot');
  foot.textContent = total >= LOG_LIMIT
    ? anyFilter()
      ? `The window is the most recent ${LOG_LIMIT} entries. Filters search inside it, not beyond it.`
      : `Showing the most recent ${LOG_LIMIT} entries.`
    : '';
  foot.hidden = !foot.textContent;
}

function renderCount(shown, total, note) {
  const count = el('filter-count');

  if (!anyFilter()) {
    count.textContent = '';
    count.hidden = true;
    return;
  }

  count.textContent = note
    || `Showing ${shown} of ${total} ${total === 1 ? 'entry' : 'entries'}.`;
  count.dataset.tone = note ? 'error' : 'plain';
  count.hidden = false;
}

// The one place the filters meet the entries. Everything that changes either
// calls this and nothing else.
function apply() {
  const from = filters.from ? dayBounds(filters.from)?.start ?? null : null;
  const to = filters.to ? dayBounds(filters.to)?.end ?? null : null;

  // Two valid dates in the wrong order is a typo, not an empty log, and saying
  // "no activity" to it would send someone looking for a bug.
  const backwards = from !== null && to !== null && from > to;
  const note = backwards ? 'That range ends before it starts.' : '';

  const shown = backwards ? [] : entries.filter((entry) => matches(entry, from, to));

  el('filter-clear').hidden = !anyFilter();
  syncPresets();
  renderCount(shown.length, entries.length, note);
  render(shown, entries.length, note);
  renderHeldSummary(backwards ? [] : summariseHeldTime(from, to), entries.length);
}

function setEntries(next) {
  entries = next;
  recomputeSessions();
  syncAccountOptions();
  apply();
}

/* ---------------------------------------------------------------- wiring */

function wireFilters() {
  el('filter-account').addEventListener('change', (event) => {
    filters.accountId = event.target.value;
    apply();
  });

  for (const id of ['filter-from', 'filter-to']) {
    el(id).addEventListener('change', () => {
      filters.from = el('filter-from').value;
      filters.to = el('filter-to').value;
      apply();
    });
  }

  for (const btn of document.querySelectorAll('.filter-presets .chip')) {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range;
      const on = btn.getAttribute('aria-pressed') === 'true';

      // Clicking the lit chip turns the range back off, which is the only way
      // to undo a preset without reaching for Clear and losing the account too.
      const back = range === 'today' ? 0 : Number(range) - 1;
      filters.from = on ? '' : dayAgo(back);
      filters.to = on ? '' : dayAgo(0);

      el('filter-from').value = filters.from;
      el('filter-to').value = filters.to;
      apply();
    });
  }

  el('filter-clear').addEventListener('click', () => {
    filters.accountId = '';
    filters.from = '';
    filters.to = '';
    el('filter-account').value = '';
    el('filter-from').value = '';
    el('filter-to').value = '';
    apply();
  });

  // A form here is for grouping and labelling, not for submitting; Enter in a
  // date field would otherwise reload the page.
  el('filters').addEventListener('submit', (event) => event.preventDefault());
}

// limitToLast hands entries back oldest-first; the page reads newest-first.
function readLog(snap) {
  const list = [];
  snap.forEach((child) => {
    list.push(child.val());
  });
  return list.reverse();
}

/* ---------------------------------------------------------------- startup */

// Not a permission. Anyone already past Cloudflare Access can read /log
// straight out of the database with devtools, because Firebase auth here is
// anonymous and the rules cannot tell one reader from another. What this does
// is keep the log off the screen of everyone it is not for. Same honesty as
// the owner controls on the board — see the README before building on it.
function showLocked() {
  el('locked').hidden = false;
  el('log-list').hidden = true;
  el('sub').hidden = true;
  // The filters start hidden and are only shown once the reader has been named,
  // so this is belt and braces — but the controls must never outlive the log
  // they narrow.
  el('filters').hidden = true;
  el('filter-count').hidden = true;
  el('held-summary').hidden = true;
  // Nothing is connecting, so a pill that says "connecting…" forever would be
  // a lie.
  el('conn').hidden = true;
}

async function start() {
  // Before any await: the theme has to work on the locked page too, which is
  // the only thing most readers of this URL will ever see.
  initTheme();
  initKineticGrid();

  // Asked first, and on its own: a non-owner never reaches Firebase at all, so
  // the log is not fetched into a page that is not going to show it.
  const identity = await loadIdentity();
  renderWho(identity);

  if (!identity.isAdmin) {
    showLocked();
    return;
  }

  db = await connect();
  if (!db) return;

  initClock(db);
  watchConnection(db);

  wireFilters();
  el('filters').hidden = false;
  el('held-summary').hidden = false;

  // The dropdown names the accounts the board has now; the log supplies the
  // ones it used to have. Neither listener owns the list, so either can arrive
  // first.
  onValue(ref(db, 'accounts'), (snap) => {
    roster.clear();
    snap.forEach((child) => {
      const label = child.val()?.label;
      roster.set(child.key, typeof label === 'string' && label ? label : 'Untitled account');
    });
    syncAccountOptions();
    recomputeSessions();
    apply();
  });

  // The held summary's "ongoing" rows read this directly, rather than
  // inferring a still-open claim from the log — see pairSessions above.
  onValue(
    ref(db, 'locks'),
    (snap) => {
      locks = snap.val() || {};
      recomputeSessions();
      apply();
    },
    (err) => showBanner(
      'Cannot read the board',
      `${err.message}. Check that the Realtime Database rules have been published.`
    )
  );

  onValue(
    query(ref(db, 'log'), limitToLast(LOG_LIMIT)),
    (snap) => setEntries(readLog(snap)),
    (err) => showBanner(
      'Cannot read the log',
      `${err.message}. Check that the Realtime Database rules have been published.`
    )
  );

  // Nothing else re-renders an ongoing hold's elapsed time on its own — nobody
  // claims or releases anything just so this number moves. Ten minutes is
  // rough on purpose: this is a summary to skim, not a stopwatch, and it is
  // not worth a per-second tick like the board's own held-card timer.
  setInterval(() => {
    recomputeSessions();
    apply();
  }, 10 * 60 * 1000);

  // Cheap insurance against a listener that died while the laptop was asleep.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function refresh() {
  try {
    const [snap, locksSnap] = await Promise.all([
      get(query(ref(db, 'log'), limitToLast(LOG_LIMIT))),
      get(ref(db, 'locks')),
    ]);
    locks = locksSnap.val() || {};
    setEntries(readLog(snap));
  } catch (err) {
    console.warn('[board] refetch on focus failed', err);
  }
}

start();
