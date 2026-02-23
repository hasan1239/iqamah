# 🌙 Ramadan Lockscreen Generator

Automatically generates a beautiful phone lockscreen wallpaper (1080×2400) with daily prayer times for Ramadan 2026.

Supports any mosque from [eSalaat.com](https://esalaat.com) — just add the timetable code and it extracts the data automatically using Claude's vision API.

**Built-in mosques:**
- Masjid Faizul Islam (Perry Barr, Birmingham)
- Masjid Quba Trust (Handsworth, Birmingham)

## How It Works

1. **Daily generation:** A GitHub Actions workflow runs every day at **2:00am GMT** during Ramadan
2. It reads prayer times from CSV timetables and renders a styled lockscreen PNG
3. Images are committed to `output/` (date-stamped) and `latest/` (stable URL)

## Adding a New Mosque

You can add any mosque from eSalaat in a couple of clicks:

1. Go to [esalaat.com](https://esalaat.com), find your city, click your mosque
2. Note the timetable code from the URL (e.g. `1003` from `esalaat.com/timetables/1003.jpg`)
3. Go to the **Actions** tab → **"Add Mosque from eSalaat"** → **Run workflow**
4. Enter the code (e.g. `1003`) and optionally the mosque name
5. The workflow downloads the image, extracts all 30 days of times using Claude API, saves a CSV, and commits it
6. From the next daily run onwards, lockscreens will be generated for that mosque too

## Stable URLs for Phone Automation

The latest lockscreen for each mosque is always at:

```
https://raw.githubusercontent.com/<user>/ramadan-lockscreen/main/latest/ramadan_lockscreen_<slug>_latest.png
```

Use these in iOS Shortcuts or Android Tasker to auto-set your wallpaper each morning.

## Setup

### 1. Create the GitHub repo

```bash
gh repo create ramadan-lockscreen --public --source=. --push
```

### 2. Add your Anthropic API key (for adding new mosques)

Go to **Settings → Secrets and variables → Actions → New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your `sk-ant-...` key from [console.anthropic.com](https://console.anthropic.com)

### 3. Manual generation

You can generate any day manually from the **Actions** tab:
- Click "Generate Daily Ramadan Lockscreen" → "Run workflow"
- Optionally set a specific date and mosque

### 4. Phone automation (Android — Tasker)

1. Create a profile triggered at 3:00am
2. Task: HTTP Get → download the `latest/` PNG URL
3. Task: Set Wallpaper → apply to lock screen

## Running Locally

```bash
pip install playwright Pillow anthropic
playwright install --with-deps chromium

# Generate for all mosques, today's date
python generate.py

# Generate for one mosque on a specific date
python generate.py faizul 2026-02-22

# Extract a new mosque from eSalaat
ANTHROPIC_API_KEY=sk-ant-... python extract_timetable.py 1003
```

## Project Structure

```
├── .github/workflows/
│   ├── generate.yml          # Daily lockscreen generation
│   └── add_mosque.yml        # Add new mosque from eSalaat
├── data/
│   ├── mosques/              # JSON configs for extracted mosques
│   ├── masjid_faizul_islam_ramadan_2026.csv
│   └── masjid_quba_ramadan_2026.csv
├── templates/
│   └── lockscreen.html       # HTML template with placeholders
├── output/                   # Generated PNGs (date-stamped)
├── latest/                   # Stable-URL copies (always today's)
├── generate.py               # Main generation script
├── extract_timetable.py      # eSalaat → Claude API → CSV extractor
└── requirements.txt
```
