// Feature registry — the single source of truth for the "More" hub grid.
// Add a feature = add one object here (plus its own route in router.js / app.js).
// Fields: { id, label, desc, icon, route, badge, enabled, show }
//   badge   — null | 'NEW' | 'BETA' | 'SOON'  (small corner chip)
//   enabled — false renders a dimmed, non-navigating tile (use with badge:'SOON')
//   show()  — optional runtime predicate; falsy hides the tile entirely. Default shown.
// Ordering = array order (worship-y first, utilities after, coming-soon last).

const QIBLA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>';

const EID_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/></svg>';

const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';

const BEADS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="20" cy="13" r="2"/><circle cx="12" cy="20" r="2"/><circle cx="4" cy="13" r="2"/><path d="M6.5 7.2 10.3 4.8M13.7 4.8l3.8 2.4M19.7 8l.5 3M18.4 14.4 13.6 18.7M10.4 18.7 5.6 14.4M4.3 11 4.8 8"/></svg>';

const BOOK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

const CALENDAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

const GIFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>';

const SHIELD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

export const FEATURES = [
  {
    id: 'qibla',
    label: 'Qibla',
    desc: 'Direction of the Kaaba',
    icon: QIBLA_SVG,
    route: '/qibla',
    badge: null,
    enabled: true,
    show: () => true,
  },
  {
    id: 'eid',
    label: 'Eid Salah',
    desc: 'All masjids by earliest jama\'at',
    icon: EID_SVG,
    route: '/eid',
    badge: null,
    enabled: true,
    show: () => false, // hidden for now — re-enable when Eid masjids are ready
  },
  {
    id: 'add',
    label: 'Add Masjid',
    desc: 'Upload a timetable',
    icon: PLUS_SVG,
    route: '/add',
    badge: 'BETA',
    enabled: true,
    show: () => true,
  },
  {
    id: 'tracker',
    label: 'Prayer Tracker',
    desc: 'Log your daily salah',
    icon: CHECK_SVG,
    route: '/tracker',
    badge: 'NEW',
    enabled: true,
    show: () => true,
  },
  {
    id: 'tasbih',
    label: 'Tasbih',
    desc: 'Dhikr counter',
    icon: BEADS_SVG,
    route: '/tasbih',
    badge: 'NEW',
    enabled: true,
    show: () => true,
  },
  {
    id: 'dua',
    label: 'Daily Dua',
    desc: 'A dua for every day',
    icon: BOOK_SVG,
    route: '/dua',
    badge: 'NEW',
    enabled: true,
    show: () => true,
  },
  {
    id: 'jummah',
    label: 'Jummah Times',
    desc: 'Friday jama\'at times',
    icon: CALENDAR_SVG,
    route: '/jummah-times',
    badge: 'NEW',
    enabled: true,
    show: () => true,
  },
  {
    id: 'eid-card',
    label: 'Eid Card',
    desc: 'Share an Eid Mubarak greeting',
    icon: GIFT_SVG,
    route: '/eid-card',
    badge: null,
    enabled: true,
    show: () => true, // consider season-gating (eid/late ramadan) once seasons cache locally
  },
  {
    id: 'admin',
    label: 'Admin',
    desc: 'Masjid data health',
    icon: SHIELD_SVG,
    route: '/admin',
    badge: null,
    enabled: true,
    // Only admins ever see this tile (session cache set by isAdmin()).
    show: () => sessionStorage.getItem('iqamah-admin') === '1',
  },
];
