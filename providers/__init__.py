"""
providers/ — per-source data ingestion for Iqamah.

Each provider (mawaqit, future esalaat, image, manual, …) lives in its own
sub-package and exposes a per-masjid `fetch_one` plus optional discovery and
bulk-fetch tooling. They all write into the same data/mosques/ directory and
share the central index.json.

Anything cross-provider lives in this module.
"""
import csv
import json
import re
import statistics
import urllib.request
from pathlib import Path


def lookup_uk_postcode(postcode: str) -> dict | None:
    """
    Look up a UK postcode via Postcodes.io. Returns the `result` dict
    (admin_ward, admin_district, region, ...) or None on failure.

    Shared across providers (cross-provider util lives here, not in a
    provider sub-package). Postcodes.io is free, no API key, no rate limit.
    """
    if not postcode:
        return None
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


def regenerate_index(mosques_dir: Path) -> int:
    """
    Rebuild data/mosques/index.json by bundling every masjid config in the
    directory, regardless of provider. Mirrors the
    `jq -s '.' $(ls *.json | sort)` step in the GitHub Actions workflows so
    local runs stay in sync without a deploy.
    Returns the number of masjids written.
    """
    index_path = mosques_dir / "index.json"
    configs = []
    for path in sorted(mosques_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            with open(path, encoding="utf-8") as f:
                configs.append(json.load(f))
        except Exception as e:
            print(f"  Skipping {path.name} in index ({e})")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(configs, f, indent=2, ensure_ascii=False)
    return len(configs)


# --- Start-time outlier check (shared across providers) ---
#
# Prayer START times are astronomical: masjids in the same postcode area should
# match within minutes (allowing for twilight-angle and the Shafi'i/Hanafi Asr
# split). An outlier means a miscalculated/misconfigured timetable — the failure
# mode behind both Green Lane (My-Masjid Fajr +61) and the unconfigured MasjidBox
# masjids (Fajr 01:04, Isha after midnight). Returns warning strings — candidates
# for a manual cross-check, not auto-hidden.
#
# Per-prayer tolerance (minutes): Dhuhr/Maghrib tight (barely vary in an area),
# Fajr/Isha looser (angle choice). Asr is one-sided — only LATER-than-peers is
# flagged (an early Shafi'i Asr is legitimate and the safe direction anyway).
START_TOLERANCE = {"zohr": 15, "maghrib_iftari": 15, "fajr_start": 40, "esha": 40}
ASR_LATE_TOLERANCE = 45


def _to_min(t: str):
    if not t or ":" not in t:
        return None
    try:
        h, m = t.split(":")[:2]
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def _postcode_area(address: str) -> str | None:
    """Leading letters of a UK postcode (e.g. 'B8 3PP' -> 'B'). Groups masjids
    by city/region — astronomical times match closely within an area."""
    m = re.search(r"\b([A-Z]{1,2})\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b", (address or "").upper())
    return m.group(1) if m else None


def check_start_outliers(data_dir: Path, slugs_to_check: list[str], ref_date: str) -> list[str]:
    """Compare each checked (visible) masjid's astronomical START times against
    same-postcode-area masjids across the catalogue. Reference medians use only
    trustworthy masjids (not needs_review / hidden) so fake times don't poison
    the comparison."""
    median_field = ["fajr_start", "zohr", "asr", "maghrib_iftari", "esha"]
    by_area: dict[str, list] = {}
    starts: dict[str, dict] = {}
    area_of: dict[str, str] = {}
    no_area = set()  # configs with no parseable postcode — can't be grouped/checked
    check_set = set(slugs_to_check)
    for cfg_path in (data_dir / "mosques").glob("*.json"):
        if cfg_path.name == "index.json":
            continue
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        slug = cfg.get("slug") or cfg_path.stem
        area = _postcode_area(cfg.get("address", ""))
        csv_path = data_dir / f"{slug}.csv"
        if not csv_path.exists():
            continue
        if not area:
            if slug in check_set and not cfg.get("hidden") and (cfg.get("quality") or {}).get("status") != "needs_review":
                no_area.add(slug)
            continue
        try:
            row = next((r for r in csv.DictReader(csv_path.open(encoding="utf-8"))
                        if r["date"] == ref_date), None)
        except Exception:
            row = None
        if not row:
            continue
        starts[slug] = {f: _to_min(row.get(f, "")) for f in median_field}
        area_of[slug] = area
        status = (cfg.get("quality") or {}).get("status")
        if status != "needs_review" and not cfg.get("hidden"):
            by_area.setdefault(area, []).append(slug)
    trustworthy = {s for slugs in by_area.values() for s in slugs}

    warnings = []
    for slug in slugs_to_check:
        if slug not in starts or slug not in trustworthy:
            continue
        peers = [s for s in by_area.get(area_of[slug], []) if s != slug]
        if len(peers) < 2:
            continue
        flags = []
        for f, tol in START_TOLERANCE.items():
            v = starts[slug][f]
            peer_vals = [starts[s][f] for s in peers if starts[s][f] is not None]
            if v is None or not peer_vals:
                continue
            med = statistics.median(peer_vals)
            if abs(v - med) > tol:
                flags.append(f"{f.split('_')[0]} {v // 60:02d}:{v % 60:02d} vs area median {int(med) // 60:02d}:{int(med) % 60:02d}")
        v = starts[slug]["asr"]
        peer_vals = [starts[s]["asr"] for s in peers if starts[s]["asr"] is not None]
        if v is not None and peer_vals:
            med = statistics.median(peer_vals)
            if v - med > ASR_LATE_TOLERANCE:
                flags.append(f"asr {v // 60:02d}:{v % 60:02d} is {v - int(med)}min LATER than area median")
        if flags:
            warnings.append(f"{slug}: " + "; ".join(flags))
    for slug in sorted(no_area):
        warnings.append(f"{slug}: couldn't auto-check (no postcode in address) — verify manually")
    return warnings
