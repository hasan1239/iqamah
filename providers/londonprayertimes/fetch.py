"""
providers/londonprayertimes/fetch.py — London Unified Prayer Timetable.

Fetches the full year from londonprayertimes.com (12 month calls) and writes it
to a masjid's CSV. Based on East London Mosque.

⚠️ ONLY SAFE FOR EAST LONDON MOSQUE. The London Unified timetable is a START-time
standard, NOT a jamaat standard. Other "followers" (e.g. London Central Mosque,
Croydon ICT) adopt the unified start times but set their OWN iqamah — verified
their Asr jamaat is ~17:27-17:30, not the unified 18:45, so applying the unified
jamaat to them is ~75min late (people miss the congregation). Only ELM genuinely
uses the unified jamaat (the timetable is derived from it). Do NOT onboard other
masjids here without confirming their actual jamaat matches.

Fetched per-year, not daily (the calendar is fixed for the year). Re-run when a
new year's data is needed.

API key: set the LPT_API_KEY environment variable (free key from
londonprayertimes.com/api). Times use the STANDARD Asr (`asr`), matching how
East London Mosque presents it (Asr begins, jama'at later at the Hanafi time).

Usage (run from repo root):
    LPT_API_KEY=... python -m providers.londonprayertimes.fetch eastlondon
    LPT_API_KEY=... python -m providers.londonprayertimes.fetch eastlondon --year 2026
"""
import argparse
import csv
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

from providers import regenerate_index

API = "https://www.londonprayertimes.com/api/times/"
SOURCE_URL = "https://www.londonprayertimes.com/"
MONTHS = ["january", "february", "march", "april", "may", "june",
          "july", "august", "september", "october", "november", "december"]

CSV_FIELDS = [
    "date", "day", "islamic_day", "sehri_ends", "fajr_start", "sunrise", "zawal",
    "zohr", "asr", "esha", "fajr_jamaat", "zohar_jamaat", "asr_jamaat",
    "maghrib_iftari", "maghrib_jamaat", "esha_jamaat",
]

MANAGED_FIELDS = {
    "slug", "display_name", "city", "address", "address_source", "phone", "email",
    "notes", "website", "logo", "latitude", "longitude", "timezone", "country_code",
    "jummah_times", "csv", "provider", "quality", "acknowledged_issues",
}


def _api_key(explicit: str | None) -> str:
    key = explicit or os.environ.get("LPT_API_KEY")
    if not key:
        raise SystemExit("Set LPT_API_KEY env var (or pass --key) — free key from londonprayertimes.com/api")
    return key


def fetch_year(key: str, year: int, delay: float = 0.4) -> dict:
    """Return {iso_date: api_row} for the whole year (12 month calls)."""
    out = {}
    for mo in MONTHS:
        url = (f"{API}?format=json&key={urllib.parse.quote(key)}"
               f"&year={year}&month={mo}&24hours=true")
        req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
        for iso, row in (payload.get("times") or {}).items():
            out[iso] = row
        time.sleep(delay)
    return out


def normalise(year_rows: dict) -> list[dict]:
    rows = []
    for iso in sorted(year_rows):
        v = year_rows[iso]
        try:
            wd = datetime.strptime(iso, "%Y-%m-%d").strftime("%a")
        except ValueError:
            continue
        rows.append({
            "date": iso,
            "day": wd,
            "islamic_day": "",
            "sehri_ends": v.get("fajr", ""),     # no imsak in the API
            "fajr_start": v.get("fajr", ""),
            "sunrise": v.get("sunrise", ""),
            "zawal": "",
            "zohr": v.get("dhuhr", ""),
            "asr": v.get("asr", ""),             # standard Asr (matches ELM)
            "esha": v.get("isha", ""),
            "fajr_jamaat": v.get("fajr_jamat", ""),
            "zohar_jamaat": v.get("dhuhr_jamat", ""),
            "asr_jamaat": v.get("asr_jamat", ""),
            "maghrib_iftari": v.get("magrib", ""),
            "maghrib_jamaat": v.get("magrib_jamat", ""),
            "esha_jamaat": v.get("isha_jamat", ""),
        })
    return rows


def load_existing_config(config_path: Path) -> dict:
    if not config_path.exists():
        return {}
    try:
        existing = json.load(open(config_path, encoding="utf-8"))
    except Exception:
        return {}
    if "lat" in existing and "latitude" not in existing:
        existing["latitude"] = existing.pop("lat")
    if "lon" in existing and "longitude" not in existing:
        existing["longitude"] = existing.pop("lon")
    return existing


def prefer_existing(existing, new):
    if existing is None or (isinstance(existing, str) and not existing.strip()):
        return new
    return existing


def build_config(slug: str, existing: dict, row_count: int) -> dict:
    def keep(field, new):
        return prefer_existing(existing.get(field), new)

    config = {
        "slug": slug,
        "display_name": keep("display_name", slug),
        "city": keep("city", "London"),
        "latitude": existing.get("latitude"),
        "longitude": existing.get("longitude"),
        "country_code": keep("country_code", "GB"),
        "website": keep("website", ""),
        "logo": keep("logo", ""),
        "address": (existing.get("address") or "").strip(),
        "address_source": existing.get("address_source") or "manual",
        "phone": (existing.get("phone") or "").strip(),
        "email": (existing.get("email") or "").strip(),
        "notes": (existing.get("notes") or "").strip(),
        "timezone": keep("timezone", "Europe/London"),
        "jummah_times": existing.get("jummah_times") or "",
        "csv": f"{slug}.csv",
        "provider": {
            "type": "londonprayertimes",
            "ref": {"city": "london"},
            "source_url": SOURCE_URL,
        },
        "quality": {
            "status": "ok",
            "checked_at": date.today().isoformat(),
            "row_count": row_count,
            "warnings": ["London Unified Prayer Timetable — shared across all London masjids that follow it."],
            "issues": [],
        },
        "acknowledged_issues": list(existing.get("acknowledged_issues") or []),
    }
    # Carry forward unknown legacy fields, but drop image-pipeline cruft that no
    # longer applies now that this is a live London-Unified feed.
    drop = {"source_image", "is_stale", "pending_update", "month", "islamic_month"}
    for k, v in existing.items():
        if k not in MANAGED_FIELDS and k not in config and k not in drop:
            config[k] = v
    return config


def write_csv(rows: list[dict], path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(rows)


def fetch_one(slug: str, data_dir: Path, year_rows: dict, verbose: bool = True) -> dict:
    """Write the (already-fetched) unified year to one masjid, preserving its
    existing metadata. Caller fetches year_rows once and reuses for all masjids."""
    rows = normalise(year_rows)
    config_path = data_dir / "mosques" / f"{slug}.json"
    existing = load_existing_config(config_path)
    write_csv(rows, data_dir / f"{slug}.csv")
    config = build_config(slug, existing, len(rows))
    config_path.parent.mkdir(parents=True, exist_ok=True)
    json.dump(config, open(config_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    if verbose:
        print(f"  {config['display_name']} — {len(rows)} days ({rows[0]['date']}..{rows[-1]['date']})")
    return {"slug": slug, "display_name": config["display_name"], "row_count": len(rows)}


def main():
    p = argparse.ArgumentParser(description="Write the London Unified timetable to a masjid.")
    p.add_argument("slug", help="Local masjid slug (existing config preserved if present)")
    p.add_argument("--year", type=int, default=date.today().year)
    p.add_argument("--key", help="API key (else LPT_API_KEY env var)")
    p.add_argument("--data-dir", default="data")
    args = p.parse_args()
    data_dir = Path(args.data_dir)
    print(f"Fetching London Unified {args.year} (12 month calls)...")
    year_rows = fetch_year(_api_key(args.key), args.year)
    print(f"Got {len(year_rows)} days")
    fetch_one(args.slug, data_dir, year_rows, verbose=True)
    print(f"index: {regenerate_index(data_dir / 'mosques')} masjids")


if __name__ == "__main__":
    main()
