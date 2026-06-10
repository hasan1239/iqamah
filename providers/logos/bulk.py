"""
providers/logos/bulk.py — backfill masjid logos in one sweep.

Reads every config in data/mosques/, skips those that already have a logo,
runs the per-masjid logo fetch for the rest, throttles, and prints a summary.
Regenerates data/mosques/index.json once at the end (only if anything changed).

Output files are left UNSTAGED — review them before `git add`ing.

Usage (run from repo root):
    python -m providers.logos.bulk
    python -m providers.logos.bulk --dry-run
    python -m providers.logos.bulk --limit 5
    python -m providers.logos.bulk --only central,aisha
    python -m providers.logos.bulk --force        # re-fetch even if logo set
    python -m providers.logos.bulk --delay 1.0
"""
import argparse
import json
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

from providers import INDEX_FILENAMES, regenerate_index
from providers.logos.fetch import fetch_one

# Windows consoles default to cp1252; force UTF-8 so our checkmarks don't blow
# up. Safe no-op on Linux/Mac. Mirrors providers/mawaqit/bulk.py:46-49.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


DEFAULT_DELAY_S = 1.5


def collect_candidates(mosques_dir, *, force, only):
    """
    Walk data/mosques/ and return the list of masjids the bulk run should
    consider, in slug order. Skips index.json and any config that can't be
    parsed (logs and continues).
    """
    only_set = {s.strip() for s in only.split(",") if s.strip()} if only else None
    entries = []
    for path in sorted(mosques_dir.glob("*.json")):
        if path.name in INDEX_FILENAMES:
            continue
        slug = path.stem
        if only_set and slug not in only_set:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                config = json.load(f)
        except Exception as e:
            print(f"  Skipping {slug}: {e}")
            continue
        has_logo = bool((config.get("logo") or "").strip())
        if has_logo and not force:
            continue
        entries.append({
            "slug": slug,
            "display_name": config.get("display_name") or slug,
            "website": (config.get("website") or "").strip(),
            "has_logo": has_logo,
        })
    return entries


def main():
    parser = argparse.ArgumentParser(
        description="Backfill masjid logos by scraping websites + Mawaqit search.",
    )
    parser.add_argument("--data-dir", default="data",
                        help="Base data directory (default: data)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Stop after N entries processed (0 = all)")
    parser.add_argument("--only", default="",
                        help="Comma-separated slugs to include (filters the list)")
    parser.add_argument("--force", action="store_true",
                        help="Re-fetch even when config.logo is already set")
    parser.add_argument("--dry-run", action="store_true",
                        help="List planned work and exit; no network, no writes")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_S,
                        help=f"Seconds between masjids (default {DEFAULT_DELAY_S})")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"

    entries = collect_candidates(mosques_dir, force=args.force, only=args.only)
    if not entries:
        print("Nothing to do — every masjid already has a logo. Use --force to re-fetch.")
        return

    if args.limit:
        entries = entries[: args.limit]

    print(f"Planned: {len(entries)} masjid(s)")
    for e in entries:
        flag = "[website+mawaqit]" if e["website"] else "[mawaqit only]"
        suffix = " (replace existing)" if e["has_logo"] else ""
        print(f"  - {e['slug']:24s} {flag:18s}  {e['display_name']}{suffix}")

    if args.dry_run:
        return

    results = []
    status_counter = Counter()

    print("")
    for i, entry in enumerate(entries, start=1):
        print(f"\n[{i}/{len(entries)}] {entry['slug']} ({entry['display_name']})")
        print("-" * 72)
        try:
            summary = fetch_one(entry["slug"], data_dir, force=args.force, verbose=True)
            results.append(summary)
            key = summary["source"] or summary["status"]
            status_counter[key] += 1
            mark = "✓" if summary["status"] == "set" else "·"
            label = summary.get("source") or summary["status"]
            print(f"  {mark} {label}")
        except Exception as e:
            print(f"  ✗ FAILED: {e}")
            traceback.print_exc()
            status_counter["errors"] += 1
            results.append({"slug": entry["slug"], "status": "error", "error": str(e)})

        if i < len(entries):
            time.sleep(args.delay)

    if any(r.get("status") == "set" for r in results):
        count = regenerate_index(mosques_dir)
        print(f"\nRegenerated {mosques_dir / 'index.json'} ({count} masjids)")

    print("\n" + "=" * 72)
    print("Summary")
    print("=" * 72)
    label_map = {
        "website":   "set from website",
        "mawaqit":   "set from Mawaqit search",
        "not_found": "no logo found",
        "skipped":   "already had a logo",
        "errors":    "errored",
    }
    for key, label in label_map.items():
        if status_counter[key]:
            print(f"  {status_counter[key]:3d}  {label}")

    print("\nNew files are unstaged — review then `git add data/logos/ data/mosques/`.")


if __name__ == "__main__":
    main()
