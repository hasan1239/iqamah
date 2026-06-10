# Jummah Times List — Spec

**Status:** Planning (not built) — design finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

A page listing masjids with their **Jummah (Friday) jama'at times**, sorted by earliest, filterable by city / nearby — so a user can find a Jummah that fits their schedule. Directly mirrors the existing **`/eid` page** (`js/views/eid-times.js`), which already lists masjids by parsed salah times.

## 2. Current state (what exists)

- Masjid configs carry a **free-text** `jummah_times` field, e.g. (from `data/mosques/central.json`):
  > `"Urdu & English Speech at 12:45pm, Main Arabic Khutba at 1:15pm"`
- The `/eid` page parses the equally free-text `eid_salah` with a regex (`parseEidTimes` in `js/views/eid-times.js`): it extracts every `H[:MM] am/pm`, sorts, and renders **time pills** + sorts masjids by earliest. **The Jummah page reuses this exact approach.**
- Jummah is **not** in the CSV timetables — it lives only in the config field. (This is why the push-notifications spec scoped Jummah reminders out of v1.)

## 3. Scope decisions (decided)

- **Reuse the `/eid` pattern** for layout/cards, parsing `jummah_times` with the same regex, rendering **time pills**, sorting by earliest time.
- **CSV fallback for missing/unparseable times (decided).** When a masjid's `jummah_times` yields no parseable time (empty, or pure prose), fall back to the **upcoming Friday row's Dhuhr/Zohar jama'at** from that masjid's CSV — on Fridays the Jummah jama'at is the Friday Dhuhr jama'at. This maximises coverage and keeps every masjid sortable. (Trade-off: the page now fetches CSVs, where `/eid` was config-only — see §5/§6.)
- **Resolution order per masjid:** (1) explicit time(s) parsed from `jummah_times` → (2) Friday-row `Zohar Jama'at` from CSV (default `1:00` like elsewhere) → (3) raw text / "See masjid info" if neither exists. Sort key = the resolved earliest time; only true (3) cases sink to the bottom.
- **Show raw text too.** Jummah strings carry meaning beyond a time ("Urdu khutbah", "1st/2nd Jummah", "English bayan"). Render time pills **and** keep the **raw label** beneath when present.
- **Always accessible**, year-round (like `/eid`). Surface it more prominently on **Fridays**.

---

## 4. Where it lives (navigation)

- **`/jummah` page** (mirrors `/eid` routing).
- **Home entry on Fridays:** a "Jummah times near you" browse button in the existing `#eidBrowseSlot`-style slot pattern (`js/views/home.js` `showEidBrowse` is the template) — shown when `new Date().getDay() === 5`.
- **Tile in the More hub** (see [more-hub-spec.md](more-hub-spec.md) — add one `FEATURES` entry, optionally `show()` emphasised on Fridays) for year-round access.

---

## 5. UI

```
┌─ Jummah Times ─────────────────────────────┐
│ All masjids with Friday jama'at, earliest first │
│ [ Nearby ]  [ search city… ]                 │  ← optional: reuse location + filter
│                                              │
│ ┌──────────────────────────────────────────┐│
│ │ Masjid Aisha          Sparkhill, B11 …    ││
│ │ [12:45pm] [1:15pm]                        ││  ← pills (parsed)
│ │ Urdu & English speech 12:45, Arabic 1:15  ││  ← raw label (muted)
│ └──────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────┐│
│ │ Quba Masjid           Aston, B6 …         ││
│ │ [1:30pm]                                  ││
│ └──────────────────────────────────────────┘│
│                                              │
│ Showing 42 masjids · Don't see yours? Add it ││
└────────────────────────────────────────────┘
```
- Cards link to `/{slug}` (data-link), like Eid cards.
- **Sort:** earliest **resolved** time ascending (parsed `jummah_times`, else Friday-row Dhuhr jama'at). Only masjids with no time from either source sink to the bottom (shown with raw text / "See masjid info").
- A small per-card hint marks fallback-sourced times (e.g. "Friday Dhuhr jama'at") so an explicit Jummah time and a derived one aren't conflated.
- **v1 = earliest-first list only.** Nearby/city filtering (reusing `getCurrentPosition` + `haversineDistance` + `deriveCity` from `masjids.js`) is **v1.1**.
- Light/night/dark; Lato; opaque cards.

---

## 6. Data model

No new storage. Reads `data/mosques/index.json` then, per masjid: the config's `jummah_times` **and** (for the fallback) the masjid CSV.

```js
function parseJummahTimes(str) {
  // identical regex to parseEidTimes: /(\d{1,2}(?::\d{2})?)\s*(am|pm)/gi
  // returns { times:[{time,minutes}], earliest, raw: str }
}
```

### Friday-Dhuhr fallback
- New helper `getFridayRow(csvData)` in `js/utils/csv.js` (mirrors `getTodayRow`/`getTomorrowRow`): finds the **upcoming Friday's** date row. Read `Zohar Jama'at` (default `1:00`, as `prayer-times.js`/`home.js` already do for Dhuhr).
- **Fetch pattern:** mirror `loadCardPrayers` in `masjids.js` — fetch all CSVs in parallel with a `loadGeneration` guard, fill/sort cards as they resolve, skeletons first. Don't block initial paint on CSVs: render config-derived (parsed `jummah_times`) cards immediately, then slot in fallback times + re-sort once CSVs land (same approach `masjids.js` uses for next-prayer + reorder).
- **Caching:** the SW already caches `/data/*.csv`; repeat visits are cheap. Coverage is bounded by the masjid count (hundreds), so cap/normalise as the list does.

### Improving coverage (recommended companion change)
Capture `jummah_times` more reliably in the contribution flow so the list grows:
- The extraction prompt + review form should surface a **Jummah times** field. Per the **add/update sync rule** ([memory], CLAUDE.md), any change to `add.html` / the extraction prompt must also be applied to `js/views/update-masjid.js`. Verify `jummah_times` is an editable field in both today; if not, add it.

---

## 7. Files

**New**
| File | Purpose |
|---|---|
| `js/views/jummah-times.js` | `/jummah` page — clone of `eid-times.js` with `parseJummahTimes`, raw label, **CSV Friday-Dhuhr fallback** + parallel CSV load/re-sort (mirrors `masjids.js loadCardPrayers`) |

**Changed**
| File | Change |
|---|---|
| `js/utils/csv.js` | add `getFridayRow(csvData)` (upcoming-Friday row, mirrors `getTodayRow`) |
| `js/router.js` | add `clean === 'jummah'` → `{ view: 'jummah-times' }` (mirror the `eid` clause) |
| `js/app.js` | add `'jummah-times': () => import('./views/jummah-times.js')` to `moduleMap` |
| `js/nav.js` | add `jummah-times` to `TAB_INDEX`; optionally show a desktop nav link on Fridays (mirror `desktopEidLink`) |
| `js/views/home.js` | Friday-only "Jummah times" browse button (mirror `showEidBrowse`) |
| `_worker.js` | ensure `/jummah` serves the SPA shell on hard refresh (the `eid` route already works — copy it) |
| `add.html` / extraction prompt + `js/views/update-masjid.js` | ensure `jummah_times` is captured/editable (sync both per CLAUDE.md rule) |
| `css` | `.jummah-*` (largely reuse `.eid-times-*` / `.eid-card` / `.eid-time-pill`) |

---

## 8. Resolved decisions

1. **Missing/unparseable `jummah_times`** — ✅ fall back to the **upcoming Friday row's Dhuhr (Zohar) jama'at** from the CSV; only masjids with neither source sink to the bottom with raw text / "See masjid info". (Jummah replaces Dhuhr on Fridays.)
2. **v1 filtering** — ✅ **earliest-first list only**; Nearby/city filter is v1.1.
3. **Multiple Jummahs** — ✅ regex captures all explicit times as pills (matches `/eid` multi-jamaat display).

### Still to confirm
- **Khutbah-start vs jama'at** — free text mixes "speech at 12:45" / "khutba at 1:15"; can't reliably distinguish, so the raw label is shown alongside pills. Accept for v1.
- **Fallback accuracy check** — verify on a few real masjids that the Friday-row `Zohar Jama'at` genuinely equals the Jummah jama'at (provider CSVs especially). If some masjids list a distinct early Jummah, the explicit `jummah_times` path already covers them.
- **Coverage push** — optional one-off pass to populate `jummah_times` for top masjids before launch.

---

## 9. Versioning / rules (from CLAUDE.md)

- **Minor bump** on merge to `main` only.
- add.html ↔ update-masjid.js must stay in sync for any contribution-flow field change.
- Opaque cards; Lato (no Cinzel) in SPA; English spelling.
