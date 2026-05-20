"""
providers/mymasjid/bulk.py — process a curated list of My-Masjid masjids.

Reads data/mymasjid_uk.txt, runs fetch_one per entry, throttles, continues
past per-masjid failures, prints a summary, and regenerates index.json once.

Curated list format (data/mymasjid_uk.txt):
    # Lines starting with # are comments and skipped.
    # One masjid per line: <guidId> [<short_slug>]
    # If the slug is omitted it's derived from the masjid name (fetched).
    287de68e-2345-461d-ac74-64b96c3c5840  east_london_mosque
    3147aa71-0096-42cf-ab69-31c71bcaa742

Usage (run from repo root):
    python -m providers.mymasjid.bulk
    python -m providers.mymasjid.bulk --limit 5
    python -m providers.mymasjid.bulk --only 287de68e-...,3147aa71-...
    python -m providers.mymasjid.bulk --dry-run
"""
import argparse
import json
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

from providers import regenerate_index
from providers.mymasjid.fetch import fetch_one, fetch_timings
from providers.mymasjid.discover import slugify

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_LIST = "data/mymasjid_uk.txt"
FETCH_DELAY_S = 1.5


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


def existing_guid_to_slug(mosques_dir: Path) -> dict[str, str]:
    """Map mymasjid provider.ref.guidId → existing slug, for idempotent re-fetch."""
    mapping = {}
    for p in mosques_dir.glob("*.json"):
        if p.name == "index.json":
            continue
        try:
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            continue
        provider = cfg.get("provider") or {}
        if provider.get("type") != "mymasjid":
            continue
        guid = (provider.get("ref") or {}).get("guidId")
        if guid:
            mapping[guid] = p.stem
    return mapping


def unique_slug(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def main():
    parser = argparse.ArgumentParser(description="Bulk-fetch My-Masjid masjids from a curated list.")
    parser.add_argument("--list-file", default=DEFAULT_LIST)
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--limit", type=int, default=0, help="Stop after N successes (0=all)")
    parser.add_argument("--only", default="", help="Comma-separated guidIds to include")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delay", type=float, default=FETCH_DELAY_S)
    args = parser.parse_args()

    list_path = Path(args.list_file)
    if not list_path.exists():
        print(f"List file not found: {list_path}")
        print("Run `python -m providers.mymasjid.discover` first, then curate the TSV into it.")
        raise SystemExit(1)

    entries = parse_list_file(list_path)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        entries = [e for e in entries if e[0] in wanted]
        if not entries:
            print(f"--only matched no entries in {list_path}")
            raise SystemExit(1)

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"

    print(f"Loaded {len(entries)} entries from {list_path}")

    taken = existing_slugs(mosques_dir)
    guid_to_slug = existing_guid_to_slug(mosques_dir)

    # Resolve slugs. Idempotent: if the guid already maps to a config, reuse it.
    # When no slug override and no existing mapping, we need the name → derive
    # lazily at fetch time (a tiny extra request in dry-run only).
    resolved = []
    for guid, override in entries:
        if guid in guid_to_slug:
            slug = guid_to_slug[guid]
        elif override:
            slug = unique_slug(override, taken)
        else:
            slug = None  # derive at fetch time from the masjid name
        if slug:
            taken.add(slug)
        resolved.append((guid, slug))

    if args.dry_run:
        print("\nDry run — would fetch:")
        for guid, slug in resolved:
            print(f"  {(slug or '<derive-from-name>'):28s} ← {guid}")
        return

    successes, failures = [], []
    status_counter = Counter()

    for i, (guid, slug) in enumerate(resolved, start=1):
        if slug is None:
            try:
                model = fetch_timings(guid)
                base = slugify((model.get("masjidDetails") or {}).get("name") or guid)
                slug = unique_slug(base, taken)
                taken.add(slug)
            except Exception as e:
                print(f"\n[{i}/{len(resolved)}] {guid}\n  ✗ FAILED (name lookup): {e}")
                failures.append({"guid": guid, "slug": "?", "error": str(e)})
                continue

        print(f"\n[{i}/{len(resolved)}] {slug} ← {guid}")
        print("-" * 72)
        try:
            summary = fetch_one(guid, slug, data_dir, verbose=False)
            successes.append(summary)
            status_counter[summary["status"]] += 1
            print(f"  ✓ {summary['display_name']}  ({summary['status']}, {summary['row_count']} days)")
        except Exception as e:
            print(f"  ✗ FAILED: {e}")
            traceback.print_exc()
            failures.append({"guid": guid, "slug": slug, "error": str(e)})

        if args.limit and len(successes) >= args.limit:
            print(f"\nReached --limit {args.limit}; stopping early")
            break
        if i < len(resolved):
            time.sleep(args.delay)

    if successes:
        count = regenerate_index(mosques_dir)
        print(f"\nRegenerated {mosques_dir / 'index.json'} ({count} masjids)")

    print("\n" + "=" * 72)
    print("Summary")
    print("=" * 72)
    print(f"  ✓ {len(successes)} succeeded")
    for status in ("ok", "warnings", "needs_review"):
        if status_counter[status]:
            label = {
                "ok": "ok (visible)",
                "warnings": "warnings (visible)",
                "needs_review": "needs_review (HIDDEN until acknowledged)",
            }[status]
            print(f"      - {status_counter[status]:3d}  {label}")
    if failures:
        print(f"  ✗ {len(failures)} failed:")
        for f in failures:
            print(f"      - {f['slug']:28s}  {f['error']}")

    if any(s["status"] == "needs_review" for s in successes):
        print("\nMasjids with status=needs_review are hidden from the public list.")
        print("Review their data/mosques/<slug>.json, then acknowledge or fix + re-fetch.")


if __name__ == "__main__":
    main()
