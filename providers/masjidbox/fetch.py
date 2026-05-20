"""
providers/masjidbox/fetch.py — daily-accumulating MasjidBox fetcher.

MasjidBox's public widget API returns only today + tomorrow, so we can't pull a
full year. Instead this runs daily and UPSERTS today's/tomorrow's rows into the
masjid's CSV by date — building a growing history while always keeping today
current (self-healing: if the masjid changes its times, we pick it up next run).
Masjids are flagged `today_only` so the frontend hides the month view (a
forward window of one day makes a calendar month pointless).

API (public, no real auth — apikey is shipped in MasjidBox's own widget JS):
    GET https://api.masjidbox.com/1.0/masjidbox/landing/athany/{slug}
    headers: apikey, User-Agent
Returns {name, address, settings, athany, timetable[2], ...}. Each timetable
day has ISO timestamps WITH timezone (already local/BST — no DST math needed),
an `iqamah` block, and `special` (imsak/iftar).

Usage (run from repo root):
    python -m providers.masjidbox.fetch green-lane-masjid-1666108368685 --slug green_lane

Outputs:
    data/{slug}.csv               — accumulating prayer times (upserted by date)
    data/mosques/{slug}.json      — masjid config (today_only, provider, quality)
    data/raw/{slug}.json          — latest raw response (debug)
"""
import argparse
import csv
import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

from providers import lookup_uk_postcode, regenerate_index

API_URL = "https://api.masjidbox.com/1.0/masjidbox/landing/athany/{slug}"
API_KEY = "JejYcMS7hsOsZTPDk2ZhKOAlW9IyQ6Px"
SOURCE_URL = "https://masjidbox.com/prayer-times/{slug}"

CSV_FIELDS = [
    "date", "day", "islamic_day", "sehri_ends", "fajr_start", "sunrise", "zawal",
    "zohr", "asr", "esha", "fajr_jamaat", "zohar_jamaat", "asr_jamaat",
    "maghrib_iftari", "maghrib_jamaat", "esha_jamaat",
]

MANAGED_FIELDS = {
    "slug", "display_name", "city", "address", "address_source", "phone", "email",
    "notes", "website", "logo", "latitude", "longitude", "timezone", "country_code",
    "jummah_times", "csv", "provider", "quality", "today_only", "acknowledged_issues",
    "suppress_times",
}

PC_RE = re.compile(r"\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b", re.IGNORECASE)


def fetch_athany(slug: str) -> dict:
    url = API_URL.format(slug=urllib.parse.quote(slug))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "apikey": API_KEY})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    if not data.get("timetable"):
        raise RuntimeError(f"No timetable for MasjidBox slug {slug}")
    return data


def _hhmm(iso: str) -> str:
    """Extract local HH:MM from an ISO timestamp like '2026-05-20T13:09:00+01:00'."""
    return iso[11:16] if iso and len(iso) >= 16 else ""


def day_to_row(d: dict) -> dict:
    iq = d.get("iqamah") or {}
    special = d.get("special") or {}
    iso_date = (d.get("date") or "")[:10]
    try:
        wd = datetime.strptime(iso_date, "%Y-%m-%d").strftime("%a")
    except ValueError:
        wd = ""
    fajr = _hhmm(d.get("fajr"))
    return {
        "date": iso_date,
        "day": wd,
        "islamic_day": "",
        "sehri_ends": _hhmm(special.get("imsak")) or fajr,
        "fajr_start": fajr,
        "sunrise": _hhmm(d.get("sunrise")),
        "zawal": "",
        "zohr": _hhmm(d.get("dhuhr")),
        "asr": _hhmm(d.get("asr")),
        "esha": _hhmm(d.get("isha")),
        "fajr_jamaat": _hhmm(iq.get("fajr")),
        "zohar_jamaat": _hhmm(iq.get("dhuhr")),
        "asr_jamaat": _hhmm(iq.get("asr")),
        "maghrib_iftari": _hhmm(d.get("maghrib")),
        "maghrib_jamaat": _hhmm(iq.get("maghrib")),
        "esha_jamaat": _hhmm(iq.get("isha")),
    }


def upsert_csv(csv_path: Path, new_rows: list[dict]) -> int:
    """Merge new rows into the existing CSV by date (update if present, else add).
    Returns total row count after the merge."""
    existing = {}
    if csv_path.exists():
        with open(csv_path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                existing[r["date"]] = r
    for r in new_rows:
        existing[r["date"]] = r
    rows = sorted(existing.values(), key=lambda r: r["date"])
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def load_existing_config(config_path: Path) -> dict:
    if not config_path.exists():
        return {}
    try:
        return json.load(open(config_path, encoding="utf-8"))
    except Exception:
        return {}


def prefer_existing(existing, new):
    if existing is None or (isinstance(existing, str) and not existing.strip()):
        return new
    return existing


def build_config(data: dict, slug: str, mb_slug: str, existing: dict, row_count: int) -> dict:
    address = (data.get("address") or "").strip()
    lat = existing.get("latitude")
    lng = existing.get("longitude")
    city = existing.get("city")
    if (lat is None or lng is None) and address:
        m = PC_RE.search(address.upper())
        if m:
            info = lookup_uk_postcode(m.group(0))
            if info:
                lat = lat if lat is not None else info.get("latitude")
                lng = lng if lng is not None else info.get("longitude")
                city = city or info.get("admin_district")

    def keep(field, new):
        return prefer_existing(existing.get(field), new)

    config = {
        "slug": slug,
        "display_name": keep("display_name", (data.get("name") or "").strip()),
        "city": keep("city", city or ""),
        "latitude": lat,
        "longitude": lng,
        "country_code": keep("country_code", data.get("country") or "GB"),
        "website": keep("website", ""),
        "logo": keep("logo", ""),
        "address": keep("address", address),
        "address_source": existing.get("address_source") or "masjidbox",
        "phone": (existing.get("phone") or "").strip(),
        "email": (existing.get("email") or "").strip(),
        "notes": (existing.get("notes") or "").strip(),
        "timezone": keep("timezone", (data.get("settings") or {}).get("timezone") or "Europe/London"),
        "jummah_times": existing.get("jummah_times") or "",
        "csv": f"{slug}.csv",
        "provider": {
            "type": "masjidbox",
            "ref": {"slug": mb_slug},
            "source_url": SOURCE_URL.format(slug=mb_slug),
        },
        "today_only": True,
        "suppress_times": list(existing.get("suppress_times") or []),
        "quality": {
            "status": "ok",
            "checked_at": date.today().isoformat(),
            "row_count": row_count,
            "warnings": [],
            "issues": [],
        },
        "acknowledged_issues": list(existing.get("acknowledged_issues") or []),
    }
    for k, v in existing.items():
        if k not in MANAGED_FIELDS and k not in config:
            config[k] = v
    return config


def fetch_one(mb_slug: str, slug: str, data_dir: Path, verbose: bool = True) -> dict:
    """mb_slug = MasjidBox URL slug (for the API); slug = our local slug (filenames)."""
    config_path = data_dir / "mosques" / f"{slug}.json"
    existing = load_existing_config(config_path)

    if verbose:
        print(f"Fetching MasjidBox {mb_slug} -> {slug}...")
    data = fetch_athany(mb_slug)

    raw_path = data_dir / "raw" / f"{slug}.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    json.dump(data, open(raw_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    new_rows = [day_to_row(d) for d in data["timetable"] if (d.get("date") or "")[:10]]
    # Per-field suppression: blank known-bad columns (e.g. an extreme high-angle
    # Fajr start) to a dash so the masjid stays usable instead of being fully
    # hidden over one cell. Re-applied every fetch from the config.
    suppress = existing.get("suppress_times") or []
    for r in new_rows:
        for f in suppress:
            if f in r:
                r[f] = "-"
    row_count = upsert_csv(data_dir / f"{slug}.csv", new_rows)
    config = build_config(data, slug, mb_slug, existing, row_count)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    json.dump(config, open(config_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)

    if verbose:
        print(f"  {config['display_name']} — upserted {len(new_rows)} day(s), CSV now {row_count} rows")
        print(f"  Wrote {config_path}")
    return {"slug": slug, "display_name": config["display_name"],
            "added": len(new_rows), "row_count": row_count}


def slugify(name: str) -> str:
    s = "".join(c for c in (name or "") if ord(c) < 128).lower()
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", s)).strip("_") or "masjid"


def main():
    p = argparse.ArgumentParser(description="Fetch one masjid from MasjidBox (daily-accumulating).")
    p.add_argument("mb_slug", help="MasjidBox slug (URL path after /prayer-times/)")
    p.add_argument("--slug", help="Local slug for filenames (default: derived from masjid name)")
    p.add_argument("--data-dir", default="data")
    args = p.parse_args()
    data_dir = Path(args.data_dir)
    slug = args.slug
    if not slug:
        slug = slugify(fetch_athany(args.mb_slug).get("name") or args.mb_slug)
    fetch_one(args.mb_slug, slug, data_dir, verbose=True)
    print(f"index: {regenerate_index(data_dir / 'mosques')} masjids")


if __name__ == "__main__":
    main()
