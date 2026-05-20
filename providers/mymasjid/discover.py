"""
providers/mymasjid/discover.py — enumerate UK masjids on time.my-masjid.com.

My-Masjid has no "list all" endpoint, but GetPublicFilteredMasjid returns ALL
matches for a search term (no real pagination). Sweeping a set of vowels +
common masjid words and deduping by guidId captures effectively the whole
directory (~2,400 globally; ~540 UK). We filter to country == "United Kingdom"
and write a TSV the maintainer curates into data/mymasjid_uk.txt.

Usage (run from repo root):
    python -m providers.mymasjid.discover
    python -m providers.mymasjid.discover --out data/mymasjid_candidates.tsv
"""
import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

API_SEARCH = (
    "https://time.my-masjid.com/api/Masjid/GetPublicFilteredMasjid"
    "?searchParam={q}&isPublished=1"
)

# Vowels alone catch almost every name; the extra words mop up the rest.
SWEEP_TERMS = list("aeiou") + [
    "masjid", "mosque", "islam", "jamia", "jame", "jamea", "madras",
    "centre", "center", "trust", "dar", "bait", "bayt", "noor", "rahma",
]

DEFAULT_OUT = "data/mymasjid_candidates.tsv"


def slugify(name: str) -> str:
    """
    Name → URL-safe slug. Strips non-ASCII (Arabic/Urdu), lowercases,
    collapses non-alphanumerics to underscores. Mirrors the spirit of the
    Mawaqit name-based slugs.
    """
    ascii_only = "".join(c for c in (name or "") if ord(c) < 128)
    s = ascii_only.lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    s = re.sub(r"_+", "_", s)
    return s or "masjid"


def search(term: str) -> list[dict]:
    url = API_SEARCH.format(q=urllib.parse.quote(term))
    req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read())
    model = payload.get("model") or {}
    return model.get("masjidList") or []


def sweep(delay: float = 0.4) -> dict[str, dict]:
    """Sweep all terms, dedupe by guidId. Returns {guidId: masjid}."""
    seen: dict[str, dict] = {}
    for term in SWEEP_TERMS:
        try:
            for m in search(term):
                if m.get("guidId"):
                    seen[m["guidId"]] = m
        except Exception as e:
            print(f"  term {term!r} failed: {e}")
        time.sleep(delay)
    return seen


def main():
    parser = argparse.ArgumentParser(description="Discover UK masjids on My-Masjid.")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"Output TSV (default: {DEFAULT_OUT})")
    parser.add_argument("--country", default="United Kingdom", help="Country filter")
    parser.add_argument("--delay", type=float, default=0.4, help="Seconds between searches")
    args = parser.parse_args()

    print(f"Sweeping {len(SWEEP_TERMS)} terms...")
    seen = sweep(args.delay)
    print(f"Found {len(seen)} unique published masjids globally")

    uk = [m for m in seen.values() if m.get("country") == args.country]
    uk.sort(key=lambda m: (m.get("city") or "", m.get("name") or ""))
    print(f"{args.country}: {len(uk)} masjids")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# guidId\tsuggested_slug\tname\tcity\taddress\n")
        for m in uk:
            f.write("\t".join([
                m.get("guidId", ""),
                slugify(m.get("name", "")),
                (m.get("name") or "").replace("\t", " "),
                (m.get("city") or "").replace("\t", " "),
                (m.get("address") or "").replace("\t", " ").replace("\n", " "),
            ]) + "\n")
    print(f"Wrote {out_path} ({len(uk)} rows)")
    print("Curate it, then paste wanted rows (guidId + optional slug) into data/mymasjid_uk.txt")


if __name__ == "__main__":
    main()
