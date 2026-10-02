# Iqamah — Feature Roadmap

> Ideas evaluated June 2026 and deliberately **not** built in the `feature/feature-pack` branch.
> Each entry notes why it's worth doing and roughly what it would take.
> The six specced features (More hub, Prayer Tracker, Tasbih, Daily Dua, Jummah Times,
> Follow Multiple Masjids) plus link unfurls, share cards, the Eid greeting generator,
> postcode search, time-to-leave, client-side lockscreen rendering, the admin fleet
> dashboard and the slim index are being built now and are not listed here.

---

## Worship & retention

### Sunnah fasting reminders
Surface the White Days (13/14/15 of each Hijri month), Mondays/Thursdays, Ashura and
Arafah as a quiet Home card: "Tomorrow is the 13th of Muharram — a White Day fast.
Sehri ends 3:12am." Reuses `js/utils/hijri.js` (Umm al-Qura) and the Sehri column we
already have. Gives the app a year-round heartbeat outside Ramadan — directly attacks
the post-Ramadan retention cliff. **Effort: small.**

### Ramadan Khatam (Quran completion) tracker
Juz'/page-per-day tracker with a pace indicator ("on track to finish by the 27th
night"). Same localStorage-only pattern as the Prayer Tracker; seasonal; highly
shareable progress. Natural Ramadan-mode companion tile in the More hub.
**Effort: small-medium.**

### Qada (missed prayer) counter
Running debt counter that decrements as make-up prayers are logged. Tonally sensitive —
needs encouraging, non-judgemental copy. Natural v2 of the Prayer Tracker once it has
an audience. **Effort: small, on top of the tracker.**

### iCal calendar feeds per masjid
`/api/ical/{slug}.ics` endpoint in `_worker.js` converting the masjid CSV into calendar
events (jama'at times; optionally a Jummah-only feed). Users subscribe once in
Google/Apple Calendar and get native notifications forever — delivers most of the value
of push notifications with none of the backend. Pairs with a "Subscribe in your
calendar" row on the masjid page. **Effort: medium (CSV→ICS in the worker, TZ
handling, feed caching).**

### Push notifications
Full spec already exists (VAPID keys, Worker push endpoint, per-prayer settings model)
— see the planning notes in the project memory. Deliberately deferred: iCal feeds and
PWA improvements buy most of the value first. **Effort: large (backend state,
subscription lifecycle, delivery scheduling).**

## Resilience & platform

### Offline-first pinned masjid
The service worker currently only falls back to `index.html`. Cache the followed
masjids' configs + CSVs (stale-while-revalidate) so today's times render instantly
with no signal — masjid basements and prayer halls are notorious dead zones, i.e. the
exact moment of use. After Follow Multiple Masjids lands, the follow list defines the
cache set. **Effort: medium (sw.js strategy work + cache invalidation on update).**

### Performance: HTTP cache headers for /data/*
`_headers` or worker-set `Cache-Control` with short max-age + SWR for configs/CSVs.
Needs care: freshness is the brand promise, so keep TTLs short (minutes, not hours).
**Effort: small.**

### Self-healing provider parsers
Provider format changes currently break feeds silently. In Oct 2026 we found AthanPlus
had switched its widget dates from "October 2, 2026" to "Oct 2, 2026"; the Masjidal
parser found 0 rows and London Central Mosque showed no times from 31 May to 2 Oct.
The new "Check daily feeds have today's times" step in `generate.yml` now *detects* that
within a day, but nothing *adapts*. Fragility by provider:

| Provider | Fetch | Breaks when |
|---|---|---|
| Masjidal | scrapes AthanPlus widget HTML | any markup/wording change (most fragile) |
| Mawaqit | regex for the `confData` JSON in the page | variable renamed / embedding changes |
| MasjidBox, My-Masjid, LondonPrayerTimes | JSON APIs | fields renamed, URL version bump |

Layers, cheapest first:
1. **Tolerant parsers (no AI).** Parse by meaning, not exact format: accept any
   reasonable date format, find prayers by label ("Fajr", "Sunrise") instead of
   position, field-alias tables for the JSON providers. Alone, this would have
   survived the "Oct 2" change. **Effort: small.**
2. **Validate every parse before writing it.** Treat 0 rows, or rows that fail the
   checks, as a failed parse rather than data. Checks: prayer ordering, sunrise and
   Maghrib vs the sun (`providers/sun.py`, `providers/quality.py`), and dates covering
   today. Keep the last good data and alert instead of writing garbage.
   **Effort: small (most checks exist).**
3. **Claude fallback extractor.** When the parser fails validation, send the raw
   response (trimmed HTML/JSON) to Claude with the same 16-field schema as image
   extraction. Run the result through the same checks, plus a comparison with the
   masjid's recent days (jama'at times rarely jump). If it passes, write it tagged
   `parsed_by: ai_fallback` and open a "Masjidal parser needs updating" GitHub issue
   with a sample of the new format. `ANTHROPIC_API_KEY` is already a GitHub Actions
   secret, and calls only happen on failure, so the cost is negligible.
   **Effort: medium.**
4. **Claude-proposed parser fix.** The issue from layer 3 triggers a job that gives
   Claude the saved sample, the parser and its tests, and opens a PR for review.
   **Effort: medium.**

**Open decision before layer 3:** should AI-extracted times go live automatically
(labelled, with the alert), or be held for approval while the last good data shows?
Sunrise/Maghrib are objectively checkable against the sun; jama'at times can only be
sanity-checked against the masjid's recent days. Recommended start: layers 1-2. Related:
"AI quality sentinel" below.

## Data & coverage (the moat)

### Coverage gap dashboard
Cross-reference MyLocalMasjid's 2,274-masjid UK directory (API already spiked — see
`providers/mylocalmasjid_status.md`) and the 538-row `data/mymasjid_candidates.tsv`
against onboarded masjids → per-city gap table ("Bradford: 41 candidates, 3
onboarded"). Turns expansion from guesswork into a prioritised outreach list. Could be
a Python report first, admin-dashboard panel later. **Effort: small (script) /
medium (UI).**

### "Request a masjid" flow
A 30-second public form (masjid name + city, optional postcode) that files a GitHub
issue via the existing PAT from `_worker.js`. Reveals real demand geography;
requesters become beachhead users when their masjid goes live. Needs rate limiting +
Turnstile like `/add`. **Effort: small-medium.**

### Per-masjid claimed admin
Scoped admin: a masjid committee member is verified once, then can update their own
masjid's Jummah times, Eid salah, announcements and timetable via the existing update
wizard. Converts the biggest operational cost (keeping ~200 masjids fresh) into
distributed volunteer labour. Builds on the existing admin-verify endpoint — needs a
per-slug permission model and an invite flow. **Effort: medium-large.**

### Times-changed detection
When a provider re-fetch alters jama'at times, record a diff summary in the config and
show "Jama'at times updated 2 days ago" on the masjid page. Reassures users after
clock changes and reinforces the freshness promise. Provider side: compare old/new CSV
on fetch; UI side: small notice component. **Effort: medium.**

### AI quality sentinel
Nightly job where Claude reviews provider fetch diffs for anomalies static rules miss
(Asr jama'at jumping 3 hours, Maghrib before sunset, suspicious AM/PM flips) and
writes a triage report / flags `needs_review`. Extends the existing quality model and
the existing Anthropic API integration. **Effort: medium.**

## Lockscreen & sharing

### Lockscreen customisation
Once client-side rendering ships, let users pick a colour theme (the v2.1–v2.3
palettes already exist as references), toggle elements (Hijri date, jama'at vs start
times), and regenerate on-device. Zero pipeline cost. **Effort: small-medium, after
client-side rendering.**

### Android Tasker / automation guide
Documented recipe (Tasker / MacroDroid / iOS Shortcuts) for auto-setting the wallpaper
daily. The stable `latest/` PNG URLs this relied on are paused as of Sep 2026 (repo size;
see `GENERATE_LOCKSCREENS` in `generate.yml`), so this needs an image source first:
resume CI generation with storage outside git, or a Worker endpoint that renders
today's lockscreen. **Effort: medium (was tiny).**

## Discovery & growth

### Masjid profile enrichment
Facility tags (women's section, parking, wudu facilities, wheelchair access, classes),
crowdsourced via the add/update flow and shown as chips on the masjid page + filters
on the list/map. Differentiates Iqamah from bare timetable apps. **Effort: medium
(schema + contribution UI + moderation).**

### Masjid announcements
Per-masjid announcement line (janazah notices, Ramadan programme, Eid arrangements)
editable by claimed admins. High community value, but needs the claimed-admin model
first and light moderation. **Effort: medium, after claimed admin.**

### SEO landing pages per city
Worker-rendered `/city/birmingham` pages listing masjids with today's times (real HTML,
not just SPA shell) for search traffic — "prayer times birmingham" queries. Builds on
the unfurl injection machinery. **Effort: medium.**
