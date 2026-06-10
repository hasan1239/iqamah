# Daily Dua / Hadith — Spec

**Status:** Planning (not built) — v1 scope finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

Show one authentic dua per day (Arabic + transliteration + English + reference), as a Home card and a small browsable collection. Lightweight daily-engagement content, year-round. Modelled on the daily content in Muslim Pro / Sadiq, but trimmed to a single high-quality item per day. Hadith join the **same daily slot in v2** (see §2).

## 2. Scope decisions (decided)

- **v1 = duas only.** No hadith in v1 — this avoids hadith-grading/attribution judgement calls entirely. Duas are drawn from the Qur'an and Sunnah (e.g. Hisnul Muslim / Fortress of the Muslim) with a reference per entry. Hadith are **v2**, once a review process for grading exists, and fold into the same daily card.
- **Single combined daily slot (decided).** One "Dua of the Day" card today; in v2 the same slot alternates dua/hadith by day. The data model already carries a `type` field so adding hadith needs no redesign.
- **Static bundled dataset**, served as a JSON file from the repo (`data/duas.json`). No API, no backend, works offline (cached by the service worker like other static assets).
- **Deterministic "dua of the day"** — pick by day index modulo dataset length, so every device shows the same item on the same date with zero state. No randomness, no storage needed for selection.
- **Authenticity is non-negotiable.** Every entry carries a **source reference**. Even duas-only must be accurate and correctly attributed — Iqamah's brand is "real/accurate", so a trusted reviewer signs off the bundled JSON before merge.

---

## 3. Where it lives (navigation)

- **Home "Dua of the Day" card** — a new Home slot in `js/views/home.js` (sibling to hero / recently-viewed). Tappable → opens the full item / `/dua`.
- **`/dua` page** — today's item large, plus a simple list to scroll the collection. Share button (Web Share API; falls back to copy) to send the dua to WhatsApp — natural organic-reach lever, consistent with the existing Eid greeting share story.
- **Tile in the More hub** (see [more-hub-spec.md](more-hub-spec.md) — add one `FEATURES` entry).
- Settings link under a Tools/Activity group.

---

## 4. UI

### Home card
```
┌─ Dua of the Day ─────────────────────  › ┐
│  اللَّهُمَّ أَعِنِّي عَلَى ذِكْرِكَ …            │  ← Amiri (Arabic allowed)
│  Allahumma a'innee 'ala dhikrika …        │  ← Lato, muted
│  "O Allah, help me to remember You …"     │  ← Lato
│  — Abu Dawud 1522 (sahih)                 │  ← reference chip
└────────────────────────────────────────────┘
```
- **Arabic in Amiri**; transliteration + translation + reference in **Lato**.
- Opaque background. Truncate long Arabic on the Home card; full text on `/dua`.

### `/dua` page
- Today's item full, with **Share** and **Copy** buttons.
- Below: list of all entries (search/filter optional in v2). Tapping one shows it full.
- Light/night/dark.

---

## 5. Data model

### `data/duas.json`
```jsonc
[
  {
    "id": "dhikr-help",
    "type": "dua",                       // "dua" | "hadith"
    "arabic": "اللَّهُمَّ أَعِنِّي عَلَى ذِكْرِكَ وَشُكْرِكَ وَحُسْنِ عِبَادَتِكَ",
    "transliteration": "Allahumma a'innee 'ala dhikrika wa shukrika wa husni 'ibadatik",
    "translation": "O Allah, help me to remember You, thank You, and worship You well.",
    "reference": "Abu Dawud 1522",
    "grade": "sahih",                    // for hadith; omit/optional for Qur'anic duas
    "tags": ["after-salah", "dhikr"]
  }
]
```

### Selection (no storage)
```js
const dayIndex = Math.floor((Date.now() - Date.UTC(2026,0,1)) / 86400000);
const item = duas[((dayIndex % duas.length) + duas.length) % duas.length];
```
- Optional: a tiny `iqamah-dua-last-shared` only if we add a "new dua available" nudge — not needed for v1.

---

## 6. Files

**New**
| File | Purpose |
|---|---|
| `data/duas.json` | curated, referenced dataset (start ~30–60 entries; grows over time) |
| `js/views/dua.js` | `/dua` page: today's item, collection list, share/copy |
| `js/utils/dua.js` (optional) | load + day-index selection helper, shared by Home card and page |

**Changed**
| File | Change |
|---|---|
| `js/views/home.js` | render "Dua of the Day" card in a new slot |
| `js/router.js` | add `clean === 'dua'` → `{ view: 'dua' }` in `resolvePath` |
| `js/app.js` | add `'dua': () => import('./views/dua.js')` to `moduleMap` |
| `js/nav.js` | add `dua` to `TAB_INDEX` |
| `js/views/settings.js` | add "Daily Dua" link (Tools group) |
| `_worker.js` | ensure `/dua` serves the SPA shell on hard refresh |
| `css` | `.dua-*` styles, Amiri for Arabic, reference chip, share buttons |

---

## 7. Resolved decisions

1. **Content type** — ✅ **Duas only in v1** (hadith deferred to v2, same slot). Sidesteps hadith grading.
2. **Source** — ✅ Qur'an/Sunnah duas, **Hisnul Muslim / Fortress of the Muslim** as the primary reference base; each entry referenced; trusted reviewer signs off `data/duas.json` before merge.
3. **Presentation** — ✅ **Single combined daily slot** ("Dua of the Day"); `type` field reserved for v2 hadith.
4. **Localisation** — ✅ English translation only (app is English-spelling per global rules).

### Still to confirm
- **Reviewer** — who signs off the dataset before merge (you, or a named scholar/reference)?
- **Dataset size** — ship ~30–60 vetted duas; expand via simple `duas.json` PRs over time.
- **Notifications tie-in** — optional "daily dua" push later, depends on push infra landing. Out of scope for v1.

---

## 8. Versioning / rules (from CLAUDE.md)

- **Minor bump** on merge to `main` only.
- Amiri for Arabic; Lato elsewhere; no Cinzel in SPA.
- Opaque backgrounds. English spelling throughout.
