// Settings view — preferences and app info
import { getTheme, toggleTheme, onThemeChange } from '../theme.js';

let unsubTheme = null;

export function render(container) {
  const theme = getTheme();
  const timeFormat = localStorage.getItem('iqamah-time-format') || '24';
  const pinnedSlug = localStorage.getItem('iqamah-pinned-masjid');
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
                ${theme === 'dark'
                  ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
                  : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
                }
              </svg>
            </span>
            <span class="settings-label">Dark Mode</span>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="darkModeToggle" ${theme === 'dark' ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
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

      <div class="settings-group">
        <div class="settings-group-title">My Masjid</div>

        <div class="settings-item" id="pinnedMasjidSetting">
          <div class="settings-item-left">
            <span class="settings-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/>
              </svg>
            </span>
            <span class="settings-label">${pinnedSlug ? 'My Masjid' : 'No masjid selected'}</span>
          </div>
          <div class="settings-pinned-right">
            <span class="settings-value" id="pinnedMasjidName">${pinnedSlug || 'None'}</span>
            ${pinnedSlug ? `<button class="settings-remove-btn" id="removePinnedBtn" aria-label="Remove My Masjid">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>` : ''}
          </div>
        </div>
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
    </div>
  `;

  // Load version
  fetch('/version.json').then(r => r.json()).then(d => {
    const el = document.getElementById('settingsVersion');
    if (el) el.textContent = 'v' + d.version;
  }).catch(() => {});

  // Load pinned masjid display name
  if (pinnedSlug) {
    fetch(`/data/mosques/${pinnedSlug}.json`).then(r => r.json()).then(config => {
      const el = document.getElementById('pinnedMasjidName');
      if (el) el.textContent = config.display_name || pinnedSlug;
    }).catch(() => {});
  }

  // Dark mode toggle
  document.getElementById('darkModeToggle').addEventListener('change', () => {
    toggleTheme();
  });

  // Update toggle icon on theme change
  unsubTheme = onThemeChange((newTheme) => {
    const toggle = document.getElementById('darkModeToggle');
    if (toggle) toggle.checked = newTheme === 'dark';
  });

  // Time format toggle
  document.getElementById('timeFormatToggle').addEventListener('change', (e) => {
    localStorage.setItem('iqamah-time-format', e.target.checked ? '24' : '12');
  });

  // Remove pinned masjid
  const removeBtn = document.getElementById('removePinnedBtn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      localStorage.removeItem('iqamah-pinned-masjid');
      const nameEl = document.getElementById('pinnedMasjidName');
      const labelEl = document.querySelector('#pinnedMasjidSetting .settings-label');
      if (nameEl) nameEl.textContent = 'None';
      if (labelEl) labelEl.textContent = 'No masjid selected';
      removeBtn.remove();
      window.dispatchEvent(new CustomEvent('iqamah-pin-changed'));
    });
  }

  // Name input — save on change
  const nameInput = document.getElementById('userNameInput');
  nameInput.addEventListener('input', () => {
    const val = nameInput.value.trim();
    if (val) localStorage.setItem('iqamah-user-name', val);
    else localStorage.removeItem('iqamah-user-name');
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

export function destroy() {
  if (unsubTheme) {
    unsubTheme();
    unsubTheme = null;
  }
}
