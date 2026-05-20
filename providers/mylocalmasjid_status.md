# MyLocalMasjid — investigated, PARKED (not building as a prayer-times provider)

**Status (2026-05-20):** Spiked. Verdict: skip as a prayer-times provider — real-times coverage is only ~49 masjids, today-only. BUT their directory API is genuinely useful as a **discovery feed** (2,274 UK masjids with contact + location). Discovery tool deferred (see "Future: discovery tool").

## TL;DR

MyLocalMasjid markets "2,300+ UK masjids with real jamaat times." The API tells a different story: **2,274 masjids in the directory, but only 49 have actual prayer-time data**, and that data is today-only. The rest are scraped directory entries with no times.

## The API (public, no auth, same-origin)

Base: `https://www.mylocalmasjid.com/api`

| Endpoint | Returns |
|---|---|
| `GET /api/masjids?page=N&size=100` | Paginated directory. `size` caps at 100 (500 → HTTP 500). 2,274 total → 23 pages. |
| `GET /api/masjid/{uuid}` | Single masjid metadata (name, lat/long, address, facilities, contact). **No prayer times.** |
| `GET /api/search/masjids?q={query}` | Name/location search → list of matches with slugs + coords. |
| `GET /api/search/locations` | Location search. |

No auth, no apikey, CORS-open, on their own domain. Next.js app-router API routes.

Masjid page URL patterns (for reference): `/{area_slug}/{masjid_slug}` (preferred) or `/masjid/{uuid}/{name-slug}` (fallback). Area pages like `/birmingham` (165+), `/london` (250+).

### `/api/masjids` item shape
Rich metadata per masjid: `id` (uuid), `name`, `masjid_slug`, `type`, `madhab`, `locale`, `active`, `phone`, `email`, `website_url`, bank/donation fields, `office_hours`, `established_year`, `data_source`, `capacity`, `meta`, `location`, `facilities`, `country_slug`, `city_slug`, `area_slug`, `neighbourhood_slug`, **`current_prayer_times`**, `special_prayers`.

### `current_prayer_times` shape (when populated — today only)
```json
{
  "date": "2026-05-20",
  "fajr_start": "03:12:00", "fajr_jammat": "04:15:00",
  "sunrise": "04:59:00",
  "dhur_start": "13:02:00", "dhur_jammat": "13:30:00",
  "asr_start": "17:12:00", "asr_start_1": null, "asr_jammat": "18:45:00",
  "magrib_start": "20:56:00", "magrib_jammat": "20:56:00",
  "isha_start": "22:08:00", "isha_jammat": "22:30:00",
  "hijri_date": "3 Dhul Hijja 1447", "extra": {}
}
```
Excellent quality — separate start + jamaat for all 5 prayers, matches our schema. Note field spellings: `dhur`, `magrib`, `jammat`.

## The coverage reality

Paged through all 2,274 (size=100, 23 pages):
- **data_source:** 100% `MLM_SOURCED` — uniform. The field is NOT a real-vs-admin discriminator; everything is scraped (`meta.sources: ["mosques_nov25"]`).
- **with non-null `current_prayer_times`: 49**
- **with non-null `special_prayers`: 0**
- The 49 are heavily London-weighted (~28 London/Westminster), then Glasgow (4), Birmingham (3), Leicester (2), scattered others (Liverpool, Preston, Dundee, Manchester, Bradford, Newport, Oldham, Rochdale, Slough, Stoke).
- **No multi-day endpoint.** Only `current_prayer_times` (today) is exposed. Probed `/prayer-times`, `/timetable`, `/range`, query-param variants on both outer id and prayer-times `masjid_id` — all 404. Same daily-accumulation problem as MasjidBox.
- Overlap with our existing 172: ~4 by exact-ish name (Al Huda Masjid, East London Mosque, Finsbury Park, Muslim Welfare House). So ~45 *potentially* new, fewer after proper location dedup.

## Verdict

**As a prayer-times provider: not worth building.** ~45 net-new masjids, today-only, London-heavy — same accumulation pain as MasjidBox for a smaller prize. The 49 with times are mostly findable via Mawaqit anyway.

**As a discovery/directory source: the best UK masjid directory exposed via a clean API.** 2,274 masjids with lat/long + address + phone/email/website. Better than Google-scraping (how we found MasjidBox masjids).

## Future: discovery tool (the "b" option — not built yet)

Idea: tap `/api/masjids` purely as a discovery feed to find UK masjids we don't have yet.
- Pull all 23 pages → 2,274 masjids
- Cross-reference (by name + lat/long proximity) against our `data/mosques/*.json`
- Output the gaps with their contact details → prioritise Mawaqit matching or admin outreach
- Could live as `providers/mylocalmasjid/discover.py` writing a TSV the maintainer curates (mirrors the mawaqit discover pattern)

Not started. Hasan may pick this up later.

## Ethics / sourcing note

Public unauthenticated API on their own domain — low-risk to read for discovery. If we ever use it, throttle (it's a small charity-style operation), attribute MyLocalMasjid as the directory source, and don't hammer it. Don't republish their scraped times as our "real times" — the 49 are themselves scraped (`MLM_SOURCED`), provenance unknown, so they wouldn't meet our real-jamaat brand bar without verification.

## Reproduce

```bash
# directory page
curl 'https://www.mylocalmasjid.com/api/masjids?size=100&page=1'
# single masjid
curl 'https://www.mylocalmasjid.com/api/masjid/b2881466-013f-4b03-87e3-d3d2afd8a9ac'
# search
curl 'https://www.mylocalmasjid.com/api/search/masjids?q=Birmingham%20Central%20Mosque'
```
