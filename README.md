# Iqamah

**Prayer times for your local masjid — always up to date.**

A progressive web app for viewing daily prayer times, downloading lockscreen wallpapers, and discovering nearby masjids. Currently serving **16 masjids** with auto-generated lockscreens and self-service timetable submissions.

Live at [iqamah.co.uk](https://iqamah.co.uk)

## Features

- **Today & Month views** — animated toggle between daily prayer times and full monthly timetable
- **Next prayer countdown** — independent countdowns for both start times and jama'at times
- **Lockscreen wallpapers** — downloadable 1080x2400 PNGs in dark and light themes, auto-generated daily
- **PWA support** — installable on Android and iOS with platform-specific prompts
- **Set My Masjid** — pin your primary masjid for quick access from the home screen
- **Qibla compass** — device orientation-based qibla direction finder
- **Self-service submissions** — upload a timetable image and AI extracts the data automatically
- **Timetable updates** — submit updated times for existing masjids
- **Seasonal modes** — adapts between Ramadan, Eid, and default layouts via a config flag
- **Eid salah times** — dedicated `/eid` page with all masjids sorted by earliest jama'at
- **Light/dark mode** — smooth crossfade transitions with animated stars (dark) or golden dust motes (light)
- **Masjid info** — address with Google Maps link, contact number, radio frequency, Eid salah, Fitrana
- **Auto version bumping** — PR labels (`major`, `minor`, `patch`) trigger automatic semver updates on merge

## How It Works

1. **Timetable data** is extracted from uploaded timetable images using Claude's vision API, producing CSV files
2. **Masjid configs** (`data/mosques/*.json`) store display name, slug, CSV reference, and metadata
3. **The SPA** (`index.html`) fetches `data/mosques/index.json` to discover all masjids, then loads each config dynamically
4. **Clean URLs** (`/aisha`, `/quba`) are handled by a Cloudflare Pages Worker (`_worker.js`) that routes requests to the SPA
5. **Daily at 2am GMT**, a GitHub Actions workflow generates lockscreen PNGs from HTML templates using Playwright, commits them to `output/` (date-stamped) and `latest/` (stable URLs)
6. **Cloudflare Pages** auto-deploys on every push to main

## Adding a New Masjid

1. Go to [iqamah.co.uk/add](https://iqamah.co.uk/add)
2. Upload a photo of the timetable and enter the masjid name
3. Review the AI-extracted times in an editable table
4. Submit — the masjid is added immediately (pending approval)

## Updating a Timetable

1. Go to `iqamah.co.uk/update/<slug>` (or click "Upload Timetable" on a masjid page with stale times)
2. Upload the new timetable image
3. Review and submit — the updated times replace the existing CSV

## Running Locally

```bash
# Install dependencies
pip install playwright Pillow anthropic
playwright install --with-deps chromium

# Generate lockscreens for all masjids (today's date)
python generate.py

# Generate for a specific masjid and date
python generate.py faizul 2026-02-22

```

For the website, serve the repo root with any static server (e.g. `npx serve .`). The `_worker.js` routing only runs on Cloudflare — locally, use `?id=slug` query params or access files directly.

## Project Structure

```
.github/workflows/
  generate.yml            Daily lockscreen generation (2am GMT cron)
  add_masjid.yml          Add masjid from self-service submission
  update_masjid.yml       Update existing timetable
  approve_masjid.yml      Approve pending masjid submissions
  season.yml              Switch seasonal mode (ramadan/eid/default)
  version_bump.yml        Auto-bump version on PR merge

data/
  mosques/                Masjid JSON configs + index.json manifest
  *.csv                   Prayer timetable CSVs
  season.json             Current seasonal mode

js/
  app.js                  SPA entry point
  router.js               Client-side router (clean URLs)
  nav.js                  Bottom navigation bar
  theme.js                Light/dark mode logic
  background.js           Stars and dust mote animations
  views/                  View modules (home, prayer-times, masjids, etc.)
  utils/                  Shared utilities (CSV parsing, hijri dates, etc.)

templates/
  lockscreen_v*.html      Lockscreen HTML templates (dark + light variants)
  eid_mubarak.html        Eid greeting image template

index.html                SPA shell + all CSS
_worker.js                Cloudflare Pages Worker (routing + API endpoints)
generate.py               Lockscreen PNG generator (Playwright + Pillow)
generate_eid.py           Eid Mubarak greeting image generator
```

## Tech Stack

- **Frontend:** Single-page app — vanilla JavaScript, CSS, client-side router
- **Backend:** Cloudflare Pages Worker (API endpoints for extraction and submission)
- **AI:** Anthropic Claude API (vision-based timetable extraction)
- **Generation:** Python, Playwright (HTML → PNG), Pillow (image resizing)
- **Hosting:** Cloudflare Pages with custom domain, auto-deploy on push
- **CI/CD:** GitHub Actions (daily generation, masjid management, version bumping)
- **Fonts:** Google Fonts (Amiri for Arabic, Lato for UI)

---

&copy; Iqamah
