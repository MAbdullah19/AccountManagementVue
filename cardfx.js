// What the account cards do under a pointer: a steel sheen that travels, a
// specular that follows, a small tilt, and an arc of light on the edge nearest
// the mouse.
//
// Ported from Aceternity's glare-card and glowing-effect. Both are React with
// Tailwind and framer-motion; the maths crossed over, the code did not. The
// look lives in styles.css — everything here does is write four numbers to one
// card. See that file for what was changed on the way across and why.
//
// One delegated listener on the board rather than a component per card. Cards
// are built, replaced and thrown away here all day; anything attached to a card
// would have to be attached and detached alongside it for no gain.
//
// The original ran a handler for every mounted instance on every mouse move, so
// a board of twelve did twelve rect reads and twelve style writes per frame.
// Only the card under the pointer can show any of this, so only that card is
// touched — the rest cost nothing.

// Degrees at the very edge of a card. The original tilts up to about ten, which
// is right for a showcase card sitting alone on a page and wrong for one
// holding a form: at ten degrees the Claim button visibly moves away from the
// pointer reaching for it.
const TILT_Y = 3;
const TILT_X = 2.4;

// How long to let the tilt ease before it starts tracking exactly. The first
// move has to travel from flat, and easing it looks right. Every move after
// that, easing means the card is a third of a second behind the mouse, which
// feels like lag rather than like weight.
const SETTLE_MS = 300;

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

let hovered = null;
let settleTimer = 0;
let frame = 0;
let queued = null;

const cardUnder = (node) =>
  node instanceof Element ? node.closest('.card:not(.card-add)') : null;

function track(card, clientX, clientY) {
  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const px = ((clientX - rect.left) / rect.width) * 100;
  const py = ((clientY - rect.top) / rect.height) * 100;

  // Rounded because these land in an inline style attribute, and a full double
  // spends seventeen characters saying something no pixel can tell apart.
  const round = (n) => Math.round(n * 1000) / 1000;

  card.style.setProperty('--fx-mx', `${round(px)}%`);
  card.style.setProperty('--fx-my', `${round(py)}%`);

  // glare-card's own numbers for where the foil sits: a third of the pointer's
  // travel, re-centred. The sheen drifts rather than tracking one to one, which
  // is what makes it read as a reflection instead of a sticker being dragged.
  card.style.setProperty('--fx-bx', `${round(50 + px / 4 - 12.5)}%`);
  card.style.setProperty('--fx-by', `${round(50 + py / 3 - 16.67)}%`);

  card.style.setProperty('--fx-ry', `${round(((px - 50) / 50) * TILT_Y)}deg`);
  card.style.setProperty('--fx-rx', `${round((-(py - 50) / 50) * TILT_X)}deg`);
  card.style.setProperty('--fx-active', '1');

  // Where the light is, in degrees clockwise from the top. The angle is
  // accumulated rather than stored in 0–360 so the arc always swings the short
  // way round: crossing from 350 to 10 has to be +20, not −340, or the glow
  // takes the long way home every time the pointer passes the top edge.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const current = parseFloat(card.style.getPropertyValue('--fx-start')) || 0;
  const target = (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI + 90;
  const diff = ((((target - current + 180) % 360) + 360) % 360) - 180;

  card.style.setProperty('--fx-start', String(round(current + diff)));
}

function enter(card) {
  hovered = card;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (hovered === card) card.style.setProperty('--fx-tilt-ms', '0ms');
  }, SETTLE_MS);
}

function leave(card) {
  if (hovered === card) hovered = null;
  clearTimeout(settleTimer);

  // The tilt eases back to flat, so the transition has to be on again before
  // the angles are cleared — otherwise the card snaps upright.
  card.style.removeProperty('--fx-tilt-ms');
  card.style.setProperty('--fx-active', '0');
  card.style.setProperty('--fx-rx', '0deg');
  card.style.setProperty('--fx-ry', '0deg');
}

function onMove(event) {
  // A finger has no hover. Following it would light a card up on tap and leave
  // it lit, which is worse than never lighting it at all.
  if (event.pointerType === 'touch') return;

  // Checked per event rather than at startup, so the setting can change
  // mid-session and be obeyed without a reload — same as theme.js.
  if (reducedMotion()) return;

  const card = cardUnder(event.target);
  if (!card) return;

  if (card !== hovered) {
    if (hovered) leave(hovered);
    enter(card);
  }

  // Coalesced to one write per frame. pointermove can fire well above the
  // refresh rate, and every extra call is a layout read followed by six style
  // writes that nothing will ever paint.
  queued = { card, x: event.clientX, y: event.clientY };
  if (frame) return;

  frame = requestAnimationFrame(() => {
    frame = 0;
    if (queued) track(queued.card, queued.x, queued.y);
  });
}

// pointerleave does not bubble, so it cannot be delegated. pointerout does, but
// it also fires on every move between two elements inside the same card — and a
// card has dozens. The relatedTarget is what tells the two apart.
function onOut(event) {
  const card = cardUnder(event.target);
  if (!card) return;
  if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
  leave(card);
}

export function initCardFx() {
  const board = document.getElementById('board');
  if (!board) return;

  board.addEventListener('pointermove', onMove, { passive: true });
  board.addEventListener('pointerout', onOut, { passive: true });
}
