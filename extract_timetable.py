#!/usr/bin/env python3
"""
Timetable Extractor
Extracts prayer times from mosque timetable images (uploaded or from eSalaat)
using Claude's vision API.

Modes:
  add     — Extract from an image and add a new masjid
  update  — Extract from an image and update an existing masjid's timetable
  esalaat — Download from eSalaat and add a new masjid (legacy)
"""

import argparse
import anthropic
import base64
import csv
import datetime
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path


ESALAAT_TIMETABLE_URL = "https://esalaat.com/timetables/{code}.jpg"

PROMPT_DIR = Path(__file__).parent / "prompts"
EXTRACTION_PROMPT = (PROMPT_DIR / "extraction.txt").read_text(encoding="utf-8")


def download_timetable(code: str, output_path: str) -> bool:
    """Download a timetable image from eSalaat."""
    url = ESALAAT_TIMETABLE_URL.format(code=code)
    print(f"  📥 Downloading {url}...")
    try:
        urllib.request.urlretrieve(url, output_path)
        print(f"  ✅ Saved to {output_path}")
        return True
    except Exception as e:
        print(f"  ❌ Download failed: {e}")
        return False


def extract_with_claude(image_path: str, api_key: str) -> dict:
    """Send the timetable image to Claude API for extraction."""
    print("  🤖 Sending to Claude API for extraction...")

    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    # Determine media type
    ext = Path(image_path).suffix.lower()
    media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
    media_type = media_types.get(ext, "image/jpeg")

    client = anthropic.Anthropic(api_key=api_key)

    message = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=8000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": EXTRACTION_PROMPT,
                    },
                ],
            }
        ],
    )

    response_text = message.content[0].text.strip()

    # Clean up response if wrapped in markdown fences
    if response_text.startswith("```"):
        response_text = re.sub(r"^```(?:json)?\s*", "", response_text)
        response_text = re.sub(r"\s*```$", "", response_text)

    try:
        data = json.loads(response_text)
        print(f"  ✅ Extracted {len(data.get('rows', []))} rows for {data.get('mosque_name', 'unknown')}")
        return data
    except json.JSONDecodeError as e:
        print(f"  ❌ Failed to parse Claude's response as JSON: {e}")
        print(f"  Response was: {response_text[:500]}...")
        sys.exit(1)



def time_to_minutes(t: str, force_pm: bool = False) -> int | None:
    """Parse a time string like '3:05' or '12:27' to minutes since midnight.

    If force_pm is True, hours 1-11 are treated as PM (adds 12).
    Returns None if the string is empty or unparseable.
    """
    if not t or not t.strip():
        return None
    t = t.strip().lower().replace("am", "").replace("pm", "").strip()
    parts = t.split(":")
    if len(parts) != 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if force_pm and 1 <= h <= 11:
        h += 12
    return h * 60 + m


def _parse_zohar_jamaat_from_notes(notes: str) -> dict:
    """Parse Zohar/Dhuhr Jama'at times from free-text notes.

    Returns a dict like {"default": "12:40", "Fri": "12:30"}.
    Handles patterns like:
      - "Zuhr Jamaat: 12:40pm Mon-Thu, 12:30pm Fri"
      - "Daily Zuhr Jama'at: 1:00pm"
      - "Zuhr Jamaat: 12:40pm Mon-Thu/Sat-Sun, 12:30pm Fri (Jummah)"
    """
    if not notes:
        return {}

    result = {}
    # Look for Zuhr/Zohr/Dhuhr Jama'at/Jamaat patterns
    pattern = re.search(
        r"(?:zuhr|zohr|zohar|dhuhr)\s*(?:jama['\u2019]?a?t)\s*[:\-]\s*(.+?)(?:\.|$)",
        notes, re.IGNORECASE,
    )
    if not pattern:
        return {}

    text = pattern.group(1).strip()

    # Extract time + day-range pairs like "12:40pm Mon-Thu/Sat-Sun, 12:30pm Fri"
    day_abbrevs = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
    day_expand = {
        "mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu",
        "fri": "Fri", "sat": "Sat", "sun": "Sun",
    }

    # Split on comma to get segments
    segments = re.split(r",\s*", text)
    first_time = None

    for seg in segments:
        # Extract time from segment
        time_match = re.search(r"(\d{1,2}:\d{2})\s*(?:am|pm)?", seg, re.IGNORECASE)
        if not time_match:
            continue
        time_val = time_match.group(1)
        if first_time is None:
            first_time = time_val

        # Look for day names/ranges in this segment
        seg_lower = seg.lower()
        found_days = []

        # Handle ranges like "Mon-Thu" or compound "Mon-Thu/Sat-Sun"
        range_parts = re.findall(r"(mon|tue|wed|thu|fri|sat|sun)(?:\s*-\s*(mon|tue|wed|thu|fri|sat|sun))?", seg_lower)
        for start_day, end_day in range_parts:
            if end_day:
                # Expand range
                all_days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                si = all_days.index(start_day)
                ei = all_days.index(end_day)
                if si <= ei:
                    found_days.extend(all_days[si:ei + 1])
                else:
                    found_days.extend(all_days[si:] + all_days[:ei + 1])
            else:
                found_days.append(start_day)

        if found_days:
            for d in found_days:
                result[day_expand[d]] = time_val
        elif not result:
            # No day specified and this is the first segment — treat as default
            result["default"] = time_val

    # If we found day-specific times but no explicit default, use the first time
    if "default" not in result and first_time:
        result["default"] = first_time

    return result


def validate_and_fix_rows(rows: list[dict], notes: str) -> list[dict]:
    """Validate extracted prayer times and fix common misplacements.

    Applies these fixes in order:
    1. Zohar jamaat looks like Asr start — move columns right
    2. Esha exists but esha_jamaat empty — move esha to esha_jamaat
    3. Asr start > Asr jamaat — swap them
    4. Maghrib iftari > Maghrib jamaat — swap them
    5. Esha start > Esha jamaat — swap them
    6. Fill zohar_jamaat from notes if still empty
    7. Warn about remaining ordering violations
    """
    fix_counts = {"day_fix": 0, "fajr_start_swap": 0, "zawal_swap": 0, "zohar_shift": 0, "esha_move": 0, "asr_swap": 0, "maghrib_swap": 0, "esha_swap": 0, "zohar_notes": 0}

    valid_days = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
    day_fixes = {"Thur": "Thu", "Tues": "Tue", "Weds": "Wed"}

    for row in rows:
        # Fix day: standardise to exactly three letters
        day = row.get("day", "").strip()
        if day and day not in valid_days:
            fixed = day_fixes.get(day, day[:3])
            if fixed in valid_days:
                row["day"] = fixed
                fix_counts["day_fix"] += 1

        # Fix: Sehri Ends > Fajr Start — swap them
        sehri_mins = time_to_minutes(row.get("sehri_ends", ""), force_pm=False)
        fajr_start_mins = time_to_minutes(row.get("fajr_start", ""), force_pm=False)
        if sehri_mins and fajr_start_mins and sehri_mins > fajr_start_mins:
            row["sehri_ends"], row["fajr_start"] = row["fajr_start"], row["sehri_ends"]
            fix_counts["fajr_start_swap"] += 1

        # Fix 0: Zawal > Zohr — swap them (model confused the columns)
        zawal_mins = time_to_minutes(row.get("zawal", ""), force_pm=True)
        zohr_mins = time_to_minutes(row.get("zohr", ""), force_pm=True)
        if zawal_mins and zohr_mins and zawal_mins > zohr_mins:
            row["zawal"], row["zohr"] = row["zohr"], row["zawal"]
            fix_counts["zawal_swap"] += 1

        zohr_mins = time_to_minutes(row.get("zohr", ""), force_pm=True)
        zohar_j_mins = time_to_minutes(row.get("zohar_jamaat", ""), force_pm=True)
        asr_mins = time_to_minutes(row.get("asr", ""), force_pm=True)
        asr_j_mins = time_to_minutes(row.get("asr_jamaat", ""), force_pm=True)
        esha_mins = time_to_minutes(row.get("esha", ""), force_pm=False)
        esha_j_mins = time_to_minutes(row.get("esha_jamaat", ""), force_pm=False)

        # Fix 1: Zohar jamaat looks like Asr start (>90min after Dhuhr start)
        if zohr_mins and zohar_j_mins and (zohar_j_mins - zohr_mins) > 90:
            old_zohar_j = row.get("zohar_jamaat", "")
            old_asr = row.get("asr", "")
            old_asr_j = row.get("asr_jamaat", "")
            row["asr_jamaat"] = old_asr
            row["asr"] = old_zohar_j
            row["zohar_jamaat"] = ""
            fix_counts["zohar_shift"] += 1
            # Recompute after fix
            asr_mins = time_to_minutes(row.get("asr", ""), force_pm=True)
            asr_j_mins = time_to_minutes(row.get("asr_jamaat", ""), force_pm=True)

        # Fix 2: Esha exists but esha_jamaat empty — timetable had no start column
        if row.get("esha") and not row.get("esha_jamaat"):
            row["esha_jamaat"] = row["esha"]
            row["esha"] = ""
            fix_counts["esha_move"] += 1
            esha_mins = None
            esha_j_mins = time_to_minutes(row.get("esha_jamaat", ""), force_pm=False)

        # Fix 3: Asr start > Asr jamaat — swap them
        if asr_mins and asr_j_mins and asr_mins > asr_j_mins:
            row["asr"], row["asr_jamaat"] = row["asr_jamaat"], row["asr"]
            fix_counts["asr_swap"] += 1

        # Fix 4: Maghrib iftari > Maghrib jamaat — swap them
        maghrib_mins = time_to_minutes(row.get("maghrib_iftari", ""), force_pm=False)
        maghrib_j_mins = time_to_minutes(row.get("maghrib_jamaat", ""), force_pm=False)
        if maghrib_mins and maghrib_j_mins and maghrib_mins > maghrib_j_mins:
            row["maghrib_iftari"], row["maghrib_jamaat"] = row["maghrib_jamaat"], row["maghrib_iftari"]
            fix_counts["maghrib_swap"] += 1

        # Fix 5: Esha start > Esha jamaat — swap them
        if esha_mins and esha_j_mins and esha_mins > esha_j_mins:
            row["esha"], row["esha_jamaat"] = row["esha_jamaat"], row["esha"]
            fix_counts["esha_swap"] += 1

    # Fix 6: Fill zohar_jamaat from notes if still empty
    zohar_from_notes = _parse_zohar_jamaat_from_notes(notes)
    if zohar_from_notes:
        for row in rows:
            if not row.get("zohar_jamaat"):
                day = row.get("day", "")
                time_val = zohar_from_notes.get(day, zohar_from_notes.get("default", ""))
                if time_val:
                    row["zohar_jamaat"] = time_val
                    fix_counts["zohar_notes"] += 1

    # Report fixes applied
    applied = {k: v for k, v in fix_counts.items() if v > 0}
    if applied:
        print(f"  🔧 Validation fixes applied: {applied}")
    else:
        print("  ✅ Validation passed — no fixes needed")

    # Fix 7: Warn about remaining cross-prayer ordering violations
    for i, row in enumerate(rows):
        sehri_mins = time_to_minutes(row.get("sehri_ends", ""), force_pm=False)
        fajr_start_mins = time_to_minutes(row.get("fajr_start", ""), force_pm=False)
        fajr_j_mins = time_to_minutes(row.get("fajr_jamaat", ""), force_pm=False)
        sunrise_mins = time_to_minutes(row.get("sunrise", ""), force_pm=False)
        zawal_mins = time_to_minutes(row.get("zawal", ""), force_pm=True)
        zohr_mins = time_to_minutes(row.get("zohr", ""), force_pm=True)
        asr_mins = time_to_minutes(row.get("asr", ""), force_pm=True)
        maghrib_mins = time_to_minutes(row.get("maghrib_iftari", ""), force_pm=True)

        if fajr_start_mins and sehri_mins and fajr_start_mins <= sehri_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Fajr Start ({row.get('fajr_start')}) <= Sehri Ends ({row.get('sehri_ends')})")
        if fajr_start_mins and sunrise_mins and fajr_start_mins >= sunrise_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Fajr Start ({row.get('fajr_start')}) >= Sunrise ({row.get('sunrise')})")
        if fajr_start_mins and fajr_j_mins and fajr_start_mins >= fajr_j_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Fajr Start ({row.get('fajr_start')}) >= Fajr Jama'at ({row.get('fajr_jamaat')})")
        if zawal_mins and sunrise_mins and zawal_mins <= sunrise_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Zawal ({row.get('zawal')}) <= Sunrise ({row.get('sunrise')})")
        if zawal_mins and zohr_mins and zawal_mins >= zohr_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Zawal ({row.get('zawal')}) >= Zohr ({row.get('zohr')})")
        if zohr_mins and asr_mins and zohr_mins >= asr_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Zohr ({row.get('zohr')}) >= Asr ({row.get('asr')})")
        if asr_mins and maghrib_mins and asr_mins >= maghrib_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Asr ({row.get('asr')}) >= Maghrib ({row.get('maghrib_iftari')})")

    return rows


def _assign_islamic_months(rows: list[dict]) -> list[str]:
    """Assign month abbreviations (Sha/Ram/Shaw) to rows based on islamic_day sequence.

    Detects month boundaries from day number resets.
    """
    days = []
    for row in rows:
        val = row.get("islamic_day") or row.get("ramadan_day") or ""
        days.append(int(val) if str(val).strip() else 0)

    n = len(days)
    resets = [i for i in range(1, n) if days[i] < days[i - 1]]

    if len(resets) == 0:
        return ["Shaw" if d > 30 else "Ram" for d in days]

    if len(resets) == 1:
        reset = resets[0]
        if days[0] == 1:
            return ["Ram" if i < reset else "Shaw" for i in range(n)]
        elif days[-1] >= 28:
            return ["Sha" if i < reset else "Ram" for i in range(n)]
        else:
            return ["Ram" if i < reset else "Shaw" for i in range(n)]

    r1, r2 = resets[0], resets[1]
    return ["Sha" if i < r1 else "Ram" if i < r2 else "Shaw" for i in range(n)]


def save_csv(data: dict, output_path: str, notes: str = ""):
    """Save extracted data as a CSV file."""
    rows = data["rows"]
    rows = validate_and_fix_rows(rows, notes)

    months = _assign_islamic_months(rows)

    fieldnames = [
        "Date", "Day", "Islamic Day", "Sehri Ends", "Fajr Start", "Sunrise",
        "Zawal", "Zohr", "Asr", "Esha",
        "Fajr Jama'at", "Zohar Jama'at", "Asr Jama'at",
        "Maghrib Iftari", "Maghrib Jama'at", "Esha Jama'at",
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for i, row in enumerate(rows):
            day_val = row.get("islamic_day") or row.get("ramadan_day") or ""
            if str(day_val).strip():
                day_num = int(day_val)
                if months[i] == "Shaw" and day_num > 30:
                    day_num -= 30
                islamic_day_str = f"{day_num} {months[i]}"
            else:
                islamic_day_str = ""
            writer.writerow({
                "Date": row.get("date", ""),
                "Day": row.get("day", ""),
                "Islamic Day": islamic_day_str,
                "Sehri Ends": row.get("sehri_ends", ""),
                "Fajr Start": row.get("fajr_start", ""),
                "Sunrise": row.get("sunrise", ""),
                "Zawal": row.get("zawal", ""),
                "Zohr": row.get("zohr", ""),
                "Asr": row.get("asr", ""),
                "Esha": row.get("esha", ""),
                "Fajr Jama'at": row.get("fajr_jamaat", ""),
                "Zohar Jama'at": row.get("zohar_jamaat", ""),
                "Asr Jama'at": row.get("asr_jamaat", ""),
                "Maghrib Iftari": row.get("maghrib_iftari", ""),
                "Maghrib Jama'at": row.get("maghrib_jamaat", ""),
                "Esha Jama'at": row.get("esha_jamaat", ""),
            })

    print(f"  ✅ CSV saved: {output_path}")


def geocode_address(address: str) -> tuple:
    """Geocode an address to (lat, lon) using OpenStreetMap Nominatim.

    Returns (None, None) on failure so it never blocks mosque creation.
    """
    try:
        query = urllib.parse.quote(address)
        url = f"https://nominatim.openstreetmap.org/search?q={query}&format=json&limit=1"
        req = urllib.request.Request(url, headers={"User-Agent": "Prayerly/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read().decode())
        if results:
            lat = float(results[0]["lat"])
            lon = float(results[0]["lon"])
            print(f"  📍 Geocoded: {lat}, {lon}")
            return lat, lon
        print("  ⚠️  Could not geocode address (no results)")
        return None, None
    except Exception as e:
        print(f"  ⚠️  Could not geocode address: {e}")
        return None, None


def save_mosque_config(mosque_name: str, slug: str, csv_filename: str, data: dict, config_dir: str):
    """Save a JSON config file for this mosque so generate.py can pick it up."""
    config = {
        "display_name": mosque_name,
        "slug": slug,
        "csv": csv_filename,
        "address": data.get("address", ""),
        "phone": data.get("phone", ""),
        "month": data.get("month", ""),
        "islamic_month": data.get("islamic_month", ""),
        "jummah_times": data.get("jummah_times", ""),
        "eid_salah": data.get("eid_salah", ""),
        "sadaqatul_fitr": data.get("sadaqatul_fitr", ""),
        "radio_frequency": data.get("radio_frequency", ""),
        "is_stale": data.get("is_stale", False),
        "notes": data.get("notes", ""),
    }

    # Geocode address to lat/lon
    if config["address"]:
        lat, lon = geocode_address(config["address"])
        if lat is not None:
            config["lat"] = lat
            config["lon"] = lon

    config_path = os.path.join(config_dir, f"{slug}.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"  \u2705 Config saved: {config_path}")

    # Regenerate index.json
    _regenerate_index(config_dir)


def _regenerate_index(config_dir: str):
    """Regenerate data/mosques/index.json from the config files on disk.

    Embeds full config objects so the landing page needs only one fetch.
    """
    configs = []
    for p in sorted(Path(config_dir).glob("*.json"), key=lambda p: p.stem):
        if p.name == "index.json":
            continue
        with open(p, encoding="utf-8") as f:
            configs.append(json.load(f))
    index_path = os.path.join(config_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(configs, f)
    print(f"  \u2705 Index updated: {index_path} ({len(configs)} mosques)")


def slugify(name: str) -> str:
    """Convert a mosque name to a URL-friendly slug."""
    s = name.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_-]+", "_", s)
    s = s.strip("_")
    return s


def deduplicate_slug(slug: str, address: str, config_dir: str) -> str:
    """Ensure the slug is unique among existing mosque configs.

    If slug already exists, tries appending area names from the address,
    then falls back to numeric suffixes.
    """
    existing_slugs = {
        p.stem for p in Path(config_dir).glob("*.json")
        if p.name != "index.json"
    }

    if slug not in existing_slugs:
        return slug

    # Try address parts (skip first part which is usually street number/name)
    if address:
        parts = [p.strip().lower() for p in address.split(",")]
        for part in parts[1:]:
            area = re.sub(r"[^\w]", "", part.strip().split()[0]) if part.strip() else ""
            if area:
                candidate = f"{slug}_{area}"
                if candidate not in existing_slugs:
                    return candidate

    # Fall back to numeric suffix
    i = 2
    while f"{slug}_{i}" in existing_slugs:
        i += 1
    return f"{slug}_{i}"


def _parse_month_range(month_str: str) -> list[datetime.date]:
    """Parse a month string like 'February-March 2026' or 'June 2025' into a list of (year, month) pairs.

    Returns a list of datetime.date objects (first of each month) covered by the string.
    """
    if not month_str:
        return []

    month_names = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }

    # Extract year
    year_match = re.search(r"(\d{4})", month_str)
    if not year_match:
        return []
    year = int(year_match.group(1))

    # Extract month names
    found_months = []
    for name, num in month_names.items():
        if name in month_str.lower():
            found_months.append(num)

    if not found_months:
        return []

    found_months.sort()
    # If it spans e.g. December-January, the second month is in the next year
    result = []
    for i, m in enumerate(found_months):
        y = year
        if i > 0 and m < found_months[0]:
            y = year + 1
        result.append(datetime.date(y, m, 1))

    return result


def check_timetable_currency(data: dict) -> None:
    """Check whether the timetable covers the current month.

    If stale, prints a warning and sets data["is_stale"] = True.
    Does NOT abort extraction.
    """
    today = datetime.date.today()
    current_ym = (today.year, today.month)

    # Method 1: Parse from data["month"] field
    month_str = data.get("month", "")
    covered_months = _parse_month_range(month_str)
    covered_ym = {(d.year, d.month) for d in covered_months}

    # Method 2: Parse from first/last row dates
    rows = data.get("rows", [])
    if rows:
        for date_str in [rows[0].get("date", ""), rows[-1].get("date", "")]:
            parsed = _parse_row_date(date_str, data.get("month", ""))
            if parsed:
                covered_ym.add((parsed.year, parsed.month))

    if not covered_ym:
        print("  \u26a0\ufe0f  Could not determine timetable date range — skipping currency check")
        return

    if current_ym in covered_ym:
        print(f"  \u2705 Timetable covers current month ({today.strftime('%B %Y')})")
        data["is_stale"] = False
    else:
        covered_str = ", ".join(
            datetime.date(y, m, 1).strftime("%B %Y") for y, m in sorted(covered_ym)
        )
        print(f"  \u26a0\ufe0f  STALE TIMETABLE: covers {covered_str}, but current month is {today.strftime('%B %Y')}")
        data["is_stale"] = True


def _parse_row_date(date_str: str, month_hint: str = "") -> datetime.date | None:
    """Parse a row date like '18 Feb' or '1 Mar' into a datetime.date.

    Uses month_hint (e.g. 'February-March 2026') for the year.
    """
    if not date_str:
        return None

    month_abbrevs = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "may": 5, "jun": 6, "jul": 7, "aug": 8,
        "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }

    match = re.match(r"(\d{1,2})\s+(\w{3})", date_str.strip())
    if not match:
        return None

    day = int(match.group(1))
    month_str = match.group(2).lower()
    month = month_abbrevs.get(month_str)
    if not month:
        return None

    # Get year from month_hint
    year_match = re.search(r"(\d{4})", month_hint)
    year = int(year_match.group(1)) if year_match else datetime.date.today().year

    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def update_mosque_config(slug: str, data: dict, config_dir: str):
    """Update an existing mosque config with new metadata from extraction.

    Preserves slug, display_name, and csv. Updates metadata fields
    (address, phone, month, etc.) only when the new value is non-empty,
    except is_stale which is always updated.
    """
    config_path = os.path.join(config_dir, f"{slug}.json")
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    # Metadata fields that can be updated
    updatable = [
        "address", "phone", "month", "islamic_month",
        "jummah_times", "eid_salah", "sadaqatul_fitr",
        "radio_frequency", "notes",
    ]
    for field in updatable:
        new_val = data.get(field, "")
        if new_val:  # Only overwrite if new value is non-empty
            config[field] = new_val

    # Always update is_stale (False is meaningful)
    config["is_stale"] = data.get("is_stale", False)

    # Geocode if address changed or lat/lon are missing
    address = config.get("address", "")
    if address:
        old_address = ""
        with open(config_path, encoding="utf-8") as f:
            old_address = json.load(f).get("address", "")
        address_changed = address != old_address
        missing_coords = "lat" not in config or "lon" not in config
        if address_changed or missing_coords:
            lat, lon = geocode_address(address)
            if lat is not None:
                config["lat"] = lat
                config["lon"] = lon

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"  \u2705 Config updated: {config_path}")


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Extract prayer timetables from images using Claude's vision API.",
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)

    # Add mode
    add_parser = subparsers.add_parser("add", help="Add a new masjid from a timetable image")
    add_parser.add_argument("--image", required=True, help="Path to timetable image (JPG/PNG)")
    add_parser.add_argument("--name", help="Override masjid name (optional)")

    # Update mode
    update_parser = subparsers.add_parser("update", help="Update an existing masjid's timetable")
    update_parser.add_argument("--slug", required=True, help="Slug of the masjid to update")
    update_parser.add_argument("--image", required=True, help="Path to timetable image (JPG/PNG)")

    # eSalaat mode (legacy)
    esalaat_parser = subparsers.add_parser("esalaat", help="Add a new masjid from eSalaat")
    esalaat_parser.add_argument("--code", required=True, help="eSalaat timetable code (e.g. 1003)")
    esalaat_parser.add_argument("--name", help="Override masjid name (optional)")

    # Reindex mode
    subparsers.add_parser("reindex", help="Regenerate data/mosques/index.json")

    return parser.parse_args()


def _load_env():
    """Load .env file from project root if it exists."""
    script_dir = Path(__file__).resolve().parent
    env_file = script_dir / ".env"
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def _get_dirs():
    """Return (script_dir, data_dir, config_dir) paths."""
    script_dir = Path(__file__).resolve().parent
    data_dir = script_dir / "data"
    config_dir = data_dir / "mosques"
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)
    return script_dir, data_dir, config_dir


def _extract_and_save(image_path, api_key, slug, data_dir, notes_override=None):
    """Common extraction + save logic. Returns (data, slug, notes)."""
    data = extract_with_claude(image_path, api_key)
    notes = notes_override or data.get("notes", "")

    check_timetable_currency(data)
    print()

    # Save raw API response
    raw_json_path = os.path.join(data_dir, f"{slug}_raw.json")
    with open(raw_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Raw JSON saved: {raw_json_path}")

    # Save CSV
    csv_filename = f"{slug}.csv"
    csv_path = os.path.join(data_dir, csv_filename)
    save_csv(data, csv_path, notes=notes)

    return data, csv_filename, notes


def main_add(args, api_key, data_dir, config_dir):
    """Add a new masjid from a timetable image."""
    image_path = args.image
    if not os.path.exists(image_path):
        print(f"\u274c Image not found: {image_path}")
        sys.exit(1)

    print(f"\U0001f319 Adding new masjid from image: {image_path}")
    print()

    data = extract_with_claude(image_path, api_key)

    mosque_name = args.name or data.get("mosque_name", "Unknown Masjid")
    raw_slug = data.get("suggested_slug") or slugify(mosque_name)
    slug = deduplicate_slug(raw_slug, data.get("address", ""), str(config_dir))
    notes = data.get("notes", "")

    print(f"  Masjid: {mosque_name}")
    print(f"  Slug: {slug}")
    print(f"  Notes: {notes}")
    print()

    check_timetable_currency(data)
    print()

    # Save raw API response
    raw_json_path = os.path.join(data_dir, f"{slug}_raw.json")
    with open(raw_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Raw JSON saved: {raw_json_path}")

    # Save CSV
    csv_filename = f"{slug}.csv"
    csv_path = os.path.join(data_dir, csv_filename)
    save_csv(data, csv_path, notes=notes)

    # Save mosque config (includes index regeneration)
    save_mosque_config(mosque_name, slug, csv_filename, data, str(config_dir))

    print()
    print(f"Done! {mosque_name} is ready.")
    print(f"   CSV: data/{csv_filename}")
    print(f"   Config: data/mosques/{slug}.json")
    if data.get("is_stale"):
        print(f"   \u26a0\ufe0f  WARNING: This timetable appears to be stale (does not cover the current month)")
    print(f"   The daily workflow will now generate lockscreens for this masjid too.")


def main_update(args, api_key, data_dir, config_dir):
    """Update an existing masjid's timetable from a new image."""
    slug = args.slug
    image_path = args.image

    config_path = os.path.join(config_dir, f"{slug}.json")
    if not os.path.exists(config_path):
        print(f"\u274c No config found for slug '{slug}' at {config_path}")
        print(f"   Available masjids: {', '.join(p.stem for p in Path(config_dir).glob('*.json') if p.name != 'index.json')}")
        sys.exit(1)

    if not os.path.exists(image_path):
        print(f"\u274c Image not found: {image_path}")
        sys.exit(1)

    with open(config_path, encoding="utf-8") as f:
        existing_config = json.load(f)
    mosque_name = existing_config["display_name"]

    print(f"\U0001f319 Updating timetable for: {mosque_name} ({slug})")
    print()

    data = extract_with_claude(image_path, api_key)
    notes = data.get("notes", "")

    print(f"  Extracted {len(data.get('rows', []))} rows")
    print()

    check_timetable_currency(data)
    print()

    # Save raw API response
    raw_json_path = os.path.join(data_dir, f"{slug}_raw.json")
    with open(raw_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Raw JSON saved: {raw_json_path}")

    # Save CSV (overwrite)
    csv_filename = f"{slug}.csv"
    csv_path = os.path.join(data_dir, csv_filename)
    save_csv(data, csv_path, notes=notes)

    # Update config (preserves slug/display_name/csv)
    update_mosque_config(slug, data, str(config_dir))

    print()
    print(f"Done! {mosque_name} timetable updated.")
    print(f"   CSV: data/{csv_filename}")
    if data.get("is_stale"):
        print(f"   \u26a0\ufe0f  WARNING: This timetable appears to be stale (does not cover the current month)")


def main_esalaat(args, api_key, data_dir, config_dir):
    """Add a new masjid from eSalaat (legacy flow)."""
    code = args.code
    name_override = args.name
    tmp_image = os.path.join(tempfile.gettempdir(), f"timetable_{code}.jpg")

    print(f"\U0001f319 Extracting timetable for eSalaat code: {code}")
    print()

    # Download the timetable image
    if not download_timetable(code, tmp_image):
        sys.exit(1)

    # Extract with Claude
    data = extract_with_claude(tmp_image, api_key)

    mosque_name = name_override or data.get("mosque_name", f"Mosque {code}")
    raw_slug = data.get("suggested_slug") or slugify(mosque_name)
    slug = deduplicate_slug(raw_slug, data.get("address", ""), str(config_dir))
    notes = data.get("notes", "")

    print(f"  Masjid: {mosque_name}")
    print(f"  Slug: {slug}")
    print(f"  Notes: {notes}")
    print()

    check_timetable_currency(data)
    print()

    # Save raw API response
    raw_json_path = os.path.join(data_dir, f"{slug}_raw.json")
    with open(raw_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Raw JSON saved: {raw_json_path}")

    # Save CSV
    csv_filename = f"{slug}.csv"
    csv_path = os.path.join(data_dir, csv_filename)
    save_csv(data, csv_path, notes=notes)

    # Save mosque config (includes index regeneration)
    save_mosque_config(mosque_name, slug, csv_filename, data, str(config_dir))

    print()
    print(f"Done! {mosque_name} is ready.")
    print(f"   CSV: data/{csv_filename}")
    print(f"   Config: data/mosques/{slug}.json")
    if data.get("is_stale"):
        print(f"   \u26a0\ufe0f  WARNING: This timetable appears to be stale (does not cover the current month)")
    print(f"   The daily workflow will now generate lockscreens for this masjid too.")


def main():
    args = parse_args()

    _, data_dir, config_dir = _get_dirs()

    if args.mode == "reindex":
        _regenerate_index(str(config_dir))
        return

    _load_env()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\u274c ANTHROPIC_API_KEY not set. Add it to .env or set the environment variable.")
        sys.exit(1)

    if args.mode == "add":
        main_add(args, api_key, str(data_dir), str(config_dir))
    elif args.mode == "update":
        main_update(args, api_key, str(data_dir), str(config_dir))
    elif args.mode == "esalaat":
        main_esalaat(args, api_key, str(data_dir), str(config_dir))


if __name__ == "__main__":
    main()
