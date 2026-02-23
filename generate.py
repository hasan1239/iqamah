#!/usr/bin/env python3
"""
Ramadan Lockscreen Generator
Generates a 1080x2400 phone lockscreen PNG with daily prayer times.
"""

import csv
import json
import os
import sys
from datetime import datetime, date
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image

# ── Configuration ──────────────────────────────────────────────────────────

# Hardcoded mosques (original two with custom column mappings)
BUILTIN_MOSQUES = {
    "faizul": {
        "csv": "masjid_faizul_islam_ramadan_2026.csv",
        "display_name": "Masjid Faizul Islam",
        "slug": "faizul",
        "columns": {
            "date": "Date",
            "day": "Day",
            "hijri": "Hijri",
            "sehri_ends": "Sehri Ends",
            "sunrise": "Sunrise",
            "zohr": "Zohr",
            "asr": "Asr",
            "esha": "Esha",
            "fajr_jamaat": "Fajr Jama'at",
            "zohar_jamaat": "Zohar Jama'at",
            "asr_jamaat": "Asr Jama'at",
            "maghrib_iftari": "Maghrib Iftari",
            "esha_jamaat": "Esha Jama'at",
        },
    },
    "quba": {
        "csv": "masjid_quba_ramadan_2026.csv",
        "display_name": "Masjid Quba Trust",
        "slug": "quba",
        "columns": {
            "date": "Date",
            "day": "Day",
            "hijri": "Ramadan",
            "sehri_ends": "End of Suhoor",
            "sunrise": "Sunrise",
            "zohr": "Zuhr Start",
            "asr": "Asr Start",
            "esha": "Isha Start",
            "fajr_jamaat": "Fajr Jama'at",
            "zohar_jamaat": None,  # Quba uses fixed 1:00pm
            "asr_jamaat": "Asr Jama'at",
            "maghrib_iftari": "Iftaar Maghrib",
            "esha_jamaat": "Isha Jama'at",
        },
    },
}

# Standard column mapping for mosques extracted from eSalaat via extract_timetable.py
STANDARD_COLUMNS = {
    "date": "Date",
    "day": "Day",
    "hijri": "Ramadan",
    "sehri_ends": "Sehri Ends",
    "sunrise": "Sunrise",
    "zohr": "Zohr",
    "asr": "Asr",
    "esha": "Esha",
    "fajr_jamaat": "Fajr Jama'at",
    "zohar_jamaat": "Zohar Jama'at",
    "asr_jamaat": "Asr Jama'at",
    "maghrib_iftari": "Maghrib Iftari",
    "esha_jamaat": "Esha Jama'at",
}

YEAR = 2026
HIJRI_YEAR = 1447


def load_mosques(data_dir: str) -> dict:
    """Load all mosque configs: builtins + any JSON configs in data/mosques/."""
    mosques = dict(BUILTIN_MOSQUES)

    config_dir = os.path.join(data_dir, "mosques")
    if os.path.isdir(config_dir):
        for f in sorted(os.listdir(config_dir)):
            if not f.endswith(".json"):
                continue
            config_path = os.path.join(config_dir, f)
            with open(config_path, encoding="utf-8") as fh:
                config = json.load(fh)
            slug = config["slug"]
            mosques[slug] = {
                "csv": config["csv"],
                "display_name": config["display_name"],
                "slug": slug,
                "columns": STANDARD_COLUMNS,
            }

    return mosques


def parse_csv_date(date_str: str) -> date:
    """Parse '18 Feb' style date strings into a date object."""
    return datetime.strptime(f"{date_str.strip()} {YEAR}", "%d %b %Y").date()


def load_timetable(csv_path: str) -> list[dict]:
    """Load CSV rows into a list of dicts."""
    with open(csv_path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def find_row_for_date(rows: list[dict], target: date, date_col: str) -> dict | None:
    """Find the row matching a given date."""
    for row in rows:
        if parse_csv_date(row[date_col]) == target:
            return row
    return None


def extract_times(row: dict, mosque_config: dict) -> dict:
    """Extract all needed time values from a CSV row."""
    cols = mosque_config["columns"]
    times = {}
    for key, col_name in cols.items():
        if key in ("date", "day", "hijri"):
            continue
        if col_name is None:
            # Quba has no Zohar Jama'at column — fixed at 1:00
            times[key] = "1:00"
        else:
            times[key] = row[col_name].strip()
    return times


def format_date_line(row: dict, mosque_config: dict) -> str:
    """Build the date line, e.g. 'Sunday 22 Feb 2026 · 5 Ramadan 1447'."""
    cols = mosque_config["columns"]
    day_name = row[cols["day"]].strip()
    date_str = row[cols["date"]].strip()
    hijri_day = row[cols["hijri"]].strip()

    day_map = {"Mon": "Monday", "Tue": "Tuesday", "Wed": "Wednesday",
               "Thu": "Thursday", "Fri": "Friday", "Sat": "Saturday", "Sun": "Sunday"}
    full_day = day_map.get(day_name, day_name)

    return f"{full_day} {date_str} {YEAR} · {hijri_day} Ramadan {HIJRI_YEAR}"


def build_html(template_path: str, times: dict, date_line: str, mosque_name: str) -> str:
    """Replace placeholders in the HTML template with actual values."""
    html = Path(template_path).read_text(encoding="utf-8")

    replacements = {
        "{{DATE_LINE}}": date_line,
        "{{MOSQUE_NAME}}": mosque_name,
        "{{SEHRI_ENDS}}": times["sehri_ends"],
        "{{MAGHRIB_IFTARI}}": times["maghrib_iftari"],
        "{{SUNRISE}}": times["sunrise"],
        "{{ZOHR}}": times["zohr"],
        "{{ASR}}": times["asr"],
        "{{ESHA}}": times["esha"],
        "{{FAJR_JAMAAT}}": times["fajr_jamaat"],
        "{{ZOHAR_JAMAAT}}": times["zohar_jamaat"],
        "{{ASR_JAMAAT}}": times["asr_jamaat"],
        "{{ESHA_JAMAAT}}": times["esha_jamaat"],
    }

    for placeholder, value in replacements.items():
        html = html.replace(placeholder, value)

    return html


def render_to_png(html_content: str, output_path: str):
    """Render HTML to a 1080x2400 PNG using Playwright + Pillow."""
    tmp_html = "/tmp/lockscreen_render.html"
    tmp_screenshot = "/tmp/lockscreen_hires.png"

    Path(tmp_html).write_text(html_content, encoding="utf-8")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
        )
        page.goto(f"file://{tmp_html}")
        page.wait_for_timeout(2000)
        page.screenshot(path=tmp_screenshot, full_page=False)
        browser.close()

    img = Image.open(tmp_screenshot)
    img_resized = img.resize((1080, 2400), Image.LANCZOS)
    img_resized.save(output_path, dpi=(300, 300))
    print(f"  ✅ Saved: {output_path}")


def generate_lockscreen(mosque_key: str, target_date: date, output_dir: str, template_path: str, data_dir: str, mosques: dict):
    """Full pipeline: CSV → HTML → PNG for one mosque and date."""
    config = mosques[mosque_key]
    csv_path = os.path.join(data_dir, config["csv"])

    rows = load_timetable(csv_path)
    row = find_row_for_date(rows, target_date, config["columns"]["date"])

    if row is None:
        print(f"  ⚠️  No data for {target_date} in {config['display_name']} timetable. Skipping.")
        return None

    times = extract_times(row, config)
    date_line = format_date_line(row, config)
    html = build_html(template_path, times, date_line, config["display_name"])

    date_slug = target_date.strftime("%d%b").lower()
    filename = f"ramadan_lockscreen_{config['slug']}_{date_slug}.png"
    output_path = os.path.join(output_dir, filename)

    os.makedirs(output_dir, exist_ok=True)
    render_to_png(html, output_path)
    return output_path


def main():
    """
    Usage:
        python generate.py                     # Both mosques, today's date
        python generate.py faizul              # One mosque, today's date
        python generate.py faizul 2026-02-22   # One mosque, specific date
        python generate.py all 2026-02-22      # Both mosques, specific date
    """
    script_dir = Path(__file__).resolve().parent
    data_dir = script_dir / "data"
    template_path = script_dir / "templates" / "lockscreen_v2.html"
    output_dir = os.environ.get("OUTPUT_DIR", str(script_dir / "output"))

    # Load all mosque configs (builtin + extracted)
    mosques = load_mosques(str(data_dir))

    mosque_arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    date_arg = sys.argv[2] if len(sys.argv) > 2 else None

    if date_arg:
        target_date = datetime.strptime(date_arg, "%Y-%m-%d").date()
    else:
        target_date = date.today()

    mosque_keys = list(mosques.keys()) if mosque_arg == "all" else [mosque_arg]

    print(f"🌙 Generating lockscreens for {target_date}")
    print(f"   Mosques: {', '.join(mosque_keys)}")
    print()

    generated = []
    for key in mosque_keys:
        if key not in mosques:
            print(f"  ❌ Unknown mosque: {key}. Valid options: {', '.join(mosques.keys())}")
            continue
        print(f"  📐 {mosques[key]['display_name']}...")
        path = generate_lockscreen(key, target_date, output_dir, str(template_path), str(data_dir), mosques)
        if path:
            generated.append(path)

    print()
    if generated:
        print(f"🎉 Done! {len(generated)} image(s) generated in {output_dir}/")
    else:
        print("⚠️  No images generated. Check the date is within Ramadan 2026 (18 Feb – 19 Mar).")
        sys.exit(1)


if __name__ == "__main__":
    main()
