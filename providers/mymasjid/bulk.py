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
import re
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

from providers import regenerate_index
from providers.mymasjid.fetch import fetch_one, fetch_timings
from providers.mymasjid.discover import slugify, dedup_key

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_LIST = "data/mymasjid_uk.txt"
FETCH_DELAY_S = 1.5

# Per-prayer tolerance (minutes) for the start-time outlier check. Dhuhr (solar
# noon) and Maghrib (sunset) barely vary between masjids in the same area, so a
# tight bound flags miscalculation reliably. Fajr/Isha vary by twilight-angle
# choice and Asr by madhab (Shafi'i vs Hanafi ~60-70min apart), so they get
# looser bounds. Asr is one-sided: only LATER-than-peers is flagged (an early
# Shafi'i Asr is legitimate and the safe direction anyway).
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
    """
    Compare each checked masjid's astronomical START times against other masjids
    in the same postcode area (across the WHOLE catalogue, for a good median).
    Start times can't legitimately differ much within an area, so an outlier
    means a miscalculated timetable (wrong location/angle/madhab, or a DST bug)
    — the failure mode behind Green Lane (Fajr +61min). Returns warning strings;
    these are candidates for a manual MasjidBox cross-check, not auto-hidden.
    """
    import csv as _csv
    median_field = ["fajr_start", "zohr", "asr", "maghrib_iftari", "esha"]
    by_area: dict[str, list] = {}   # trustworthy masjids only (reference medians)
    starts: dict[str, dict] = {}
    area_of: dict[str, str] = {}
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
        if not area or not csv_path.exists():
            continue
        try:
            row = next((r for r in _csv.DictReader(csv_path.open(encoding="utf-8"))
                        if r["date"] == ref_date), None)
        except Exception:
            row = None
        if not row:
            continue
        starts[slug] = {f: _to_min(row.get(f, "")) for f in median_field}
        area_of[slug] = area
        # Only TRUSTWORTHY masjids seed the reference medians — placeholder/hidden
        # masjids carry fake times that would poison the comparison.
        status = (cfg.get("quality") or {}).get("status")
        if status != "needs_review" and not cfg.get("hidden"):
            by_area.setdefault(area, []).append(slug)
    trustworthy = {s for slugs in by_area.values() for s in slugs}

    import statistics
    warnings = []
    for slug in slugs_to_check:
        # Only check VISIBLE masjids — already-hidden/needs_review ones are out
        # of public view, so an outlier there isn't a live risk.
        if slug not in starts or slug not in trustworthy:
            continue
        area = area_of[slug]
        peers = [s for s in by_area.get(area, []) if s != slug]
        if len(peers) < 2:
            continue  # not enough trustworthy local reference points
        flags = []
        for f, tol in START_TOLERANCE.items():
            v = starts[slug][f]
            peer_vals = [starts[s][f] for s in peers if starts[s][f] is not None]
            if v is None or not peer_vals:
                continue
            med = statistics.median(peer_vals)
            if abs(v - med) > tol:
                flags.append(f"{f.split('_')[0]} {v // 60:02d}:{v % 60:02d} vs area median {int(med) // 60:02d}:{int(med) % 60:02d}")
        # Asr: one-sided (later than peers only)
        v = starts[slug]["asr"]
        peer_vals = [starts[s]["asr"] for s in peers if starts[s]["asr"] is not None]
        if v is not None and peer_vals:
            med = statistics.median(peer_vals)
            if v - med > ASR_LATE_TOLERANCE:
                flags.append(f"asr {v // 60:02d}:{v % 60:02d} is {v - int(med)}min LATER than area median")
        if flags:
            warnings.append(f"{slug}: " + "; ".join(flags))
    return warnings


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
    seen_keys: dict[str, str] = {}  # house+postcode -> first slug, for dup warnings
    dup_warnings = []

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
            # Intra-batch duplicate safety net: two list entries that resolve to
            # the same physical masjid (same house number + postcode).
            try:
                cfg = json.loads((data_dir / "mosques" / f"{slug}.json").read_text(encoding="utf-8"))
                key = dedup_key(cfg.get("display_name", ""), cfg.get("address", ""))
                if key and key in seen_keys:
                    msg = f"{slug} looks like a duplicate of {seen_keys[key]} (same address)"
                    dup_warnings.append(msg)
                    print(f"  ⚠ DUPLICATE: {msg} — keep only one")
                elif key:
                    seen_keys[key] = slug
            except Exception:
                pass
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

    if dup_warnings:
        print(f"\n  ⚠ {len(dup_warnings)} suspected duplicate(s) — delete one of each:")
        for w in dup_warnings:
            print(f"      - {w}")

    if successes:
        import datetime as _dt
        outliers = check_start_outliers(data_dir, [s["slug"] for s in successes],
                                        _dt.date.today().isoformat())
        if outliers:
            print(f"\n  ⚠ {len(outliers)} start-time outlier(s) — astronomical times that don't")
            print("      match same-area masjids, so the timetable may be miscalculated.")
            print("      Cross-check against the masjid's own site (e.g. MasjidBox); hide if our")
            print("      jama'at is LATER than reality (set \"hidden\": true in the config):")
            for w in outliers:
                print(f"      - {w}")

    if any(s["status"] == "needs_review" for s in successes):
        print("\nMasjids with status=needs_review are hidden from the public list.")
        print("Review their data/mosques/<slug>.json, then acknowledge or fix + re-fetch.")


if __name__ == "__main__":
    main()
