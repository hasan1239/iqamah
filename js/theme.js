// Theme management — light/dark mode toggle with crossfade overlay
// Extracted from duplicated code across all pages

let themeChangeCallbacks = [];

export function getTheme() {
  return document.documentElement.classList.contains('light-mode') ? 'light' : 'dark';
}

export function onThemeChange(callback) {
  themeChangeCallbacks.push(callback);
  return () => {
    themeChangeCallbacks = themeChangeCallbacks.filter(cb => cb !== callback);
  };
}

function updateThemeColor() {
  const isLight = document.documentElement.classList.contains('light-mode');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isLight ? '#faf6ef' : '#050c18';
}

export function toggleTheme() {
  const root = document.documentElement;

  // Crossfade overlay: capture current bg gradient, fade it out over the new theme
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;transition:opacity 0.4s ease;';
  overlay.style.backgroundImage = getComputedStyle(document.body).backgroundImage;
  document.body.appendChild(overlay);

  root.classList.add('theme-transitioning');
  root.classList.toggle('light-mode');
  const isLight = root.classList.contains('light-mode');
  localStorage.setItem('iqamah-theme', isLight ? 'light' : 'dark');
  updateThemeColor();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
  });

  setTimeout(() => {
    overlay.remove();
    root.classList.remove('theme-transitioning');
  }, 400);

  // Notify listeners
  const theme = isLight ? 'light' : 'dark';
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

export function initTheme() {
  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('iqamah-theme')) return;
    if (e.matches) {
      document.documentElement.classList.remove('light-mode');
    } else {
      document.documentElement.classList.add('light-mode');
    }
    updateThemeColor();
    const theme = getTheme();
    themeChangeCallbacks.forEach(cb => cb(theme));
  });

  updateThemeColor();
}
