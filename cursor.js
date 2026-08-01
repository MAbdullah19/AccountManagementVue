// The ring a click leaves behind. Shared by both pages.
//
// The pointer itself is not here — it is a real `cursor:` in styles.css, drawn
// from the mark, because a div chasing the mouse is always one frame behind the
// thing it is imitating. This file owns only the part that has to happen at a
// moment: the ripple.
//
// One delegated listener on the document rather than a handler per control.
// Cards come and go on this board all day, and a per-element listener would
// have to be attached and detached alongside them for no gain.

const MAX_LIVE = 5;

// A hard ceiling on how long a ring may exist, whatever the animation does.
// Comfortably past the 620ms in the stylesheet.
const REAP_MS = 1200;

const live = new Set();

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function remove(node) {
  if (!live.delete(node)) return;
  node.remove();
}

function spawn(x, y) {
  // Rapid clicking should not stack twenty overlapping rings, each animating.
  // The oldest goes, because it is the one furthest through its life anyway.
  if (live.size >= MAX_LIVE) remove(live.values().next().value);

  const node = document.createElement('span');
  node.className = 'ripple';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;

  live.add(node);
  document.body.append(node);

  // Belt, and braces. animationend is the tidy way out, but it never fires if
  // the animation did not run — a stylesheet that failed to load, or a browser
  // extension that strips animations — and a ring that never leaves would sit
  // over the page permanently. The timer is the one that cannot be argued with.
  node.addEventListener('animationend', () => remove(node));
  setTimeout(() => remove(node), REAP_MS);
}

function onPointerDown(event) {
  // Primary button only: a right click opens a menu and a middle click pastes
  // or scrolls, and neither is the "yes, that one" a ripple is acknowledging.
  if (event.button !== 0 || !event.isPrimary) return;

  // Checked here rather than at startup so the setting can change mid-session
  // and be obeyed without a reload — same reason theme.js watches its query.
  if (reducedMotion()) return;

  // Clicking into a field is aiming a caret, not pressing something. A ring
  // blooming out of the text you are about to edit is noise at exactly the
  // moment the page should be still.
  if (event.target instanceof Element && event.target.closest('input, textarea')) return;

  spawn(event.clientX, event.clientY);
}

export function initRipples() {
  // Pointer events rather than click: the ring should appear as the button goes
  // down, not when it comes back up. On a press-and-hold those are far enough
  // apart to feel broken.
  document.addEventListener('pointerdown', onPointerDown);
}
