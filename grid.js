// The lattice behind the page: a grid that leans toward the pointer and rings
// out from a click. Shared by both pages.
//
// It is decoration and it is drawn on a canvas, which is a combination worth
// being careful about — a background that costs a frame every 16ms on a laptop
// running on battery is not worth having. Three things keep it honest:
//
//   * The loop stops. There is no permanent requestAnimationFrame here. It runs
//     while the drawn pointer is still catching up to the real one or a click
//     is still expanding, then draws one last frame and lets go. A page nobody
//     is touching costs nothing.
//   * The static dot texture is a pattern, not 2,600 arcs per frame.
//   * Touch never starts it. A finger has no hover to follow, so on a phone
//     this is a still texture and the loop only wakes for the tap.
//
// The canvas is transparent rather than painting its own background. The
// original this was ported from filled itself with a dark grey, which would
// have meant the grid owning the page colour instead of the theme owning it —
// and there would be no light theme at all. Everything below draws lines on
// nothing and lets --paper show through.

const TAU = Math.PI * 2;

/* ---------- shape ---------- */

const CELL = 55;         // nominal cell; the real one divides the viewport evenly
const INFLUENCE = 260;   // how far from the pointer a node still feels it
const MAX_WARP = 24;     // furthest a node is ever pushed
const DOT_SPACING = 28;
const EASE = 0.08;       // how fast the drawn pointer catches the real one
const SETTLED = 0.4;     // px; below this the two are the same point

const NODE_R = 1.8;
const NODE_R_HOT = 3.2;

const WAVE_WIDTH = 55;   // thickness of a click's front
const WAVE_SPEED = 400;  // px per second
const WAVE_FADE = 1.2;   // opacity lost per second
const WAVE_PUSH = 18;    // how far the front shoves a node aside

// The same ceiling cursor.js puts on its rings, for the same reason: rapid
// clicking should not leave twenty overlapping waves to integrate per node.
const MAX_WAVES = 5;

// The pointer parked here influences nothing, which is the resting state — on
// load, and any time the mouse leaves the window.
const AWAY = -1e4;

/* ---------- colour ---------- */

// The hues styles.css samples from logo.png, in the form a canvas can lerp.
// Kept here rather than read back out of custom properties because these are
// the constants of that file — the five logo values, which no theme is allowed
// to move — and parsing them out of getComputedStyle every theme change would
// buy nothing but a string parser.
//
// What each theme does change is which way the neutral runs. On paper the
// resting grid is the logo's black at a whisper; on the dark theme it is white
// at a whisper. Both go red as the pointer nears, because red is what this
// page means by "something is happening here".
const PALETTE = {
  light: {
    line:    { r: 26,  g: 26,  b: 26,  a: 0.075 },
    lineHot: { r: 224, g: 27,  b: 36,  a: 0.85 },
    node:    { r: 26,  g: 26,  b: 26,  a: 0.13 },
    nodeHot: { r: 224, g: 27,  b: 36,  a: 1 },
    dot:     'rgba(26,26,26,0.055)',
    glow:    '224,27,36',
    glowMax: 0.20,
    wave:    '176,18,31',
    waveMax: 0.22,
  },
  dark: {
    line:    { r: 255, g: 255, b: 255, a: 0.085 },
    lineHot: { r: 236, g: 28,  b: 36,  a: 0.9 },
    node:    { r: 255, g: 255, b: 255, a: 0.16 },
    // --red-ink's dark value. #ec1c24 is the brand red but it is also nearly
    // the same luminance as the page under it, and a node that dark reads as a
    // hole rather than a light.
    nodeHot: { r: 255, g: 95,  b: 102, a: 1 },
    dot:     'rgba(255,255,255,0.05)',
    glow:    '236,28,36',
    glowMax: 0.30,
    wave:    '236,28,36',
    waveMax: 0.28,
  },
};

const theme = () =>
  document.documentElement.dataset.theme === 'dark' ? PALETTE.dark : PALETTE.light;

/* ---------- state ---------- */

let canvas = null;
let ctx = null;

let width = 0;
let height = 0;
let ratio = 1;

// Where the pointer is, and where the drawing thinks it is. The gap between
// them is the whole reason the grid feels heavy rather than glued to the mouse.
const drawn = { x: AWAY, y: AWAY };
const real = { x: AWAY, y: AWAY };

const waves = [];

let frameId = 0;

// The dot texture, and what it was built for. Rebuilt when either changes.
let dots = null;
let dotsFor = null;

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/* ---------- helpers ---------- */

const lerp = (a, b, t) => a + (b - a) * t;

// Far enough outside the viewport that a pointer there cannot light a single
// node. Both ends of the loop need this: a pointer that has gone this far has
// nothing left to animate, and one arriving from out here should not spend two
// seconds gliding in from -10,000.
const offstage = (p) =>
  p.x < -INFLUENCE || p.y < -INFLUENCE || p.x > width + INFLUENCE || p.y > height + INFLUENCE;

// Smoothstep. The linear version of this made every node switch on at exactly
// the edge of the influence circle, which drew a visible ring around the
// pointer — the eye finds the discontinuity before it finds the effect.
const smooth = (t) => t * t * (3 - 2 * t);

function mix(base, hot, t) {
  const r = Math.round(lerp(base.r, hot.r, t));
  const g = Math.round(lerp(base.g, hot.g, t));
  const b = Math.round(lerp(base.b, hot.b, t));
  return `rgba(${r},${g},${b},${lerp(base.a, hot.a, t).toFixed(3)})`;
}

/* ---------- the dot texture ---------- */

// One dot, one tile, repeated by the compositor. The port this came from drew
// every dot with its own arc() on every frame — around 2,600 of them on a
// 1080p screen, all of them identical and none of them moving.
function buildDots(palette) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.max(1, Math.round(DOT_SPACING * ratio));

  const tc = tile.getContext('2d');
  if (!tc) return null;

  tc.scale(ratio, ratio);
  tc.fillStyle = palette.dot;
  tc.beginPath();
  tc.arc(DOT_SPACING / 2, DOT_SPACING / 2, 0.7, 0, TAU);
  tc.fill();

  const pattern = ctx.createPattern(tile, 'repeat');
  // The tile is drawn at device resolution but painted through a context
  // already scaled by the same factor, so without this it repeats at ratio
  // times the spacing it was drawn for.
  pattern?.setTransform?.(new DOMMatrix([1 / ratio, 0, 0, 1 / ratio, 0, 0]));
  return pattern;
}

/* ---------- warping ---------- */

// Where a node at (gx, gy) actually gets drawn, and how strongly it is lit.
function warp(gx, gy, col, row, cols, rows) {
  // The boundary rows and columns are pinned, easing off over the first cell
  // and a half. Without this the grid visibly detaches from the edge of the
  // screen whenever the pointer comes near it, which reads as the background
  // peeling rather than as depth.
  const margin = 1.5;
  const cp = Math.min(col / margin, (cols - 1 - col) / margin, 1);
  const rp = Math.min(row / margin, (rows - 1 - row) / margin, 1);
  const pin = cp * cp * rp * rp;

  const dx = gx - drawn.x;
  const dy = gy - drawn.y;
  const dist = Math.hypot(dx, dy);

  const lit = Math.max(0, 1 - dist / INFLUENCE) * pin;

  // Displacement from every click still expanding.
  let wx = 0;
  let wy = 0;
  for (const wave of waves) {
    const rdx = gx - wave.x;
    const rdy = gy - wave.y;
    const diff = Math.hypot(rdx, rdy) - wave.radius;
    if (Math.abs(diff) >= WAVE_WIDTH) continue;

    // Nodes ahead of the front are pushed out, nodes behind it are pulled back
    // in. That sign flip is what makes it a wave passing through rather than an
    // expanding shove.
    const push =
      (1 - Math.abs(diff) / WAVE_WIDTH) * wave.opacity * WAVE_PUSH * pin *
      (diff < 0 ? 1 : -1);
    const angle = Math.atan2(rdy, rdx);
    wx += Math.cos(angle) * push;
    wy += Math.sin(angle) * push;
  }

  if (dist < INFLUENCE && dist > 0 && pin > 0) {
    const t = dist / INFLUENCE;
    // The Math.min term is the difference between a grid that leans and a grid
    // with a hole punched in it: without it the four nodes nearest the cursor
    // get the full 24px and collapse onto each other.
    const fall = (1 - t) * (1 - t) * Math.min(1, dist / 60);
    const amount = fall * MAX_WARP * pin;
    const angle = Math.atan2(dy, dx);
    return {
      x: gx - Math.cos(angle) * amount + wx,
      y: gy - Math.sin(angle) * amount + wy,
      lit,
    };
  }

  return { x: gx + wx, y: gy + wy, lit };
}

/* ---------- drawing ---------- */

function draw(now) {
  const palette = theme();

  if (dotsFor !== palette || dots === null) {
    dots = buildDots(palette);
    dotsFor = palette;
  }

  ctx.clearRect(0, 0, width, height);

  if (dots) {
    ctx.fillStyle = dots;
    ctx.fillRect(0, 0, width, height);
  }

  // Age the waves before anything reads them, so the grid and the rings agree
  // about where the front is this frame.
  for (let i = waves.length - 1; i >= 0; i--) {
    const wave = waves[i];
    const age = (now - wave.born) / 1000;
    wave.radius = Math.max(0, age * WAVE_SPEED);
    wave.opacity = Math.max(0, 1 - age * WAVE_FADE);
    if (wave.opacity <= 0) waves.splice(i, 1);
  }

  // A whole extra row and column, so the grid runs off every edge instead of
  // ending in a visible border one cell short of the screen.
  const cols = Math.max(2, Math.ceil(width / CELL)) + 1;
  const rows = Math.max(2, Math.ceil(height / CELL)) + 1;
  const cw = width / (cols - 1);
  const ch = height / (rows - 1);

  const grid = [];
  for (let row = 0; row < rows; row++) {
    grid[row] = [];
    for (let col = 0; col < cols; col++) {
      grid[row][col] = warp(col * cw, row * ch, col, row, cols, rows);
    }
  }

  /* lines */

  const segment = (a, b) => {
    const t = smooth((a.lit + b.lit) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = mix(palette.line, palette.lineHot, t);
    ctx.lineWidth = lerp(0.8, 1.5, t);
    ctx.stroke();
  };

  ctx.lineCap = 'butt';

  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols - 1; col++)
      segment(grid[row][col], grid[row][col + 1]);

  for (let col = 0; col < cols; col++)
    for (let row = 0; row < rows - 1; row++)
      segment(grid[row][col], grid[row + 1][col]);

  /* nodes */

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const node = grid[row][col];
      const t = smooth(node.lit);
      const r = lerp(NODE_R, NODE_R_HOT, t);

      // A halo, but only on the nodes near enough to have earned one. Below a
      // third lit it would be a gradient nobody can see costing a fill.
      if (t > 0.3) {
        const outer = r + lerp(0, 6, (t - 0.3) / 0.7);
        const glow = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, outer);
        glow.addColorStop(0, `rgba(${palette.glow},${(t * palette.glowMax).toFixed(3)})`);
        glow.addColorStop(1, `rgba(${palette.glow},0)`);
        ctx.beginPath();
        ctx.arc(node.x, node.y, outer, 0, TAU);
        ctx.fillStyle = glow;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, TAU);
      ctx.fillStyle = mix(palette.node, palette.nodeHot, t);
      ctx.fill();
    }
  }

  /* the ring each click leaves */

  for (const wave of waves) {
    ctx.beginPath();
    ctx.arc(wave.x, wave.y, wave.radius, 0, TAU);
    ctx.strokeStyle =
      `rgba(${palette.wave},${(wave.opacity * palette.waveMax).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/* ---------- the loop, and how it stops ---------- */

function frame(now) {
  drawn.x = lerp(drawn.x, real.x, EASE);
  drawn.y = lerp(drawn.y, real.y, EASE);

  draw(now);

  // Nothing is chasing anything and nothing is expanding: this frame is
  // already the final state, so there is no reason to ask for another one.
  //
  // The second clause is what ends a relax. An 8%-per-frame ease never
  // actually arrives, so a pointer easing back out to the parking spot would
  // otherwise run about a hundred frames after the last one that changed a
  // pixel. Once both ends are off the board, it is over.
  const chasing =
    (Math.abs(drawn.x - real.x) > SETTLED || Math.abs(drawn.y - real.y) > SETTLED) &&
    !(offstage(drawn) && offstage(real));

  frameId = chasing || waves.length ? requestAnimationFrame(frame) : 0;
}

function wake() {
  if (!ctx || frameId) return;
  frameId = requestAnimationFrame(frame);
}

/* ---------- events ---------- */

function resize() {
  ratio = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  // The pattern is built for one device ratio, and dragging a window to a
  // second monitor changes it.
  dots = null;
  dotsFor = null;

  wake();
}

function onMove(event) {
  // A finger is not a pointer that hovers. Following it would mean warping the
  // grid through every scroll on a phone, which is a frame budget spent on
  // something nobody asked to see.
  if (event.pointerType === 'touch') return;

  // Checked per event rather than at startup, so the setting can change
  // mid-session and be obeyed without a reload — same as cursor.js.
  if (reducedMotion()) return;

  real.x = event.clientX;
  real.y = event.clientY;

  // A pointer that was parked has just appeared, and it appeared here — it did
  // not travel. Easing in from the parking spot would drag a warp across the
  // whole page for two seconds every time the mouse re-entered the window, and
  // once more on the very first move of the session.
  if (offstage(drawn)) {
    drawn.x = real.x;
    drawn.y = real.y;
  }

  wake();
}

// The mouse leaving the window is not the mouse stopping. Without this the
// grid stays bent around wherever it was when it crossed the edge, which looks
// like the page froze mid-animation.
function park() {
  real.x = AWAY;
  real.y = AWAY;
  wake();
}

// A pointerout with nothing on the other side of it is the pointer leaving the
// document entirely — moving between two elements gives the element it moved
// to instead, and there are hundreds of those on a full board.
function onOut(event) {
  if (!event.relatedTarget) park();
}

function onDown(event) {
  if (event.button !== 0 || !event.isPrimary) return;
  if (reducedMotion()) return;

  // Clicking into a field is aiming a caret. cursor.js declines to ring for it
  // for the same reason, and a wave rolling out of the box you are about to
  // type in is the louder half of that noise.
  if (event.target instanceof Element && event.target.closest('input, textarea')) return;

  if (waves.length >= MAX_WAVES) waves.shift();

  waves.push({
    x: event.clientX,
    y: event.clientY,
    radius: 0,
    opacity: 1,
    born: performance.now(),
  });

  wake();
}

/* ---------- start ---------- */

export function initKineticGrid() {
  if (canvas) return;

  canvas = document.createElement('canvas');
  canvas.className = 'grid-bg';
  canvas.setAttribute('aria-hidden', 'true');

  ctx = canvas.getContext('2d');
  // No 2d context is not an error worth reporting anywhere — the page is a
  // board of cards on --paper and always was. Leave it off.
  if (!ctx) {
    canvas = null;
    return;
  }

  document.body.prepend(canvas);
  resize();

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown);
  document.addEventListener('pointerout', onOut);
  // Alt-tabbing away does not move the pointer, so nothing above would fire —
  // and coming back to a grid still bent around a cursor that is no longer
  // there is the same frozen-page look.
  window.addEventListener('blur', park);

  // theme.js writes data-theme on <html>, and every colour above is read fresh
  // each frame — so the only thing a theme change needs is a frame.
  new MutationObserver(wake).observe(document.documentElement, {
    attributeFilter: ['data-theme'],
  });
}
