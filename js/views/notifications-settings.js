// Notification settings UI — renders the "Prayer Reminders" groups for the
// Settings view and wires them to js/utils/notifications.js prefs.
// See docs/push-notifications-spec.md §4 for the model. v0 = app-open only.

import {
  loadPrefs, savePrefs, getNotificationState, requestPermission,
} from '../utils/notifications.js';

const BELL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>';

// Prayers and which sub-reminders each one exposes (spec §4).
const PRAYERS = [
  { key: 'fajr', label: 'Fajr', kinds: ['start', 'jamaat', 'end'] },
  { key: 'dhuhr', label: 'Dhuhr', kinds: ['start', 'jamaat', 'end'] },
  { key: 'asr', label: 'Asr', kinds: ['start', 'jamaat', 'end'] },
  { key: 'maghrib', label: 'Maghrib', kinds: ['start', 'jamaat'] }, // pray ASAP — no end
  { key: 'esha', label: 'Esha', kinds: ['start', 'jamaat'] },        // no clean end time
];

const KIND_LABEL = { start: 'Start time', jamaat: "Jama'at time", end: 'Ends soon' };

// Lead-time chip sets per kind.
const LEADS = {
  start: [[0, 'At time'], [5, '5m'], [10, '10m'], [15, '15m'], [30, '30m']],
  jamaat: [[0, 'At time'], [5, '5m'], [10, '10m'], [15, '15m'], [30, '30m']],
  end: [[15, '15m'], [30, '30m'], [45, '45m'], [60, '60m']],
  suhoor: [[15, '15m'], [30, '30m'], [45, '45m'], [60, '60m']],
  iftar: [[0, 'At time'], [5, '5m'], [10, '10m']],
};

function leadChips(kind, current) {
  return `<div class="notif-leads" data-kind="${kind}">${
    LEADS[kind].map(([v, l]) => `<button type="button" class="notif-chip${v === current ? ' active' : ''}" data-lead="${v}">${l}</button>`).join('')
  }</div>`;
}

// One sub-reminder block: label + toggle + (chips, shown when on).
function subBlock(kind, pref) {
  const on = !!(pref && pref.on);
  const lead = pref ? pref.lead : 0;
  return `
    <div class="notif-sub" data-kind="${kind}">
      <div class="notif-sub-top">
        <span class="notif-sub-label">${KIND_LABEL[kind]}</span>
        <label class="toggle-switch">
          <input type="checkbox" class="notif-sub-toggle" data-kind="${kind}" ${on ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
      ${leadChips(kind, lead)}
    </div>`;
}

// Collapsed-row summary text, e.g. "Start · Jama'at 15m · Ends 30m" or "Off".
function summaryText(prayerPref, kinds) {
  const parts = [];
  for (const kind of kinds) {
    const p = prayerPref[kind];
    if (!p || !p.on) continue;
    if (kind === 'start') parts.push(p.lead ? `Start ${p.lead}m` : 'Start');
    else if (kind === 'jamaat') parts.push(p.lead ? `Jama'at ${p.lead}m` : "Jama'at");
    else if (kind === 'end') parts.push(`Ends ${p.lead}m`);
  }
  return parts.length ? parts.join(' · ') : 'Off';
}

function prayerRow(p, prefs) {
  const pref = prefs.prayers[p.key];
  const subs = p.kinds.map(k => subBlock(k, pref[k])).join('');
  return `
    <div class="notif-prayer" data-prayer="${p.key}">
      <button type="button" class="notif-prayer-head" aria-expanded="false">
        <span class="notif-prayer-name">${p.label}</span>
        <span class="notif-prayer-summary">${summaryText(pref, p.kinds)}</span>
        <span class="notif-prayer-chevron">${CHEVRON_SVG}</span>
      </button>
      <div class="notif-prayer-body">
        ${subs}
      </div>
    </div>`;
}

function ramadanRow(key, label, hint, pref) {
  return `
    <div class="notif-extra" data-extra="${key}">
      <div class="notif-sub-top">
        <div class="settings-item-left" style="gap:0;flex-direction:column;align-items:flex-start">
          <span class="settings-label">${label}</span>
          <span class="settings-desc">${hint}</span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" class="notif-extra-toggle" data-extra="${key}" ${pref.on ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
      ${leadChips(key, pref.lead)}
    </div>`;
}

/**
 * Returns the full HTML for the notification settings (master + prayers + ramadan).
 * @param {string} season  'ramadan' | 'eid' | 'default'
 * @param {string} pinnedName  display name of the target masjid (or '')
 */
export function renderNotifications(season, pinnedName) {
  const prefs = loadPrefs();
  const state = getNotificationState();

  // Master group — its content depends on capability.
  let masterInner;
  if (state === 'unsupported') {
    masterInner = `
      <div class="settings-item">
        <div class="settings-item-left"><span class="settings-icon">${BELL_SVG}</span><span class="settings-label">Notifications</span></div>
        <span class="settings-value">Not supported</span>
      </div>
      <div class="notif-info-card">Your browser doesn't support notifications.</div>`;
  } else if (state === 'ios-needs-install') {
    masterInner = `
      <div class="settings-item">
        <div class="settings-item-left"><span class="settings-icon">${BELL_SVG}</span><span class="settings-label">Notifications</span></div>
      </div>
      <div class="notif-info-card">To get prayer reminders on iPhone, add Iqamah to your Home Screen first: tap the Share icon in Safari, then <strong>Add to Home Screen</strong>, and open it from there.</div>`;
  } else {
    const masterOn = prefs.master && state === 'granted';
    masterInner = `
      <div class="settings-item">
        <div class="settings-item-left"><span class="settings-icon">${BELL_SVG}</span><span class="settings-label">Notifications</span></div>
        <label class="toggle-switch">
          <input type="checkbox" id="notifMaster" ${masterOn ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="settings-item" id="notifTarget">
        <div class="settings-item-left"><span class="settings-icon">${MOSQUE_SVG}</span><span class="settings-label">Remind me for</span></div>
        <span class="settings-value">${pinnedName || 'No masjid pinned'}</span>
      </div>
      ${state === 'denied' ? '<div class="notif-info-card notif-denied">Notifications are blocked. Enable them for this site in your browser settings, then turn this on.</div>' : ''}`;
  }

  const showDetail = state === 'granted' || state === 'default' || state === 'denied';
  const enabledClass = (prefs.master && state === 'granted') ? ' notif-enabled' : '';

  let detail = '';
  if (showDetail) {
    const prayersHtml = PRAYERS.map(p => prayerRow(p, prefs)).join('');
    const ramadanHtml = season === 'ramadan' ? `
      <div class="notif-subtitle">Ramadan</div>
      ${ramadanRow('suhoor', 'Suhoor ends', 'Before Sehri ends', prefs.ramadanExtras.suhoor)}
      ${ramadanRow('iftar', 'Iftar', 'At Maghrib / iftar time', prefs.ramadanExtras.iftar)}` : '';
    detail = `
      <div class="notif-detail${enabledClass}" id="notifDetail">
        ${prayersHtml}
        ${ramadanHtml}
      </div>`;
  }

  // Prayers + Ramadan live inside the same "Prayer Reminders" group (no separate
  // heading) so they don't read as a distinct feature.
  return `
    <div class="settings-group" id="notifMasterGroup">
      <div class="settings-group-title">Prayer Reminders</div>
      ${masterInner}
      ${detail}
    </div>`;
}

// Wire all interactions within `container` (the settings view root).
export function setupNotifications(container) {
  const master = container.querySelector('#notifMaster');
  const detail = container.querySelector('#notifDetail');

  function refreshEnabled() {
    const prefs = loadPrefs();
    if (detail) detail.classList.toggle('notif-enabled', prefs.master && getNotificationState() === 'granted');
  }

  // Master toggle: request permission on enable; revert if not granted.
  if (master) {
    master.addEventListener('change', async () => {
      const prefs = loadPrefs();
      if (master.checked) {
        let state = getNotificationState();
        if (state === 'default') state = await requestPermission();
        if (state !== 'granted') {
          master.checked = false;
          prefs.master = false;
          savePrefs(prefs);
          // Re-render to surface the denied/blocked notice.
          window.dispatchEvent(new CustomEvent('iqamah-notif-rerender'));
          return;
        }
        prefs.master = true;
      } else {
        prefs.master = false;
      }
      savePrefs(prefs);
      refreshEnabled();
    });
  }

  // Accordion expand/collapse.
  container.querySelectorAll('.notif-prayer-head').forEach(head => {
    head.addEventListener('click', () => {
      const row = head.closest('.notif-prayer');
      const open = row.classList.toggle('open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  // Per-prayer sub-reminder toggles.
  container.querySelectorAll('.notif-sub-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      const prayerEl = toggle.closest('.notif-prayer');
      const kind = toggle.dataset.kind;
      const prayerKey = prayerEl.dataset.prayer;
      const prefs = loadPrefs();
      prefs.prayers[prayerKey][kind].on = toggle.checked;
      savePrefs(prefs);
      updateSummary(prayerEl, prefs);
    });
  });

  // Per-prayer lead chips.
  container.querySelectorAll('.notif-prayer .notif-leads').forEach(group => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.notif-chip');
      if (!chip) return;
      const prayerEl = chip.closest('.notif-prayer');
      const kind = group.dataset.kind;
      const prayerKey = prayerEl.dataset.prayer;
      const lead = parseInt(chip.dataset.lead, 10);
      const prefs = loadPrefs();
      prefs.prayers[prayerKey][kind].lead = lead;
      // Selecting a lead implies the reminder is on.
      if (!prefs.prayers[prayerKey][kind].on) {
        prefs.prayers[prayerKey][kind].on = true;
        const t = prayerEl.querySelector(`.notif-sub-toggle[data-kind="${kind}"]`);
        if (t) t.checked = true;
      }
      savePrefs(prefs);
      group.querySelectorAll('.notif-chip').forEach(c => c.classList.toggle('active', c === chip));
      updateSummary(prayerEl, prefs);
    });
  });

  // Ramadan extras toggles.
  container.querySelectorAll('.notif-extra-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      const key = toggle.dataset.extra;
      const prefs = loadPrefs();
      prefs.ramadanExtras[key].on = toggle.checked;
      savePrefs(prefs);
    });
  });

  // Ramadan extras lead chips.
  container.querySelectorAll('.notif-extra .notif-leads').forEach(group => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.notif-chip');
      if (!chip) return;
      const extraEl = chip.closest('.notif-extra');
      const key = extraEl.dataset.extra;
      const lead = parseInt(chip.dataset.lead, 10);
      const prefs = loadPrefs();
      prefs.ramadanExtras[key].lead = lead;
      if (!prefs.ramadanExtras[key].on) {
        prefs.ramadanExtras[key].on = true;
        const t = extraEl.querySelector('.notif-extra-toggle');
        if (t) t.checked = true;
      }
      savePrefs(prefs);
      group.querySelectorAll('.notif-chip').forEach(c => c.classList.toggle('active', c === chip));
    });
  });

  refreshEnabled();
}

function updateSummary(prayerEl, prefs) {
  const prayerKey = prayerEl.dataset.prayer;
  const def = PRAYERS.find(p => p.key === prayerKey);
  const summary = prayerEl.querySelector('.notif-prayer-summary');
  if (summary && def) summary.textContent = summaryText(prefs.prayers[prayerKey], def.kinds);
}
