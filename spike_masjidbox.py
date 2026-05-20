"""One-off spike: probe MasjidBox widget API to see what it returns.

Run from repo root:   python spike_masjidbox.py

Saves raw JSON dumps to data/raw/spike_masjidbox/{slug}__{label}.json and
prints a summary of fields, day coverage, and iqama presence.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://api.masjidbox.com/1.0/masjidbox/landing/athany"
API_KEY = "JejYcMS7hsOsZTPDk2ZhKOAlW9IyQ6Px"

SAMPLE_SLUGS = [
    "eastlondonmosque",
    "bournemouth-islamic-centre-and-central-mosque",
    "northampton-mosque-and-islamic-centre",
]

OUT_DIR = Path("data/raw/spike_masjidbox")


def fetch(slug: str, days: int, begin: str, extra_headers: dict | None = None) -> tuple[int, bytes, dict]:
    url = f"{BASE}/{slug}?get=at&days={days}&begin={begin}"
    headers = {
        "User-Agent": "Mozilla/5.0 (spike)",
        "Accept": "application/json",
        "apikey": API_KEY,
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def save(slug: str, label: str, body: bytes) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{slug}__{label}.json"
    path.write_bytes(body)
    return path


def summarise(label: str, body: bytes) -> None:
    try:
        data = json.loads(body)
    except Exception as e:
        print(f"  [{label}] not JSON: {e}; first 200B: {body[:200]!r}")
        return

    print(f"  [{label}] top-level type: {type(data).__name__}")
    if isinstance(data, dict):
        print(f"           top-level keys: {list(data.keys())[:20]}")
        for key in list(data.keys())[:5]:
            val = data[key]
            kind = type(val).__name__
            if isinstance(val, list):
                print(f"             .{key}: list[{len(val)}]"
                      + (f"  first item keys: {list(val[0].keys())[:15]}" if val and isinstance(val[0], dict) else ""))
            elif isinstance(val, dict):
                print(f"             .{key}: dict keys={list(val.keys())[:15]}")
            else:
                preview = repr(val)[:80]
                print(f"             .{key}: {kind} = {preview}")
    elif isinstance(data, list):
        print(f"           list[{len(data)}]"
              + (f"  first item keys: {list(data[0].keys())[:15]}" if data and isinstance(data[0], dict) else ""))

    blob = json.dumps(data).lower()
    print(f"           mentions 'iqama'? {'iqama' in blob}   'jama'? {'jama' in blob}   'athan'? {'athan' in blob}")


def main() -> int:
    today = dt.date.today().isoformat()
    print(f"=== MasjidBox spike — begin={today} ===\n")

    for slug in SAMPLE_SLUGS:
        print(f"--- {slug} ---")

        for days in (7, 30, 90, 365, 999):
            status, body, headers = fetch(slug, days=days, begin=today)
            content_len = len(body)
            print(f"  days={days:>4}  http={status}  bytes={content_len}  ctype={headers.get('Content-Type', '?')}")
            if status == 200 and content_len > 0:
                path = save(slug, f"days{days}", body)
                if days in (30, 365):
                    summarise(f"days={days}", body)
            time.sleep(0.5)

        status, body, _ = fetch(slug, days=30, begin=today, extra_headers={
            "Origin": "https://masjidbox.com",
            "Referer": f"https://masjidbox.com/prayer-times/{slug}",
        })
        print(f"  with Origin+Referer:  http={status}  bytes={len(body)}")
        if status == 200:
            save(slug, "days30_with_referer", body)

        status, body, _ = fetch(slug, days=30, begin=today, extra_headers={"apikey": "x"})
        print(f"  with bogus apikey:    http={status}  bytes={len(body)}")

        print()
        time.sleep(1)

    print(f"Saved raw responses to {OUT_DIR.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
