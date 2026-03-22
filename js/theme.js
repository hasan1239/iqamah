// Theme management — light/night/dark mode with crossfade overlay
// Three themes: light (cream), night (dark blue with stars), dark (true black OLED)

let themeChangeCallbacks = [];

const THEME_COLORS = { light: '#faf6ef', night: '#050c18', dark: '#000000' };
const VALID_THEMES = ['light', 'night', 'dark'];

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'night';
}

export function onThemeChange(callback) {
  themeChangeCallbacks.push(callback);
  return () => {
    themeChangeCallbacks = themeChangeCallbacks.filter(cb => cb !== callback);
  };
}

function updateThemeColor() {
  const theme = getTheme();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme] || THEME_COLORS.night;
}

export function setTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  const root = document.documentElement;

  // Crossfade overlay: capture current bg, fade it out over the new theme
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;transition:opacity 0.4s ease;';
  overlay.style.backgroundImage = getComputedStyle(document.body).backgroundImage;
  overlay.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  document.body.appendChild(overlay);

  root.classList.add('theme-transitioning');
  root.setAttribute('data-theme', theme);
  localStorage.setItem('iqamah-theme', theme);
  updateThemeColor();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
  });

  setTimeout(() => {
    overlay.remove();
    root.classList.remove('theme-transitioning');
  }, 400);

  // Notify listeners
  themeChangeCallbacks.forEach(cb => cb(theme));

  // Analytics
  if (window.goatcounter) {
    window.goatcounter.count({
      path: '/theme/' + theme,
      title: 'Theme toggle',
      event: true,
    });
  }
}

export function toggleTheme() {
  const current = getTheme();
  const order = ['light', 'night', 'dark'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  setTheme(next);
}

export function initTheme() {
  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('iqamah-theme')) return;
    const theme = e.matches ? 'night' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeColor();
    themeChangeCallbacks.forEach(cb => cb(theme));
  });

  updateThemeColor();
}
