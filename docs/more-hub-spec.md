# "More" Hub Tab — Spec

**Status:** Planning (not built) — **BUILD FIRST**, design finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

> **Priority:** This is the navigation scaffolding for the upcoming features
> ([prayer-tracker](prayer-tracker-spec.md), [tasbih-counter](tasbih-counter-spec.md),
> [daily-dua-hadith](daily-dua-hadith-spec.md), [jummah-times](jummah-times-spec.md)).
> Each of those plugs into the hub as one registry entry — so this ships **before** them.

---

## 1. Goal

Replace the **Qibla** bottom-nav tab with a **More** tab that opens a **grid of feature tiles** (Qibla being one of them). This solves the "bottom nav is full (5 tabs)" constraint that every recent feature spec ran into — instead of cramming new tabs or burying features in Settings, new features get a tile in the grid. A **declarative feature registry** makes adding a feature a one-line change.

## 2. Why this first

- The tracker/tasbih/dua/jummah specs all punted on navigation ("no 6th tab; surface via Home + Settings"). The More hub gives them a proper, discoverable home.
- One-time nav refactor; afterwards each feature is additive (a registry entry + its route), no nav surgery.

## 3. Scope decisions (decided)

- **Tab name: "More"** (decided) with a 2×2-grid / dots icon. Open-ended; holds worship features (Tracker/Dua) and utilities (Qibla/Tasbih) alike.
- **Replaces the Qibla tab** at bottom-nav index 3. **Qibla keeps its `/qibla` route** and becomes the **first tile** in the grid — no functionality lost, just relocated.
- **Grid is driven by a feature registry** (`js/features.js`) — a declarative array of tiles. The More view renders enabled tiles; adding a feature = adding one object.
- **Coming-soon tiles: 1–2 `SOON` max** (decided) — telegraph the roadmap and avoid a sparse grid without overpromising. Dimmed, non-tappable.
- **Eid Salah + Add Masjid become tiles** (decided), **and keep their existing entries** (Eid seasonal desktop link / Home button; Add in Settings + desktop nav). Accept minor duplication for discoverability.
- **One-time "Qibla moved to More" hint** (decided) for existing users — a dismissible toast gated on `localStorage` `iqamah-more-hint`.
- **Mobile-first hub.** The grid page is responsive and works on desktop, but the primary surface is the mobile bottom nav (where Qibla lived).

---

## 4. Navigation changes

### Bottom nav (`js/nav.js`)
- In the `TABS` array, **replace the `qibla` entry with a `more` entry**: `{ id:'more', label:'More', path:'/more', icon: GRID_SVG }`. Order stays Home · Masjids · Times · More · Settings.
- `getActiveTabId()` — extend the existing `add-masjid → settings` precedent so **More-hosted views highlight the More tab**: map `more`, `qibla`, `tracker`, `tasbih`, `dua`, `jummah-times` → `'more'`.

### Router (`js/router.js`)
- `resolvePath`: add `clean === 'more'` → `{ view: 'more', params: {} }`. (The `qibla` clause already exists and stays.)
- `TAB_INDEX`: replace `'qibla': 3` with `'more': 3`; also map the hosted views to `3` (`qibla, tracker, tasbih, dua, 'jummah-times'`) so slide-transition direction is sane when navigating from a tab into a hub feature.

### App (`js/app.js`)
- Add `'more': () => import('./views/more.js')` to `moduleMap`.

### Desktop nav (`index.html` `#desktop-nav-links`)
- Qibla was never in the desktop nav. Add a **"More"** desktop link (`<a data-nav="more" href="/more" data-link>More</a>`) for parity, placed before Settings. `updateActiveTab()` in `nav.js` already toggles `.active` on `data-nav` matches — extend its mapping so hosted views light up the More desktop link too.
- (Eid Salah / Add Masjid desktop links can remain as-is, or later collapse into the hub — out of scope here.)

### Worker (`_worker.js`)
- Ensure `/more` serves the SPA shell on hard refresh (match how `/qibla`, `/eid` are already served — single-segment named route, not a masjid slug; verify it doesn't fall through to the masjid lookup).

---

## 5. Feature registry (the extensibility core)

`js/features.js` exports the tile list. The More grid maps over it; this is the single place to add/remove/reorder features.

```js
// js/features.js
export const FEATURES = [
  {
    id: 'qibla',
    label: 'Qibla',
    desc: 'Find the direction of the Kaaba',
    icon: QIBLA_SVG,
    route: '/qibla',
    badge: null,            // null | 'NEW' | 'BETA' | 'SOON'
    enabled: true,
    show: () => true,       // optional predicate (season, day-of-week, platform…)
  },
  { id:'eid', label:'Eid Salah', desc:'All masjids by earliest jama\'at', icon: EID_SVG,
    route:'/eid', enabled:true, show: () => true },           // always accessible, like the /eid page
  { id:'add', label:'Add Masjid', desc:'Upload a timetable', icon: PLUS_SVG,
    route:'/add', badge:'BETA', enabled:true, show: () => true },
  // Launch with 1–2 SOON tiles to telegraph the roadmap (decided):
  { id:'tracker', label:'Prayer Tracker', desc:'Coming soon', icon: CHECK_SVG,
    route:'/tracker', badge:'SOON', enabled:false, show: () => true },
  { id:'tasbih', label:'Tasbih', desc:'Coming soon', icon: BEADS_SVG,
    route:'/tasbih', badge:'SOON', enabled:false, show: () => true },
  // Later specs flip these to enabled:true (drop badge or → 'NEW') and add dua/jummah entries.
];
```

**Field rules**
- `enabled:false` → render a dimmed, non-navigating "coming soon" tile (use with `badge:'SOON'`). Lets us telegraph the roadmap.
- `show()` → optional runtime predicate; falsy hides the tile entirely (seasonal Eid, Friday-emphasis Jummah, mobile-only items, etc.). Default shown.
- `badge` → small corner chip (reuse existing `.beta-badge` styling).
- **Ordering** = array order. Worship-y features first, utilities after, "coming soon" last is a reasonable default.

> **Optional future hardening (not v1):** derive `resolvePath`/`moduleMap`/`TAB_INDEX` entries from the registry too, so a feature truly is *one* edit. v1 keeps route registration explicit for clarity; the registry only drives the grid.

---

## 6. UI

```
┌─ More ──────────────────────────────┐
│  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │  ◧     │  │  🕌    │  │  ☆     │  │
│  │ Qibla  │  │ Eid    │  │ Tasbih │  │   tiles: icon + label (+ desc on wide)
│  └────────┘  └────────┘  └ SOON ──┘  │
│  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │  ✓     │  │  📖    │  │  +     │  │
│  │Tracker │  │ Dua    │  │Add Masjid│ │
│  └ SOON ──┘  └ SOON ──┘  └────────┘  │
└──────────────────────────────────────┘
```
- **Grid:** 2 columns on narrow phones, 3 on wider / desktop. Each tile is a card: gold-tinted icon, label, optional one-line desc, optional badge.
- **Opaque** tile/background (design rule — no see-through to stars/motes). Gold accents, Lato font, light/night/dark.
- Tap a tile → `navigate(route)`. Disabled (`SOON`) tiles don't navigate (subtle press feedback only).
- Header reads "More" (matches other view headers like Settings/Masjids).

---

## 7. Files

**New**
| File | Purpose |
|---|---|
| `js/views/more.js` | renders the grid from `FEATURES`; tap → navigate; handles `enabled`/`show`/`badge` |
| `js/features.js` | the feature registry (single source for tiles) |

**Changed**
| File | Change |
|---|---|
| `js/nav.js` | `TABS`: `qibla` → `more` (grid icon); `getActiveTabId`/`updateActiveTab`: map hosted views (`qibla`,`tracker`,`tasbih`,`dua`,`jummah-times`,`more`) → `more` |
| `js/router.js` | `resolvePath` add `more`; `TAB_INDEX` `qibla→more` at 3 + map hosted views to 3 |
| `js/app.js` | add `'more'` to `moduleMap` |
| `index.html` | add a `More` desktop-nav link; `.more-*` grid styles in the `<style>` block |
| `_worker.js` | confirm `/more` serves the SPA shell |
| `js/views/qibla.js` | unchanged (still rendered at `/qibla`); just no longer a direct tab |

**Ripple into the four feature specs:** each gains its tile by adding one `FEATURES` entry (plus its own route per its spec). Their "navigation" sections should reference this hub instead of Settings-only links.

---

## 8. Edge cases / notes

- **Launch grid (decided):** Qibla · Eid Salah · Add Masjid (BETA) · Prayer Tracker (SOON) · Tasbih (SOON) — six-ish tiles, not sparse. SOON tiles flip to live as each feature ships; Dua/Jummah tiles are added by their specs.
- **Back behaviour:** entering a feature from More then pressing back returns to `/more` (normal history). The More tab stays highlighted while inside a hosted feature (via `getActiveTabId`).
- **Qibla discoverability:** moving Qibla one tap deeper is the main UX cost. Mitigate by putting Qibla **first** in the grid and keeping its bottom-nav muscle-memory loss minimal (it was an end tab). Consider a one-time toast/hint "Qibla is now under More" for existing users (localStorage `iqamah-more-hint`).
- **Analytics:** `navigate()` already pings goatcounter per path — tile taps are captured for free via their routes.

---

## 9. Resolved decisions

1. **Tab label** — ✅ **"More"** (grid icon).
2. **Coming-soon tiles** — ✅ **1–2 `SOON` tiles max** (launch with Tracker + Tasbih).
3. **Eid / Add Masjid** — ✅ **added as grid tiles AND kept** in their existing nav/Settings spots (accept minor duplication for discoverability).
4. **Qibla relocation hint** — ✅ **yes**, one-time dismissible toast (`iqamah-more-hint`).

---

## 10. Versioning / rules (from CLAUDE.md)

- **Minor bump** (new feature/nav change) only on merge to `main`, never on the feature branch.
- Opaque tile backgrounds; Lato (no Cinzel) in the SPA; English spelling.
- Prefer automatic/zero-config behaviour — the registry should make features appear without per-feature nav code.
