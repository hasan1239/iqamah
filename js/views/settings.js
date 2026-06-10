// Settings view — preferences and app info
import { getTheme, setTheme, onThemeChange } from '../theme.js';
import { isAdmin, clearAdminCache } from '../utils/admin.js';
import { getOthers, getMyMasjid, setMyMasjid, clearMyMasjid, removeOther } from '../utils/follow.js';
import { loadMasjidIndex } from '../utils/masjid-index.js';
import { openWhatsNew } from '../utils/whats-new.js';

let unsubTheme = null;
let masjidNames = {}; // slug -> display_name (from index.json)

const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z"/></svg>';
const REMOVE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function render(container) {
  const theme = getTheme();
  const timeFormat = localStorage.getItem('iqamah-time-format') || '24';
  const userName = localStorage.getItem('iqamah-user-name') || '';

  container.innerHTML = `
    <div class="settings-view">
      <header class="settings-header">
        <h1>Settings</h1>
      </header>

      <div class="settings-group">
        <div class="settings-group-title">Profile</div>

        <div class="settings-item">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
            </span>
            <span class="settings-label">Your Name</span>
          </div>
          <input type="text" id="userNameInput" class="settings-input" placeholder="Enter your name" value="${userName}" maxlength="30">
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Appearance</div>

        <div class="settings-item" id="themeToggleSetting">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                ${theme === 'light'
                  ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
                  : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
                }
              </svg>
            </span>
            <span class="settings-label">Theme</span>
          </div>
          <div class="theme-segmented" data-active="${theme}" id="themeSegmented">
            <div class="theme-segmented-slider"></div>
            <button data-theme="light" class="${theme === 'light' ? 'active' : ''}">Light</button>
            <button data-theme="night" class="${theme === 'night' ? 'active' : ''}">Night</button>
            <button data-theme="dark" class="${theme === 'dark' ? 'active' : ''}">Dark</button>
          </div>
        </div>

        <div class="settings-item" id="timeFormatSetting">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </span>
            <span class="settings-label">24-Hour Time</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="timeFormatToggle" ${timeFormat === '24' ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>

      <div class="settings-group" id="yourMasjidsGroup">
        <div class="settings-group-title">My Masjid</div>
        <div id="myMasjidRow"></div>
        <div class="settings-group-title settings-group-title-inner">Pinned Masjids</div>
        <div id="otherMasjidsList"></div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Contribute</div>

        <a href="/add" class="settings-item settings-link" data-link>
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </span>
            <span class="settings-label">Add Your Masjid</span>
          </div>
          <span class="settings-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </span>
        </a>

        <a href="mailto:prayerly@hotmail.com?subject=Iqamah Feedback" class="settings-item settings-link" id="feedbackLink">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </span>
            <span class="settings-label">Send Feedback</span>
          </div>
          <span class="settings-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </span>
        </a>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">About</div>

        <div class="settings-item settings-about-card">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
              </svg>
            </span>
            <div>
              <span class="settings-label">What does Iqamah mean?</span>
              <span class="settings-desc">The Iqamah is the second call to prayer, given immediately before the congregational prayer begins.</span>
            </div>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/>
              </svg>
            </span>
            <span class="settings-label">Masjids</span>
          </div>
          <span class="settings-value" id="settingsMasjidCount">...</span>
        </div>

        <div class="settings-item">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </span>
            <span class="settings-label">Version</span>
          </div>
          <span class="settings-value" id="settingsVersion">...</span>
        </div>

        <div class="settings-item settings-link" id="whatsNewSetting" role="button" tabindex="0">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>
              </svg>
            </span>
            <span class="settings-label">What's new</span>
          </div>
          <span class="settings-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </span>
        </div>

        <div class="settings-item" id="resetAppSetting">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </span>
            <span class="settings-label">Reset App</span>
          </div>
          <button class="settings-reset-btn" id="resetAppBtn">Reset</button>
        </div>
      </div>

      <p class="settings-attribution">
        Geographic data © OpenStreetMap contributors.<br>
        Postcode data from Postcodes.io.
      </p>
    </div>
  `;

  // Load version
  fetch('/version.json').then(r => r.json()).then(d => {
    const el = document.getElementById('settingsVersion');
    if (el) el.textContent = 'v' + d.version;
  }).catch(() => {});

  // Load masjid count + display names for the Your Masjids list
  loadMasjidIndex().then(configs => {
    const visible = configs.filter(c =>
      !c.test_masjid && !c.hidden && !(c.quality && c.quality.status === 'needs_review')
    );
    const el = document.getElementById('settingsMasjidCount');
    if (el) el.textContent = visible.length.toString();
    masjidNames = {};
    configs.forEach(c => { masjidNames[c.slug] = c.display_name; });
    renderMasjidLists();
  }).catch(() => {});

  // My Masjid + Other Masjids — initial render (slugs upgrade to display
  // names once index.json arrives above)
  renderMasjidLists();
  const yourMasjidsGroup = document.getElementById('yourMasjidsGroup');
  yourMasjidsGroup.addEventListener('click', (e) => {
    // "Set as My Masjid" on an other — promotion swap: the old My Masjid
    // moves into Other Masjids (handled by follow.js)
    const promoteBtn = e.target.closest('.set-my-btn');
    if (promoteBtn) {
      setMyMasjid(promoteBtn.dataset.slug);
      renderMasjidLists();
      return;
    }
    const removeMyBtn = e.target.closest('.my-masjid-remove');
    if (removeMyBtn) {
      clearMyMasjid();
      renderMasjidLists();
      return;
    }
    const removeOtherBtn = e.target.closest('.other-masjid-remove');
    if (removeOtherBtn) {
      removeOther(removeOtherBtn.dataset.slug);
      renderMasjidLists();
    }
  });

  // Theme segmented control
  const segmented = document.getElementById('themeSegmented');
  segmented.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    setTheme(btn.dataset.theme);
  });

  // Update segmented control on theme change
  unsubTheme = onThemeChange((newTheme) => {
    const seg = document.getElementById('themeSegmented');
    if (!seg) return;
    seg.setAttribute('data-active', newTheme);
    seg.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === newTheme);
    });
  });

  // "What's new" — opens the changelog sheet (whats-new.js)
  const whatsNewRow = document.getElementById('whatsNewSetting');
  whatsNewRow.addEventListener('click', () => openWhatsNew());
  whatsNewRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openWhatsNew();
    }
  });

  // Time format toggle
  document.getElementById('timeFormatToggle').addEventListener('change', (e) => {
    localStorage.setItem('iqamah-time-format', e.target.checked ? '24' : '12');
  });

  // Name input — save on change
  const nameInput = document.getElementById('userNameInput');
  nameInput.addEventListener('input', () => {
    const val = nameInput.value.trim();
    if (val) localStorage.setItem('iqamah-user-name', val);
    else localStorage.removeItem('iqamah-user-name');
    clearAdminCache();
  });

  // Admin badge
  isAdmin().then(admin => {
    if (!admin) return;
    const profileGroup = container.querySelector('.settings-group');
    if (!profileGroup) return;
    const badge = document.createElement('div');
    badge.className = 'settings-item admin-badge-item';
    badge.innerHTML = `
      <div class="settings-item-left">
        <span class="settings-icon" style="color: #4caf50">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </span>
        <span class="settings-label">Admin Mode</span>
      </div>
      <span class="admin-badge">Active</span>
    `;
    profileGroup.appendChild(badge);
  });

  // Reset app
  const resetBtn = document.getElementById('resetAppBtn');
  resetBtn.addEventListener('click', () => {
    if (resetBtn.dataset.confirm) {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('iqamah-'));
      keys.forEach(k => localStorage.removeItem(k));
      window.location.href = '/';
      return;
    }
    resetBtn.dataset.confirm = '1';
    resetBtn.textContent = 'Confirm?';
    resetBtn.classList.add('settings-reset-confirm');
    setTimeout(() => {
      if (resetBtn) {
        delete resetBtn.dataset.confirm;
        resetBtn.textContent = 'Reset';
        resetBtn.classList.remove('settings-reset-confirm');
      }
    }, 3000);
  });
}

// --- My Masjid + Other Masjids group ---

function renderMasjidLists() {
  renderMyMasjidRow();
  renderOtherMasjidsList();
}

function renderMyMasjidRow() {
  const wrap = document.getElementById('myMasjidRow');
  if (!wrap) return;

  const myMasjid = getMyMasjid();

  if (!myMasjid) {
    wrap.innerHTML = `
      <div class="settings-item">
        <div class="settings-item-left">
          <span class="settings-icon settings-icon-muted">${STAR_SVG}</span>
          <span class="settings-label settings-label-muted">No My Masjid set</span>
        </div>
        <a href="/masjids" class="settings-value settings-browse-link" data-link>Browse</a>
      </div>`;
    return;
  }

  const name = masjidNames[myMasjid] || myMasjid;
  wrap.innerHTML = `
    <div class="settings-item your-masjid-row">
      <div class="settings-item-left">
        <span class="settings-icon">${STAR_SVG}</span>
        <span class="settings-label your-masjid-name">${name}</span>
      </div>
      <button class="settings-remove-btn my-masjid-remove" data-slug="${myMasjid}" aria-label="Remove ${name} as My Masjid" title="Remove My Masjid">
        ${REMOVE_SVG}
      </button>
    </div>`;
}

function renderOtherMasjidsList() {
  const wrap = document.getElementById('otherMasjidsList');
  if (!wrap) return;

  const others = getOthers();

  if (others.length === 0) {
    wrap.innerHTML = `
      <div class="settings-item">
        <div class="settings-item-left">
          <span class="settings-icon settings-icon-muted">${PIN_SVG}</span>
          <span class="settings-label settings-label-muted">No pinned masjids yet</span>
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = others.map(slug => {
    const name = masjidNames[slug] || slug;
    return `<div class="settings-item your-masjid-row">
      <div class="settings-item-left">
        <span class="settings-label your-masjid-name">${name}</span>
      </div>
      <div class="your-masjid-actions">
        <button class="set-my-btn" data-slug="${slug}" aria-label="Set ${name} as My Masjid">Set as My Masjid</button>
        <button class="settings-remove-btn other-masjid-remove" data-slug="${slug}" aria-label="Unpin ${name}" title="Remove">
          ${REMOVE_SVG}
        </button>
      </div>
    </div>`;
  }).join('');
}

export function destroy() {
  if (unsubTheme) {
    unsubTheme();
    unsubTheme = null;
  }
}
