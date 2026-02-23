#!/usr/bin/env python3
"""
eSalaat Timetable Extractor
Downloads a mosque timetable image from esalaat.com and uses
Claude's vision API to extract prayer times into a CSV file.
"""

import anthropic
import base64
import csv
import json
import os
import re
import sys
import urllib.request
from pathlib import Path


ESALAAT_TIMETABLE_URL = "https://esalaat.com/timetables/{code}.jpg"

EXTRACTION_PROMPT = """You are extracting Ramadan prayer times from a mosque timetable image.

Look at this timetable image carefully and extract ALL rows of data into a JSON array.

CRITICAL RULES:
1. Resolve ALL ditto marks (" or '') to the actual value from the row above. Every cell must have an explicit time value — never output " marks.
2. If the Fajr Jama'at column says something like "FIFTEEN MINUTES AFTER SEHRI ENDS" or similar (written vertically or as a note), then leave Fajr Jama'at as "SEHRI+15" for every row — I will calculate it later.
3. If a Zohar/Dhuhr Jama'at column says "NO SALAH" or similar, set it to the value noted elsewhere (often "1:00" for daily Zuhr jama'at) or "1:00" if unclear.
4. Use 24-hour times if the timetable does, otherwise keep the format as shown.
5. Include the year 2026 context: Ramadan starts 18 Feb 2026.

Extract into this exact JSON structure:
{
  "mosque_name": "the mosque name from the image",
  "notes": "any relevant notes (e.g. 'Fajr Jama'at is 15 mins after Sehri ends', 'Daily Zuhr Jama'at: 1:00pm')",
  "rows": [
    {
      "date": "18 Feb",
      "day": "Wed",
      "ramadan_day": 1,
      "sehri_ends": "5:24",
      "sunrise": "7:18",
      "zohr": "12:28",
      "asr": "3:35",
      "esha": "7:01",
      "fajr_jamaat": "SEHRI+15",
      "zohar_jamaat": "1:00",
      "asr_jamaat": "4:30",
      "maghrib_iftari": "5:30",
      "esha_jamaat": "7:30"
    }
  ]
}

IMPORTANT:
- "zohr" = Dhuhr/Zuhr START time (beginning of prayer, not jama'at)
- "asr" = Asr START time
- "esha" = Esha/Isha START time
- "maghrib_iftari" = Maghrib/Iftar time
- "zohar_jamaat" = Dhuhr/Zuhr JAMA'AT time
- "asr_jamaat" = Asr JAMA'AT time
- "esha_jamaat" = Esha/Isha JAMA'AT time
- Some timetables may label columns differently — map them to the fields above as best you can.
- Some timetables may not have separate start and jama'at columns for every prayer. Map what's available.
- If a column is genuinely missing (not just labelled differently), omit that field.

Return ONLY valid JSON, no markdown fences, no explanation."""


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
        model="claude-sonnet-4-5-20250929",
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


def resolve_sehri_plus(rows: list[dict], minutes: int = 15) -> list[dict]:
    """Replace 'SEHRI+15' with actual calculated times."""
    for row in rows:
        if row.get("fajr_jamaat", "").startswith("SEHRI+"):
            sehri = row["sehri_ends"]
            # Parse time like "5:24" or "4:30"
            parts = sehri.split(":")
            h, m = int(parts[0]), int(parts[1])
            m += minutes
            if m >= 60:
                h += 1
                m -= 60
            row["fajr_jamaat"] = f"{h}:{m:02d}"
    return rows


def save_csv(data: dict, output_path: str):
    """Save extracted data as a CSV file."""
    rows = data["rows"]
    rows = resolve_sehri_plus(rows)

    fieldnames = [
        "Date", "Day", "Ramadan", "Sehri Ends", "Sunrise",
        "Zohr", "Asr", "Esha",
        "Fajr Jama'at", "Zohar Jama'at", "Asr Jama'at",
        "Maghrib Iftari", "Esha Jama'at",
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({
                "Date": row.get("date", ""),
                "Day": row.get("day", ""),
                "Ramadan": row.get("ramadan_day", ""),
                "Sehri Ends": row.get("sehri_ends", ""),
                "Sunrise": row.get("sunrise", ""),
                "Zohr": row.get("zohr", ""),
                "Asr": row.get("asr", ""),
                "Esha": row.get("esha", ""),
                "Fajr Jama'at": row.get("fajr_jamaat", ""),
                "Zohar Jama'at": row.get("zohar_jamaat", ""),
                "Asr Jama'at": row.get("asr_jamaat", ""),
                "Maghrib Iftari": row.get("maghrib_iftari", ""),
                "Esha Jama'at": row.get("esha_jamaat", ""),
            })

    print(f"  ✅ CSV saved: {output_path}")


def save_mosque_config(mosque_name: str, slug: str, csv_filename: str, notes: str, config_dir: str):
    """Save a JSON config file for this mosque so generate.py can pick it up."""
    config = {
        "display_name": mosque_name,
        "slug": slug,
        "csv": csv_filename,
        "notes": notes,
    }
    config_path = os.path.join(config_dir, f"{slug}.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"  ✅ Config saved: {config_path}")


def slugify(name: str) -> str:
    """Convert a mosque name to a URL-friendly slug."""
    s = name.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_-]+", "_", s)
    s = s.strip("_")
    return s


def main():
    """
    Usage:
        python extract_timetable.py <esalaat_code> [mosque_name_override]

    Examples:
        python extract_timetable.py 1003
        python extract_timetable.py 1003 "Masjid Aisha"
    """
    if len(sys.argv) < 2:
        print("Usage: python extract_timetable.py <esalaat_code> [mosque_name_override]")
        print("Example: python extract_timetable.py 1003")
        sys.exit(1)

    code = sys.argv[1]
    name_override = sys.argv[2] if len(sys.argv) > 2 else None

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("❌ ANTHROPIC_API_KEY environment variable not set.")
        sys.exit(1)

    script_dir = Path(__file__).resolve().parent
    data_dir = script_dir / "data"
    config_dir = data_dir / "mosques"
    tmp_image = f"/tmp/timetable_{code}.jpg"

    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)

    print(f"🌙 Extracting timetable for eSalaat code: {code}")
    print()

    # Step 1: Download the timetable image
    if not download_timetable(code, tmp_image):
        sys.exit(1)

    # Step 2: Extract with Claude
    data = extract_with_claude(tmp_image, api_key)

    mosque_name = name_override or data.get("mosque_name", f"Mosque {code}")
    slug = slugify(mosque_name)
    notes = data.get("notes", "")

    print(f"  📛 Mosque: {mosque_name}")
    print(f"  🔖 Slug: {slug}")
    print(f"  📝 Notes: {notes}")
    print()

    # Step 3: Save CSV
    csv_filename = f"{slug}_ramadan_2026.csv"
    csv_path = os.path.join(data_dir, csv_filename)
    save_csv(data, csv_path)

    # Step 4: Save mosque config
    save_mosque_config(mosque_name, slug, csv_filename, notes, str(config_dir))

    print()
    print(f"🎉 Done! {mosque_name} is ready.")
    print(f"   CSV: data/{csv_filename}")
    print(f"   Config: data/mosques/{slug}.json")
    print(f"   The daily workflow will now generate lockscreens for this mosque too.")


if __name__ == "__main__":
    main()
