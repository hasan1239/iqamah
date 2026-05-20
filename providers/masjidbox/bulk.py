"""
providers/masjidbox/bulk.py — daily fetch for the curated MasjidBox list.

Reads data/masjidbox_uk.txt (MasjidBox slug + optional local slug), upserts
today/tomorrow into each masjid's CSV, throttles, continues past failures, and
regenerates the index once. Designed to run daily from the 2am workflow.

List format (data/masjidbox_uk.txt):
    # comments allowed
    # <masjidbox-slug>  [<local-slug>]
    green-lane-masjid-1666108368685  green_lane
    sparkbrook-masjid

Usage (run from repo root):
    python -m providers.masjidbox.bulk
    python -m providers.masjidbox.bulk --limit 3
    python -m providers.masjidbox.bulk --dry-run
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from providers import regenerate_index, check_start_outliers
from providers.masjidbox.fetch import fetch_one, fetch_athany, slugify

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_LIST = "data/masjidbox_uk.txt"
FETCH_DELAY_S = 2.0


def parse_list_file(path: Path) -> list[tuple[str, str | None]]:
    entries = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            entries.append((parts[0], parts[1] if len(parts) > 1 else None))
    return entries


def existing_slugs(mosques_dir: Path) -> set[str]:
    return {p.stem for p in mosques_dir.glob("*.json") if p.name != "index.json"}


def existing_mbslug_to_slug(mosques_dir: Path) -> dict[str, str]:
    mapping = {}
    for p in mosques_dir.glob("*.json"):
        if p.name == "index.json":
            continue
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        prov = cfg.get("provider") or {}
        if prov.get("type") == "masjidbox":
            ref = (prov.get("ref") or {}).get("slug")
            if ref:
                mapping[ref] = p.stem
    return mapping


def unique_slug(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def main():
    p = argparse.ArgumentParser(description="Bulk daily-fetch MasjidBox masjids from a curated list.")
    p.add_argument("--list-file", default=DEFAULT_LIST)
    p.add_argument("--data-dir", default="data")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--only", default="", help="Comma-separated MasjidBox slugs to include")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--delay", type=float, default=FETCH_DELAY_S)
    args = p.parse_args()

    list_path = Path(args.list_file)
    if not list_path.exists():
        print(f"List file not found: {list_path}")
        raise SystemExit(1)

    entries = parse_list_file(list_path)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        entries = [e for e in entries if e[0] in wanted]

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"
    taken = existing_slugs(mosques_dir)
    mb_to_slug = existing_mbslug_to_slug(mosques_dir)

    # Resolve local slugs (idempotent: reuse existing slug for a known MasjidBox slug)
    resolved = []
    for mb_slug, override in entries:
        if mb_slug in mb_to_slug:
            slug = mb_to_slug[mb_slug]
        elif override:
            slug = unique_slug(override, taken)
        else:
            slug = None  # derive from name at fetch time
        if slug:
            taken.add(slug)
        resolved.append((mb_slug, slug))

    if args.dry_run:
        print("Dry run — would fetch:")
        for mb_slug, slug in resolved:
            print(f"  {(slug or '<derive>'):28s} <- {mb_slug}")
        return

    ok, fail = [], []
    for i, (mb_slug, slug) in enumerate(resolved, 1):
        try:
            if slug is None:
                slug = unique_slug(slugify(fetch_athany(mb_slug).get("name") or mb_slug), taken)
                taken.add(slug)
            summary = fetch_one(mb_slug, slug, data_dir, verbose=False)
            ok.append(summary)
            print(f"[{i}/{len(resolved)}] ✓ {summary['display_name']} ({summary['row_count']} rows)")
        except Exception as e:
            print(f"[{i}/{len(resolved)}] ✗ {mb_slug}: {e}")
            traceback.print_exc()
            fail.append({"mb_slug": mb_slug, "error": str(e)})
        if args.limit and len(ok) >= args.limit:
            break
        if i < len(resolved):
            time.sleep(args.delay)

    if ok:
        print(f"\nRegenerated index ({regenerate_index(mosques_dir)} masjids)")

    # Start-time outlier check: catches unconfigured MasjidBox masjids (high-angle
    # calc + flat +10 iqamah → Isha after midnight) and any miscalculated timetable.
    if ok:
        import datetime as _dt
        outliers = check_start_outliers(data_dir, [s["slug"] for s in ok],
                                        _dt.date.today().isoformat())
        if outliers:
            print(f"\n  ⚠ {len(outliers)} start-time outlier(s) — verify against the masjid's")
            print("      board; set \"hidden\": true on any whose times are wrong (esp. Isha after midnight).")
            print("      (Asr 'later than median' on Hanafi masjids in a Salafi-heavy area is usually a false positive.)")
            for w in outliers:
                print(f"      - {w}")

    print(f"\nSummary: {len(ok)} ok, {len(fail)} failed")
    for f in fail:
        print(f"  ✗ {f['mb_slug']}: {f['error']}")


if __name__ == "__main__":
    main()
