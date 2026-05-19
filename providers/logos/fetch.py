"""
providers/logos/fetch.py — resolve a logo for one masjid.

Cascade:
  1. If config.logo already set → skip (use --force to override).
  2. config.website → fetch HTML, try og:image / largest apple-touch-icon /
     twitter:image / icon links / /favicon.ico. Download to data/logos/.
  3. Mawaqit search by display_name (+ postcode hint from address) → use the
     matched masjid's Mawaqit CDN logo URL directly.
  4. No-op.

Usage (run from repo root, e.g. after a user submits a timetable via /add):
    python -m providers.logos.fetch <slug>
    python -m providers.logos.fetch <slug> --force
"""
import argparse
import json
import re
from pathlib import Path

from providers import regenerate_index
from providers.logos import (
    extract_logo_candidates,
    fetch_bytes,
    is_valid_logo,
    mawaqit_search,
    save_logo,
)


UK_POSTCODE_RE = re.compile(
    r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b",
    re.IGNORECASE,
)


def _extract_postcode(address):
    if not address:
        return None
    m = UK_POSTCODE_RE.search(address)
    if not m:
        return None
    return f"{m.group(1).upper()} {m.group(2).upper()}"


def _try_website(config, slug, logos_dir, verbose):
    website = (config.get("website") or "").strip()
    if not website:
        return None
    if verbose:
        print(f"  Website: {website}")
    page = fetch_bytes(website)
    if not page:
        if verbose:
            print(f"    fetch failed")
        return None
    body, ctype = page
    if "html" not in ctype:
        if verbose:
            print(f"    not HTML ({ctype})")
        return None
    try:
        html = body.decode("utf-8", errors="replace")
    except Exception:
        return None

    for candidate in extract_logo_candidates(html, website):
        if verbose:
            print(f"    candidate: {candidate}")
        got = fetch_bytes(candidate)
        if not got:
            if verbose:
                print(f"      fetch failed")
            continue
        data, c_ctype = got
        ok, ext = is_valid_logo(data, c_ctype)
        if not ok:
            if verbose:
                print(f"      rejected (type={c_ctype}, {len(data)} bytes)")
            continue
        rel = save_logo(data, slug, ext, logos_dir)
        if verbose:
            print(f"      -> {rel} ({len(data)} bytes)")
        return rel
    return None


def _try_mawaqit(config, verbose):
    name = (config.get("display_name") or "").strip()
    if not name:
        return None
    postcode = _extract_postcode(config.get("address"))
    if verbose:
        print(f"  Mawaqit search: '{name}' (postcode hint: {postcode or 'none'})")
    hit = mawaqit_search(name, postcode_hint=postcode)
    if not hit:
        if verbose:
            print(f"    no confident match")
        return None
    if verbose:
        print(f"    matched '{hit['display_name']}' -> {hit['logo_url']}")
    return hit["logo_url"]


def _write_config(config_path, config):
    """Atomic write so a Ctrl-C mid-write doesn't corrupt the config."""
    tmp = config_path.with_suffix(config_path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp.replace(config_path)


def fetch_one(slug, data_dir, *, force=False, verbose=True):
    """
    Resolve a logo for one masjid. Reads data/mosques/{slug}.json, runs the
    cascade, writes the config back if a logo was found.

    Returns {slug, status, source, value} where:
      status ∈ {"set", "skipped", "not_found"}
      source ∈ {"website", "mawaqit", None}
      value  = the string written to config.logo (or the existing one if skipped)

    Does NOT regenerate index.json — caller decides when (CLI does it
    immediately; bulk does it once at the end).
    """
    config_path = data_dir / "mosques" / f"{slug}.json"
    if not config_path.exists():
        raise FileNotFoundError(f"No config at {config_path}")

    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    existing = (config.get("logo") or "").strip()
    if existing and not force:
        if verbose:
            print(f"  Already has logo: {existing}")
        return {"slug": slug, "status": "skipped", "source": None, "value": existing}

    logos_dir = data_dir / "logos"

    rel = _try_website(config, slug, logos_dir, verbose)
    if rel:
        config["logo"] = rel
        _write_config(config_path, config)
        return {"slug": slug, "status": "set", "source": "website", "value": rel}

    url = _try_mawaqit(config, verbose)
    if url:
        config["logo"] = url
        _write_config(config_path, config)
        return {"slug": slug, "status": "set", "source": "mawaqit", "value": url}

    if verbose:
        print(f"  No logo found.")
    return {"slug": slug, "status": "not_found", "source": None, "value": None}


def main():
    parser = argparse.ArgumentParser(
        description="Resolve a logo for one masjid (website scrape + Mawaqit search).",
    )
    parser.add_argument("slug", help="Masjid slug, e.g. central")
    parser.add_argument("--force", action="store_true",
                        help="Re-fetch even when config.logo is already set")
    parser.add_argument("--data-dir", default="data",
                        help="Base data directory (default: data)")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    summary = fetch_one(args.slug, data_dir, force=args.force, verbose=True)
    print(f"\nResult: {summary}")

    if summary["status"] == "set":
        mosques_dir = data_dir / "mosques"
        count = regenerate_index(mosques_dir)
        print(f"Regenerated {mosques_dir / 'index.json'} ({count} masjids)")


if __name__ == "__main__":
    main()
