"""
providers/masjidal/bulk.py — daily fetch for the curated Masjidal list.

Reads data/masjidal_uk.txt (AthanPlus masjid_id + local slug), scrapes ~7 days
into each masjid's CSV, runs the shared start-time outlier check, regenerates
the index. Run daily from the 2am workflow (the widget's window is ~7 days, so
a missed run is well covered).

List format (data/masjidal_uk.txt):
    # comments allowed
    # <athanplus-masjid-id>  <local-slug>
    QKMqqaKB  london_central_mosque
"""
import argparse
import datetime
import json
import sys
import time
import traceback
from pathlib import Path

from providers import regenerate_index, check_start_outliers
from providers.masjidal.fetch import fetch_one

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_LIST = "data/masjidal_uk.txt"
FETCH_DELAY_S = 2.0


def parse_list_file(path: Path) -> list[tuple[str, str]]:
    entries = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2:
                entries.append((parts[0], parts[1]))
    return entries


def main():
    p = argparse.ArgumentParser(description="Bulk daily-fetch Masjidal/AthanPlus masjids.")
    p.add_argument("--list-file", default=DEFAULT_LIST)
    p.add_argument("--data-dir", default="data")
    p.add_argument("--delay", type=float, default=FETCH_DELAY_S)
    args = p.parse_args()

    list_path = Path(args.list_file)
    if not list_path.exists():
        print(f"List file not found: {list_path}")
        raise SystemExit(1)

    data_dir = Path(args.data_dir)
    entries = parse_list_file(list_path)
    ok, fail = [], []
    for i, (mid, slug) in enumerate(entries, 1):
        try:
            s = fetch_one(mid, slug, data_dir, verbose=False)
            ok.append(s)
            print(f"[{i}/{len(entries)}] ✓ {s['display_name']} ({s['row_count']} rows)")
        except Exception as e:
            print(f"[{i}/{len(entries)}] ✗ {mid}: {e}")
            traceback.print_exc()
            fail.append({"mid": mid, "error": str(e)})
        if i < len(entries):
            time.sleep(args.delay)

    if ok:
        print(f"\nRegenerated index ({regenerate_index(data_dir / 'mosques')} masjids)")
        outliers = check_start_outliers(data_dir, [s["slug"] for s in ok],
                                        datetime.date.today().isoformat())
        if outliers:
            print(f"\n  ⚠ {len(outliers)} start-time outlier(s) — verify against the masjid's board:")
            for w in outliers:
                print(f"      - {w}")

    print(f"\nSummary: {len(ok)} ok, {len(fail)} failed")
    for f in fail:
        print(f"  ✗ {f['mid']}: {f['error']}")


if __name__ == "__main__":
    main()
