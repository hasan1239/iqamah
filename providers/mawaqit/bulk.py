"""
providers/mawaqit/bulk.py — process a curated list of Mawaqit slugs in one go.

Reads data/mawaqit_uk.txt (or --list-file), runs the per-masjid fetch pipeline
for each entry, throttles requests, continues past per-masjid failures, and
prints a summary at the end. Regenerates data/mosques/index.json once.

Curated list format (data/mawaqit_uk.txt):
    # Lines starting with # are comments and skipped
    # One slug per line; optional short slug as a second whitespace-separated field
    amanah-masjid-birmingham-b11-1jb-united-kingdom  amanah
    quba-islamic-cultural-centre-birmingham-b7-4ny-united-kingdom  quba_aston
    south-birmingham-central-masjid-birmingham-b139ls-united-kingdom

When the short slug is omitted, the script auto-derives one:
  1. base = first hyphen-separated token of the mawaqit path (e.g. "quba"),
     pulling in the next token when the first is a short Arabic prefix
     ("al-falah-..." → "al_falah") or a generic mosque word
     ("masjid-abdul-..." → "masjid_abdul").
  2. If base collides with an existing masjid config, append outward postcode
     (e.g. "quba_b7"); if still collides, append the inward part too
     ("quba_b74ny"); last resort, append a numeric suffix.

Usage (run from repo root):
    python -m providers.mawaqit.bulk
    python -m providers.mawaqit.bulk --list-file data/mawaqit_uk.txt --limit 5
    python -m providers.mawaqit.bulk --only amanah-masjid-...,quba-islamic-...
    python -m providers.mawaqit.bulk --dry-run
"""
import argparse
import json
import re
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

from providers import INDEX_FILENAMES, regenerate_index
from providers.mawaqit.fetch import (
    extract_postcode_from_slug,
    fetch_one,
)

# Windows consoles default to cp1252; force UTF-8 so our checkmarks and arrows
# don't blow up. Safe no-op on Linux/Mac.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


DEFAULT_LIST = "data/mawaqit_uk.txt"
MAWAQIT_DELAY_S = 2.0   # gap between mawaqit.net fetches
GEOCODE_DELAY_S = 1.2   # geocoding happens inside fetch_one when address is empty


def parse_list_file(path: Path) -> list[tuple[str, str | None]]:
    """
    Parse the curated list. Returns a list of (mawaqit_path, short_slug_override).
    short_slug_override is None when the user wants us to derive it.
    """
    entries = []
    with open(path, encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            mawaqit_path = parts[0]
            short_slug = parts[1] if len(parts) > 1 else None
            entries.append((mawaqit_path, short_slug))
    return entries


SHORT_PREFIXES = {"al", "el", "an", "as", "ar", "at", "ad", "az", "ash", "ath"}

# Generic mosque words. On their own they're useless as a slug ("masjid",
# "mosque") so we always pull in the next token to identify the specific
# masjid (e.g. masjid-abdul-raheem → masjid_abdul).
GENERIC_PREFIXES = {"masjid", "mosque", "jamia", "jame", "jamea", "jameah"}


def _base_from_path(mawaqit_path: str) -> str:
    """
    Derive a sensible base slug from the mawaqit URL path.
    Rules:
      - Generic mosque word ('masjid', 'mosque', ...) → take next token too,
        and one more if it's a short Arabic prefix
        ('masjid-al-huda-...' → 'masjid_al_huda')
      - Short Arabic prefix as first token ('al', 'el', ...) → combine with
        next token ('al-falah-...' → 'al_falah')
      - Otherwise take just the first token
    """
    tokens = [t for t in mawaqit_path.split("-") if t]
    if not tokens:
        return "masjid"
    first = tokens[0].lower()

    if first in GENERIC_PREFIXES and len(tokens) > 1:
        second = tokens[1].lower()
        if second in SHORT_PREFIXES and len(tokens) > 2:
            base = f"{first}_{second}_{tokens[2].lower()}"
        else:
            base = f"{first}_{second}"
    elif first in SHORT_PREFIXES and len(tokens) > 1:
        base = f"{first}_{tokens[1].lower()}"
    else:
        base = first

    return re.sub(r"[^a-z0-9_]", "", base) or "masjid"


def derive_short_slug(mawaqit_path: str, taken: set[str]) -> str:
    """
    Pick a unique short slug for this masjid given the set already in use.
    Strategy:
      1. base = first token (or first two if it's a short Arabic prefix)
      2. If unique → use it
      3. Append outward postcode (e.g. 'quba_b7')
      4. Append full postcode (e.g. 'quba_b74ny')
      5. Numeric suffix as last resort ('quba_2', 'quba_3', ...)
    """
    base = _base_from_path(mawaqit_path)
    if base not in taken:
        return base

    postcode = extract_postcode_from_slug(mawaqit_path)
    if postcode:
        outward = postcode.split(" ")[0].lower()
        candidate = f"{base}_{outward}"
        if candidate not in taken:
            return candidate
        candidate = f"{base}_{postcode.replace(' ', '').lower()}"
        if candidate not in taken:
            return candidate

    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def existing_short_slugs(mosques_dir: Path) -> set[str]:
    """Set of slugs currently checked into data/mosques/."""
    return {p.stem for p in mosques_dir.glob("*.json") if p.name not in INDEX_FILENAMES}


def existing_path_to_slug(mosques_dir: Path) -> dict[str, str]:
    """
    Map each existing masjid's mawaqit `provider.ref.path` back to its short
    slug, so re-fetches are idempotent (e.g. fetching
    amanah-masjid-...-united-kingdom keeps using `amanah`, not a new
    `amanah_b11` derived from collision rules).
    Only includes configs whose provider.type is 'mawaqit'.
    """
    mapping = {}
    for p in mosques_dir.glob("*.json"):
        if p.name in INDEX_FILENAMES:
            continue
        try:
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            continue
        provider = cfg.get("provider") or {}
        if provider.get("type") != "mawaqit":
            continue
        ref_path = (provider.get("ref") or {}).get("path")
        if ref_path:
            mapping[ref_path] = p.stem
    return mapping


def main():
    parser = argparse.ArgumentParser(
        description="Run fetch_mawaqit for every entry in a curated list.",
    )
    parser.add_argument("--list-file", default=DEFAULT_LIST,
                        help=f"Curated list path (default: {DEFAULT_LIST})")
    parser.add_argument("--data-dir", default="data",
                        help="Base data directory (default: data)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Stop after N successful fetches (0 = all)")
    parser.add_argument("--only", default="",
                        help="Comma-separated list of mawaqit paths to include "
                             "(filters the curated list down)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse the list and print what would be fetched; no network calls")
    parser.add_argument("--delay", type=float, default=MAWAQIT_DELAY_S,
                        help=f"Seconds between Mawaqit fetches (default {MAWAQIT_DELAY_S})")
    args = parser.parse_args()

    list_path = Path(args.list_file)
    if not list_path.exists():
        print(f"List file not found: {list_path}")
        print(f"Run `python -m providers.mawaqit.discover --city <name>` first, then paste slugs into it.")
        raise SystemExit(1)

    entries = parse_list_file(list_path)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        entries = [e for e in entries if e[0] in wanted]
        if not entries:
            print(f"--only filter matched no entries in {list_path}")
            raise SystemExit(1)

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"

    print(f"Loaded {len(entries)} entries from {list_path}")

    # Pre-resolve short slugs so we can flag collisions before any network call.
    # Re-fetches stay idempotent: if a config already exists with this exact
    # mawaqit path, reuse its short slug instead of deriving a new one.
    taken = existing_short_slugs(mosques_dir)
    path_to_slug = existing_path_to_slug(mosques_dir)
    resolved = []
    for mawaqit_path, override in entries:
        if override:
            short = override
        elif mawaqit_path in path_to_slug:
            short = path_to_slug[mawaqit_path]
        else:
            short = derive_short_slug(mawaqit_path, taken)
        taken.add(short)
        resolved.append((mawaqit_path, short))

    if args.dry_run:
        print("\nDry run — would fetch:")
        for mawaqit_path, short in resolved:
            print(f"  {short:24s} ← {mawaqit_path}")
        return

    successes = []
    failures = []
    status_counter = Counter()

    print("")
    for i, (mawaqit_path, short) in enumerate(resolved, start=1):
        print(f"\n[{i}/{len(resolved)}] {short} ← {mawaqit_path}")
        print("-" * 72)
        try:
            summary = fetch_one(
                mawaqit_path, short, data_dir,
                verbose=False,
            )
            successes.append(summary)
            status_counter[summary["status"]] += 1
            print(f"  ✓ {summary['display_name']}  ({summary['status']}, {summary['row_count']} days)")
        except Exception as e:
            print(f"  ✗ FAILED: {e}")
            traceback.print_exc()
            failures.append({
                "mawaqit_path": mawaqit_path,
                "slug": short,
                "error": str(e),
            })

        if args.limit and len(successes) >= args.limit:
            print(f"\nReached --limit {args.limit}; stopping early")
            break

        if i < len(resolved):
            time.sleep(args.delay)

    # Final index regeneration
    if successes:
        count = regenerate_index(mosques_dir)
        print(f"\nRegenerated {mosques_dir / 'index.json'} ({count} masjids)")

    # Summary
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
            print(f"      - {f['slug']:24s}  {f['error']}")

    if any(s["status"] == "needs_review" for s in successes):
        print("\nMasjids with status=needs_review are hidden from the public list.")
        print("Review their data/mosques/<slug>.json, then either:")
        print("  - Add to acknowledged_issues (e.g. [\"isha_clamped\"])")
        print("  - Fix the underlying data and re-fetch")


if __name__ == "__main__":
    main()
