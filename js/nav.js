// Bottom navigation bar — mobile only
import { navigate, getCurrentRoute } from './router.js';

const TABS = [
  {
    id: 'home',
    label: 'Home',
    path: '/',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  },
  {
    id: 'masjids',
    label: 'Masjids',
    path: '/masjids',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/><line x1="3.5" y1="8" x2="3.5" y2="10"/><line x1="20.5" y1="8" x2="20.5" y2="10"/></svg>',
  },
  {
    id: 'prayer-times',
    label: 'Times',
    path: null, // Dynamic — uses pinned masjid
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  },
  {
    id: 'qibla',
    label: 'Qibla',
    path: '/qibla',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  },
];

function getTimesPath() {
  const pinned = localStorage.getItem('iqamah-pinned-masjid');
  return pinned ? '/' + pinned : '/times';
}

function getActiveTabId() {
  const route = getCurrentRoute();
  if (route.view === 'add-masjid') return 'settings';
  return route.view;
}

export function initNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;

  renderNav(nav);

  // Intercept tab clicks
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    e.preventDefault();

    const tabId = tab.dataset.tab;
    let path;
    if (tabId === 'prayer-times') {
      path = getTimesPath();
      // If currently on /times (no masjid) but now have a pinned masjid, force navigate
      if (path !== '/times' && getCurrentRoute().view === 'prayer-times' && !getCurrentRoute().params.slug) {
        navigate(path, { replace: true });
        return;
      }
    } else {
      path = TABS.find(t => t.id === tabId)?.path || '/';
    }

    navigate(path);
  });
}

function renderNav(nav) {
  const activeId = getActiveTabId();

  const tabsHTML = TABS.map(tab => {
    const isActive = tab.id === activeId;
    const href = tab.id === 'prayer-times' ? getTimesPath() : tab.path;

    return `<a class="nav-tab${isActive ? ' active' : ''}" data-tab="${tab.id}" href="${href}">
      <span class="nav-icon">${tab.icon}</span>
      <span class="nav-label">${tab.label}</span>
    </a>`;
  }).join('');

  nav.innerHTML = `<div class="bottom-nav-inner">${tabsHTML}</div>`;
}

export function updateActiveTab() {
  const nav = document.getElementById('bottom-nav');
  if (nav) renderNav(nav);

  // Update desktop nav active state
  const desktopLinks = document.getElementById('desktop-nav-links');
  if (!desktopLinks) return;
  const route = getCurrentRoute();
  const activeView = route.view;
  desktopLinks.querySelectorAll('.desktop-nav-link').forEach(link => {
    const navId = link.dataset.nav;
    link.classList.toggle('active', navId === activeView || (navId === 'masjids' && activeView === 'prayer-times'));
  });
}
