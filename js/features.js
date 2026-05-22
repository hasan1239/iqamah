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

export const FEATURES = [
  {
    id: 'qibla',
    label: 'Qibla',
    desc: 'Find the direction of the Kaaba',
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
    desc: 'Coming soon',
    icon: CHECK_SVG,
    route: '/tracker',
    badge: null, // "Coming soon" desc already conveys this
    enabled: false,
    show: () => true,
  },
  {
    id: 'tasbih',
    label: 'Tasbih',
    desc: 'Coming soon',
    icon: BEADS_SVG,
    route: '/tasbih',
    badge: null, // "Coming soon" desc already conveys this
    enabled: false,
    show: () => true,
  },
];
