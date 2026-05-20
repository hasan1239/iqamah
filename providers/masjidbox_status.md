# MasjidBox provider — BUILT (daily-accumulating)

**Status (2026-05-20):** BUILT and onboarded. The 2-day-window limitation was turned into a daily-accumulation design instead of waiting on iCal — see `providers/masjidbox/`. The original parked investigation is kept below for context.

**How it works now:** `providers/masjidbox/{fetch,bulk}.py` run daily (via `generate.yml`), upserting today+tomorrow into each masjid's CSV by date. Masjids are flagged `today_only` so the frontend hides the month view. No admin opt-in needed — works for any MasjidBox masjid we can find a slug for (discovery is via Google `site:masjidbox.com/prayer-times`, curated into `data/masjidbox_uk.txt`). Self-healing: re-fetched daily, so always current.

**Quality gates:** the shared start-time outlier check (`providers/__init__.py:check_start_outliers`) flags miscalculated/unconfigured masjids. MasjidBox has its own placeholder problem (~30% in the Birmingham batch were unconfigured: high-angle calc + flat +10 iqamah → Isha after midnight) — these get hidden. `suppress_times` config blanks individual bad cells (e.g. an extreme Fajr start) so a masjid stays usable instead of fully hidden when only a cell is wrong but the jamaat is real.

**Birmingham batch:** 13 onboarded, 4 hidden (unconfigured), 9 visible — several recovering masjids that were placeholder junk on My-Masjid (Green Lane, Mohammadi, etc.) now with correct live data. **iCal is no longer needed for breadth** (daily-fetch works without admin involvement); it would only add full-year data for the month view, which we've decided to hide anyway.

**Scale caution:** at ~60-100 UK masjids the daily burst is detectable and against MasjidBox's stated "no public API" — send them a courtesy email before scaling big (see "Ethics" below).

## (Historical) Why it was parked

The widget API works but only returns a 2-day window (yesterday + today). Anything wider triggers a Cloudflare 503. Without a full-year data source, every MasjidBox masjid we onboard would have a broken month view for ~30 days while data accumulates day-by-day — a UX downgrade vs Mawaqit masjids that are usable instantly. (Resolved by hiding the month view for these masjids.)

The official alternative is **iCal subscription links** (MasjidBox calls these "shareable public iCalendar links"). Format is undocumented — we need to see one real example before we can design against it. Each masjid admin generates their own from their dashboard.

## What's known about the API

**Working endpoint** (use only when needed; respect rate limits):
```
GET https://api.masjidbox.com/1.0/masjidbox/landing/athany/{slug}
Header: apikey: JejYcMS7hsOsZTPDk2ZhKOAlW9IyQ6Px
       User-Agent: Mozilla/5.0
```

Returns full masjid info — including `name`, `address`, `country`, `verified`, `settings` (timezone, language), `athany` (showIqamah, theme, qrcode), and a `timetable` of **2 days** with full per-day records:
- start times (`fajr`, `sunrise`, `dhuhr`, `asr`, `maghrib`, `isha`) as ISO timestamps with timezone
- `iqamah` block (same prayers, congregation times)
- `hijri` (gregorian + day-of-month + Arabic month name + ISO month name + year)
- `special` (`imsak`, `iftar`)

**API key is non-secret** — hardcoded in their public widget bundle (`public/0.784da860.app.js`, `app/config.js` module). Found via grepping the bundle for `masjidboxKEY`.

**What does NOT work:**
- ANY query string (e.g. `?get=at&days=30&begin=2026-05-20`) → 503 from Cloudflare, including the form documented in their own JS bundle
- Browser-like headers (Origin / Referer / Sec-Fetch-*) → 503, sometimes IP-level rate limit
- Subpath variants (`/timetable`, `/calendar`, `/days/30`) → 503

Spike script: `spike_masjidbox.py` at repo root. Raw response dumps saved under `data/raw/spike_masjidbox/*.json`.

## What's known about iCal

- Officially called "Shareable iCal" — see https://masjidbox.com/changelog/shareable-ical-and-accuracy-alerts
- Described as "public" — token-gated but not user-private
- Generated from masjid admin dashboard: Settings → Prayer Times
- URL format unknown — not in JS bundle, not in public page HTML, not in sitemap, support article 404s
- Likely on `api.masjidbox.com` based on host pattern, but unverified

## Why we want a real sample

Once we see one real iCal URL, we can:
1. Confirm host + path pattern
2. Build a `/add` form field where masjid admins paste their iCal URL
3. Fetch + parse + import to standard CSV format (parsing is trivial — RFC 5545, `python-icalendar` lib or even a regex)
4. End up with full-year data per masjid, officially blessed by MasjidBox

## Outreach (2026-05-20)

Hasan emailed:
- **Birmingham Central Mosque** — info@centralmosque.org.uk
- **Green Lane Masjid** — info@greenlanemasjid.org

Asking each for their MasjidBox iCal subscription URL.

If no reply by ~2026-05-27, follow up with the next tier:
- **UKIM Sparkbrook** — sbmasjid@gmail.com / 0121 773 8651
- **Mohammadi Masjid Alum Rock** — mohammadimasjid@live.co.uk / 0121 328 7773
- **East Birmingham Central Masjid (EBC)** — info@ebcmasjid.com / 0121 246 3779
- **Zia Ul Ummah Centre** — info@ziaulummahfoundation.org.uk / 0121 771 0180

## UK coverage estimate

No public directory. From ~4 Google search queries I identified ~24 unique UK MasjidBox slugs across Birmingham, London, Luton, Leicester, Bradford, Manchester, Nottingham, York, Preston, Bournemouth, Northampton, Hastings, Herts & Essex. Realistic total: **50–150 UK masjids**, lean toward 60–80. After dedup with our existing 128 Mawaqit/eSalaat/image masjids, expect **+30–50 net new masjids** if we ship a working flow.

## Next steps when work resumes

1. **Once an iCal URL arrives** — probe it with `curl`, log the response shape, build a minimal parser.
2. **Scaffold `providers/masjidbox/`** matching the `providers/mawaqit/` structure:
   - `fetch.py` — accept iCal URL, fetch, parse to standard 16-field CSV, write `data/{slug}.csv` + `data/mosques/{slug}.json` (with `provider.type = "masjidbox"`, `provider.ref = {ical_url}`)
   - `bulk.py` — read curated `data/masjidbox_uk.txt` of slug+ical_url pairs, fetch each
   - No `discover.py` — MasjidBox has no enumeration API; discovery is manual via Google + admin outreach
3. **Add to `/add` page** — third tab "MasjidBox iCal URL" alongside the existing image upload and (future) Mawaqit URL flows. Validate the URL returns `text/calendar` before accepting.
4. **Quality flags** — re-use the `quality` block from mawaqit; iCal data shouldn't need many checks since it comes straight from the admin, but worth running the same `iqamas_unconfigured`/`fajr_after_sunrise` sanity checks.

## What NOT to do without permission

- **Don't bulk-poll** the widget API daily for many masjids. The hardcoded key is shipped to every browser, so it's not strictly "stolen", but high traffic from our IPs could get us key-rotated or blocked. If we ever fall back to widget API + daily accumulation, throttle hard.
- **Don't ship MasjidBox masjids with 2-day-window data** as a permanent state. The whole brand promise is real iqama times across the month — a "data accumulating" badge for 30 days is acceptable only as a temporary bridge while we build the iCal flow.
- **Don't onboard without admin consent** — even when we have a working iCal flow. The iCal URL is per-masjid and shared by their admin; treat it as a relationship, not a scrape.
