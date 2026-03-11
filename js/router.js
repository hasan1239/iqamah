// Client-side router using History API

let renderCallback = null;
let currentPath = null;

// Tab indices for slide direction
const TAB_INDEX = {
  home: 0,
  masjids: 1,
  'prayer-times': 2,
  qibla: 3,
  settings: 4,
};

function getTabIndex(viewName) {
  return TAB_INDEX[viewName] ?? 1;
}

export function resolvePath(path) {
  const clean = path.replace(/^\/+|\/+$/g, '');

  if (!clean || clean === 'index.html') {
    return { view: 'home', params: {} };
  }
  if (clean === 'masjids') {
    return { view: 'masjids', params: {} };
  }
  if (clean === 'qibla') {
    return { view: 'qibla', params: {} };
  }
  if (clean === 'add') {
    return { view: 'add-masjid', params: {} };
  }
  if (clean === 'settings') {
    return { view: 'settings', params: {} };
  }
  if (clean === 'times') {
    return { view: 'prayer-times', params: { slug: null } };
  }

  // Single segment = masjid slug
  if (!clean.includes('/') && !clean.includes('.')) {
    return { view: 'prayer-times', params: { slug: clean } };
  }

  return { view: 'not-found', params: {} };
}

export function getCurrentPath() {
  return currentPath || window.location.pathname;
}

export function getCurrentRoute() {
  return resolvePath(getCurrentPath());
}

export function navigate(path, { replace = false, skipTransition = false } = {}) {
  if (path === currentPath) {
    // Tapping the same tab — scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  const oldRoute = currentPath ? resolvePath(currentPath) : null;
  const newRoute = resolvePath(path);

  if (replace) {
    history.replaceState({ path }, '', path);
  } else {
    history.pushState({ path }, '', path);
  }

  currentPath = path;

  // Determine slide direction
  let direction = 'none';
  if (!skipTransition && oldRoute) {
    const oldIdx = getTabIndex(oldRoute.view);
    const newIdx = getTabIndex(newRoute.view);
    if (newIdx > oldIdx) direction = 'left';
    else if (newIdx < oldIdx) direction = 'right';
    else direction = 'fade';
  }

  if (renderCallback) {
    renderCallback(newRoute.view, newRoute.params, direction);
  }

  // Analytics
  if (window.goatcounter) {
    window.goatcounter.count({ path });
  }
}

export function initRouter(callback) {
  renderCallback = callback;

  // Handle back/forward
  window.addEventListener('popstate', (e) => {
    const path = e.state?.path || window.location.pathname;
    currentPath = path;
    const route = resolvePath(path);
    if (renderCallback) {
      renderCallback(route.view, route.params, 'none');
    }
  });

  // Initial render from current URL
  const initialPath = window.location.pathname;
  currentPath = initialPath;
  history.replaceState({ path: initialPath }, '', initialPath);
  const route = resolvePath(initialPath);
  if (renderCallback) {
    renderCallback(route.view, route.params, 'none');
  }
}
