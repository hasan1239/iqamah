"""
fetch_mawaqit.py — Phase 1 single-masjid Mawaqit fetcher.

Pulls a year of prayer times from a Mawaqit mosque page, normalises it to
Iqamah's 16-field schema, runs quality checks, reverse-geocodes the address
from lat/lng (with postcode override from the URL slug), and writes a CSV +
metadata JSON.

Preservation behaviour:
  - Stable facts and user-editable fields are PRESERVED on re-fetch if non-empty.
  - Any unknown fields in the existing config are carried forward untouched.
  - Legacy field names (lat/lon) are migrated to (latitude/longitude) on load.
  - To force a refresh of a specific field, blank it in the masjid's JSON
    and re-run.

Geocoding (UK masjids):
  - Postcode: extracted from the Mawaqit URL slug (authoritative)
  - Ward + city: looked up via Postcodes.io (authoritative UK administrative data)
  - Street name: reverse-geocoded via OpenStreetMap Nominatim
  When Nominatim's postcode disagrees with the slug's, the house number is
  dropped (Nominatim has likely hit a neighbouring building).

Usage:
    python fetch_mawaqit.py amanah-masjid-birmingham-b11-1jb-united-kingdom --slug amanah
    python fetch_mawaqit.py amanah-masjid-birmingham-b11-1jb-united-kingdom --slug amanah --keep-raw

Outputs:
    data/{slug}.csv               — parsed prayer times
    data/mosques/{slug}.json      — masjid config + quality report
    data/raw/{slug}.json          — raw Mawaqit confData blob (debug/audit)
"""
import argparse
import csv
import json
import re
import urllib.request
from datetime import date
from pathlib import Path


MAWAQIT_URL = "https://mawaqit.net/en/m/{path}"

# calendar[m][d]      = [fajr_start, shuruq, dhuhr, asr, maghrib, isha]
# iqamaCalendar[m][d] = [fajr_iqama, dhuhr_iqama, asr_iqama, maghrib_iqama, isha_iqama]
START_FAJR, START_SHURUQ, START_DHUHR, START_ASR, START_MAGHRIB, START_ISHA = range(6)
IQ_FAJR, IQ_DHUHR, IQ_ASR, IQ_MAGHRIB, IQ_ISHA = range(5)

# Fields this script knows about and manages. Anything in the existing config
# that's NOT in this list will be carried forward untouched.
MANAGED_FIELDS = {
    "slug", "display_name", "city", "association", "address", "address_source",
    "phone", "email", "notes", "website", "logo", "latitude", "longitude",
    "timezone", "country_code", "jummah_times", "csv", "provider", "quality",
}

# UK postcode pattern: outward code (1-2 letters + 1-2 digits + optional letter)
# followed by inward code (digit + 2 letters). The Mawaqit slug separates
# the two halves with a dash, e.g. b11-1jb, b7-4ny, sw1a-1aa.
UK_POSTCODE_IN_SLUG_RE = re.compile(
    r"\b([a-z]{1,2}\d{1,2}[a-z]?)-?(\d[a-z]{2})\b",
    re.IGNORECASE,
)


def fetch_confdata(mawaqit_path: str) -> dict:
    """Fetch a Mawaqit page and extract the confData JSON blob."""
    url = MAWAQIT_URL.format(path=mawaqit_path)
    req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode("utf-8")

    m = re.search(r"var confData = (\{.*?\});", html, re.DOTALL)
    if not m:
        raise RuntimeError(f"confData not found at {url} — page format may have changed")
    return json.loads(m.group(1))


# English particles kept lowercase mid-name during normalisation
NAME_LOWERCASE_WORDS = {
    "of", "and", "the", "in", "for", "to", "at", "by", "with", "from", "on",
}


def normalise_name(text: str) -> str:
    """
    Normalise a masjid or city name to consistent Title Case.

    Handles:
      - All-uppercase input ("QUBA Islamic Centre" → "Quba Islamic Centre")
      - All-lowercase input ("amanah masjid" → "Amanah Masjid")
      - Hyphenated names: both halves capitalised ("Al-Rahman" stays "Al-Rahman")
      - Persian/Urdu "-e-" connector kept lowercase ("Masjid-e-Quba")
      - Small English particles kept lowercase mid-name
        ("Centre for Islamic Education", not "Centre For Islamic Education")
      - Apostrophes don't trigger re-capitalisation ("Jum'a" stays "Jum'a")

    Note: this doesn't preserve true acronyms — "BMA Centre" becomes "Bma Centre".
    For masjids that genuinely use an acronym, set display_name manually in the
    config and the preserve logic will keep it across future re-fetches.
    """
    if not text:
        return text

    s = text.lower()

    # Capitalise first letter of the whole string
    s = s[0].upper() + s[1:]

    # Capitalise the first letter after a space, hyphen, or opening bracket.
    # Apostrophe and period are intentionally NOT included — names like "Jum'a"
    # and "St.Anne's" should not be re-capitalised after these.
    s = re.sub(
        r"([\s\(\[\-])([a-z])",
        lambda m: m.group(1) + m.group(2).upper(),
        s,
    )

    # Lowercase small English particles when they appear mid-name
    words = s.split(" ")
    for i in range(1, len(words)):
        if words[i].lower() in NAME_LOWERCASE_WORDS:
            words[i] = words[i].lower()
    s = " ".join(words)

    # Persian/Urdu "-e-" connector ("Masjid-e-Quba")
    s = re.sub(r"-E-", "-e-", s)

    return s


def parse_mawaqit_label(label: str | None, fallback_name: str | None = None) -> tuple[str, str]:
    """
    Mawaqit's `label` field is consistently formatted as "Masjid Name - City"
    (e.g. "Amanah Masjid - Birmingham"). Split on the last " - " to extract
    a clean display name and the city.

    Returns (display_name, city). City is empty string if the label doesn't
    follow the convention.
    """
    text = (label or fallback_name or "").strip()
    if not text:
        return "", ""

    # Use rsplit so masjid names containing " - " (e.g. "Al-Falah - Centre - London")
    # still split correctly at the last " - ".
    if " - " in text:
        name, _, city = text.rpartition(" - ")
        return normalise_name(name.strip()), normalise_name(city.strip())
    return normalise_name(text), ""


def extract_postcode_from_slug(mawaqit_path: str) -> str | None:
    """
    Extract a UK postcode embedded in the Mawaqit URL slug.

    Examples:
      'amanah-masjid-birmingham-b11-1jb-united-kingdom' → 'B11 1JB'
      'quba-islamic-cultural-centre-birmingham-b7-4ny-united-kingdom' → 'B7 4NY'

    Returns None for non-UK masjids or slugs that don't contain a postcode.
    """
    match = UK_POSTCODE_IN_SLUG_RE.search(mawaqit_path)
    if not match:
        return None
    outward, inward = match.group(1).upper(), match.group(2).upper()
    return f"{outward} {inward}"


def reverse_geocode_components(lat: float, lng: float) -> dict | None:
    """
    Reverse-geocode lat/lng via OpenStreetMap Nominatim.
    Returns the raw `address` components dict, or None on failure.

    Nominatim usage policy:
      - Free, no API key required
      - Rate-limited to 1 req/sec (fine for single masjid; throttle if looping)
      - Requires a meaningful User-Agent identifying the application
      - Returned data is ODbL-licensed; attribute "© OpenStreetMap contributors"
        somewhere visible on the public site (footer is fine).
    """
    try:
        url = (
            "https://nominatim.openstreetmap.org/reverse"
            f"?format=jsonv2&lat={lat}&lon={lng}&zoom=18&addressdetails=1"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
        return result.get("address", {})
    except Exception as e:
        print(f"  Geocode failed: {e}")
        return None


def lookup_uk_postcode(postcode: str) -> dict | None:
    """
    Look up a UK postcode via Postcodes.io.
    Returns dict with admin_ward, admin_district, region, etc., or None on failure.

    Postcodes.io is free, no API key, no rate limit. Run by Ideal Postcodes
    as an open-data service backed by ONS.
    """
    try:
        normalised = postcode.replace(" ", "").upper()
        url = f"https://api.postcodes.io/postcodes/{normalised}"
        req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
        if payload.get("status") == 200:
            return payload.get("result")
        return None
    except Exception as e:
        print(f"  Postcode lookup failed: {e}")
        return None


def build_address(lat: float, lng: float, mawaqit_path: str) -> str | None:
    """
    Build a UK address by combining authoritative sources:
      - Postcode: from the Mawaqit URL slug
      - Ward + city: from Postcodes.io (authoritative UK administrative data)
      - Street name: from Nominatim (best available without paid PAF data)

    When Nominatim's postcode disagrees with the slug, drop the house number —
    Nominatim has hit a neighbouring building and the number can't be trusted.
    """
    slug_postcode = extract_postcode_from_slug(mawaqit_path)
    postcode_info = lookup_uk_postcode(slug_postcode) if slug_postcode else None
    components = reverse_geocode_components(lat, lng)

    if components is None and postcode_info is None and slug_postcode is None:
        return None

    # Street info only available from Nominatim
    geocoded_postcode = (components.get("postcode") or "").upper().strip() if components else ""
    postcodes_match = (
        not slug_postcode or not geocoded_postcode or slug_postcode == geocoded_postcode
    )
    house_number = (components.get("house_number") if components and postcodes_match else None)
    road = components.get("road") if components else None

    if slug_postcode and geocoded_postcode and not postcodes_match:
        print(f"  Geocoded postcode '{geocoded_postcode}' disagrees with slug "
              f"postcode '{slug_postcode}'; using slug, dropping house number")

    # Ward selection — Nominatim suburb is more colloquial ("Sparkbrook"),
    # Postcodes.io admin_ward is authoritative but can be long
    # ("Sparkbrook & Balsall Heath East"). Prefer the shorter Nominatim version
    # when both sources roughly agree (one is a substring of the other); fall
    # back to Postcodes.io's authoritative ward otherwise.
    nominatim_suburb = (
        (components.get("suburb") or components.get("neighbourhood"))
        if components else None
    )
    postcodes_ward = postcode_info.get("admin_ward") if postcode_info else None

    ward = None
    if nominatim_suburb and postcodes_ward:
        n_lower = nominatim_suburb.lower()
        p_lower = postcodes_ward.lower()
        if n_lower in p_lower or p_lower in n_lower:
            ward = nominatim_suburb  # both agree, use the shorter version
        else:
            ward = postcodes_ward    # disagreement → trust Postcodes.io
    else:
        ward = nominatim_suburb or postcodes_ward

    city = None
    if postcode_info:
        city = postcode_info.get("admin_district")
    if not city and components:
        city = components.get("city") or components.get("town") or components.get("village")

    postcode = slug_postcode or geocoded_postcode or None

    # Combine house number with road so we get "29-33 Henley Street" rather
    # than the awkward "29-33, Henley Street".
    street = None
    if road and house_number:
        street = f"{house_number} {road}"
    elif road:
        street = road
    elif house_number:
        street = house_number  # rare, but graceful

    parts = [street, ward, city, postcode]
    return ", ".join(p for p in parts if p) or None


def sub_minutes(time_str: str, mins: int) -> str:
    """Subtract N minutes from an HH:MM time. Used for sehri_ends from imsak offset."""
    if not time_str or mins <= 0:
        return time_str or ""
    h, m = map(int, time_str.split(":"))
    total = h * 60 + m - mins
    return f"{total // 60:02d}:{total % 60:02d}"


def detect_year(data: dict) -> int:
    """Mawaqit calendar arrays are always for the current year."""
    return date.today().year


def normalise(data: dict, year: int) -> list[dict]:
    """Walk the calendar + iqamaCalendar and produce one row per day."""
    rows = []
    imsak_offset = data.get("imsakNbMinBeforeFajr", 0) or 0
    jumua = data.get("jumua")
    jumua_as_duhr = data.get("jumuaAsDuhr", False)

    for month_idx in range(12):
        month_starts = data["calendar"][month_idx]
        month_iqamas = data["iqamaCalendar"][month_idx]

        for day_str in sorted(month_starts.keys(), key=int):
            day = int(day_str)
            try:
                d = date(year, month_idx + 1, day)
            except ValueError:
                continue

            s = month_starts[day_str]
            i = month_iqamas.get(day_str, ["", "", "", "", ""])

            fajr_start = s[START_FAJR]
            zohar_jamaat = i[IQ_DHUHR]

            if d.weekday() == 4 and jumua_as_duhr and jumua:
                zohar_jamaat = jumua

            rows.append({
                "date": d.isoformat(),
                "day": d.strftime("%a"),
                "islamic_day": "",
                "sehri_ends": sub_minutes(fajr_start, imsak_offset),
                "fajr_start": fajr_start,
                "sunrise": s[START_SHURUQ],
                "zawal": "",
                "zohr": s[START_DHUHR],
                "asr": s[START_ASR],
                "esha": s[START_ISHA],
                "fajr_jamaat": i[IQ_FAJR],
                "zohar_jamaat": zohar_jamaat,
                "asr_jamaat": i[IQ_ASR],
                "maghrib_iftari": s[START_MAGHRIB],
                "maghrib_jamaat": i[IQ_MAGHRIB],
                "esha_jamaat": i[IQ_ISHA],
            })
    return rows


def quality_check(rows: list[dict], data: dict, blank_unreliable: bool = True) -> dict:
    """Run quality checks against the normalised rows. Returns a status dict."""
    warnings = []
    issues = []
    isha_clamped_days = []

    # Isha clamping (UK summer)
    for row in rows:
        m_start, i_start = row["maghrib_iftari"], row["esha"]
        m_jam, i_jam = row["maghrib_jamaat"], row["esha_jamaat"]
        if m_start and i_start and m_start == i_start and m_jam == i_jam:
            isha_clamped_days.append(row["date"])
            if blank_unreliable:
                row["esha"] = ""
                row["esha_jamaat"] = ""

    if isha_clamped_days:
        warnings.append(
            f"Isha clamped to Maghrib on {len(isha_clamped_days)} days "
            f"({isha_clamped_days[0]} to {isha_clamped_days[-1]}). "
            "Verify whether the masjid genuinely combines Isha with Maghrib in summer, "
            "or has a fixed Isha time that needs to be set manually."
        )
        issues.append({
            "type": "isha_clamped",
            "severity": "high",
            "count": len(isha_clamped_days),
            "first_date": isha_clamped_days[0],
            "last_date": isha_clamped_days[-1],
            "action_taken": "esha and esha_jamaat blanked" if blank_unreliable else "none (--keep-raw set)",
            "fix": "Verify masjid's summer Isha policy and either accept the combine or add an override",
        })

    # Sehri not configured
    if (data.get("imsakNbMinBeforeFajr", 0) or 0) == 0:
        warnings.append(
            "imsakNbMinBeforeFajr is 0 — sehri_ends equals fajr_start year-round. "
            "During Ramadan, users may expect Suhoor to end ~10 minutes earlier."
        )
        issues.append({
            "type": "sehri_unconfigured",
            "severity": "medium",
            "action_taken": "sehri_ends = fajr_start (Mawaqit's default)",
            "fix": "Verify masjid's actual Suhoor cutoff during Ramadan",
        })

    # Fajr jamaat after sunrise (sanity check)
    fajr_after_sunrise = [
        r["date"] for r in rows
        if r["fajr_jamaat"] and r["sunrise"] and r["fajr_jamaat"] >= r["sunrise"]
    ]
    if fajr_after_sunrise:
        warnings.append(
            f"Fajr jamaat is at or after sunrise on {len(fajr_after_sunrise)} days. "
            "Indicates a data error — Fajr jamaat must always be before sunrise."
        )
        issues.append({
            "type": "fajr_after_sunrise",
            "severity": "high",
            "count": len(fajr_after_sunrise),
            "action_taken": "none",
            "fix": "Investigate — likely a Mawaqit data bug for this masjid",
        })

    # All iqamas empty
    iqama_fields = ["fajr_jamaat", "zohar_jamaat", "asr_jamaat", "esha_jamaat"]
    all_empty = all(all(not r[f] for f in iqama_fields) for r in rows)
    if all_empty:
        warnings.append(
            "All iqama fields are empty across the year. Masjid hasn't configured "
            "jama'at times in Mawaqit — only start times are available."
        )
        issues.append({
            "type": "iqamas_unconfigured",
            "severity": "high",
            "action_taken": "iqama fields left blank",
            "fix": "Reach out to masjid, or skip this masjid",
        })

    high_severity = any(i.get("severity") == "high" for i in issues)
    status = "ok" if not issues else ("needs_review" if high_severity else "warnings")

    return {
        "status": status,
        "checked_at": date.today().isoformat(),
        "row_count": len(rows),
        "warnings": warnings,
        "issues": issues,
    }


def load_existing_config(config_path: Path) -> dict:
    """
    Load existing config if it exists, migrating legacy field names.

    Migrations:
      - lat → latitude (legacy field from image-extraction pipeline)
      - lon → longitude (legacy field from image-extraction pipeline)
      - If `address` is set but `address_source` is missing, mark as "manual"
        (since pre-Mawaqit addresses were always manually populated)
    """
    if not config_path.exists():
        return {}

    try:
        with open(config_path, encoding="utf-8") as f:
            existing = json.load(f)
    except Exception as e:
        print(f"  Couldn't read existing config ({e}); treating as new masjid.")
        return {}

    if "lat" in existing and "latitude" not in existing:
        existing["latitude"] = existing.pop("lat")
    if "lon" in existing and "longitude" not in existing:
        existing["longitude"] = existing.pop("lon")

    if existing.get("address") and not existing.get("address_source"):
        existing["address_source"] = "manual"

    return existing


def prefer_existing(existing_value, new_value):
    """Return existing_value if set (not None, not empty string); else new_value."""
    if existing_value is None:
        return new_value
    if isinstance(existing_value, str) and existing_value.strip() == "":
        return new_value
    return existing_value


def resolve_address(data: dict, existing: dict, mawaqit_path: str) -> tuple[str, str]:
    """
    Determine the masjid's address and its source.

    Precedence:
      1. address_source == 'manual' in existing config → keep, never touch
      2. Any existing non-empty address → reuse (don't re-geocode every fetch)
      3. Empty → geocode using lat/lng + slug postcode hint
    """
    existing_addr = (existing.get("address") or "").strip()
    existing_source = existing.get("address_source")

    if existing_addr and existing_source == "manual":
        return existing_addr, "manual"

    if existing_addr:
        return existing_addr, existing_source or "geocoded"

    lat, lng = data.get("latitude"), data.get("longitude")
    if lat is None or lng is None:
        # Last-resort: use just the slug postcode if we have one
        slug_postcode = extract_postcode_from_slug(mawaqit_path)
        return (slug_postcode or ""), ("geocoded" if slug_postcode else "none")

    print(f"  Geocoding {lat}, {lng}...")
    address = build_address(lat, lng, mawaqit_path)
    return (address or ""), ("geocoded" if address else "none")


def build_config(
    data: dict,
    slug: str,
    mawaqit_path: str,
    quality: dict,
    existing: dict,
) -> dict:
    """
    Build the data/mosques/{slug}.json config.

    PRESERVED if non-empty in existing config:
      Stable facts: display_name, latitude, longitude, country_code, website
      User-editable: address, phone, email, notes, jummah_times, association, timezone

    ALWAYS REFRESHED:
      slug, csv (filename-derived), provider, quality

    CARRIED FORWARD UNCHANGED:
      Any other field present in the existing config (legacy fields like
      is_stale, source_image, approved, eid_salah, sadaqatul_fitr,
      radio_frequency, islamic_month, month — kept untouched).
    """
    address, address_source = resolve_address(data, existing, mawaqit_path)
    parsed_name, parsed_city = parse_mawaqit_label(data.get("label"), data.get("name"))

    def keep(field, new_value):
        return prefer_existing(existing.get(field), new_value)

    config = {
        "slug": slug,
        "display_name": keep("display_name", parsed_name),
        "city": keep("city", parsed_city),
        "latitude": keep("latitude", data.get("latitude")),
        "longitude": keep("longitude", data.get("longitude")),
        "country_code": keep("country_code", data.get("countryCode")),
        "website": keep("website", data.get("site") or ""),
        "logo": keep("logo", (data.get("logo") or "").strip()),
        "address": address,
        "address_source": address_source,
        "phone": (existing.get("phone") or "").strip(),
        "email": (existing.get("email") or "").strip(),
        "notes": (existing.get("notes") or "").strip(),
        "association": keep("association", data.get("association")),
        "timezone": keep("timezone", data.get("timezone")),
        "jummah_times": keep("jummah_times", ", ".join(
            t for t in [data.get("jumua"), data.get("jumua2"), data.get("jumua3")] if t
        )),
        "csv": f"{slug}.csv",
        "provider": {
            "type": "mawaqit",
            "ref": {"path": mawaqit_path},
            "source_url": MAWAQIT_URL.format(path=mawaqit_path),
        },
        "quality": quality,
    }

    # Carry forward any unknown fields from the existing config
    for k, v in existing.items():
        if k not in MANAGED_FIELDS and k not in config:
            config[k] = v

    return config


def write_csv(rows: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path", help="Mawaqit URL path, e.g. amanah-masjid-birmingham-b11-1jb-united-kingdom")
    parser.add_argument("--slug", help="Short slug for filenames (default: derived from path)")
    parser.add_argument("--data-dir", default="data", help="Base data directory (default: data)")
    parser.add_argument(
        "--keep-raw",
        action="store_true",
        help="Don't blank unreliable values (debug mode — shows what Mawaqit actually returned)",
    )
    args = parser.parse_args()

    slug = args.slug or args.path.split("-")[0]
    data_dir = Path(args.data_dir)
    blank_unreliable = not args.keep_raw

    csv_path = data_dir / f"{slug}.csv"
    config_path = data_dir / "mosques" / f"{slug}.json"
    raw_path = data_dir / "raw" / f"{slug}.json"
    existing = load_existing_config(config_path)

    print(f"Fetching {args.path}...")
    data = fetch_confdata(args.path)
    year = detect_year(data)
    print(f"Loaded {data.get('name')} — {year}")

    # Save the raw confData blob for debugging and future field extraction
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    rows = normalise(data, year)
    print(f"Normalised {len(rows)} days")

    quality = quality_check(rows, data, blank_unreliable=blank_unreliable)
    print(f"\nQuality: {quality['status']}")
    for w in quality["warnings"]:
        print(f"  WARNING: {w}")

    config = build_config(data, slug, args.path, quality, existing)

    write_csv(rows, csv_path)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {raw_path}")
    print(f"Wrote {csv_path}")
    print(f"Wrote {config_path}")
    print(f"Address: {config['address']} ({config['address_source']})")

    today_row = next((r for r in rows if r["date"] == date.today().isoformat()), rows[0])
    print(f"\nToday's row: {today_row}")


if __name__ == "__main__":
    main()
