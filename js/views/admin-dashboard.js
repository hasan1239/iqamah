// Admin fleet-health dashboard — one page listing every masjid with
// data-health columns so the maintainer can triage from a phone.
// Admin-gated via isAdmin(); everything is client-side from the single
// /data/mosques/index.json fetch (the index carries full config objects).
import { isAdmin } from '../utils/admin.js';

const PROVIDER_LABELS = {
  mawaqit: 'Mawaqit',
  esalaat: 'eSalaat',
  mymasjid: 'MyMasjid',
  masjidbox: 'MasjidBox',
  londonprayertimes: 'LondonPrayerTimes',
  masjidal: 'Masjidal',
  image: 'Timetable',
  manual: 'Manual',
};

const STATUS_META = {
  needs_review: { label: 'Needs review', cls: 'review', rank: 0 },
  warnings: { label: 'Warnings', cls: 'warn', rank: 1 },
  none: { label: 'No checks', cls: 'none', rank: 2 },
  ok: { label: 'OK', cls: 'ok', rank: 3 },
};

const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

// --- Module state ---
let viewRoot = null;
let configs = [];
let searchQuery = '';
let statusFilter = 'all';
let sortKey = 'status'; // 'status' | 'checked' | 'name'
let expandedSlugs = new Set();
let renderGen = 0;

// --- Helpers ---

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mirrors prayer-times.js renderSourceTag derivation: legacy configs that
// only carry a source_image are the "image" (Timetable) source.
function providerType(cfg) {
  const ptype = cfg.provider && cfg.provider.type;
  if (ptype) return ptype;
  if (cfg.source_image) return 'image';
  return null;
}

function providerLabel(cfg) {
  const type = providerType(cfg);
  if (!type) return 'None';
  return PROVIDER_LABELS[type] || type;
}

function qualityStatus(cfg) {
  const s = cfg.quality && cfg.quality.status;
  return STATUS_META[s] ? s : 'none';
}

function statusRank(cfg) {
  return STATUS_META[qualityStatus(cfg)].rank;
}

function isStaleish(cfg) {
  return cfg.is_stale === true || cfg.pending_update === true;
}

function getFlags(cfg) {
  const flags = [];
  if (cfg.approved === false) flags.push({ cls: 'unapproved', label: 'Unapproved' });
  if (cfg.is_stale === true) flags.push({ cls: 'stale', label: 'Stale' });
  if (cfg.pending_update === true) flags.push({ cls: 'pending', label: 'Pending update' });
  if (cfg.hidden === true) flags.push({ cls: 'hidden', label: 'Hidden' });
  if (cfg.test_masjid === true) flags.push({ cls: 'test', label: 'Test' });
  if (cfg.today_only === true) flags.push({ cls: 'today-only', label: 'Today only' });
  return flags;
}

function checkedInfo(cfg) {
  const raw = cfg.quality && cfg.quality.checked_at;
  if (!raw) return { text: 'never', days: Infinity, old: true };
  const d = new Date(raw + 'T00:00:00');
  if (isNaN(d.getTime())) return { text: esc(raw), days: Infinity, old: true };
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const text = d.toLocaleDateString('en-GB', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
  return { text: `${text} (${days}d)`, days, old: days > 14 };
}

function checkedSortValue(cfg) {
  const raw = cfg.quality && cfg.quality.checked_at;
  if (!raw) return ''; // sorts before any ISO date → never-checked floats to top
  return raw;
}

function nameCompare(a, b) {
  return (a.display_name || a.slug || '').localeCompare(
    b.display_name || b.slug || '', undefined,
    { sensitivity: 'base', ignorePunctuation: true });
}

function matchesFilter(cfg) {
  if (statusFilter === 'unapproved') {
    if (cfg.approved !== false) return false;
  } else if (statusFilter === 'stale') {
    if (!isStaleish(cfg)) return false;
  } else if (statusFilter !== 'all') {
    if (qualityStatus(cfg) !== statusFilter) return false;
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const name = (cfg.display_name || '').toLowerCase();
    const slug = (cfg.slug || '').toLowerCase();
    if (!name.includes(q) && !slug.includes(q)) return false;
  }
  return true;
}

function sortConfigs(list) {
  const sorted = list.slice();
  if (sortKey === 'name') {
    sorted.sort(nameCompare);
  } else if (sortKey === 'checked') {
    // Oldest first — never-checked (empty string) floats to the very top.
    sorted.sort((a, b) => {
      const av = checkedSortValue(a);
      const bv = checkedSortValue(b);
      if (av !== bv) return av < bv ? -1 : 1;
      return nameCompare(a, b);
    });
  } else {
    // Status severity: needs_review → warnings → no checks → ok,
    // then oldest-checked first within each band.
    sorted.sort((a, b) => {
      const ra = statusRank(a);
      const rb = statusRank(b);
      if (ra !== rb) return ra - rb;
      const av = checkedSortValue(a);
      const bv = checkedSortValue(b);
      if (av !== bv) return av < bv ? -1 : 1;
      return nameCompare(a, b);
    });
  }
  return sorted;
}

// --- Summary ---

function buildSummary() {
  const total = configs.length;
  const byStatus = { ok: 0, warnings: 0, needs_review: 0, none: 0 };
  let unapproved = 0;
  let staleish = 0;
  const byProvider = {};

  configs.forEach(cfg => {
    byStatus[qualityStatus(cfg)]++;
    if (cfg.approved === false) unapproved++;
    if (isStaleish(cfg)) staleish++;
    const label = providerLabel(cfg);
    byProvider[label] = (byProvider[label] || 0) + 1;
  });

  const providerPills = Object.keys(byProvider)
    .sort((a, b) => byProvider[b] - byProvider[a] || a.localeCompare(b))
    .map(label => `<span class="admin-provider-pill">${esc(label)} <strong>${byProvider[label]}</strong></span>`)
    .join('');

  return `
    <div class="admin-summary">
      <button type="button" class="admin-stat" data-filter="all">
        <span class="admin-stat-value">${total}</span>
        <span class="admin-stat-label">Total</span>
      </button>
      <button type="button" class="admin-stat admin-stat-ok" data-filter="ok">
        <span class="admin-stat-value">${byStatus.ok}</span>
        <span class="admin-stat-label">OK</span>
      </button>
      <button type="button" class="admin-stat admin-stat-warn" data-filter="warnings">
        <span class="admin-stat-value">${byStatus.warnings}</span>
        <span class="admin-stat-label">Warnings</span>
      </button>
      <button type="button" class="admin-stat admin-stat-review" data-filter="needs_review">
        <span class="admin-stat-value">${byStatus.needs_review}</span>
        <span class="admin-stat-label">Review</span>
      </button>
      <button type="button" class="admin-stat" data-filter="unapproved">
        <span class="admin-stat-value">${unapproved}</span>
        <span class="admin-stat-label">Unapproved</span>
      </button>
      <button type="button" class="admin-stat" data-filter="stale">
        <span class="admin-stat-value">${staleish}</span>
        <span class="admin-stat-label">Stale</span>
      </button>
    </div>
    <div class="admin-providers">${providerPills}</div>`;
}

// --- Rows ---

function issueTags(cfg) {
  const issues = (cfg.quality && cfg.quality.issues) || [];
  if (!issues.length) return '';
  const seen = new Set();
  const tags = [];
  issues.forEach(issue => {
    if (!issue || !issue.type || seen.has(issue.type)) return;
    seen.add(issue.type);
    const sev = issue.severity === 'high' ? 'high' : 'medium';
    const ack = issue.acknowledged ? ' <span class="admin-issue-ack" title="Acknowledged">&#10003;</span>' : '';
    tags.push(`<span class="admin-issue-tag admin-issue-${sev}">${esc(issue.type)}${ack}</span>`);
  });
  const shown = tags.slice(0, 3);
  const extra = tags.length - shown.length;
  if (extra > 0) shown.push(`<span class="admin-issue-tag admin-issue-more">+${extra}</span>`);
  return shown.join('');
}

function rowDetail(cfg) {
  const q = cfg.quality;
  let html = '';

  if (!q) {
    html += `<p class="admin-detail-empty">No quality data — legacy config (no provider block).</p>`;
  } else {
    const warnings = q.warnings || [];
    if (warnings.length) {
      html += `<div class="admin-detail-section">
        <div class="admin-detail-title">Warnings</div>
        <ul class="admin-detail-list">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>`;
    }
    const issues = q.issues || [];
    if (issues.length) {
      html += `<div class="admin-detail-section">
        <div class="admin-detail-title">Issues</div>
        <ul class="admin-detail-list">${issues.map(issue => {
          const sev = issue.severity === 'high' ? 'high' : 'medium';
          const bits = [];
          if (issue.count != null) bits.push(`count: ${esc(issue.count)}`);
          if (issue.first_date) bits.push(`${esc(issue.first_date)} &rarr; ${esc(issue.last_date || '?')}`);
          if (issue.action_taken) bits.push(`action: ${esc(issue.action_taken)}`);
          if (issue.fix) bits.push(`fix: ${esc(issue.fix)}`);
          return `<li>
            <span class="admin-issue-tag admin-issue-${sev}">${esc(issue.type)}</span>
            <span class="admin-detail-sev">${esc(issue.severity || '?')}${issue.acknowledged ? ', acknowledged' : ''}</span>
            ${bits.length ? `<div class="admin-detail-bits">${bits.join(' &middot; ')}</div>` : ''}
          </li>`;
        }).join('')}</ul>
      </div>`;
    }
    if (!warnings.length && !issues.length) {
      html += `<p class="admin-detail-empty">No warnings or issues recorded.</p>`;
    }
    const acked = cfg.acknowledged_issues || [];
    if (acked.length) {
      html += `<div class="admin-detail-ack">Acknowledged: ${acked.map(esc).join(', ')}</div>`;
    }
  }

  const csv = cfg.csv || `${cfg.slug}.csv`;
  html += `<div class="admin-detail-meta">slug: <code>${esc(cfg.slug)}</code> &middot; csv: <code>${esc(csv)}</code>${cfg.city ? ` &middot; ${esc(cfg.city)}` : ''}</div>`;
  html += `<div class="admin-detail-actions">
    <a href="/update/${esc(cfg.slug)}" data-link class="admin-detail-btn">Update masjid</a>
    <a href="/${esc(cfg.slug)}" data-link class="admin-detail-btn admin-detail-btn-ghost">Open page</a>
  </div>`;
  return html;
}

function rowHTML(cfg) {
  const status = qualityStatus(cfg);
  const meta = STATUS_META[status];
  const checked = checkedInfo(cfg);
  const rows = cfg.quality && cfg.quality.row_count != null ? cfg.quality.row_count : '&mdash;';
  const flags = getFlags(cfg)
    .map(f => `<span class="admin-flag admin-flag-${f.cls}">${f.label}</span>`)
    .join('');
  const tags = issueTags(cfg);
  const expanded = expandedSlugs.has(cfg.slug);

  return `
    <article class="admin-row${expanded ? ' expanded' : ''}" data-slug="${esc(cfg.slug)}">
      <div class="admin-row-main">
        <div class="admin-row-head">
          <a href="/${esc(cfg.slug)}" data-link class="admin-row-name">${esc(cfg.display_name || cfg.slug)}</a>
          <span class="admin-chip admin-chip-${meta.cls}">${meta.label}</span>
          <span class="admin-row-caret">${CHEVRON_SVG}</span>
        </div>
        <div class="admin-row-meta">
          <span class="admin-meta-provider">${esc(providerLabel(cfg))}</span>
          <span class="admin-meta-dot">&middot;</span>
          <span class="admin-meta-checked${checked.old ? ' is-old' : ''}">checked ${checked.text}</span>
          <span class="admin-meta-dot">&middot;</span>
          <span class="admin-meta-rows">${rows} rows</span>
        </div>
        ${flags || tags ? `<div class="admin-row-tags">${flags}${tags}</div>` : ''}
      </div>
      <div class="admin-row-detail"${expanded ? '' : ' hidden'}>${expanded ? rowDetail(cfg) : ''}</div>
    </article>`;
}

function renderList() {
  if (!viewRoot) return;
  const listEl = viewRoot.querySelector('#adminList');
  const countEl = viewRoot.querySelector('#adminResultCount');
  if (!listEl) return;

  const filtered = sortConfigs(configs.filter(matchesFilter));
  if (countEl) {
    countEl.textContent = `${filtered.length} of ${configs.length} masjids`;
  }
  if (!filtered.length) {
    listEl.innerHTML = `<div class="admin-empty">No masjids match.</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(rowHTML).join('');
}

function syncControls() {
  if (!viewRoot) return;
  viewRoot.querySelectorAll('.admin-filter-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === statusFilter);
  });
  const sortSel = viewRoot.querySelector('#adminSort');
  if (sortSel) sortSel.value = sortKey;
}

// --- Dashboard shell ---

function renderDashboard() {
  const chips = [
    ['all', 'All'],
    ['ok', 'OK'],
    ['warnings', 'Warnings'],
    ['needs_review', 'Needs review'],
    ['unapproved', 'Unapproved'],
    ['stale', 'Stale'],
  ].map(([key, label]) =>
    `<button type="button" class="admin-filter-chip${statusFilter === key ? ' active' : ''}" data-filter="${key}">${label}</button>`
  ).join('');

  viewRoot.innerHTML = `
    <header class="admin-header">
      <h1>Fleet Health</h1>
      <p class="admin-subtitle">Data health across all masjids</p>
    </header>
    ${buildSummary()}
    <div class="admin-controls">
      <div class="admin-search-bar">
        <span class="admin-search-icon">${SEARCH_SVG}</span>
        <input type="text" id="adminSearch" class="admin-search-input" placeholder="Filter by name or slug..." autocomplete="off">
      </div>
      <div class="admin-filter-row">${chips}</div>
      <div class="admin-sort-row">
        <span id="adminResultCount" class="admin-result-count"></span>
        <label class="admin-sort-label" for="adminSort">Sort
          <select id="adminSort" class="admin-sort-select">
            <option value="status">Severity</option>
            <option value="checked">Oldest checked</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
    </div>
    <div class="admin-list" id="adminList"></div>`;

  // Search
  const search = viewRoot.querySelector('#adminSearch');
  if (search) {
    search.addEventListener('input', () => {
      searchQuery = search.value.trim();
      renderList();
    });
  }

  // Sort
  const sortSel = viewRoot.querySelector('#adminSort');
  if (sortSel) {
    sortSel.value = sortKey;
    sortSel.addEventListener('change', () => {
      sortKey = sortSel.value;
      renderList();
    });
  }

  // Delegated clicks: summary tiles, filter chips, row expansion
  viewRoot.addEventListener('click', onViewClick);

  renderList();
}

function onViewClick(e) {
  // Summary stat tiles double as filters
  const stat = e.target.closest('.admin-stat[data-filter]');
  if (stat && viewRoot && viewRoot.contains(stat)) {
    statusFilter = stat.dataset.filter;
    syncControls();
    renderList();
    return;
  }

  const chip = e.target.closest('.admin-filter-chip');
  if (chip && viewRoot && viewRoot.contains(chip)) {
    statusFilter = chip.dataset.filter;
    syncControls();
    renderList();
    return;
  }

  // Row tap toggles the drill-down — but let real links navigate, and
  // don't collapse when interacting inside the expanded detail panel.
  if (e.target.closest('a')) return;
  if (e.target.closest('.admin-row-detail')) return;
  const row = e.target.closest('.admin-row[data-slug]');
  if (!row || !viewRoot || !viewRoot.contains(row)) return;
  const slug = row.dataset.slug;
  const detail = row.querySelector('.admin-row-detail');
  if (!detail) return;
  if (expandedSlugs.has(slug)) {
    expandedSlugs.delete(slug);
    row.classList.remove('expanded');
    detail.hidden = true;
    detail.innerHTML = '';
  } else {
    expandedSlugs.add(slug);
    const cfg = configs.find(c => c.slug === slug);
    detail.innerHTML = cfg ? rowDetail(cfg) : '';
    detail.hidden = false;
    row.classList.add('expanded');
  }
}

// --- View lifecycle ---

export async function render(container, params) {
  const gen = ++renderGen;

  // Neutral gate screen — no data is shown until the admin check resolves.
  container.innerHTML = `
    <div class="admin-view">
      <div class="admin-gate" aria-busy="true">
        <div class="skeleton-bone" style="width:50%;height:1.4rem;margin:24px auto 14px;border-radius:8px"></div>
        <div class="skeleton-bone" style="width:70%;height:0.8rem;margin:0 auto;border-radius:6px"></div>
      </div>
    </div>`;
  viewRoot = container.querySelector('.admin-view');

  const admin = await isAdmin();
  if (gen !== renderGen || !viewRoot) return; // navigated away mid-check

  if (!admin) {
    viewRoot.innerHTML = `
      <div class="admin-denied">
        <h1>Not authorised</h1>
        <p>This page is only available to the site maintainer.</p>
        <a href="/" data-link class="admin-detail-btn">Go home</a>
      </div>`;
    return;
  }

  try {
    const res = await fetch('/data/mosques/index.json');
    if (gen !== renderGen || !viewRoot) return;
    if (!res.ok) throw new Error(`index.json ${res.status}`);
    configs = await res.json();
    if (gen !== renderGen || !viewRoot) return;
    renderDashboard();
  } catch (err) {
    console.error('Admin dashboard failed to load:', err);
    if (gen !== renderGen || !viewRoot) return;
    viewRoot.innerHTML = `
      <div class="admin-denied">
        <h1>Couldn't load data</h1>
        <p>Failed to fetch the masjid index. Check your connection and try again.</p>
        <a href="/admin" data-link class="admin-detail-btn">Retry</a>
      </div>`;
  }
}

export function destroy() {
  renderGen++;
  if (viewRoot) viewRoot.removeEventListener('click', onViewClick);
  viewRoot = null;
  configs = [];
  searchQuery = '';
  statusFilter = 'all';
  sortKey = 'status';
  expandedSlugs = new Set();
}
