"""
providers/ — per-source data ingestion for Iqamah.

Each provider (mawaqit, future esalaat, image, manual, …) lives in its own
sub-package and exposes a per-masjid `fetch_one` plus optional discovery and
bulk-fetch tooling. They all write into the same data/mosques/ directory and
share the central index.json.

Anything cross-provider lives in this module.
"""
import json
import urllib.request
from pathlib import Path


def lookup_uk_postcode(postcode: str) -> dict | None:
    """
    Look up a UK postcode via Postcodes.io. Returns the `result` dict
    (admin_ward, admin_district, region, ...) or None on failure.

    Shared across providers (cross-provider util lives here, not in a
    provider sub-package). Postcodes.io is free, no API key, no rate limit.
    """
    if not postcode:
        return None
    try:
        normalised = postcode.replace(" ", "").upper()
        url = f"https://api.postcodes.io/postcodes/{normalised}"
        req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
        if payload.get("status") == 200:
            return payload.get("result")
        return None
    except Exception as e:
        print(f"  Postcode lookup failed: {e}")
        return None


def regenerate_index(mosques_dir: Path) -> int:
    """
    Rebuild data/mosques/index.json by bundling every masjid config in the
    directory, regardless of provider. Mirrors the
    `jq -s '.' $(ls *.json | sort)` step in the GitHub Actions workflows so
    local runs stay in sync without a deploy.
    Returns the number of masjids written.
    """
    index_path = mosques_dir / "index.json"
    configs = []
    for path in sorted(mosques_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            with open(path, encoding="utf-8") as f:
                configs.append(json.load(f))
        except Exception as e:
            print(f"  Skipping {path.name} in index ({e})")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(configs, f, indent=2, ensure_ascii=False)
    return len(configs)
