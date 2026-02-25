#!/usr/bin/env python3
"""
Ramadan Lockscreen Generator
Generates a 1080x2400 phone lockscreen PNG with daily prayer times.
"""

import csv
import json
import os
import shutil
import sys
import tempfile
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
            if not f.endswith(".json") or f == "index.json":
                continue
            config_path = os.path.join(config_dir, f)
            with open(config_path, encoding="utf-8") as fh:
                config = json.load(fh)
            slug = config["slug"]
            mosques[slug] = {
                "csv": config["csv"],
                "display_name": config["display_name"],
                "slug": slug,
                "columns": config.get("columns", STANDARD_COLUMNS),
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


def format_date_line(row: dict, mosque_config: dict) -> tuple[str, str]:
    """Build the date line parts for alignment with diamond divider."""
    cols = mosque_config["columns"]
    day_name = row[cols["day"]].strip()
    date_str = row[cols["date"]].strip()
    hijri_day = row[cols["hijri"]].strip()

    day_map = {"Mon": "Monday", "Tue": "Tuesday", "Wed": "Wednesday",
               "Thu": "Thursday", "Fri": "Friday", "Sat": "Saturday", "Sun": "Sunday"}
    full_day = day_map.get(day_name, day_name)

    english_date = f"{full_day} {date_str} {YEAR}"
    islamic_date = f"{hijri_day} Ramadan {HIJRI_YEAR}"

    return english_date, islamic_date


def build_html(template_path: str, times: dict, date_parts: tuple[str, str], mosque_name: str) -> str:
    """Replace placeholders in the HTML template with actual values."""
    html = Path(template_path).read_text(encoding="utf-8")

    english_date, islamic_date = date_parts

    replacements = {
        "{{ENGLISH_DATE}}": english_date,
        "{{ISLAMIC_DATE}}": islamic_date,
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
    tmp_dir = tempfile.gettempdir()
    tmp_html = os.path.join(tmp_dir, "lockscreen_render.html")
    tmp_screenshot = os.path.join(tmp_dir, "lockscreen_hires.png")

    Path(tmp_html).write_text(html_content, encoding="utf-8")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
        )
        page.goto(Path(tmp_html).as_uri())
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
    date_parts = format_date_line(row, config)
    html = build_html(template_path, times, date_parts, config["display_name"])

    date_slug = target_date.strftime("%d%b").lower()
    filename = f"ramadan_lockscreen_{config['slug']}_{date_slug}.png"
    output_path = os.path.join(output_dir, filename)

    os.makedirs(output_dir, exist_ok=True)
    render_to_png(html, output_path)
    return output_path


def copy_to_latest(generated_files: list[str], script_dir: Path):
    """Copy generated files to latest/ folder with stable names."""
    latest_dir = script_dir / "latest"
    os.makedirs(latest_dir, exist_ok=True)

    for filepath in generated_files:
        # Extract slug from filename: ramadan_lockscreen_{slug}_{date}.png
        filename = os.path.basename(filepath)
        parts = filename.replace("ramadan_lockscreen_", "").split("_")
        slug = parts[0]  # First part is the slug

        latest_filename = f"ramadan_lockscreen_{slug}_latest.png"
        latest_path = latest_dir / latest_filename

        # Copy file
        shutil.copy2(filepath, latest_path)
        print(f"  📋 Copied to latest/{latest_filename}")


def main():
    """
    Usage:
        python generate.py                                   # All mosques, today's date, v2 template
        python generate.py faizul                            # One mosque, today's date, v2 template
        python generate.py faizul 2026-02-22                 # One mosque, specific date, v2 template
        python generate.py all 2026-02-22                    # All mosques, specific date, v2 template
        python generate.py all 2026-02-22 --template v2.1    # With specific template
    """
    script_dir = Path(__file__).resolve().parent
    data_dir = script_dir / "data"
    output_dir = os.environ.get("OUTPUT_DIR", str(script_dir / "output"))

    # Parse arguments
    args = sys.argv[1:]

    # Extract --template flag and value
    template_version = "v2"  # default
    if "--template" in args:
        template_idx = args.index("--template")
        if template_idx + 1 < len(args):
            template_version = args[template_idx + 1]
            # Remove --template and its value from args
            args = args[:template_idx] + args[template_idx + 2:]

    # Now parse remaining positional arguments
    mosque_arg = args[0] if len(args) > 0 else "all"
    date_arg = args[1] if len(args) > 1 else None

    template_path = script_dir / "templates" / f"lockscreen_{template_version}.html"
    if not template_path.exists():
        print(f"❌ Template not found: {template_path}")
        print(f"   Available templates: v1, v2, v2.1, v2.2, v2.3")
        sys.exit(1)

    # Load all mosque configs (builtin + extracted)
    mosques = load_mosques(str(data_dir))

    if date_arg:
        target_date = datetime.strptime(date_arg, "%Y-%m-%d").date()
    else:
        target_date = date.today()

    mosque_keys = list(mosques.keys()) if mosque_arg == "all" else [mosque_arg]

    print(f"🌙 Generating lockscreens for {target_date}")
    print(f"   Template: {template_version}")
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
        print()
        print("📋 Copying to latest/ folder...")
        copy_to_latest(generated, script_dir)
    else:
        print("⚠️  No images generated. Check the date is within Ramadan 2026 (18 Feb – 19 Mar).")
        sys.exit(1)


if __name__ == "__main__":
    main()
