# Prayerly

**Daily Ramadan prayer times for your local masjid.**

View prayer times online or download as a beautifully designed phone lockscreen wallpaper (1080×2400). Supports any masjid from [eSalaat.com](https://esalaat.com) — just add the timetable code and it extracts the data automatically using Claude's vision API.

## Features

- 🌐 **View online:** Today's times and full monthly timetable with animated toggle
- 📱 **Download lockscreen:** PNG wallpaper optimized for modern phones
- 🤖 **Auto-updates:** Generates daily at 2am GMT throughout Ramadan 2026
- 🕌 **Multi-masjid:** Easily add any masjid from eSalaat

**Available masjids:**
- [Masjid Faizul Islam](https://hasan1239.github.io/ramadan-lockscreen/masjid.html?id=faizul)
- [Masjid Quba Trust](https://hasan1239.github.io/ramadan-lockscreen/masjid.html?id=quba)
- [Masjid Aisha](https://hasan1239.github.io/ramadan-lockscreen/masjid.html?id=aisha)

## How It Works

1. **Website:** Static HTML pages hosted on GitHub Pages display prayer times dynamically
2. **Daily generation:** A GitHub Actions workflow runs every day at **2:00am GMT** during Ramadan
3. It reads prayer times from CSV timetables and renders styled lockscreen PNGs
4. Images are committed to `output/` (date-stamped) and `latest/` (stable URL)
5. Website auto-discovers all available masjids from JSON configs

## Adding a New Masjid

You can add any masjid from eSalaat in a couple of clicks:

1. Go to [esalaat.com](https://esalaat.com), find your city, click your masjid
2. Note the timetable code from the URL (e.g. `1003` from `esalaat.com/timetables/1003.jpg`)
3. Go to the **Actions** tab → **"Add Masjid from eSalaat"** → **Run workflow**
4. Enter the code (e.g. `1003`) and optionally the masjid name
5. The workflow downloads the image, extracts all 30 days of times using Claude API, saves a CSV, and commits it
6. From the next daily run onwards, lockscreens will be generated for that masjid too

## Phone Automation

The latest lockscreen for each masjid is always available at a stable URL:

```
https://raw.githubusercontent.com/hasan1239/ramadan-lockscreen/main/latest/ramadan_lockscreen_<slug>_latest.png
```

### Android (Tasker)

1. Create a profile triggered at 3:00am daily
2. Task: **HTTP Get** → download your masjid's `latest/` PNG URL
3. Task: **Set Wallpaper** → apply to lock screen

Your lockscreen will update itself every morning without any manual effort.

## Running Locally

```bash
pip install playwright Pillow anthropic
playwright install --with-deps chromium

# Generate for all masjids, today's date
python generate.py

# Generate for one masjid on a specific date
python generate.py faizul 2026-02-22

# Extract a new masjid from eSalaat
ANTHROPIC_API_KEY=sk-ant-... python extract_timetable.py 1003
```

## Project Structure

```
├── .github/workflows/
│   ├── generate.yml          # Daily lockscreen generation
│   └── add_mosque.yml        # Add new masjid from eSalaat
├── data/
│   ├── mosques/              # JSON configs + index for dynamic discovery
│   └── *.csv                 # Prayer timetable data
├── templates/
│   └── lockscreen*.html      # HTML templates for PNG generation
├── index.html                # Homepage with masjid cards
├── masjid.html               # Prayer times page with Today/Month views
├── output/                   # Generated PNGs (date-stamped)
├── latest/                   # Stable-URL copies (always today's)
├── generate.py               # Main generation script
├── extract_timetable.py      # eSalaat → Claude API → CSV extractor
├── favicon.ico               # Site favicon
├── salahdaily_icon.png       # Logo
└── requirements.txt
```

## Tech Stack

- **Frontend:** Static HTML, CSS, vanilla JavaScript
- **Backend:** Python + Playwright (HTML → PNG) + Anthropic Claude (vision API)
- **Hosting:** GitHub Pages + GitHub Actions
- **Fonts:** Google Fonts (Cinzel, Amiri, Lato)

---

© Prayerly
