// Light, dark, or whatever the operating system says — shared by both pages.
//
// The choice is stored as one of three values and never as a boolean, because
// "follow the system" is a real answer and not the absence of one: a colleague
// whose laptop flips to dark at sunset should see the board flip with it, and a
// boolean cannot express that.
//
// Applying the stored choice is *not* done here. It has to happen before the
// first paint, so it lives in an inline <script> in each page's <head> — this
// module is loaded with the rest of the page and would arrive a repaint too
// late. The two must agree on the key and the attribute; they are named here so
// there is one place to change them.

export const THEME_KEY = 'account-board:theme';

const ORDER = ['light', 'dark'];

// localStorage throws rather than returning null in some privacy modes, and a
// theme is not worth failing a page load over.
function stored() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return ORDER.includes(value) ? value : '';
  } catch {
    return '';
  }
}

function store(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the toggle still works for this page view, which is most of the value */
  }
}

const systemPrefersDark = () =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

// What is actually on screen right now, whether it was chosen or inherited.
const active = () => stored() || (systemPrefersDark() ? 'dark' : 'light');

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.getElementById('theme-btn');
  // The label has to name the destination, not the current state — it is read
  // out as the thing you are about to do.
  if (button) button.setAttribute('aria-label',
    theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
}

export function initTheme() {
  const button = document.getElementById('theme-btn');
  if (!button) return;

  apply(active());

  button.addEventListener('click', () => {
    const next = active() === 'dark' ? 'light' : 'dark';
    store(next);
    apply(next);
  });

  // Until somebody presses the button there is no stored choice, so the page
  // is still following the system and should keep following it — including
  // when the system changes under it mid-session.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!stored()) apply(active());
  });
}
