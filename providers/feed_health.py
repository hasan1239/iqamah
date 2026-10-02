"""
Which live-feed masjids have no timetable row for today (UK date)?

    python -m providers.feed_health                      # all live feeds
    python -m providers.feed_health --types mawaqit,mymasjid
    python -m providers.feed_health --fail               # exit 1 if any are missing

Used by generate.yml twice: to trigger a full-year refresh as soon as a
full-year feed runs out (e.g. on 1 January, when Mawaqit/My-Masjid/
LondonPrayerTimes CSVs still end on 31 December), and as the final step that
fails the run (GitHub emails the owner) when any feed has no times today.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from providers import INDEX_FILENAMES
from providers.sun import uk_utc_offset_minutes

LIVE_FEEDS = ("mawaqit", "mymasjid", "masjidbox", "masjidal", "londonprayertimes")


def uk_today():
    """Today in the UK, without needing a tz database (Windows has none)."""
    now = datetime.now(timezone.utc)
    local = now + timedelta(minutes=uk_utc_offset_minutes(now.date()))
    # The rule is day-granular; around 01:00 UTC on change days this is
    # within an hour either way, which can't move the date at 00:07 UK.
    return local.date()


def missing_today(data_dir: Path, types=LIVE_FEEDS, today=None) -> list[str]:
    today = (today or uk_today()).isoformat()
    missing = []
    for path in sorted((data_dir / "mosques").glob("*.json")):
        if path.name in INDEX_FILENAMES:
            continue
        cfg = json.loads(path.read_text(encoding="utf-8"))
        ptype = (cfg.get("provider") or {}).get("type")
        if ptype not in types or cfg.get("hidden") or cfg.get("test_masjid"):
            continue
        csv_path = data_dir / (cfg.get("csv") or f"{cfg['slug']}.csv")
        dates = set()
        if csv_path.exists():
            with open(csv_path, encoding="utf-8", newline="") as f:
                dates = {(r.get("date") or r.get("Date") or "").strip() for r in csv.DictReader(f)}
        if today not in dates:
            missing.append(f"{cfg['slug']} ({ptype})")
    return missing


def main():
    ap = argparse.ArgumentParser(description="List live-feed masjids with no row for today")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--types", default=",".join(LIVE_FEEDS))
    ap.add_argument("--fail", action="store_true", help="exit 1 if any are missing")
    args = ap.parse_args()
    missing = missing_today(Path(args.data_dir), tuple(t.strip() for t in args.types.split(",")))
    for m in missing:
        print(m)
    if missing and args.fail:
        print(f"::error::No times for {uk_today()} from: " + ", ".join(missing), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
