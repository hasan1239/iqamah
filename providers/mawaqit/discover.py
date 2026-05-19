"""
providers/mawaqit/discover.py — enumerate UK masjids on Mawaqit so you can
curate which ones to onboard into Iqamah.

Mawaqit exposes an undocumented public search API:
  https://mawaqit.net/api/2.0/mosque/search?word=<keyword>&page=<N>
  https://mawaqit.net/api/2.0/mosque/search?lat=<lat>&lon=<lon>&page=<N>

This script paginates through the search results, filters to UK masjids, and
writes a TSV you can sort/filter in a spreadsheet. Pick the rows you want and
paste their slug column into data/mawaqit_uk.txt for the bulk fetcher to pull.

Usage (run from repo root):
    python -m providers.mawaqit.discover --city birmingham
    python -m providers.mawaqit.discover --word "east london"
    python -m providers.mawaqit.discover --lat 52.486 --lon -1.890 --label birmingham_area
    python -m providers.mawaqit.discover --city manchester --max-pages 5

Output:
    data/mawaqit_candidates_<label>.tsv
"""
import argparse
import csv
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path


SEARCH_URL = "https://mawaqit.net/api/2.0/mosque/search"
PAGE_DELAY_S = 1.2  # be polite to Mawaqit


def fetch_search_page(params: dict) -> list:
    """Hit one page of Mawaqit's search API. Returns the JSON array."""
    query = urllib.parse.urlencode(params)
    url = f"{SEARCH_URL}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def paginate(base_params: dict, max_pages: int = 20) -> list:
    """Walk pages 1..max_pages until an empty page comes back."""
    results = []
    seen_slugs = set()
    for page in range(1, max_pages + 1):
        params = {**base_params, "page": page}
        try:
            batch = fetch_search_page(params)
        except Exception as e:
            print(f"  Page {page} failed: {e}; stopping pagination")
            break
        if not batch:
            break
        # Dedupe defensively in case the API returns overlaps near boundaries
        new = [m for m in batch if m.get("slug") not in seen_slugs]
        for m in new:
            seen_slugs.add(m.get("slug"))
        results.extend(new)
        print(f"  Page {page}: +{len(new)} (total {len(results)})")
        time.sleep(PAGE_DELAY_S)
    return results


UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b", re.IGNORECASE)


def is_uk(masjid: dict) -> bool:
    """Identify UK masjids by slug suffix or address text."""
    slug = (masjid.get("slug") or "").lower()
    if slug.endswith("-united-kingdom"):
        return True
    loc = (masjid.get("localisation") or "").lower()
    if "united kingdom" in loc:
        return True
    # Some UK entries have just a postcode — last-resort check
    return bool(UK_POSTCODE_RE.search(masjid.get("localisation") or ""))


def extract_postcode(masjid: dict) -> str:
    """Pull a UK postcode out of the localisation or slug."""
    for field in ("localisation", "slug"):
        text = masjid.get(field) or ""
        m = UK_POSTCODE_RE.search(text)
        if m:
            return f"{m.group(1).upper()} {m.group(2).upper()}"
    return ""


def extract_city(masjid: dict) -> str:
    """
    Extract the city by taking text between the postcode and 'United Kingdom'.
    Mawaqit's localisation format is consistently
    '<street> <postcode> <CITY> United Kingdom' (mixed casing).
    """
    loc = (masjid.get("localisation") or "").strip()
    if not loc:
        return ""
    if loc.lower().endswith("united kingdom"):
        loc = loc[: -len("United Kingdom")].rstrip(", ").strip()
    m = UK_POSTCODE_RE.search(loc)
    if m:
        after = loc[m.end():].lstrip(", ").strip()
        if after:
            words = [w.strip(",.") for w in after.split()[:3] if w.strip(",.")]
            return " ".join(words).title()
    return ""


def write_tsv(masjids: list, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cols = [
        "slug", "name", "city", "postcode",
        "lat", "lon",
        "iqama_enabled", "closed",
        "jumua", "has_image", "has_email", "has_phone", "has_site",
        "association", "localisation",
    ]
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols, delimiter="\t")
        writer.writeheader()
        for m in masjids:
            writer.writerow({
                "slug": m.get("slug") or "",
                "name": (m.get("name") or "").strip(),
                "city": extract_city(m),
                "postcode": extract_postcode(m),
                "lat": m.get("latitude") or "",
                "lon": m.get("longitude") or "",
                "iqama_enabled": "yes" if m.get("iqamaEnabled") else "no",
                "closed": "yes" if m.get("closed") else "no",
                "jumua": m.get("jumua") or "",
                "has_image": "yes" if m.get("image") else "no",
                "has_email": "yes" if m.get("email") else "no",
                "has_phone": "yes" if m.get("phone") else "no",
                "has_site": "yes" if m.get("site") else "no",
                "association": (m.get("associationName") or "").strip(),
                "localisation": (m.get("localisation") or "").replace("\n", " ").replace("\t", " "),
            })


def discover_search(
    base_params: dict,
    max_pages: int = 20,
    uk_only: bool = True,
    verbose: bool = True,
) -> list[dict]:
    """
    Run one search against Mawaqit, paginate to exhaustion, optionally UK-filter,
    sort with iqama-enabled first. Returns the raw masjid dicts (same shape as
    Mawaqit's API response). Used by both the CLI and the sweep tool — keeps
    the side-effect (TSV write) out of the reusable path.
    """
    if verbose:
        print(f"Searching Mawaqit ({base_params})...")
    all_results = paginate(base_params, max_pages=max_pages)
    if verbose:
        print(f"  fetched {len(all_results)} masjid(s) total")
    results = [m for m in all_results if is_uk(m)] if uk_only else list(all_results)
    if verbose and uk_only:
        print(f"  UK-filtered: {len(results)}")
    results.sort(key=lambda m: (
        0 if m.get("iqamaEnabled") else 1,
        m.get("slug") or "",
    ))
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Discover UK masjids on Mawaqit and write a curatable TSV.",
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--city", help="City name to search (uses Mawaqit's ?word=)")
    src.add_argument("--word", help="Arbitrary keyword search term (uses ?word=)")
    src.add_argument("--lat", type=float, help="Latitude (use with --lon for geo search)")
    parser.add_argument("--lon", type=float, help="Longitude (used with --lat)")
    parser.add_argument("--label", help="Filename label (default: derived from --city/--word/coords)")
    parser.add_argument("--max-pages", type=int, default=20, help="Pagination cap (default 20)")
    parser.add_argument("--data-dir", default="data", help="Output directory (default: data)")
    parser.add_argument(
        "--no-uk-filter",
        action="store_true",
        help="Skip the UK filter (include international results)",
    )
    args = parser.parse_args()

    if args.lat is not None and args.lon is None:
        parser.error("--lat requires --lon")

    if args.city:
        base = {"word": args.city}
        label = args.label or args.city.lower().replace(" ", "_")
    elif args.word:
        base = {"word": args.word}
        label = args.label or re.sub(r"\W+", "_", args.word.lower()).strip("_")
    else:
        base = {"lat": args.lat, "lon": args.lon}
        label = args.label or f"geo_{args.lat:.3f}_{args.lon:.3f}".replace("-", "n")

    uk = discover_search(base, max_pages=args.max_pages, uk_only=not args.no_uk_filter)

    out_path = Path(args.data_dir) / f"mawaqit_candidates_{label}.tsv"
    write_tsv(uk, out_path)
    print(f"\nWrote {out_path}")

    # Quick breakdown
    iq = sum(1 for m in uk if m.get("iqamaEnabled"))
    closed = sum(1 for m in uk if m.get("closed"))
    print(f"  iqamaEnabled: {iq}/{len(uk)}")
    print(f"  closed:       {closed}/{len(uk)}")
    print(f"\nReview the TSV in a spreadsheet, then paste slugs you want into")
    print(f"data/mawaqit_uk.txt — one per line, optionally with a short slug:")
    print(f"  amanah-masjid-birmingham-b11-1jb-united-kingdom  amanah")


if __name__ == "__main__":
    main()
