// Notification preferences + foreground (v0) scheduler.
//
// v0 scope: reminders fire via the service worker while the app is open. There
// is no server yet — see docs/push-notifications-spec.md for the v1 server-push
// plan. Prefs live in localStorage under `iqamah-notif-prefs`; on v1 they move
// into the push subscription record.

import { isIOSSafari, isStandalone, isIOS } from './pwa.js';
import { parseCSV, getTodayRow } from './csv.js';
import { buildReminders } from './prayer-schedule.js';

const PREFS_KEY = 'iqamah-notif-prefs';
const FIRED_KEY = 'iqamah-notif-fired';
const NOTIF_ICON = '/iqamah-icon.png';            // large icon — navy/gold brand mark
const NOTIF_BADGE = '/iqamah-icon-transparent.png'; // status-bar badge (Android masks to white)
// Action buttons (Android / installed PWA only — iOS ignores them gracefully).
// "Prayed" marks the salah done for today so its remaining jama'at/end
// reminders are suppressed (see handleSwMessage + the prayed-guard below).
const NOTIF_ACTIONS = [
  { action: 'view', title: 'View times' },
  { action: 'prayed', title: 'Prayed' },
];

// Default state on first enable: all starts on at-time, jama'at/ends-soon off,
// Ramadan Suhoor 30m + Iftar at-time. (spec §4)
export function defaultPrefs() {
  const day = () => ({
    start: { on: true, lead: 0 },
    jamaat: { on: false, lead: 15 },
    end: { on: false, lead: 30 },
  });
  const fajr = day(); const dhuhr = day(); const asr = day();
  const maghrib = { start: { on: true, lead: 0 }, jamaat: { on: false, lead: 15 } }; // no end
  const esha = { start: { on: true, lead: 0 }, jamaat: { on: false, lead: 15 } };    // no end
  return {
    master: false, // off until the user explicitly enables + grants permission
    slug: null,    // null = follow iqamah-pinned-masjid
    prayers: { fajr, dhuhr, asr, maghrib, esha },
    ramadanExtras: { suhoor: { on: true, lead: 30 }, iftar: { on: true, lead: 0 } },
  };
}

// Deep-merge stored prefs over defaults so newly added fields are filled in.
export function loadPrefs() {
  const base = defaultPrefs();
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { stored = null; }
  if (!stored) return base;
  const merged = { ...base, ...stored };
  merged.prayers = { ...base.prayers };
  for (const k of Object.keys(base.prayers)) {
    merged.prayers[k] = { ...base.prayers[k], ...(stored.prayers && stored.prayers[k]) };
  }
  merged.ramadanExtras = {
    suhoor: { ...base.ramadanExtras.suhoor, ...(stored.ramadanExtras && stored.ramadanExtras.suhoor) },
    iftar: { ...base.ramadanExtras.iftar, ...(stored.ramadanExtras && stored.ramadanExtras.iftar) },
  };
  return merged;
}

export function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent('iqamah-notif-prefs-changed'));
}

// --- Capability / permission ---

// 'unsupported' | 'ios-needs-install' | 'default' | 'granted' | 'denied'
export function getNotificationState() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    // iOS Safari (not installed) has no Notification API at all — guide install.
    if (isIOS() && !isStandalone()) return 'ios-needs-install';
    return 'unsupported';
  }
  if (isIOSSafari() && !isStandalone()) return 'ios-needs-install';
  return Notification.permission; // default | granted | denied
}

export async function requestPermission() {
  if (!('Notification' in window)) return 'denied';
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

// --- Time formatting (respects iqamah-time-format) ---

function use24h() { return localStorage.getItem('iqamah-time-format') !== '12'; }

function formatTime(timeStr, isAM) {
  const m = (timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return timeStr || '';
  let hours = parseInt(m[1], 10);
  const minutes = m[2];
  const already24h = hours >= 13 || hours === 0;
  if (already24h) isAM = hours < 12;
  if (use24h()) {
    if (!already24h) { if (!isAM && hours !== 12) hours += 12; if (isAM && hours === 12) hours = 0; }
    return `${hours}:${minutes}`;
  }
  if (already24h) {
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${h12}:${minutes} ${suffix}`;
  }
  return `${hours}:${minutes} ${isAM ? 'AM' : 'PM'}`;
}

// --- Notification copy (spec §4) ---

function buildCopy(reminder, masjidName) {
  const { kind, label, lead } = reminder;
  const time = formatTime(reminder.timeStr, reminder.isAM);
  const tail = masjidName ? ` · ${masjidName}` : '';
  switch (kind) {
    case 'start':
      return { title: `${label} has begun`, body: `${time}${tail}` };
    case 'jamaat':
      return lead > 0
        ? { title: `${label} jama'at in ${lead} min`, body: `${time}${tail}` }
        : { title: `${label} jama'at now`, body: `${time}${tail}` };
    case 'end':
      return { title: `${label} ends in ${lead} min`, body: `Pray before ${time}${tail}` };
    case 'suhoor':
      return { title: `Suhoor ends in ${lead} min`, body: `${time}${tail}` };
    case 'iftar':
      return { title: 'Iftar — time to break your fast', body: `${time}${tail}` };
    default:
      return { title: label, body: `${time}${tail}` };
  }
}

// --- Fired-guard (avoid repeats across reloads within a day) ---

function todayKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function loadFired() {
  try {
    const all = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
    // Prune anything not from today.
    const k = todayKey();
    return all[k] ? { [k]: all[k] } : {};
  } catch { return {}; }
}

function markFired(id) {
  const k = todayKey();
  const all = loadFired();
  all[k] = all[k] || [];
  if (!all[k].includes(id)) all[k].push(id);
  localStorage.setItem(FIRED_KEY, JSON.stringify(all));
}

function alreadyFired(id) {
  const fired = loadFired()[todayKey()] || [];
  return fired.includes(id);
}

// --- Prayed-guard: prayers the user marked done today (via the "Prayed"
// notification action). Their remaining jama'at/end reminders are suppressed. ---

const PRAYED_KEY = 'iqamah-notif-prayed';

function loadPrayed() {
  try {
    const all = JSON.parse(localStorage.getItem(PRAYED_KEY) || '{}');
    const k = todayKey();
    return all[k] || [];
  } catch { return []; }
}

function markPrayed(prayer) {
  const k = todayKey();
  const list = loadPrayed();
  if (!list.includes(prayer)) list.push(prayer);
  localStorage.setItem(PRAYED_KEY, JSON.stringify({ [k]: list })); // prune to today
}

function isPrayed(prayer) {
  return loadPrayed().includes(prayer);
}

// --- Foreground scheduler ---

let timers = [];
let midnightTimer = null;
let initialised = false;

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
  if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
}

async function fireNotification(reminder, masjidName, slug) {
  const id = `${reminder.kind}:${reminder.prayer}`;
  if (alreadyFired(id)) return;
  const { title, body } = buildCopy(reminder, masjidName);
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      tag: `${todayKey()}:${id}`,
      icon: NOTIF_ICON,
      badge: NOTIF_BADGE,
      data: { url: slug ? `/${slug}` : '/', prayer: reminder.prayer },
      actions: NOTIF_ACTIONS,
    });
    markFired(id);
  } catch { /* SW not ready / permission revoked — skip silently */ }
}

function scheduleMidnightRollover() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  midnightTimer = setTimeout(() => { rescheduleNotifications(); }, nextMidnight - now);
}

// Clear existing timers and (re)build today's schedule from prefs + CSV.
export async function rescheduleNotifications() {
  clearTimers();

  const prefs = loadPrefs();
  if (!prefs.master) return;
  if (getNotificationState() !== 'granted') return;

  const slug = prefs.slug || localStorage.getItem('iqamah-pinned-masjid');
  if (!slug) return;

  let config, csvText, season = 'default';
  try {
    const [cfgRes, seasonRes] = await Promise.all([
      fetch(`/data/mosques/${slug}.json`),
      fetch('/data/season.json').catch(() => null),
    ]);
    if (!cfgRes.ok) return;
    config = await cfgRes.json();
    if (seasonRes && seasonRes.ok) { try { season = (await seasonRes.json()).season || 'default'; } catch {} }
    const csvRes = await fetch(`/data/${config.csv}`);
    if (!csvRes.ok) return;
    csvText = await csvRes.text();
  } catch { return; }

  const todayRow = getTodayRow(parseCSV(csvText));
  if (!todayRow) { scheduleMidnightRollover(); return; }

  const masjidName = config.display_name || slug;
  const now = Date.now();
  const reminders = buildReminders(todayRow, prefs, season, new Date());

  for (const r of reminders) {
    const delay = r.at.getTime() - now;
    const id = `${r.kind}:${r.prayer}`;
    if (delay < -60000) continue;          // more than a minute past — skip
    if (alreadyFired(id)) continue;
    // Suppress jama'at/end once the salah has been marked prayed today.
    if ((r.kind === 'jamaat' || r.kind === 'end') && isPrayed(r.prayer)) continue;
    if (delay <= 0) { fireNotification(r, masjidName, slug); continue; }
    if (delay > 26 * 60 * 60 * 1000) continue; // safety cap
    timers.push(setTimeout(() => fireNotification(r, masjidName, slug), delay));
  }

  scheduleMidnightRollover();
}

// TEMP (dev): fire a representative sample notification immediately so the
// look/feel can be checked without waiting for a prayer time. Bypasses the
// fired-guard so it can be triggered repeatedly. Remove before v1 ships.
export async function sendTestNotification(masjidName) {
  if (getNotificationState() !== 'granted') {
    const s = await requestPermission();
    if (s !== 'granted') return false;
  }
  const sample = { kind: 'jamaat', label: 'Asr', lead: 15, prayer: 'asr', timeStr: '18:45', isAM: false };
  const { title, body } = buildCopy(sample, masjidName);
  const slug = localStorage.getItem('iqamah-pinned-masjid');
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body, tag: 'iqamah-test', icon: NOTIF_ICON, badge: NOTIF_BADGE,
      data: { url: slug ? `/${slug}` : '/', prayer: sample.prayer },
      actions: NOTIF_ACTIONS,
    });
    return true;
  } catch { return false; }
}

// App-wide init (called once from app.js). Reschedules on prefs/pin changes.
export function initNotifications() {
  if (initialised) return;
  initialised = true;
  window.addEventListener('iqamah-notif-prefs-changed', () => rescheduleNotifications());
  window.addEventListener('iqamah-pin-changed', () => rescheduleNotifications());
  // The SW relays a "Prayed" notification-action tap; record it and reschedule
  // so the salah's remaining jama'at/end reminders are dropped.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'iqamah-prayed' && e.data.prayer) {
        markPrayed(e.data.prayer);
        rescheduleNotifications();
      }
    });
  }
  // Rebuild when the app regains focus (it may have been backgrounded for hours).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') rescheduleNotifications();
  });
  rescheduleNotifications();
}
