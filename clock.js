// Server time, and every bit of time formatting the board needs.
//
// Nothing outside this module may call Date.now(). If one person's laptop is
// six minutes fast, their claimedAt is wrong for everyone reading the board,
// so all timestamps go through the server offset.
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

let offset = 0;

export function initClock(db) {
  onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
    offset = snap.val() || 0;
  });
}

// The server's idea of "now", in epoch ms. Use this for every write and every
// elapsed-time calculation.
export const serverNow = () => Date.now() + offset;

// Exposed for diagnostics only.
export const currentOffset = () => offset;

const pad = (n) => String(n).padStart(2, '0');

// Second-accurate, for the live ticking line: "07s", "32m 07s", "2h 14m 07s".
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

// Coarse, for the overdue subtitle: "14m", "2h 14m".
export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (totalMin > 0) return `${totalMin}m`;
  return 'under a minute';
}

// mm:ss, for a deadline short enough that the seconds are the point: "6:42",
// "0:09". Rounded up rather than down, so a countdown reaches 0:00 exactly when
// the deadline passes instead of a second before it.
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

// "2:14 PM" in the reader's own locale and timezone.
export function formatTimeOfDay(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Log lines: time alone for today, prefixed with the date for anything older.
export function formatLogTime(ms) {
  const then = new Date(ms);
  const time = formatTimeOfDay(ms);
  if (then.toDateString() === new Date(serverNow()).toDateString()) return time;
  return `${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
