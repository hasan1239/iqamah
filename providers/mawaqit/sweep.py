"""
providers/mawaqit/sweep.py — discover, filter, and append metro masjids to
the curated list in one shot. No TSV middleman.

Runs Mawaqit word-search against one or more city/town names, dedupes results
across searches, drops false-positive matches by geocoding each city to a
bounding box and excluding any masjid whose lat/lng falls outside the union,
plus the usual iqamaEnabled/closed/already-known checks. Survivors are
appended to data/mawaqit_uk.txt under a labelled comment header. You then
run the bulk fetcher yourself.

Usage (run from repo root):
    # One or more named cities (word + geo search per city, deduped):
    python -m providers.mawaqit.sweep --cities leicester
    python -m providers.mawaqit.sweep --cities "smethwick,west bromwich,wolverhampton"

    # Whole-area sweep — geocodes the area, tiles geo anchors over the bbox.
    # Best when you want everything in a metro without knowing town names:
    python -m providers.mawaqit.sweep --metro birmingham
    python -m providers.mawaqit.sweep --metro "west midlands"
    python -m providers.mawaqit.sweep --metro "greater manchester"

    # Preview without writing:
    python -m providers.mawaqit.sweep --metro birmingham --dry-run

    # Skip the bbox filter (rare — e.g. for international or very loose match):
    python -m providers.mawaqit.sweep --cities birmingham --no-bbox-filter
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from providers import INDEX_FILENAMES
from providers.mawaqit.discover import (
    discover_search,
    extract_city,
    extract_postcode,
)
from providers.mawaqit.fetch import strip_non_english


GEOCODE_DELAY_S = 1.1  # Nominatim asks for ≤1 req/sec


def forward_geocode_city(city: str, country: str = "United Kingdom") -> dict | None:
    """
    Forward-geocode a city/town name to bounding box + centre point via
    OpenStreetMap Nominatim. Returns
        {'bbox': {s, n, w, e}, 'lat': float, 'lon': float, 'display_name': str}
    or None.

    Caller is responsible for honouring Nominatim's 1-req/sec rate limit
    between calls.
    """
    query = urllib.parse.urlencode({
        "q": f"{city}, {country}",
        "format": "jsonv2",
        "limit": 1,
    })
    url = f"https://nominatim.openstreetmap.org/search?{query}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read())
    except Exception as e:
        print(f"  Geocode failed for '{city}': {e}")
        return None
    if not results:
        return None
    r = results[0]
    bb = r.get("boundingbox")  # ["s", "n", "w", "e"] as strings
    if not bb or len(bb) != 4:
        return None
    try:
        return {
            "bbox": {
                "s": float(bb[0]), "n": float(bb[1]),
                "w": float(bb[2]), "e": float(bb[3]),
            },
            "lat": float(r.get("lat")),
            "lon": float(r.get("lon")),
            "display_name": r.get("display_name", ""),
        }
    except (TypeError, ValueError):
        return None


def in_any_bbox(lat: float, lng: float, bboxes: list[dict]) -> bool:
    return any(
        b["s"] <= lat <= b["n"] and b["w"] <= lng <= b["e"]
        for b in bboxes
    )


def name_to_slug(name: str) -> str:
    """
    Slugify a masjid name into a short identifier suitable for filenames
    and URLs. Strips Arabic/non-ASCII first, then:
      "Old Hill Masjid" → "old_hill_masjid"
      "Adam Mosque & Dawah Academy" → "adam_mosque_dawah_academy"
      "BAIT-US-SALAM" → "bait_us_salam"
      "ZAYTUNA MASJID مسجد الزيتونة" → "zaytuna_masjid"
    Returns empty string when the name yields nothing usable (e.g. Arabic-only).
    """
    cleaned = strip_non_english(name or "")
    if not cleaned:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "_", cleaned.lower())
    return slug.strip("_")


def grid_anchors(
    bbox: dict,
    miles_per_cell: float = 5.0,
    max_anchors: int = 25,
) -> tuple[list[tuple[float, float]], int, int, float]:
    """
    Tile a bbox with anchor points roughly `miles_per_cell` apart.
    Returns (anchors, rows, cols, cell_size_used). Each anchor is (lat, lng)
    at the centre of its grid cell. Cell size auto-grows if the requested
    density would exceed `max_anchors`.

    Used by --metro mode to spread Mawaqit geo-searches across an area —
    Mawaqit caps each search at ~23 results, so one anchor only covers ~5mi
    in a dense city. A grid lets us enumerate everything in the area without
    knowing town names upfront.
    """
    lat_mi = (bbox["n"] - bbox["s"]) * 69
    lng_mi = (bbox["e"] - bbox["w"]) * 42  # rough at UK latitudes
    cell = miles_per_cell
    while True:
        rows = max(1, round(lat_mi / cell))
        cols = max(1, round(lng_mi / cell))
        if rows * cols <= max_anchors:
            break
        cell *= 1.2
    anchors = []
    for i in range(rows):
        for j in range(cols):
            lat = bbox["s"] + (i + 0.5) * (bbox["n"] - bbox["s"]) / rows
            lng = bbox["w"] + (j + 0.5) * (bbox["e"] - bbox["w"]) / cols
            anchors.append((lat, lng))
    return anchors, rows, cols, cell


def load_onboarded(mosques_dir: Path) -> set[str]:
    """Mawaqit-provider paths already on disk (provider.ref.path)."""
    out = set()
    for p in mosques_dir.glob("*.json"):
        if p.name in INDEX_FILENAMES:
            continue
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if (cfg.get("provider") or {}).get("type") != "mawaqit":
            continue
        ref = (cfg.get("provider", {}).get("ref") or {}).get("path")
        if ref:
            out.add(ref)
    return out


_KNOWN_PREFIXES = ("# triage-deleted:", "# parked:")


def load_known_in_list(list_path: Path) -> set[str]:
    """
    Mawaqit paths already mentioned in the curated list — whether active,
    triage-deleted, or parked (discovered but intentionally not fetched).
    Avoids re-suggesting the same masjid each sweep.
    """
    if not list_path.exists():
        return set()
    out = set()
    for line in list_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        prefix_match = next((p for p in _KNOWN_PREFIXES if s.startswith(p)), None)
        if prefix_match:
            rest = s[len(prefix_match):].strip()
            parts = rest.split()
            if parts:
                out.add(parts[0])
        elif s.startswith("#") or not s:
            continue
        else:
            parts = s.split()
            if parts:
                out.add(parts[0])
    return out


def main():
    parser = argparse.ArgumentParser(
        description="Sweep: discover + filter + append to mawaqit_uk.txt",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--cities",
        help='Comma-separated city/town names to search. Each runs both a '
             'Mawaqit word search (name match) and a geo search at the city '
             'centre. Best for single-town coverage or a curated list of towns. '
             'Filtered to the union of the cities\' bounding boxes.',
    )
    mode.add_argument(
        "--metro",
        help='Area name to fully enumerate via a geographic grid (e.g. '
             '"birmingham", "west midlands", "greater manchester"). Geocodes '
             'the area, tiles its bbox with ~5-mile geo anchors (capped at 25), '
             'runs Mawaqit geo search at each. Catches every masjid in the '
             'bbox regardless of name — no need to know surrounding town names.',
    )
    parser.add_argument(
        "--label", default="",
        help="Header comment to insert above the appended block.",
    )
    parser.add_argument(
        "--no-bbox-filter", action="store_true",
        help="Skip the geographic bbox filter (rare — e.g. intentionally loose).",
    )
    parser.add_argument(
        "--no-geo-search", action="store_true",
        help="(--cities only) Skip the per-city geographic Mawaqit search.",
    )
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--list-file", default="data/mawaqit_uk.txt")
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be appended; don't touch mawaqit_uk.txt.",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    mosques_dir = data_dir / "mosques"
    list_path = Path(args.list_file)

    cities = [c.strip() for c in args.cities.split(",")] if args.cities else []
    cities = [c for c in cities if c]

    onboarded = load_onboarded(mosques_dir)
    known = load_known_in_list(list_path)

    # Resolve bbox(es) + run discovery searches.
    bboxes: list[dict] = []
    by_slug: dict[str, tuple[dict, str]] = {}

    if args.metro:
        # Metro mode: single area, tiled with a geo-anchor grid.
        print(f"Looking up metro boundary for '{args.metro}' (Nominatim)...")
        info = forward_geocode_city(args.metro)
        if not info:
            print(f"  NOT FOUND — cannot proceed without a bounding box")
            raise SystemExit(1)
        b = info["bbox"]
        lat_mi = (b["n"] - b["s"]) * 69
        lng_mi = (b["e"] - b["w"]) * 42
        print(f"  bbox ~{lat_mi:.1f} × {lng_mi:.1f} mi")
        print(f"  {info['display_name']}")
        if not args.no_bbox_filter:
            bboxes.append(b)

        anchors, rows, cols, cell = grid_anchors(b)
        print(f"\nGrid: {rows} × {cols} = {len(anchors)} geo anchor(s), ~{cell:.1f} mi per cell")
        print()
        for n, (lat, lng) in enumerate(anchors, start=1):
            print(f"[anchor {n}/{len(anchors)}] {lat:.3f}, {lng:.3f}")
            results = discover_search({"lat": lat, "lon": lng}, max_pages=args.max_pages, verbose=True)
            new_here = 0
            for m in results:
                slug = m.get("slug")
                if slug and slug not in by_slug:
                    by_slug[slug] = (m, f"anchor {n}")
                    new_here += 1
            print(f"  +{new_here} new (total unique so far: {len(by_slug)})")
            if n < len(anchors):
                time.sleep(2)  # be polite to mawaqit between anchor searches
            print()
        print(f"Unique candidates across {len(anchors)} anchor(s): {len(by_slug)}")
    else:
        # Cities mode: per-city bbox + per-city word + geo search.
        city_info: dict[str, dict] = {}
        if not (args.no_bbox_filter and args.no_geo_search):
            print("Looking up city boundaries (Nominatim)...")
            for i, city in enumerate(cities):
                info = forward_geocode_city(city)
                if info:
                    b = info["bbox"]
                    lat_mi = (b["n"] - b["s"]) * 69
                    lng_mi = (b["e"] - b["w"]) * 42
                    print(f"  {city:25s} centre {info['lat']:.3f},{info['lon']:.3f}  bbox ~{lat_mi:.1f} × {lng_mi:.1f} mi")
                    city_info[city] = info
                    if not args.no_bbox_filter:
                        bboxes.append(b)
                else:
                    print(f"  {city:25s} NOT FOUND — no bbox filter or geo search for this city")
                if i < len(cities) - 1:
                    time.sleep(GEOCODE_DELAY_S)
            print()

        for city in cities:
            word_results = discover_search({"word": city}, max_pages=args.max_pages, verbose=True)
            for m in word_results:
                slug = m.get("slug")
                if slug and slug not in by_slug:
                    by_slug[slug] = (m, f"{city} (word)")

            if not args.no_geo_search and city in city_info:
                info = city_info[city]
                geo_results = discover_search(
                    {"lat": info["lat"], "lon": info["lon"]},
                    max_pages=args.max_pages,
                    verbose=True,
                )
                geo_new = 0
                for m in geo_results:
                    slug = m.get("slug")
                    if slug and slug not in by_slug:
                        by_slug[slug] = (m, f"{city} (geo)")
                        geo_new += 1
                if geo_new:
                    print(f"  +{geo_new} unique from geo search not seen in word search")
            print()

        print(f"Unique candidates across {len(cities)} city/ies: {len(by_slug)}")

    # Whether bbox filtering is active for the keep/skip pass below
    bbox_active = bboxes and not args.no_bbox_filter

    keepers = []
    filtered = []  # (slug, m, reason) for everything dropped — listed in full
    skipped_by_reason: dict[str, int] = {}
    for slug, (m, source) in by_slug.items():
        reasons = []
        if slug in onboarded:
            reasons.append("already onboarded")
        if slug in known:
            reasons.append("already in list")
        if not m.get("iqamaEnabled"):
            reasons.append("no iqamas")
        if m.get("closed"):
            reasons.append("closed")
        if bbox_active:
            try:
                lat = float(m.get("latitude") or 0)
                lng = float(m.get("longitude") or 0)
            except (TypeError, ValueError):
                lat = lng = 0
            if lat and lng and not in_any_bbox(lat, lng, bboxes):
                pc = extract_postcode(m) or "?"
                reasons.append(f"outside city bbox (postcode {pc})")
        if reasons:
            primary = reasons[0]
            skipped_by_reason[primary] = skipped_by_reason.get(primary, 0) + 1
            filtered.append((slug, m, primary))
            continue
        keepers.append((slug, m, source))

    keepers.sort(key=lambda x: (
        extract_postcode(x[1]),
        x[0],
    ))
    # Group filtered entries by reason for readable output
    filtered.sort(key=lambda x: (x[2], extract_postcode(x[1]), x[0]))

    print()
    print(f"New additions: {len(keepers)}")
    for reason, n in sorted(skipped_by_reason.items(), key=lambda x: -x[1]):
        print(f"  Skipped — {reason}: {n}")

    if filtered:
        print()
        print(f"=== Filtered ({len(filtered)}) ===")
        current_reason = None
        for slug, m, reason in filtered:
            if reason != current_reason:
                print(f"\n  {reason}:")
                current_reason = reason
            pc = extract_postcode(m) or "?"
            print(f"    [{pc:8s}] {m.get('name', slug)[:38]:38s}  {slug}")

    if not keepers:
        print("\nNothing new to append.")
        return

    # Derive a name-based short slug for each keeper, handling collisions
    # against existing configs on disk and other keepers in this batch.
    taken = {p.stem for p in mosques_dir.glob("*.json") if p.name not in INDEX_FILENAMES}
    proposed: list[tuple[str, dict, str]] = []  # (mawaqit_path, masjid_data, short_slug)
    for slug, m, _src in keepers:
        short = name_to_slug(m.get("name") or "")
        if not short:
            # Arabic-only name or empty — fall back to path-derived behaviour
            # by leaving the 2nd column blank; bulk's derive_short_slug handles it
            proposed.append((slug, m, ""))
            continue
        # Collision: append outward postcode, then full postcode, then numeric
        candidate = short
        if candidate in taken:
            pc = extract_postcode(m)
            outward = pc.split(" ")[0].lower() if pc else ""
            if outward and f"{short}_{outward}" not in taken:
                candidate = f"{short}_{outward}"
            elif pc and f"{short}_{pc.replace(' ', '').lower()}" not in taken:
                candidate = f"{short}_{pc.replace(' ', '').lower()}"
            else:
                n = 2
                while f"{short}_{n}" in taken:
                    n += 1
                candidate = f"{short}_{n}"
        taken.add(candidate)
        proposed.append((slug, m, candidate))

    print()
    print("=== Would append ===" if args.dry_run else "=== Appending ===")
    for slug, m, short in proposed:
        pc = extract_postcode(m) or "?"
        short_display = short or "(auto)"
        print(f"  [{pc:8s}] {short_display:24s} ← {m.get('name', slug)[:34]:34s}  {slug}")

    if args.dry_run:
        print("\nDry run — mawaqit_uk.txt not modified")
        return

    # Compose the appended section
    if args.metro:
        default_label = f"Metro sweep: {args.metro}"
        search_summary = f"Metro area: {args.metro}"
    else:
        default_label = f"Sweep ({', '.join(cities)})"
        search_summary = f"Cities searched: {', '.join(cities)}"
    label = args.label.strip() or default_label
    lines_to_add = [
        "",
        f"# {label} — {date.today().isoformat()}",
        f"# {search_summary}",
    ]
    if bbox_active:
        lines_to_add.append(f"# Bbox filter: {len(bboxes)} boundary/ies (Nominatim)")
    lines_to_add.append(f"# {len(proposed)} new entries")
    for path_slug, _m, short in proposed:
        lines_to_add.append(f"{path_slug}  {short}" if short else path_slug)

    existing = list_path.read_text(encoding="utf-8").rstrip() if list_path.exists() else ""
    list_path.write_text(
        existing + "\n".join(lines_to_add) + "\n",
        encoding="utf-8",
    )
    print(f"\nAppended {len(keepers)} entries to {list_path}")
    print("Next: python -m providers.mawaqit.bulk   (will fetch the new ones; existing masjids skip via idempotency)")


if __name__ == "__main__":
    main()
