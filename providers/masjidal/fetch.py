"""
providers/masjidal/fetch.py — Masjidal / Athan+ widget scraper.

AthanPlus (timing.athanplus.com) powers the Masjidal prayer widget that masjids
like London Central Mosque embed. It server-renders ~7 days of the masjid's REAL
times (adhan + iqamah) — no public JSON API, so we parse the widget HTML and
upsert by date into the CSV (daily-accumulating, today_only, like MasjidBox).

⚠️ HTML scrape — fragile to widget markup changes. Each fetch validates it parsed
plausible rows; if AthanPlus changes the layout, the parser needs updating.

Usage (run from repo root):
    python -m providers.masjidal.fetch QKMqqaKB --slug london_central_mosque

Discovery: the masjid_id is in the embed URL on the masjid's own website, e.g.
iccuk.org embeds masjid_id=QKMqqaKB.
"""
import argparse
import csv
import json
import re
import urllib.request
from datetime import date, datetime
from pathlib import Path

from providers import lookup_uk_postcode, regenerate_index

EMBED_URL = "https://timing.athanplus.com/masjid/widgets/embed?theme=2&masjid_id={mid}"
SOURCE_URL = "https://timing.athanplus.com/masjid/widgets/embed?masjid_id={mid}"

CSV_FIELDS = [
    "date", "day", "islamic_day", "sehri_ends", "fajr_start", "sunrise", "zawal",
    "zohr", "asr", "esha", "fajr_jamaat", "zohar_jamaat", "asr_jamaat",
    "maghrib_iftari", "maghrib_jamaat", "esha_jamaat",
]
MANAGED_FIELDS = {
    "slug", "display_name", "city", "address", "address_source", "phone", "email",
    "notes", "website", "logo", "latitude", "longitude", "timezone", "country_code",
    "jummah_times", "csv", "provider", "quality", "today_only", "suppress_times",
    "acknowledged_issues",
}
PC_RE = re.compile(r"\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b", re.IGNORECASE)
TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})\s*(AM|PM)\b", re.IGNORECASE)
DATE_RE = re.compile(r"[A-Z][a-z]+,\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})")


def fetch_html(mid: str) -> str:
    req = urllib.request.Request(EMBED_URL.format(mid=mid), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "ignore")


def _to24(h: int, m: int, ap: str) -> str:
    ap = ap.upper()
    if ap == "PM" and h != 12:
        h += 12
    if ap == "AM" and h == 12:
        h = 0
    return f"{h:02d}:{m:02d}"


def parse_widget(html: str) -> list[dict]:
    """Parse the AthanPlus widget into 16-field rows. Each carousel-item is one
    day: a date header then prayer rows (Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha),
    each with a STARTS time and (except Sunrise) an IQAMAH time — 11 time tokens."""
    blocks = re.split(r'class="carousel-item', html)[1:]
    rows = []
    for block in blocks:
        dm = DATE_RE.search(block)
        if not dm:
            continue
        try:
            iso = datetime.strptime(dm.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
        except ValueError:
            continue
        times = [_to24(int(h), int(m), ap) for h, m, ap in TIME_RE.findall(block)]
        if len(times) < 11:
            continue  # malformed day-block; skip
        # Order: fajr_start, fajr_iqamah, sunrise, dhuhr_s, dhuhr_iq, asr_s, asr_iq,
        #        maghrib_s, maghrib_iq, isha_s, isha_iq, [jumuah]
        t = times
        wd = datetime.strptime(iso, "%Y-%m-%d").strftime("%a")
        rows.append({
            "date": iso, "day": wd, "islamic_day": "",
            "sehri_ends": t[0], "fajr_start": t[0], "sunrise": t[2], "zawal": "",
            "zohr": t[3], "asr": t[5], "esha": t[9],
            "fajr_jamaat": t[1], "zohar_jamaat": t[4], "asr_jamaat": t[6],
            "maghrib_iftari": t[7], "maghrib_jamaat": t[8], "esha_jamaat": t[10],
        })
    # de-dup by date (keep last), sort
    by_date = {r["date"]: r for r in rows}
    return [by_date[d] for d in sorted(by_date)]


def upsert_csv(csv_path: Path, new_rows: list[dict]) -> int:
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


def load_existing_config(p: Path) -> dict:
    if not p.exists():
        return {}
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def prefer_existing(existing, new):
    if existing is None or (isinstance(existing, str) and not existing.strip()):
        return new
    return existing


def build_config(slug: str, mid: str, existing: dict, row_count: int) -> dict:
    def keep(field, new):
        return prefer_existing(existing.get(field), new)
    address = (existing.get("address") or "").strip()
    lat, lng, city = existing.get("latitude"), existing.get("longitude"), existing.get("city")
    if (lat is None or lng is None) and address:
        m = PC_RE.search(address.upper())
        if m:
            info = lookup_uk_postcode(m.group(0))
            if info:
                lat = lat if lat is not None else info.get("latitude")
                lng = lng if lng is not None else info.get("longitude")
                city = city or info.get("admin_district")
    config = {
        "slug": slug,
        "display_name": keep("display_name", slug),
        "city": keep("city", city or ""),
        "latitude": lat, "longitude": lng,
        "country_code": keep("country_code", "GB"),
        "website": keep("website", ""), "logo": keep("logo", ""),
        "address": address, "address_source": existing.get("address_source") or "manual",
        "phone": (existing.get("phone") or "").strip(),
        "email": (existing.get("email") or "").strip(),
        "notes": (existing.get("notes") or "").strip(),
        "timezone": keep("timezone", "Europe/London"),
        "jummah_times": existing.get("jummah_times") or "",
        "csv": f"{slug}.csv",
        "provider": {"type": "masjidal", "ref": {"masjid_id": mid},
                     "source_url": SOURCE_URL.format(mid=mid)},
        "today_only": True,
        "suppress_times": list(existing.get("suppress_times") or []),
        "quality": {"status": "ok", "checked_at": date.today().isoformat(),
                    "row_count": row_count, "warnings": [], "issues": []},
        "acknowledged_issues": list(existing.get("acknowledged_issues") or []),
    }
    for k, v in existing.items():
        if k not in MANAGED_FIELDS and k not in config:
            config[k] = v
    return config


def fetch_one(mid: str, slug: str, data_dir: Path, verbose: bool = True) -> dict:
    config_path = data_dir / "mosques" / f"{slug}.json"
    existing = load_existing_config(config_path)
    html = fetch_html(mid)
    new_rows = parse_widget(html)
    if not new_rows:
        raise RuntimeError(f"Parsed 0 rows for {mid} — widget markup may have changed")
    suppress = existing.get("suppress_times") or []
    for r in new_rows:
        for f in suppress:
            if f in r:
                r[f] = "-"
    row_count = upsert_csv(data_dir / f"{slug}.csv", new_rows)
    config = build_config(slug, mid, existing, row_count)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    json.dump(config, open(config_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    if verbose:
        print(f"  {config['display_name']} — parsed {len(new_rows)} day(s) "
              f"({new_rows[0]['date']}..{new_rows[-1]['date']}), CSV now {row_count} rows")
    return {"slug": slug, "display_name": config["display_name"],
            "added": len(new_rows), "row_count": row_count}


def main():
    p = argparse.ArgumentParser(description="Fetch one masjid from Masjidal/AthanPlus widget.")
    p.add_argument("masjid_id", help="AthanPlus masjid_id (from the embed URL on the masjid's site)")
    p.add_argument("--slug", required=True, help="Local slug for filenames")
    p.add_argument("--data-dir", default="data")
    args = p.parse_args()
    data_dir = Path(args.data_dir)
    fetch_one(args.masjid_id, args.slug, data_dir, verbose=True)
    print(f"index: {regenerate_index(data_dir / 'mosques')} masjids")


if __name__ == "__main__":
    main()
