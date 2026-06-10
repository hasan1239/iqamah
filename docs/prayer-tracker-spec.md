# Prayer Tracker & Streaks — Spec

**Status:** Planning (not built) — design finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

Let a user log each of the five daily prayers — and how it was prayed (in jama'ah / on time / late / missed) — build a visible **streak**, and see simple history & stats. A daily-habit hook that turns Iqamah from a reference tool into something opened every day. Modelled on Pillars / Prayerly / Muslim Pro trackers, but kept lightweight and 100% client-side.

## 2. Scope decisions (decided)

- **Client-only, no backend.** All state in `localStorage`. No accounts, no sync (matches the app's static/local-first design). Cross-device sync is explicitly out of scope for v1.
- **Five fard prayers only in v1.** Sunnah/Nafl rows (Duha, Tahajjud, Witr) deferred to **v2** behind a setting — keeps v1 tight and the streak logic simple.
- **Status model (decided): four states + untracked** — `jamaah` · `ontime` · `late` · `missed` · `null`. The jama'ah distinction is on-brand for Iqamah and powers the "% in jama'ah" stat; don't collapse it.
- **No guilt design.** Missed is recorded neutrally; the UI never shames. Streak counts *days fully logged with all fard prayed* (see §5).
- **Integrates with notifications "Prayed" action.** The push spec already writes `iqamah-notif-prayed` (`{ "YYYY-MM-DD": [prayerKeys] }`) when the user taps **Prayed** on a notification. The tracker should treat that as a `jamaah`/`ontime` signal so the two features reinforce rather than duplicate. See [push-notifications-spec.md](push-notifications-spec.md) §4.

---

## 3. Where it lives (navigation)

The bottom nav is full (Home · Masjids · Times · Qibla · Settings) — **do not add a 6th tab.** Instead:

- **Home check-in card** — a compact "Today's prayers" card with five tappable segments, inserted as a new Home slot **below the hero, above Recently Viewed** (between `#heroContainer` and `#recentSection` in `js/views/home.js`). Tapping a prayer opens a small **status picker** popover (Jama'ah / On time / Late / Missed). This is the primary daily touchpoint.
- **Full `/tracker` page** — history grid, current/best streak, weekly/monthly stats, reached from the Home card header ("View all ›"), a **tile in the More hub** (see [more-hub-spec.md](more-hub-spec.md) — add a `FEATURES` entry), and a Settings link.

This mirrors how Home already hosts hero + recently-viewed sections and links out to fuller views.

---

## 4. UI

### Home check-in card
```
┌─ Today's Prayers ──────────────  View all › ┐
│  Fajr   Dhuhr   Asr   Maghrib   Esha         │
│   ●       ○      ◐       ○        ○           │   ● jama'ah  ◐ prayed  ○ untracked
│  🔥 6-day streak                              │
└──────────────────────────────────────────────┘
```
- Tap a prayer → status picker popover (Jama'ah / On time / Late / Missed); tap a choice to set, tap the same prayer again to change. `navigator.vibrate(20)` on set (pattern already used in masjids.js long-press).
- Card uses an **opaque** background (`var(--card-bg)`, see design rule) so background motes/stars don't show through.

### `/tracker` page
- **Streak header:** current streak (🔥 N days) + best streak.
- **Month grid:** one row per week, five cells per day colour-coded by best status that day; tap a past day to edit (within an editable window — see §5).
- **Stats strip:** this week / this month % prayed, % in jama'ah.
- Light/night/dark themes; Lato font (no Cinzel — that's lockscreen-only).

---

## 5. Data model & rules

### localStorage `iqamah-tracker-log`
```jsonc
{
  "2026-05-22": { "fajr": "jamaah", "dhuhr": "ontime", "asr": "late", "maghrib": null, "esha": null },
  "2026-05-21": { "fajr": "jamaah", "dhuhr": "jamaah", "asr": "jamaah", "maghrib": "ontime", "esha": "ontime" }
}
```
- Keys are local-date `YYYY-MM-DD` (use the device's local day, consistent with `getTodayRow` in `js/utils/csv.js`).
- Prune entries older than ~13 months on read to cap storage.

### Settings/meta `iqamah-tracker-meta`
```jsonc
{ "trackSunnah": false, "streakBest": 12, "startedOn": "2026-05-01" }
```

### Streak rule (decided)
- A day **counts toward the streak** when **all five fard** are logged with a non-`missed`, non-`null` status (i.e. each is `jamaah`/`ontime`/`late`).
- **Today is grace-exempt:** today never breaks the streak until it ends — an incomplete today shows "keep going", not a reset.
- **Editable window:** allow editing today + the previous 2 days only (prevents retroactive streak-gaming, keeps it honest). Older days are read-only in the grid.

### Notifications interplay
- On load, fold any `iqamah-notif-prayed[today]` prayer keys into the log as `jamaah` **if still `null`** (don't overwrite an explicit user choice). Keep the two keys separate; tracker is the richer store.

---

## 6. Files

**New**
| File | Purpose |
|---|---|
| `js/views/tracker.js` | `/tracker` page: streak header, month grid, stats, edit handlers |
| `js/utils/tracker.js` | pure helpers: read/write log, compute current/best streak, prune, fold notif-prayed |

**Changed**
| File | Change |
|---|---|
| `js/views/home.js` | render the "Today's Prayers" check-in card in a new slot; wire status picker + vibrate; refresh on visibility |
| `js/router.js` | add `clean === 'tracker'` → `{ view: 'tracker' }` in `resolvePath` (before the single-segment-slug fallback, or `tracker` resolves as a masjid slug) |
| `js/app.js` | add `'tracker': () => import('./views/tracker.js')` to `moduleMap` |
| `js/nav.js` | add `tracker` to `TAB_INDEX` (slide-direction only; no new tab) |
| `js/views/settings.js` | add a "Prayer Tracker" link in a Tools/Activity group (+ optional "Track Sunnah prayers" toggle) |
| `_worker.js` | ensure `/tracker` serves the SPA shell on hard refresh (verify how named routes like `/qibla` are served today and match it) |
| `css` (site stylesheet) | `.tracker-*`, check-in card, status dots, month grid colours per theme |

---

## 7. Resolved decisions

1. **Status granularity** — ✅ **Four states + untracked** (`jamaah`/`ontime`/`late`/`missed`/`null`). Keeps the on-brand jama'ah insight.
2. **Home card placement** — ✅ **Below hero, above Recently Viewed.**
3. **Sunnah/Nafl** — ✅ **Deferred to v2** (behind a setting). v1 is five fard only.
4. **Streak rule** — ✅ **All five fard prayed that day** (any of jama'ah/on-time/late); today grace-exempt until it ends.
5. **Edit window** — ✅ **Today + previous 2 days** editable; older days read-only (anti-gaming).
6. **Tap interaction** — ✅ **Status picker popover** (not cycle-on-tap).

### Still to confirm
- **Reset/export** — "Reset App" already clears all `iqamah-*` keys, so the tracker log clears automatically. Decide whether to add an **export-to-JSON** (and re-import) before any destructive reset. Leaning: add a lightweight JSON export in v1.1, not v1.

---

## 8. Versioning / rules (from CLAUDE.md)

- **Minor bump** (new feature) only when merged to `main`, never on the feature branch.
- Opaque card backgrounds; Lato only (no Cinzel) in the SPA.
- Prefer automatic behaviour over manual controls where equivalent (e.g. auto-fold notif "Prayed" rather than asking the user to double-log).
