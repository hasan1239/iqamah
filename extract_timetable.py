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
import urllib.request
from pathlib import Path


ESALAAT_TIMETABLE_URL = "https://esalaat.com/timetables/{code}.jpg"

EXTRACTION_PROMPT = (
    "You are extracting prayer times from a mosque timetable image "
    "into a standardised JSON format. Your goal is 100% accuracy \u2014 every "
    "time value must exactly match what is printed on the timetable.\n\n"
    "This prompt works for ANY mosque timetable \u2014 any month, any "
    "location, any format.\n\n"
    "STEP 1: SURVEY THE ENTIRE IMAGE\n"
    "Before extracting any data, scan the FULL image including:\n"
    "- The main table with rows and columns\n"
    "- Column headers (which may be in Arabic, English, or both)\n"
    "- Vertical/rotated text running alongside columns (commonly used for "
    "Fajr Jama'at rules, Zuhr Jama'at times, and Maghrib Jama'at rules)\n"
    "- Footnotes, bottom text, and side notes (these frequently contain "
    "fixed jama'at times, Jumu'ah times, Eid salah times, Sadaqatul Fitr "
    "amounts, and radio frequencies)\n"
    "- The mosque name, address, and contact details (usually at the top "
    "or bottom)\n"
    "- The month, year, and Islamic month/year (e.g. \"Ramadan 1447 AH\", "
    "\"June 2025\", \"Dhul Hijjah 1446\")\n\n"
    "STEP 2: IDENTIFY COLUMN MAPPING\n"
    "Timetables vary widely in column names. Map each column you see to "
    "the correct output field:\n\n"
    "  Sehri Ends / End of Suhoor / Suhur End / End of Sehri / Sehri / "
    "Fajr Begins / Fajr Start / Subha Sadiq \u2192 \"sehri_ends\"\n"
    "  Sunrise / Sun-Rise \u2192 \"sunrise\"\n"
    "  Zohr / Zuhr / Dhuhr Start / Dhuhr Begins / Zuhr Start / "
    "Zuhr Begins \u2192 \"zohr\"\n"
    "  Asr Start / Asr Begins \u2192 \"asr\"\n"
    "  Esha / Isha Start / Isha Begins \u2192 \"esha\"\n"
    "  Fajr Jama'at / Fajr Jamaat / Fajar Jamaat \u2192 \"fajr_jamaat\"\n"
    "  Zohar Jama'at / Zuhr Jama'at / Dhuhr Jama'at / Dhuhr Jamaat / "
    "Zuhr Jamaat / Zohr & Juma \u2192 \"zohar_jamaat\"\n"
    "  Asr Jama'at / Asr Jamaat \u2192 \"asr_jamaat\"\n"
    "  Maghrib / Iftaar / Iftar / Maghrib Azan / Iftaar Maghrib / "
    "Maghrib Azan & Iftari \u2192 \"maghrib_iftari\"\n"
    "  Esha Jama'at / Isha Jama'at / Isha Jamaat / "
    "Taraweeh Jamaat \u2192 \"esha_jamaat\"\n\n"
    "IMPORTANT COLUMN DISAMBIGUATION:\n\n"
    "Sunset vs Maghrib/Iftar: Some timetables have BOTH a \"Sunset\" "
    "column AND a separate \"Maghrib\" or \"Iftar\" column. These are "
    "different values \u2014 Sunset is the astronomical event, while "
    "Maghrib/Iftar is a few minutes later when the prayer begins and the "
    "fast is broken. If both columns exist, ALWAYS use the Maghrib/Iftar "
    "column for \"maghrib_iftari\", NOT the Sunset column. If only one of "
    "these columns exists, use whichever is available.\n\n"
    "Sehri Ends vs Fajr Start: Some timetables have both \"End of "
    "Suhoor\" and \"Fajr Start\" as separate columns. Others only have "
    "one (treating them as the same). Use whichever column represents the "
    "earliest pre-dawn time \u2014 typically \"End of Suhoor/Sehri Ends\" if "
    "both exist. If only \"Fajr Start\" exists, use that.\n\n"
    "Zawal/Zenith vs Zohr/Zuhr: Some timetables have BOTH a \"Zawal\" / "
    "\"Zenith\" / \"After Zenith\" column AND a separate \"Zohr\" / \"Zuhr\" "
    "/ \"Dhuhr Start\" column. These are different \u2014 Zawal is when the sun "
    "passes its zenith (and prayer is NOT permitted), while Zohr/Zuhr is "
    "when the Dhuhr prayer window begins (a few minutes later). If both "
    "columns exist, ALWAYS use the Zohr/Zuhr/Dhuhr column for \"zohr\", "
    "NOT the Zawal/Zenith column. If only one exists, use whichever is "
    "available.\n\n"
    "NOTE ON PRE-MONTH ROWS:\n"
    "Some timetables include rows before the main month begins (e.g. a "
    "Ramadan timetable starting from the day before Ramadan). Include ALL "
    "rows shown in the timetable \u2014 do not skip or renumber them.\n\n"
    "STEP 3: HANDLE SPECIAL PATTERNS\n\n"
    "DITTO MARKS \u2014 CRITICAL:\n"
    "Many timetables use ditto marks to mean \"same as the row above\". "
    "These appear as:\n"
    "  \"  (double quote)\n"
    "  ''  (two single quotes)\n"
    "  \"\"  (two double quotes)\n"
    "  \u00ab  (guillemet)\n"
    "  \u2033  (double prime)\n"
    "  Empty/blank cells that clearly should have a value\n"
    "You MUST resolve ALL of these to the actual repeated value. Walk down "
    "each column: if a cell has a ditto mark, copy the value from the "
    "nearest non-ditto row above it. NEVER output a ditto mark \u2014 every "
    "cell must have an explicit time value or be genuinely empty.\n\n"
    "VERTICAL/ROTATED TEXT:\n"
    "Some columns have a rule written vertically instead of individual "
    "values per row. Common examples:\n"
    "  - \"FIFTEEN MINUTES AFTER SEHRI ENDS\" / \"Fajr will be 15 minutes "
    "after suhur end\" / \"TEN MINUTES AFTER SEHRI ENDS\" / \"15 minutes "
    "after Fajr start\" \u2192 for fajr_jamaat, calculate the actual time for "
    "each row by adding the stated minutes to the value the rule "
    "references. Pay close attention to what the rule says: if it says "
    "\"after Sehri ends\" add to the sehri_ends value; if it says \"after "
    "Fajr start\" or \"after Fajr beginning time\" add to the Fajr Start "
    "column (even if that is a different column from sehri_ends). Output "
    "the calculated time, not a formula (e.g. Sehri 5:42 + 15 mins \u2192 "
    "fajr_jamaat \"5:57\"). HOWEVER: if the Fajr Jama'at column also "
    "contains explicit per-row time values, ALWAYS use the explicit values "
    "from the table \u2014 they take priority over any rule or note. The rule "
    "may be approximate guidance while the table values are the mosque's "
    "actual scheduled times.\n"
    "  - \"Zuhar Jamat 1:00\" / \"Jumu'ah Jamat 1:00\" \u2192 set zohar_jamaat "
    "to \"1:00\" for all rows (or apply Jumu'ah-specific time on Fridays "
    "if different). ALSO extract any Jumu'ah time mentioned here into the "
    "\"jummah_times\" metadata field \u2014 do not just put it in \"notes\".\n"
    "  - \"Maghrib Jama'at, 10 minutes after Azan\" / \"5 minutes after "
    "Iftar\" / \"straight after breaking fast\" \u2192 there is no "
    "maghrib_jamaat field in the output. Note the rule in the \"notes\" "
    "field instead.\n\n"
    "HEADER NOTES AND ANNOUNCEMENTS:\n"
    "Some timetables show key information in large text ABOVE the table "
    "(not in footnotes). For example:\n"
    "  - \"ZOHR 1:00PM & JUMUAH @ 1:15PM\" \u2192 extract into jummah_times "
    "metadata (e.g. \"1:15pm\") AND apply: zohar_jamaat = \"1:00\" on "
    "non-Fridays, \"1:15\" on Fridays.\n"
    "  - \"Fajr Jamaat will be 15 mins after Sehri Ends\" \u2192 apply the "
    "rule (but explicit table values take priority if present).\n"
    "  Treat these header notes the same as footnotes \u2014 extract relevant "
    "data into the correct metadata fields.\n\n"
    "FOOTNOTES AND BOTTOM NOTES:\n"
    "Look carefully at text below or beside the table. Common patterns:\n"
    "  - \"Daily Zuhr Jama'at: 1:00pm\" / \"Zuhr Jamaat - 12:40pm\" \u2192 "
    "apply this time to zohar_jamaat for all non-Friday rows\n"
    "  - \"Jumu'ah at 12:30pm & 1:40pm\" / \"First Jamaat @ 12:45pm Second "
    "Jamaat @ 1:30pm\" \u2192 extract into jummah_times metadata AND use the "
    "FIRST jumu'ah time as zohar_jamaat on Fridays\n"
    "  - \"Eid Salah: 7:30am & 9:00am\" \u2192 extract into eid_salah "
    "metadata\n"
    "  - \"Sadaqatul Fitr: \u00a3X\" / \"Sadq-E-Fitr \u00a35.00\" / \"Fitrana \u00a36 "
    "per person\" \u2192 extract into sadaqatul_fitr metadata\n"
    "  - \"Radio Frequency: 454.3500\" / \"Freq: 461.2375\" \u2192 extract into "
    "radio_frequency metadata\n\n"
    "FRIDAY OVERRIDES FOR ZOHAR JAMA'AT:\n"
    "On Fridays, the Zuhr/Dhuhr Jama'at time often changes to a Jumu'ah "
    "time. Check:\n"
    "1. Does the table show explicit different values on Friday rows? \u2192 "
    "Use those values.\n"
    "2. Does a footnote specify a Jumu'ah time different from the daily "
    "Zuhr Jama'at? \u2192 Use the first Jumu'ah time on Fridays, the daily "
    "time on other days.\n"
    "3. If no distinction is made, use the same time for all days.\n\n"
    "DATE FORMATTING:\n"
    "Some timetables show full dates (\"18 Feb\"), others show only day "
    "numbers (\"18\", \"19\", \"20\"...) without the month. If only day "
    "numbers are shown, you must infer the month from context: look at the "
    "timetable title, headers, or footnotes for the month/year "
    "information, and combine it with the day numbers. If the timetable "
    "spans two months (e.g. February into March), determine where the "
    "month changes by looking at when day numbers reset from a high number "
    "back to 1 (e.g. 28 \u2192 1 means Feb \u2192 Mar). Always output dates in "
    "\"DD Mon\" format (e.g. \"18 Feb\", \"1 Mar\").\n\n"
    "STEP 4: OUTPUT FORMAT\n\n"
    "Return this exact JSON structure:\n"
    "{\n"
    "  \"mosque_name\": \"Full Mosque Name as shown on the timetable\",\n"
    "  \"suggested_slug\": \"faizul\",\n"
    "  \"address\": \"Full address as shown on the timetable\",\n"
    "  \"phone\": \"Phone number as shown on the timetable\",\n"
    "  \"month\": \"February-March 2026\",\n"
    "  \"islamic_month\": \"Ramadan 1447\",\n"
    "  \"jummah_times\": \"1st Jumu'ah: 12:30pm, 2nd Jumu'ah: 1:40pm\",\n"
    "  \"eid_salah\": \"7:30am & 9:00am\",\n"
    "  \"sadaqatul_fitr\": \"\u00a37 per person\",\n"
    "  \"radio_frequency\": \"454.3500\",\n"
    "  \"notes\": \"Any other relevant notes not captured above: Maghrib "
    "jama'at rules, Taraweeh details, etc.\",\n"
    "  \"rows\": [\n"
    "    {\n"
    "      \"date\": \"18 Feb\",\n"
    "      \"day\": \"Wed\",\n"
    "      \"islamic_day\": 1,\n"
    "      \"sehri_ends\": \"5:42\",\n"
    "      \"sunrise\": \"7:17\",\n"
    "      \"zohr\": \"12:27\",\n"
    "      \"asr\": \"2:55\",\n"
    "      \"esha\": \"\",\n"
    "      \"fajr_jamaat\": \"5:57\",\n"
    "      \"zohar_jamaat\": \"12:40\",\n"
    "      \"asr_jamaat\": \"4:30\",\n"
    "      \"maghrib_iftari\": \"5:28\",\n"
    "      \"esha_jamaat\": \"7:15\"\n"
    "    }\n"
    "  ]\n"
    "}\n\n"
    "METADATA FIELD DEFINITIONS:\n"
    "- \"mosque_name\": Full name as shown on the image\n"
    "- \"suggested_slug\": A short, URL-safe slug (lowercase, no spaces, "
    "underscores only) derived from the most distinctive word(s) in the "
    "mosque name. Strip common prefixes like Masjid, Masjid-e, Masjid-al, "
    "Jam-e, Jamia, Al, and common suffixes like Trust, Foundation, "
    "Association, Society, Centre, Mosque, Islamic Centre. Use what "
    "remains as the slug. If the remaining word is very long, abbreviate "
    "sensibly. Examples: \"Masjid Faizul Islam\" \u2192 \"faizul\", "
    "\"Birmingham Jam-e-Masjid\" \u2192 \"jame\", \"Eden Foundation\" \u2192 "
    "\"eden\", \"Masjid Al Falaah\" \u2192 \"falaah\", \"Masjid Abu Bakr\" \u2192 "
    "\"abubakr\", \"Great Barr Muslim Foundation\" \u2192 \"gbmf\", "
    "\"Madinatul Uloom Al-Islamyah\" \u2192 \"muai\".\n"
    "- \"address\": Full street address including postcode/ZIP if visible. "
    "Set to \"\" if not shown.\n"
    "- \"phone\": Phone number(s) as shown. Include multiple if listed "
    "(e.g. \"0121 554 9157 / 07980 924 816\"). Set to \"\" if not shown.\n"
    "- \"month\": The Gregorian month(s) and year covered (e.g. \"June "
    "2025\", \"February-March 2026\")\n"
    "- \"islamic_month\": The Islamic month and Hijri year if shown (e.g. "
    "\"Ramadan 1447\", \"Dhul Hijjah 1446\"). Set to \"\" if not shown.\n"
    "- \"jummah_times\": Jumu'ah/Friday prayer time(s) exactly as stated. "
    "Many mosques have multiple Jumu'ah salahs \u2014 include all with "
    "khutbah/speech times if listed (e.g. \"1st: 12:30pm (Khutbah "
    "12:10pm), 2nd: 1:30pm\"). Set to \"\" if not shown.\n"
    "- \"eid_salah\": Eid salah time(s) exactly as stated (e.g. \"7:30am & "
    "9:00am\", \"1st Salah: 7:00am, 2nd Salah: 8:00am\"). Include all "
    "listed times. Set to \"\" if not shown.\n"
    "- \"sadaqatul_fitr\": Sadaqatul Fitr / Sadqa-e-Fitr / Fitrana amount "
    "exactly as stated including currency (e.g. \"\u00a37 per person\", "
    "\"\u00a34.50\", \"\u00a36 per person (min)\"). Set to \"\" if not shown.\n"
    "- \"radio_frequency\": Radio receiver frequency if shown (e.g. "
    "\"454.3500\", \"461.2375\"). Set to \"\" if not shown.\n"
    "- \"notes\": Any other relevant notes not captured by the fields "
    "above: Maghrib jama'at rules, Taraweeh details, special programmes, "
    "etc.\n\n"
    "ROW FIELD DEFINITIONS:\n"
    "- \"date\": \"DD Mon\" format (e.g. \"18 Feb\", \"1 Mar\", \"15 Jun\"). "
    "Always include the month abbreviation even if the timetable only "
    "shows day numbers.\n"
    "- \"day\": Three-letter day name (e.g. \"Wed\", \"Thu\", \"Fri\")\n"
    "- \"islamic_day\": The Islamic/Hijri day number if shown in the "
    "timetable. Set to null if not present.\n"
    "- \"sehri_ends\": When suhoor/sehri must stop OR Fajr start time "
    "(pre-dawn time)\n"
    "- \"sunrise\": Sunrise time\n"
    "- \"zohr\": Dhuhr/Zuhr START time (beginning of prayer window, NOT "
    "jama'at)\n"
    "- \"asr\": Asr START time (beginning of prayer window, NOT jama'at)\n"
    "- \"esha\": Esha/Isha START time (beginning of prayer window, NOT "
    "jama'at). Set to \"\" if the timetable does not have this column.\n"
    "- \"fajr_jamaat\": Fajr congregational prayer time. If the Fajr "
    "Jama'at column has explicit per-row values, ALWAYS use those \u2014 even "
    "if a note or header also states a rule like \"15 minutes after Sehri "
    "ends\". Only calculate from the rule if the column itself has no "
    "individual values (e.g. vertical text only, or all ditto marks with "
    "no starting value). Set to \"\" if not present.\n"
    "- \"zohar_jamaat\": Dhuhr/Zuhr congregational prayer time. Apply "
    "Friday Jumu'ah overrides if applicable. Set to \"\" if not present.\n"
    "- \"asr_jamaat\": Asr congregational prayer time. Set to \"\" if not "
    "present.\n"
    "- \"maghrib_iftari\": Maghrib/Iftar time (when the fast breaks and "
    "Maghrib prayer begins). If both Sunset and Maghrib columns exist, "
    "use the Maghrib/Iftar column.\n"
    "- \"esha_jamaat\": Esha/Isha congregational prayer time. Set to \"\" "
    "if not present.\n\n"
    "EVERY row must include ALL 13 fields listed above (date through "
    "esha_jamaat), even if the value is \"\" (empty string) because the "
    "timetable doesn't have that column.\n\n"
    "TIME FORMAT RULES:\n"
    "- Always use colons, not dots (convert \"5.40\" to \"5:40\")\n"
    "- Keep the same hour format as the timetable (if it shows \"5:24\" "
    "for Fajr and \"12:28\" for Dhuhr, keep that \u2014 do not convert "
    "between 12h/24h)\n"
    "- Do not add leading zeros unless the timetable uses them\n"
    "- If a column genuinely doesn't exist in the timetable, use \"\" "
    "(empty string)\n\n"
    "STEP 5: VALIDATE YOUR OUTPUT\n\n"
    "Before returning, check:\n"
    "1. Row count: Count the rows in the timetable image and ensure your "
    "output matches exactly.\n"
    "2. Monotonic trends: Over any given month, sehri/fajr times should "
    "trend consistently (getting earlier or later depending on season and "
    "hemisphere) and maghrib should trend consistently the opposite way. "
    "If values jump erratically, re-read the image.\n"
    "3. Day sequence: Days should follow a consistent weekly cycle (Mon, "
    "Tue, Wed, Thu, Fri, Sat, Sun). Verify the first date's day matches "
    "what is shown.\n"
    "4. No ditto marks remain: Every cell must be a time value or \"\". "
    "No \" or '' ditto characters anywhere in the output.\n"
    "5. Every row has all 13 fields with no missing keys.\n"
    "6. Fajr Jama'at values are actual calculated times, never "
    "\"SEHRI+15\" or similar formulas.\n"
    "7. Zohar Jama'at on Fridays reflects any Jumu'ah override found in "
    "the timetable.\n"
    "8. All dates include month abbreviation in \"DD Mon\" format.\n\n"
    "Return ONLY valid JSON, no markdown fences, no explanation, "
    "no preamble."
)


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
    4. Esha start > Esha jamaat — swap them
    5. Fill zohar_jamaat from notes if still empty
    6. Warn about remaining ordering violations
    """
    fix_counts = {"zohar_shift": 0, "esha_move": 0, "asr_swap": 0, "esha_swap": 0, "zohar_notes": 0}

    for row in rows:
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

        # Fix 4: Esha start > Esha jamaat — swap them
        if esha_mins and esha_j_mins and esha_mins > esha_j_mins:
            row["esha"], row["esha_jamaat"] = row["esha_jamaat"], row["esha"]
            fix_counts["esha_swap"] += 1

    # Fix 5: Fill zohar_jamaat from notes if still empty
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

    # Fix 6: Warn about remaining cross-prayer ordering violations
    for i, row in enumerate(rows):
        zohr_mins = time_to_minutes(row.get("zohr", ""), force_pm=True)
        asr_mins = time_to_minutes(row.get("asr", ""), force_pm=True)
        maghrib_mins = time_to_minutes(row.get("maghrib_iftari", ""), force_pm=True)

        if zohr_mins and asr_mins and zohr_mins >= asr_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Zohr ({row.get('zohr')}) >= Asr ({row.get('asr')})")
        if asr_mins and maghrib_mins and asr_mins >= maghrib_mins:
            print(f"  ⚠️  Row {i+1} ({row.get('date', '?')}): Asr ({row.get('asr')}) >= Maghrib ({row.get('maghrib_iftari')})")

    return rows


def save_csv(data: dict, output_path: str, notes: str = ""):
    """Save extracted data as a CSV file."""
    rows = data["rows"]
    rows = validate_and_fix_rows(rows, notes)

    fieldnames = [
        "Date", "Day", "Islamic Day", "Sehri Ends", "Sunrise",
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
                "Islamic Day": row.get("islamic_day", "") or row.get("ramadan_day", ""),
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
    config_path = os.path.join(config_dir, f"{slug}.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"  \u2705 Config saved: {config_path}")

    # Regenerate index.json
    _regenerate_index(config_dir)


def _regenerate_index(config_dir: str):
    """Regenerate data/mosques/index.json from the config files on disk."""
    slugs = sorted(
        p.stem for p in Path(config_dir).glob("*.json")
        if p.name != "index.json"
    )
    index_path = os.path.join(config_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(slugs, f)
    print(f"  \u2705 Index updated: {index_path} ({len(slugs)} mosques)")


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

    _load_env()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\u274c ANTHROPIC_API_KEY not set. Add it to .env or set the environment variable.")
        sys.exit(1)

    _, data_dir, config_dir = _get_dirs()

    if args.mode == "add":
        main_add(args, api_key, str(data_dir), str(config_dir))
    elif args.mode == "update":
        main_update(args, api_key, str(data_dir), str(config_dir))
    elif args.mode == "esalaat":
        main_esalaat(args, api_key, str(data_dir), str(config_dir))


if __name__ == "__main__":
    main()
