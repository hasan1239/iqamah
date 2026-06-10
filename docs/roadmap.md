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
daily from the stable `latest/` URLs. Long-standing future-plan item in CLAUDE.md;
mostly a docs task. **Effort: tiny.**

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
