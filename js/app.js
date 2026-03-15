// Iqamah SPA — App entry point
import { initTheme } from './theme.js';
import { initBackground } from './background.js';
import { initRouter, navigate } from './router.js';
import { initNav, updateActiveTab } from './nav.js';
import { registerServiceWorker, initInstallPrompt } from './utils/pwa.js';

const viewModules = {};
let currentViewModule = null;
let appContainer = null;
let transitionCleanupId = null;

// Lazy-load view modules
async function loadView(viewName) {
  if (viewModules[viewName]) return viewModules[viewName];

  const moduleMap = {
    'home': () => import('./views/home.js'),
    'masjids': () => import('./views/masjids.js'),
    'prayer-times': () => import('./views/prayer-times.js'),
    'qibla': () => import('./views/qibla.js'),
    'settings': () => import('./views/settings.js'),
    'add-masjid': () => import('./views/add-masjid.js'),
    'not-found': () => import('./views/not-found.js'),
  };

  const loader = moduleMap[viewName];
  if (!loader) return null;

  const mod = await loader();
  viewModules[viewName] = mod;
  return mod;
}

async function renderView(viewName, params, direction) {
  appContainer = document.getElementById('app');
  if (!appContainer) return;

  // Cancel any pending transition cleanup
  if (transitionCleanupId) {
    clearTimeout(transitionCleanupId);
    transitionCleanupId = null;
  }

  // Destroy previous view
  if (currentViewModule && currentViewModule.destroy) {
    currentViewModule.destroy();
  }

  // Update nav
  updateActiveTab();

  // Load and render new view
  const viewModule = await loadView(viewName);
  if (!viewModule) {
    const notFound = await loadView('not-found');
    if (notFound) notFound.render(appContainer);
    currentViewModule = notFound;
    return;
  }

  // Slide transition
  if (direction && direction !== 'none') {
    const oldContent = appContainer.innerHTML;
    const wrapper = document.createElement('div');
    wrapper.className = 'view-transition';

    // Old view
    const oldView = document.createElement('div');
    oldView.className = 'view-pane view-exit';
    oldView.innerHTML = oldContent;

    // New view
    const newView = document.createElement('div');
    newView.className = 'view-pane view-enter';

    if (direction === 'left') {
      oldView.style.animation = 'slideOutLeft 250ms ease-out forwards';
      newView.style.animation = 'slideInRight 250ms ease-out forwards';
    } else if (direction === 'right') {
      oldView.style.animation = 'slideOutRight 250ms ease-out forwards';
      newView.style.animation = 'slideInLeft 250ms ease-out forwards';
    } else {
      oldView.style.animation = 'fadeOut 200ms ease-out forwards';
      newView.style.animation = 'fadeIn 200ms ease-out forwards';
    }

    wrapper.appendChild(oldView);
    wrapper.appendChild(newView);
    appContainer.innerHTML = '';
    appContainer.appendChild(wrapper);

    // Render into new pane
    await viewModule.render(newView, params);
    currentViewModule = viewModule;

    // Clean up after animation
    transitionCleanupId = setTimeout(() => {
      transitionCleanupId = null;
      // Only clean up if this transition's wrapper is still in the DOM
      if (!appContainer.contains(wrapper)) return;
      appContainer.innerHTML = '';
      // Move newView contents into app container
      while (newView.firstChild) {
        appContainer.appendChild(newView.firstChild);
      }
    }, 260);
  } else {
    // No transition
    appContainer.innerHTML = '';
    await viewModule.render(appContainer, params);
    currentViewModule = viewModule;
  }

  // Scroll to top
  window.scrollTo(0, 0);
}

// Intercept link clicks for SPA navigation
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link], a[href^="/"]');
  if (!link) return;

  const href = link.getAttribute('href');
  if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
  if (link.getAttribute('download') !== null) return;
  if (link.getAttribute('target') === '_blank') return;

  // Only intercept internal links
  if (href.startsWith('/') && !href.includes('.')) {
    e.preventDefault();
    navigate(href);
  }
});

// Migrate localStorage keys from prayerly-* to iqamah-*
if (!localStorage.getItem('iqamah-migrated')) {
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('prayerly-')) {
      const newKey = k.replace('prayerly-', 'iqamah-');
      if (!localStorage.getItem(newKey)) localStorage.setItem(newKey, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  });
  localStorage.setItem('iqamah-migrated', '1');
}

// Init
initTheme();
initBackground();
initNav();
initInstallPrompt();
registerServiceWorker();
initRouter(renderView);
