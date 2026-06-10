// Prayer Tracker view — log the five daily fard prayers, build a streak,
// and review history & stats. Spec: docs/prayer-tracker-spec.md.
// 100% client-side: all state lives in localStorage (iqamah-tracker-*).
//
// The data layer (readLog / setPrayerStatus / computeStreaks / computeStats)
// is exported so the Home check-in card (spec §3) can reuse it rather than
// duplicating storage logic.
import { gregorianToHijri } from '../utils/hijri.js';

// ============================================================
// Constants
// ============================================================

const LOG_KEY = 'iqamah-tracker-log';
const META_KEY = 'iqamah-tracker-meta';
const NOTIF_PRAYED_KEY = 'iqamah-notif-prayed';
const PRUNE_DAYS = 396;        // ~13 months of history kept (spec §5)
const EDIT_WINDOW_DAYS = 2;    // today + previous 2 days editable (spec §5)

export const PRAYERS = [
  { key: 'fajr', label: 'Fajr' },
  { key: 'dhuhr', label: 'Dhuhr' },
  { key: 'asr', label: 'Asr' },
  { key: 'maghrib', label: 'Maghrib' },
  { key: 'esha', label: 'Esha' },
];

export const STATUSES = [
  { key: 'jamaah', label: "Jama'ah" },
  { key: 'ontime', label: 'On time' },
  { key: 'late', label: 'Late' },
  { key: 'missed', label: 'Missed' },
];

const PRAYED_STATUSES = ['jamaah', 'ontime', 'late'];

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="6" x2="12" y2="18"/><line x1="6" y1="12" x2="18" y2="12"/></svg>';
const ICON_FLAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
const ICON_CHEVRON_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="15 18 9 12 15 6"/></svg>';
const ICON_CHEVRON_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// ============================================================
// Storage (with in-memory fallback for private-mode browsers)
// ============================================================

const memStore = {};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return memStore[key] ?? null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { memStore[key] = value; }
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ============================================================
// Date helpers (local device day, consistent with getTodayRow)
// ============================================================

function pad2(n) { return String(n).padStart(2, '0'); }

export function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

// "is b the day after a?" — via addDays so DST changes can't skew it
function isNextDay(aKey, bKey) {
  return localDateKey(addDays(parseKey(aKey), 1)) === bKey;
}

// ============================================================
// Data layer (exported for reuse by the Home check-in card)
// ============================================================

function emptyEntry() {
  const e = {};
  for (const p of PRAYERS) e[p.key] = null;
  return e;
}

export function readMeta() {
  const meta = safeParse(storageGet(META_KEY), null);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { trackSunnah: false, streakBest: 0, startedOn: null };
  }
  return {
    trackSunnah: meta.trackSunnah === true,
    streakBest: typeof meta.streakBest === 'number' ? meta.streakBest : 0,
    startedOn: typeof meta.startedOn === 'string' ? meta.startedOn : null,
  };
}

function writeMeta(meta) {
  storageSet(META_KEY, JSON.stringify(meta));
}

// Drop entries older than ~13 months (and any malformed keys)
function pruneLog(log, todayK) {
  const cutoff = localDateKey(addDays(parseKey(todayK), -PRUNE_DAYS));
  let changed = false;
  for (const k of Object.keys(log)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoff) {
      delete log[k];
      changed = true;
    }
  }
  return changed;
}

// Fold notification "Prayed" taps into today's log as jama'ah,
// but never overwrite an explicit user choice (spec §5).
function foldNotifPrayed(log, todayK) {
  const notif = safeParse(storageGet(NOTIF_PRAYED_KEY), null);
  if (!notif || typeof notif !== 'object') return false;
  const list = notif[todayK];
  if (!Array.isArray(list)) return false;
  let changed = false;
  for (const k of list) {
    if (!PRAYERS.some(p => p.key === k)) continue;
    if (!log[todayK]) log[todayK] = emptyEntry();
    if (log[todayK][k] == null) {
      log[todayK][k] = 'jamaah';
      changed = true;
    }
  }
  return changed;
}

export function readLog() {
  const todayK = localDateKey(new Date());
  let log = safeParse(storageGet(LOG_KEY), {});
  if (!log || typeof log !== 'object' || Array.isArray(log)) log = {};
  let changed = pruneLog(log, todayK);
  changed = foldNotifPrayed(log, todayK) || changed;
  if (changed) storageSet(LOG_KEY, JSON.stringify(log));
  return log;
}

export function isEditableDate(dateK) {
  const today = startOfDay(new Date());
  const minK = localDateKey(addDays(today, -EDIT_WINDOW_DAYS));
  return dateK >= minK && dateK <= localDateKey(today);
}

// Set (or clear, with status = null) one prayer's status for a date.
// Returns false when the date is outside the editable window.
export function setPrayerStatus(dateK, prayerKey, status) {
  if (!isEditableDate(dateK)) return false;
  if (!PRAYERS.some(p => p.key === prayerKey)) return false;
  if (status !== null && !STATUSES.some(s => s.key === status)) return false;

  const log = readLog();
  if (!log[dateK]) log[dateK] = emptyEntry();
  log[dateK][prayerKey] = status;
  storageSet(LOG_KEY, JSON.stringify(log));

  const meta = readMeta();
  if (!meta.startedOn) {
    meta.startedOn = localDateKey(new Date());
    writeMeta(meta);
  }
  computeStreaks(log); // persists a new best streak if reached
  return true;
}

// A day counts toward the streak when all five fard are logged with a
// non-missed, non-null status (spec §5).
export function isCompleteEntry(entry) {
  return !!entry && PRAYERS.every(p => PRAYED_STATUSES.includes(entry[p.key]));
}

function countPrayed(entry) {
  if (!entry) return 0;
  return PRAYERS.filter(p => PRAYED_STATUSES.includes(entry[p.key])).length;
}

function countStatus(entry, status) {
  if (!entry) return 0;
  return PRAYERS.filter(p => entry[p.key] === status).length;
}

// Current streak (today grace-exempt: an incomplete today doesn't break it)
// plus best streak, merged with the persisted meta value.
export function computeStreaks(log) {
  const today = startOfDay(new Date());
  const todayK = localDateKey(today);

  let current = 0;
  let cursor = isCompleteEntry(log[todayK]) ? today : addDays(today, -1);
  while (isCompleteEntry(log[localDateKey(cursor)])) {
    current++;
    cursor = addDays(cursor, -1);
  }

  const completeKeys = Object.keys(log).filter(k => isCompleteEntry(log[k])).sort();
  let best = 0, run = 0, prev = null;
  for (const k of completeKeys) {
    run = prev && isNextDay(prev, k) ? run + 1 : 1;
    if (run > best) best = run;
    prev = k;
  }

  const meta = readMeta();
  const merged = Math.max(best, current, meta.streakBest);
  if (merged !== meta.streakBest) {
    meta.streakBest = merged;
    writeMeta(meta);
  }
  return { current, best: merged };
}

// This week / this month % prayed (of all slots elapsed so far) and
// % of prayed prayers that were in jama'ah this month.
export function computeStats(log) {
  const today = startOfDay(new Date());
  const dow = (today.getDay() + 6) % 7; // 0 = Monday (UK week)

  let weekPrayed = 0;
  for (let i = 0; i <= dow; i++) {
    weekPrayed += countPrayed(log[localDateKey(addDays(today, -i))]);
  }
  const weekPct = Math.round((weekPrayed / ((dow + 1) * 5)) * 100);

  const dom = today.getDate();
  let monthPrayed = 0, monthJamaah = 0;
  for (let i = 0; i < dom; i++) {
    const entry = log[localDateKey(addDays(today, -i))];
    monthPrayed += countPrayed(entry);
    monthJamaah += countStatus(entry, 'jamaah');
  }
  const monthPct = Math.round((monthPrayed / (dom * 5)) * 100);
  const jamaahPct = monthPrayed > 0 ? Math.round((monthJamaah / monthPrayed) * 100) : null;

  return { weekPct, monthPct, jamaahPct };
}

// ============================================================
// View state
// ============================================================

let root = null;
let todayKey = null;
let viewMonth = null;       // Date — first day of the displayed month
let editorDateKey = null;   // 'YYYY-MM-DD' | null — open day editor
let pickerOpenFor = null;   // prayer key | null — open status popover
let docClickHandler = null;
let keyHandler = null;
let visHandler = null;
let tickInterval = null;

function buzz() {
  if (navigator.vibrate) navigator.vibrate(20);
}

function statusLabel(status) {
  const s = STATUSES.find(x => x.key === status);
  return s ? s.label : null;
}

function statusIcon(status) {
  if (status === 'missed') return ICON_DASH;
  if (PRAYED_STATUSES.includes(status)) return ICON_CHECK;
  return ICON_PLUS;
}

// ============================================================
// Render
// ============================================================

export function render(container) {
  const now = new Date();
  todayKey = localDateKey(now);
  viewMonth = startOfMonth(now);
  editorDateKey = null;
  pickerOpenFor = null;

  container.innerHTML = `
    <div class="tracker-view">
      <header class="tracker-header">
        <h1>Prayer Tracker</h1>
        <p class="tracker-subtitle">Log your five daily prayers and build a streak</p>
      </header>
      <section class="tracker-streak-card" id="trackerStreak" aria-live="polite"></section>
      <section class="tracker-today-card" id="trackerToday"></section>
      <section class="tracker-stats" id="trackerStats"></section>
      <section class="tracker-month-card" id="trackerMonth"></section>
      <section id="trackerEditorSlot"></section>
      <p class="tracker-note">Stored privately on this device<span class="tracker-note-edit">Today and the previous two days can be edited</span></p>
    </div>`;

  root = container.querySelector('.tracker-view');
  root.addEventListener('click', onRootClick);

  // Dismiss the status popover on outside taps (capture phase so it runs
  // before the delegated handler opens a new one).
  docClickHandler = (e) => {
    if (!pickerOpenFor) return;
    if (e.target.closest('.tracker-picker') || e.target.closest('.tracker-seg')) return;
    closePicker();
  };
  document.addEventListener('click', docClickHandler, true);

  keyHandler = (e) => {
    if (e.key === 'Escape') closePicker();
  };
  document.addEventListener('keydown', keyHandler);

  // Refresh when the app regains focus (picks up notification "Prayed"
  // folds and day rollovers) and once a minute for midnight rollover.
  visHandler = () => {
    if (document.visibilityState === 'visible') checkDayAndRefresh(true);
  };
  document.addEventListener('visibilitychange', visHandler);
  tickInterval = setInterval(() => checkDayAndRefresh(false), 60000);

  refreshAll();
}

export function destroy() {
  closePicker(); // popover lives on document.body now — remove it explicitly
  if (docClickHandler) {
    document.removeEventListener('click', docClickHandler, true);
    docClickHandler = null;
  }
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  if (visHandler) {
    document.removeEventListener('visibilitychange', visHandler);
    visHandler = null;
  }
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  root = null;
  editorDateKey = null;
}

function checkDayAndRefresh(force) {
  if (!root) return;
  const nowKey = localDateKey(new Date());
  if (nowKey !== todayKey) {
    const wasCurrentMonth = viewMonth.getTime() === startOfMonth(parseKey(todayKey)).getTime();
    todayKey = nowKey;
    if (wasCurrentMonth) viewMonth = startOfMonth(new Date());
    if (editorDateKey && !isEditableDate(editorDateKey)) editorDateKey = null;
    refreshAll();
  } else if (force) {
    refreshAll();
  }
}

function refreshAll() {
  if (!root) return;
  closePicker();
  const log = readLog();
  renderStreak(log);
  renderToday(log);
  renderStats(log);
  renderGrid(log);
  renderEditor(log);
}

// ---------- Streak card ----------

function renderStreak(log) {
  const el = root.querySelector('#trackerStreak');
  if (!el) return;
  const { current, best } = computeStreaks(log);
  const todayComplete = isCompleteEntry(log[todayKey]);

  let hint;
  if (todayComplete) {
    hint = 'All five logged today, ma sha Allah';
  } else if (current > 0) {
    hint = "Log today's prayers to keep it going";
  } else {
    hint = 'Log all five prayers today to start a streak';
  }

  const countHTML = current > 0
    ? `<strong>${current}</strong><span>-day streak</span>`
    : '<span>No streak yet</span>';

  el.innerHTML = `
    <span class="tracker-flame${current > 0 ? '' : ' is-zero'}">${ICON_FLAME}</span>
    <div class="tracker-streak-text">
      <div class="tracker-streak-count">${countHTML}</div>
      <div class="tracker-streak-hint">${hint}</div>
    </div>
    <div class="tracker-streak-best">
      <span>Best</span>
      <strong>${best}</strong>
    </div>`;
}

// ---------- Today check-in card ----------

function renderToday(log) {
  const el = root.querySelector('#trackerToday');
  if (!el) return;
  const today = parseKey(todayKey);
  const hijri = gregorianToHijri(today);
  const gregStr = today.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const entry = log[todayKey] || emptyEntry();

  const segs = PRAYERS.map(p => {
    const st = entry[p.key];
    const stClass = st ? `tr-st-${st}` : 'tr-st-none';
    // Status is conveyed by the dot's colour/icon alone — no text row.
    return `
      <button class="tracker-seg" data-prayer="${p.key}" aria-haspopup="menu"
              aria-label="${p.label}: ${statusLabel(st) || 'not logged yet'}">
        <span class="tracker-seg-name">${p.label}</span>
        <span class="tracker-seg-dot ${stClass}">${statusIcon(st)}</span>
      </button>`;
  }).join('');

  el.innerHTML = `
    <div class="tracker-card-head">
      <span class="tracker-card-title">Today</span>
      <span class="tracker-card-date">${gregStr} · ${hijri.day} ${hijri.monthName}</span>
    </div>
    <div class="tracker-seg-row">${segs}</div>`;
}

// ---------- Status picker popover ----------
// The popover is portalled to document.body with fixed positioning. It used
// to live inside #trackerToday, but every tracker card has backdrop-filter,
// which creates a stacking context per card — so the stats cards (later in
// DOM order) always painted over the picker no matter its z-index. A body
// portal escapes the card's stacking context entirely; styling lives in
// _agent_css/tracker-fixes.css under .tracker-picker-portal.

let pickerEl = null;          // the portalled popover element, if open
let pickerReposition = null;  // scroll/resize handler keeping it anchored

function openPicker(prayerKey, segEl) {
  closePicker();
  pickerOpenFor = prayerKey;

  const entry = readLog()[todayKey] || emptyEntry();
  const current = entry[prayerKey];

  const pop = document.createElement('div');
  pop.className = 'tracker-picker tracker-picker-portal';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = STATUSES.map(s => `
    <button class="tracker-picker-opt${current === s.key ? ' active' : ''}"
            data-status="${s.key}" role="menuitemradio" aria-checked="${current === s.key}">
      <span class="tracker-picker-dot tr-st-${s.key}"></span>${s.label}
    </button>`).join('')
    + (current ? `<button class="tracker-picker-opt tracker-picker-clear" data-status="">Clear</button>` : '');

  // The popover no longer lives inside the view root, so option clicks won't
  // reach the delegated root handler — handle them on the element itself.
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('.tracker-picker-opt');
    if (!opt || !pickerOpenFor) return;
    setPrayerStatus(todayKey, pickerOpenFor, opt.dataset.status || null);
    buzz();
    refreshAll(); // closes the picker via closePicker()
  });

  document.body.appendChild(pop);
  pickerEl = pop;

  // Anchor under the tapped segment in viewport coords, clamped to the
  // viewport; flips above the segment when there's no room below.
  const position = () => {
    if (!pickerEl) return;
    const rect = segEl.getBoundingClientRect();
    const popW = pickerEl.offsetWidth;
    const popH = pickerEl.offsetHeight;
    let left = rect.left + rect.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
    let top = rect.bottom + 6;
    if (top + popH + 8 > window.innerHeight) {
      top = Math.max(8, rect.top - popH - 6);
    }
    pickerEl.style.left = `${left}px`;
    pickerEl.style.top = `${top}px`;
  };
  position();

  // Fixed positioning means viewport coords drift as the page scrolls —
  // keep the popover glued to its segment (capture catches inner scrollers).
  pickerReposition = position;
  window.addEventListener('scroll', pickerReposition, true);
  window.addEventListener('resize', pickerReposition);
}

function closePicker() {
  pickerOpenFor = null;
  if (pickerReposition) {
    window.removeEventListener('scroll', pickerReposition, true);
    window.removeEventListener('resize', pickerReposition);
    pickerReposition = null;
  }
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
  }
}

// ---------- Stats strip ----------

function renderStats(log) {
  const el = root.querySelector('#trackerStats');
  if (!el) return;
  const { weekPct, monthPct, jamaahPct } = computeStats(log);
  el.innerHTML = `
    <div class="tracker-stat">
      <div class="tracker-stat-value">${weekPct}%</div>
      <div class="tracker-stat-label">This week</div>
      <div class="tracker-stat-sub">prayed</div>
    </div>
    <div class="tracker-stat">
      <div class="tracker-stat-value">${monthPct}%</div>
      <div class="tracker-stat-label">This month</div>
      <div class="tracker-stat-sub">prayed</div>
    </div>
    <div class="tracker-stat">
      <div class="tracker-stat-value">${jamaahPct === null ? '-' : jamaahPct + '%'}</div>
      <div class="tracker-stat-label">Jama'ah</div>
      <div class="tracker-stat-sub">prayed</div>
    </div>`;
}

// ---------- Month grid ----------

function renderGrid(log) {
  const el = root.querySelector('#trackerMonth');
  if (!el) return;

  const today = parseKey(todayKey);
  const minMonth = startOfMonth(addDays(today, -PRUNE_DAYS));
  const maxMonth = startOfMonth(today);
  const prevDisabled = viewMonth.getTime() <= minMonth.getTime();
  const nextDisabled = viewMonth.getTime() >= maxMonth.getTime();

  const title = viewMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const lead = (viewMonth.getDay() + 6) % 7; // blanks before the 1st (Monday start)
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="tracker-day tracker-day-blank"></span>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateK = localDateKey(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));
    const entry = log[dateK];
    const isFuture = dateK > todayKey;
    const editable = isEditableDate(dateK);
    const complete = isCompleteEntry(entry);

    const dots = PRAYERS.map(p => {
      const st = entry ? entry[p.key] : null;
      return `<span class="tracker-day-dot ${st ? `tr-st-${st}` : 'tr-st-none'}"></span>`;
    }).join('');

    const classes = ['tracker-day'];
    if (dateK === todayKey) classes.push('is-today');
    if (editable) classes.push('is-editable');
    if (complete) classes.push('is-complete');
    if (isFuture) classes.push('is-future');

    const label = `${d} ${title}${editable ? ', tap to edit' : ''}`;
    cells += `
      <button class="${classes.join(' ')}" data-date="${dateK}" ${editable ? '' : 'disabled'}
              aria-label="${label}">
        <span class="tracker-day-num">${d}</span>
        <span class="tracker-day-dots">${dots}</span>
      </button>`;
  }

  const legend = STATUSES.map(s => `
    <span class="tracker-legend-item">
      <span class="tracker-day-dot tr-st-${s.key}"></span>${s.label}
    </span>`).join('')
    + '<span class="tracker-legend-item"><span class="tracker-legend-ring"></span>All five prayed</span>';

  el.innerHTML = `
    <div class="tracker-month-nav">
      <button class="tracker-month-btn" data-nav="-1" ${prevDisabled ? 'disabled' : ''} aria-label="Previous month">${ICON_CHEVRON_L}</button>
      <div class="tracker-month-title">${title}</div>
      <button class="tracker-month-btn" data-nav="1" ${nextDisabled ? 'disabled' : ''} aria-label="Next month">${ICON_CHEVRON_R}</button>
    </div>
    <div class="tracker-dow">
      <span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span>
    </div>
    <div class="tracker-grid">${cells}</div>
    <div class="tracker-legend">${legend}</div>`;
}

// ---------- Day editor (editable window only) ----------

function renderEditor(log) {
  const slot = root.querySelector('#trackerEditorSlot');
  if (!slot) return;
  if (!editorDateKey) {
    slot.innerHTML = '';
    return;
  }

  const entry = log[editorDateKey] || emptyEntry();
  const d = parseKey(editorDateKey);
  const title = editorDateKey === todayKey
    ? 'Today'
    : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const rows = PRAYERS.map(p => {
    const st = entry[p.key];
    const chips = STATUSES.map(s => `
      <button class="tracker-chip${st === s.key ? ` active tr-st-${s.key}` : ''}"
              data-prayer="${p.key}" data-status="${s.key}"
              aria-pressed="${st === s.key}">${s.label}</button>`).join('');
    return `
      <div class="tracker-editor-row">
        <span class="tracker-editor-prayer">${p.label}</span>
        <div class="tracker-editor-opts">${chips}</div>
      </div>`;
  }).join('');

  slot.innerHTML = `
    <div class="tracker-editor">
      <div class="tracker-card-head">
        <span class="tracker-card-title">Edit · ${title}</span>
        <button class="tracker-editor-close" aria-label="Close editor">${ICON_CLOSE}</button>
      </div>
      ${rows}
      <p class="tracker-editor-hint">Tap a selected status again to clear it</p>
    </div>`;
}

// ---------- Delegated click handling ----------

function onRootClick(e) {
  // (Status popover options are handled on the popover element itself —
  // it's portalled to document.body, so those clicks never reach here.)

  // Today segment → toggle the status popover
  const seg = e.target.closest('.tracker-seg');
  if (seg) {
    if (pickerOpenFor === seg.dataset.prayer) {
      closePicker();
    } else {
      openPicker(seg.dataset.prayer, seg);
    }
    return;
  }

  // Month navigation
  const monthBtn = e.target.closest('.tracker-month-btn');
  if (monthBtn && !monthBtn.disabled) {
    viewMonth = addMonths(viewMonth, Number(monthBtn.dataset.nav));
    renderGrid(readLog());
    return;
  }

  // Grid day → open the day editor (editable days only; others are disabled)
  const dayBtn = e.target.closest('.tracker-day');
  if (dayBtn && dayBtn.dataset.date && isEditableDate(dayBtn.dataset.date)) {
    editorDateKey = dayBtn.dataset.date;
    renderEditor(readLog());
    const editor = root.querySelector('.tracker-editor');
    if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  // Editor close
  if (e.target.closest('.tracker-editor-close')) {
    editorDateKey = null;
    renderEditor(readLog());
    return;
  }

  // Editor status chip — tap to set, tap the active one again to clear
  const chip = e.target.closest('.tracker-chip');
  if (chip && editorDateKey) {
    const isActive = chip.classList.contains('active');
    setPrayerStatus(editorDateKey, chip.dataset.prayer, isActive ? null : chip.dataset.status);
    buzz();
    refreshAll();
  }
}
