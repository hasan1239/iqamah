// "What's new" sheet — update discoverability driven by data/changelog.json.
//
//   checkWhatsNew() — boot-time, silent. Shows the sheet at most once per app
//                     version: when /version.json has moved past the version
//                     the user last dismissed ('iqamah-last-seen-version').
//                     Brand-new users are seeded silently and never see it
//                     (everything is new to them anyway).
//   openWhatsNew()  — unconditional (Settings > What's new). Always shows the
//                     newest changelog entries regardless of seen state.
//
// The sheet is a bottom sheet on mobile and a centred dialog at >=768px,
// styled by the .wn-* block in index.html (visually matches the .ctx-*
// context-menu sheet: solid var(--nav-bg) surface, safe-area padding, gold
// accents). The node is appended to document.body and fully removed on
// dismiss. ALL failures are silent — this must never block the app.

import { navigate } from '../router.js';

const LAST_SEEN_KEY = 'iqamah-last-seen-version';
const MAX_ENTRIES = 3; // cap displayed releases to the newest three

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let active = null; // { backdrop, sheet, onKeyDown, prevFocus }

// Semver-ish compare: split on dots, numeric compare, tolerate missing parts.
// Returns -1 / 0 / 1.
function cmpVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// "2026-06-10" -> "10 June 2026" (UK style). Falls back to the raw string.
function formatDate(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const month = MONTHS[parseInt(m[2], 10) - 1];
  if (!month) return String(iso);
  return `${parseInt(m[3], 10)} ${month} ${m[1]}`;
}

function itemHTML(item) {
  const hasRoute = typeof item.route === 'string' && item.route.startsWith('/');
  const tag = hasRoute ? 'button' : 'div';
  const attrs = hasRoute
    ? ` type="button" data-route="${escapeHTML(item.route)}"`
    : '';
  return `
    <${tag} class="wn-item${hasRoute ? ' wn-item-link' : ''}"${attrs}>
      <span class="wn-item-dot" aria-hidden="true"></span>
      <span class="wn-item-text">
        <span class="wn-item-title">${escapeHTML(item.title || '')}</span>
        ${item.desc ? `<span class="wn-item-desc">${escapeHTML(item.desc)}</span>` : ''}
      </span>
      ${hasRoute ? `<span class="wn-item-chevron">${CHEVRON_SVG}</span>` : ''}
    </${tag}>`;
}

function releaseHTML(release) {
  const meta = [
    release.version ? `Version ${release.version}` : '',
    formatDate(release.date),
  ].filter(Boolean).join(' · ');
  return `
    <section class="wn-release">
      <div class="wn-release-head">
        ${release.title ? `<span class="wn-release-title">${escapeHTML(release.title)}</span>` : ''}
        ${meta ? `<span class="wn-release-meta">${escapeHTML(meta)}</span>` : ''}
      </div>
      ${(release.items || []).map(itemHTML).join('')}
    </section>`;
}

// Build and show the sheet. onDismiss runs once, after any dismissal
// (Done button, backdrop tap, Escape, or tapping a routed item).
function showSheet(entries, onDismiss) {
  if (active) return; // one sheet at a time

  const backdrop = document.createElement('div');
  backdrop.className = 'wn-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'wn-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', "What's new");
  sheet.tabIndex = -1;
  sheet.innerHTML = `
    <div class="wn-grabber" aria-hidden="true"></div>
    <h2 class="wn-title">What's new</h2>
    <div class="wn-body">${entries.map(releaseHTML).join('')}</div>
    <button type="button" class="wn-done">Done</button>
  `;

  const dismiss = () => {
    if (!active || active.sheet !== sheet) return;
    const { onKeyDown, prevFocus } = active;
    active = null;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.classList.remove('visible');
    sheet.classList.remove('visible');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 250);
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus({ preventScroll: true }); } catch { /* gone */ }
    }
    try { if (onDismiss) onDismiss(); } catch { /* silent */ }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  };

  backdrop.addEventListener('click', dismiss);
  sheet.querySelector('.wn-done').addEventListener('click', dismiss);
  sheet.addEventListener('click', (e) => {
    const btn = e.target.closest('.wn-item-link');
    if (!btn) return;
    const route = btn.dataset.route;
    dismiss();
    if (route) navigate(route);
  });
  document.addEventListener('keydown', onKeyDown, true);

  const prevFocus = document.activeElement;
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('visible');
    sheet.classList.add('visible');
  });
  sheet.focus({ preventScroll: true });

  active = { backdrop, sheet, onKeyDown, prevFocus };
}

function visibleEntries(changelog) {
  return (Array.isArray(changelog) ? changelog : [])
    .filter((r) => r && Array.isArray(r.items) && r.items.length > 0);
}

// Boot-time check. Call once after the router has rendered the first view.
export async function checkWhatsNew() {
  try {
    const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    const current = (await fetchJSON('/version.json')).version;
    if (!current) return;

    if (!lastSeen) {
      // First visit (or pre-feature profile): seed quietly, show nothing.
      localStorage.setItem(LAST_SEEN_KEY, current);
      return;
    }
    if (cmpVersions(current, lastSeen) <= 0) return; // up to date

    const changelog = await fetchJSON('/data/changelog.json');
    const entries = visibleEntries(changelog)
      .filter((r) => r.version && cmpVersions(r.version, lastSeen) > 0)
      .slice(0, MAX_ENTRIES); // file is newest-first

    if (entries.length === 0) {
      // Version moved but nothing user-facing to show — advance quietly so
      // we stop re-fetching the changelog on every load.
      localStorage.setItem(LAST_SEEN_KEY, current);
      return;
    }

    // Delay so the sheet never fights the initial paint.
    setTimeout(() => {
      try {
        showSheet(entries, () => {
          try { localStorage.setItem(LAST_SEEN_KEY, current); } catch { /* silent */ }
        });
      } catch { /* silent */ }
    }, 800);
  } catch { /* silent — never block the app */ }
}

// Unconditional open (Settings > What's new). Shows the newest entries
// regardless of seen state; opens immediately (this is a direct user action,
// not a boot-time surprise, so no delay). Only ever advances last-seen,
// never rewinds it.
export async function openWhatsNew() {
  try {
    const changelog = await fetchJSON('/data/changelog.json');
    const entries = visibleEntries(changelog).slice(0, MAX_ENTRIES);
    if (entries.length === 0) return;

    let current = null;
    try { current = (await fetchJSON('/version.json')).version; } catch { /* optional */ }

    showSheet(entries, () => {
      try {
        if (!current) return;
        const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
        if (!lastSeen || cmpVersions(current, lastSeen) > 0) {
          localStorage.setItem(LAST_SEEN_KEY, current);
        }
      } catch { /* silent */ }
    });
  } catch { /* silent */ }
}
