# My-Masjid (time.my-masjid.com) — GREEN LIGHT, build planned

**Status (2026-05-20):** Spiked, then **BUILT** (`providers/mymasjid/{fetch,discover,bulk}.py`). Verified end-to-end on East London Mosque: DST exact-match vs MasjidBox, full year (365 days), CSV schema byte-identical to Mawaqit, AM/PM auto-correction working. Best provider since Mawaqit. **Not yet onboarded** — discovery sweep + curated first batch is the next operational step. This doc = findings + build plan + decisions.

> Not to be confused with: **myMasjid** (mymasjid.com / api.mymasjid.com) — a separate WordPress "managed masjid websites" company. And **MyLocalMasjid** (mylocalmasjid.com) — see `mylocalmasjid_status.md`. This provider is specifically **time.my-masjid.com** (the timetable display SaaS, app "My Masjid Community", control panel at controlpanel.my-masjid.com).

## The API (public, no auth, ASP.NET)

Base: `https://time.my-masjid.com/api`. Response envelope: `{model, hasError, message, statusCode, errors}`.

| Endpoint | Returns |
|---|---|
| `GET /api/Masjid/GetPublicFilteredMasjid?searchParam={q}&isPublished=1` | Search (needs ≥1 char; blank → HTTP 400). `model.masjidList[]` = {id, **guidId**, name, address, city, country, image, ...}. Pager returns ALL matches (pageSize = int max). |
| `GET /api/Masjid/GetAllMasjidLocations` | Global directory, 2,234 entries: {id, name, latitude, longitude}. No country field, lat/long sometimes junk/test. |
| `GET /api/TimingsInfoScreen/GetMasjidTimings?GuidId={guid}` | **Full timetable.** See shape below. |
| `GET /api/Country/GetAllCountries`, `GET /api/City/GetCitiesByCountryId?...` | Reference data. UK countryId = 53. |

No apikey, CORS-open, on their own domain. Found by grepping the Angular client chunks (`time.my-masjid.com/chunk-*.js`) — base URL + routes are literals; `getMasjidTimings(GuidId)` and `getPublicFilteredMasjid(searchParam,isPublished)` are the client methods.

## Timetable shape (`GetMasjidTimings.model`)

```jsonc
{
  "masjidDetails": { "id", "guidId", "name", "house", "street", "zipCode", "latitude", "longitude", ... },
  "masjidSettings": {
    "isDstOn": true,            // CRITICAL — see DST gotcha
    "jumahTime": "...",
    "isTimingsUploaded": false, // ambiguous; NOT "has no data" (see below)
    "hijriOffset": 0,
    "jummahTimeEqualsZuhrTime": false,
    "displayTimeIn12HourFormat": true, ...
  },
  "salahTimings": [   // list of 366 — FULL YEAR
    {
      "day": 20, "month": 5,
      "fajr": "02:12", "shouruq": "03:59", "zuhr": "12:02",
      "asr": "17:22", "maghrib": "19:56", "isha": "21:08",
      "iqamah_Fajr": "02:27", "iqamah_Zuhr": "12:30", "iqamah_Asr": "17:45",
      "iqamah_Maghrib": "20:11", "iqamah_Isha": "21:30",
      "asr_start_1": null
    }, ...
  ],
  "iqamahTimings": { ... },          // default/current iqamah config
  "jumahSalahIqamahTimings": [ { "time": "12:00", "iqamahTime": "12:30", "iqamahTimeMinutes": 30, "isPrimary": true } ],
  "lastUpdatedAt": "2026-05-19T16:00:37"
}
```

`salahTimings` has no year field — it's "the current year", indexed by day+month (handle Feb 29 / 366 vs 365). No per-day hijri (only a global `hijriOffset`).

## Findings (the spike that justified building)

**Start times verified ACCURATE.** Cross-checked East London Mosque against the MasjidBox data from `masjidbox_status.md`. My-Masjid (+1hr DST) matches MasjidBox **exactly across all 6 prayers** on May 20 (fajr 03:12, zuhr 13:02, asr 18:22, maghrib 20:56, isha 22:08 BST). Independent corroboration.

**Iqamah times are REAL admin config, not calculated offsets.** Tell: zuhr iqamah is a fixed seasonal clock time — 12:30 (Apr–Aug), 12:45 (Sep–Mar) — a human-set schedule, not "start + constant". And iqamah differs slightly from MasjidBox (fajr 5 min, maghrib 8 min), confirming each masjid configures per-platform = genuinely independent data. Quality is comparable to Mawaqit (which is also "what the masjid configured in the platform").

**Coverage: ~538 UK published masjids.** A vowel + term sweep of `GetPublicFilteredMasjid` pulled 2,462 unique of the ~2,234 directory (i.e. effectively complete). Of 538 UK:
- 48 overlap with our existing 169 (confirms legit masjids)
- **~490 potentially new** (pre-geo-dedup; even halved, ~3–4× our catalogue)
- Spread: London 60, **Blackburn 42, Bradford 41**, Birmingham 39, Leicester 25, Manchester 18, Bolton, Glasgow, Luton, Nelson, Burnley — strong northern mill-town coverage where Mawaqit is thin.

## Gotchas (must handle in the build)

1. **DST.** Times are stored in **base/GMT (winter) form**; the consumer adds +1hr during British Summer Time. Verified: ELM May (BST) needed +1hr to match MasjidBox. The build must apply UK DST (last Sun Mar → last Sun Oct = +1hr) per-row when `isDstOn` is true. Get this wrong and every summer time is an hour early. Mirror the app's logic — confirm how `isDstOn` interacts (likely: if true, app shifts during DST window).
2. **Data glitches.** Some masjids have AM/PM or entry errors in their config — observed a zuhr iqamah of `01:00` (East London Mosque, 60 winter days) and a zuhr start of `23:57` in the year series. Policy (implemented): **auto-correct only the high-confidence ±12h AM/PM typos**, then flag whatever's left. See "Glitch policy" below.
3. **`isTimingsUploaded: false` is ambiguous** — every sampled masjid had it false yet all had full 366-day data. Do NOT treat false as "no data". It likely distinguishes CSV-upload vs in-app entry.
4. **Jummah.** `jumahSalahIqamahTimings` is separate from the daily series. On Fridays, map Jummah iqamah into `zohar_jamaat` (mirroring how the Mawaqit provider handles `jumuaAsDuhr`). Respect `jummahTimeEqualsZuhrTime`.
5. **No imsak/sehri.** My-Masjid has no Suhoor field → `sehri_ends` = `fajr_start` (record `sehri_unconfigured`, same as Mawaqit).
6. **366 vs 365 / leap years.** Build dates from day+month against the current year; skip invalid (Feb 29 in non-leap).

## Field mapping → our 16-field CSV

CSV schema (from `providers/mawaqit/fetch.py:normalise`): `date, day, islamic_day, sehri_ends, fajr_start, sunrise, zawal, zohr, asr, esha, fajr_jamaat, zohar_jamaat, asr_jamaat, maghrib_iftari, maghrib_jamaat, esha_jamaat`

| CSV field | My-Masjid source |
|---|---|
| `date` | `date(year, month, day).isoformat()` |
| `day` | weekday name from date |
| `islamic_day` | "" (no per-day hijri; could compute from `hijriOffset` later) |
| `sehri_ends` | = `fajr` (DST-adjusted) — no imsak field |
| `fajr_start` | `fajr` |
| `sunrise` | `shouruq` |
| `zawal` | "" |
| `zohr` | `zuhr` |
| `asr` | `asr` |
| `esha` | `isha` |
| `fajr_jamaat` | `iqamah_Fajr` |
| `zohar_jamaat` | `iqamah_Zuhr` (Friday → Jummah iqamah) |
| `asr_jamaat` | `iqamah_Asr` |
| `maghrib_iftari` | `maghrib` |
| `maghrib_jamaat` | `iqamah_Maghrib` |
| `esha_jamaat` | `iqamah_Isha` |

All times DST-adjusted before writing.

## Build plan — `providers/mymasjid/`

Mirror `providers/mawaqit/` exactly (same shape so it slots into the existing architecture, bulk runner, triage, and frontend with zero frontend changes).

```
providers/mymasjid/
├── fetch.py      fetch_one(guid, slug, data_dir, ...) — pipeline for one masjid
├── discover.py   sweep GetPublicFilteredMasjid (vowel+terms) → filter UK → TSV to curate
└── bulk.py       read data/mymasjid_uk.txt, fetch_one per entry, throttle, regenerate index once
```

**`fetch.py` / `fetch_one(guid, slug, data_dir)`**
1. `GET GetMasjidTimings?GuidId={guid}` → save raw to `data/raw/{slug}.json`
2. `apply_dst()` per row (UK DST window, gated on `isDstOn`)
3. `normalise()` → 16-field rows (mapping table above), Jummah into Friday zohar_jamaat
4. `repair_glitches()` then `quality_check()` — repair corrects high-confidence ±12h AM/PM typos in place (logged as `time_corrected`, medium, visible); quality_check reuses Mawaqit's `fajr_after_sunrise`/`iqamas_unconfigured`/`sehri_unconfigured` and flags any residual unfixable `time_glitch` (high → needs_review)
5. `build_config()` — same shape as Mawaqit. `provider: {type:"mymasjid", ref:{guidId, masjid_id, name}, source_url:"https://time.my-masjid.com/timingsInfoScreen/{guid}"}`. Preserve user-editable fields on re-fetch (copy Mawaqit's preserve logic verbatim).
6. Geocode address: My-Masjid gives `house/street/zipCode/lat/long` directly in `masjidDetails` — richer than Mawaqit, may not even need Nominatim. Prefer their address; fall back to the shared geocoder.
7. Write CSV + config + raw. Do NOT regenerate index (caller does).

**`discover.py`** — sweep `GetPublicFilteredMasjid` over vowels + common terms, dedupe by guidId, filter `country == "United Kingdom"`, write `data/mymasjid_candidates.tsv` (guid, name, city, address) for manual curation into `data/mymasjid_uk.txt`. (Enumeration confirmed working — vowels alone ≈ full directory.)

**`bulk.py`** — read curated `data/mymasjid_uk.txt` (guid + optional slug override), call `fetch_one` per entry with throttle + continue-on-error, print summary, regenerate index once. Mirror `providers/mawaqit/bulk.py`.

**Slug derivation** — name-based, same rules as Mawaqit (slugify `name`, collision suffix). Provide a 2nd-column override in `mymasjid_uk.txt`. Reuse, don't reinvent.

**Idempotent re-fetch** — key on `provider.ref.guidId`; reuse existing slug if the guid already maps to a config.

**Triage** — `providers/triage.py` already walks `needs_review` masjids generically; add a `rebuild_from_cache`-equivalent in `mymasjid/fetch.py` (reads `data/raw/{slug}.json`, re-runs offline) so triage works without re-hitting the API.

### Estimated effort
~1 day. The hard parts are DST handling and the glitch validator; the rest is structurally identical to the Mawaqit provider we already have.

### Open decisions for Hasan
- **DST source of truth:** compute UK DST ourselves (simple: last Sun Mar–last Sun Oct) vs trust a per-masjid setting. Recommend compute ourselves + assert it matches a known masjid on each run.
- **Glitch policy (DECIDED + calibrated against the Birmingham batch):**
  - **Auto-correct (`repair_glitches`)** — a deliberate, narrow exception to the "providers don't destructively edit CSV values" rule. Corrects a value **only** when a single ±12h shift lands it cleanly into its window (start ordering; `[start-10, start+180]` for iqamahs) — unambiguous AM/PM typos like Dhuhr iqamah `01:00`→`13:00`. Logged as `time_corrected` (`{date, field, old, new}`), medium, masjid stays **visible**. Verified on East London Mosque: 60 `01:00`→`13:00` fixes, full audit trail.
  - **needs_review (HIGH) only for things we genuinely can't trust:** unparseable start times, broken start-ordering (allowing the Maghrib==Isha clamp), `fajr_after_sunrise`, and non-Fajr jama'ats grossly outside `[start-180, start+240]` that ±12h couldn't fix.
  - **NOT flagged (verified-legitimate patterns that initially over-flagged):**
    - **Jummah before Dhuhr start** — on Fridays the Jummah time fills the Dhuhr-jamaat slot; it legitimately precedes the *calculated* Dhuhr start (e.g. Green Lane Jummah 12:30 vs Dhuhr start 12:45–13:45). Confirmed against real data: all such days were Fridays.
    - **Isha clamped to Maghrib** (UK summer) — recorded as `isha_clamped` medium/visible, like the Mawaqit provider.
    - **Late-summer Fajr** — Fajr is exempt from the jama'at window; its real constraint is `fajr_jamaat < sunrise`.
  - **Birmingham first batch (31 masjids) result:** before calibration 15 visible / 16 needs_review; after, **29 visible / 2 needs_review** (both genuine `fajr_after_sunrise` — a fixed Fajr jamaat coinciding with/after sunrise in deep summer / at the spring DST transition).
- **Onboarding scale:** 490 is a lot. Suggest a first batch of ~30–50 (the big northern towns where Mawaqit is thin) to validate the pipeline before a full sweep.

## Ethics / sourcing
Public unauthenticated API on their own domain. Throttle politely (it's a small operation), attribute My-Masjid as the source in the config provider block, cache raw responses for offline re-runs. Same posture as Mawaqit. Don't hammer `GetMasjidTimings` — one fetch per masjid per run, cache aggressively.

## Reproduce
```bash
curl 'https://time.my-masjid.com/api/Masjid/GetPublicFilteredMasjid?searchParam=East%20London&isPublished=1'
curl 'https://time.my-masjid.com/api/TimingsInfoScreen/GetMasjidTimings?GuidId=287de68e-2345-461d-ac74-64b96c3c5840'
```
