"""
Re-run the sun-position check (providers/sun.py) for every live-feed masjid
from the CSVs already on disk, with no network. Replaces each config's sun_times_*
issues and recomputes its status, leaving every other issue untouched.

Run daily (generate.yml) so the 14-day hide window moves with the calendar
even for feeds that are only fetched weekly (Mawaqit, My-Masjid) or yearly
(LondonPrayerTimes): a calendar that's an hour out from next month gets hidden
before those days arrive.

    python -m providers.requalify            # update configs + index
    python -m providers.requalify --dry-run  # print status changes only
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from providers import INDEX_FILENAMES, regenerate_index
from providers.sun import sun_time_issues, sun_time_warnings

LIVE_FEEDS = ("mawaqit", "mymasjid", "masjidbox", "masjidal", "londonprayertimes")
SUN_TYPES = ("sun_times_unsafe", "sun_times_off", "sun_times_late", "sun_times_early")


def requalify(config: dict, rows: list[dict], today=None) -> dict:
    """Return the config's quality block with fresh sun issues and status."""
    q = dict(config.get("quality") or {})
    lat = config.get("latitude") if config.get("latitude") is not None else config.get("lat")
    lon = config.get("longitude") if config.get("longitude") is not None else config.get("lon")
    acknowledged = set(config.get("acknowledged_issues") or [])

    issues = [i for i in q.get("issues", []) if i.get("type") not in SUN_TYPES]
    warnings = [w for w in q.get("warnings", []) if not w.startswith("Sunrise/Maghrib")]
    fresh = sun_time_issues(rows, lat, lon, today=today)
    for issue in fresh:
        if issue["type"] in acknowledged:
            issue["acknowledged"] = True
    issues += fresh
    warnings += sun_time_warnings(fresh)

    unacked = [i for i in issues if not i.get("acknowledged")]
    if not unacked:
        status = "ok"
    elif any(i.get("severity") == "high" for i in unacked):
        status = "needs_review"
    else:
        status = "warnings"
    q.update(issues=issues, warnings=warnings, status=status)
    return q


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    data_dir = Path(args.data_dir)

    changed = 0
    for path in sorted((data_dir / "mosques").glob("*.json")):
        if path.name in INDEX_FILENAMES:
            continue
        raw = path.read_text(encoding="utf-8")
        config = json.loads(raw)
        if (config.get("provider") or {}).get("type") not in LIVE_FEEDS:
            continue
        csv_path = data_dir / (config.get("csv") or f"{config['slug']}.csv")
        if not csv_path.exists():
            continue
        with open(csv_path, encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
        old = config.get("quality") or {}
        new = requalify(config, rows)
        if new == old:
            continue
        changed += 1
        if new.get("status") != old.get("status"):
            print(f"{config['slug']}: {old.get('status')} -> {new['status']}")
        if not args.dry_run:
            config["quality"] = new
            path.write_text(json.dumps(config, indent=2, ensure_ascii=False)
                            + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")

    print(f"{changed} config(s) {'would change' if args.dry_run else 'updated'}")
    if changed and not args.dry_run:
        print(f"index: {regenerate_index(data_dir / 'mosques')} masjids")


if __name__ == "__main__":
    main()
