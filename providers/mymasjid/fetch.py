"""
providers/mymasjid/fetch.py — Single-masjid My-Masjid fetcher.

Pulls a full year of prayer times from time.my-masjid.com's public API,
applies UK DST (their times are stored in GMT/standard form — see DST note),
normalises to Iqamah's 16-field schema, runs quality checks, and writes a
CSV + metadata JSON.

API (public, no auth):
    GET /api/TimingsInfoScreen/GetMasjidTimings?GuidId={guid}
      → { model: { masjidDetails, masjidSettings, salahTimings[366],
                   jumahSalahIqamahTimings, ... } }

DST (critical):
    My-Masjid stores times in GMT/standard (winter) form. The display layer
    adds +1h during British Summer Time. We mirror that: for UK masjids with
    masjidSettings.isDstOn, every time on a date inside the BST window gets
    +60 minutes. Verified against MasjidBox for East London Mosque — winter
    rows match as-is, summer rows match after +1h.

Preservation behaviour mirrors the Mawaqit provider: user-editable fields are
kept on re-fetch; unknown fields carried forward; idempotent on provider.ref.guidId.

Usage (run from repo root):
    python -m providers.mymasjid.fetch 287de68e-2345-461d-ac74-64b96c3c5840 --slug east_london_mosque

Outputs:
    data/{slug}.csv               — parsed prayer times
    data/mosques/{slug}.json      — masjid config + quality report
    data/raw/{slug}.json          — raw GetMasjidTimings model (debug/audit)
"""
import argparse
import csv
import json
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from providers import lookup_uk_postcode, regenerate_index


API_BASE = "https://time.my-masjid.com/api"
TIMINGS_URL = API_BASE + "/TimingsInfoScreen/GetMasjidTimings?GuidId={guid}"
SOURCE_URL = "https://time.my-masjid.com/timingsInfoScreen/{guid}"

# Fields this script manages. Anything else in an existing config is carried
# forward untouched (same contract as the Mawaqit provider).
MANAGED_FIELDS = {
    "slug", "display_name", "city", "association", "address", "address_source",
    "phone", "email", "notes", "website", "logo", "latitude", "longitude",
    "timezone", "country_code", "jummah_times", "csv", "provider", "quality",
    "acknowledged_issues",
}


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_timings(guid: str) -> dict:
    """Fetch GetMasjidTimings and return the `model` dict."""
    url = TIMINGS_URL.format(guid=urllib.parse.quote(guid))
    req = urllib.request.Request(url, headers={"User-Agent": "iqamah.co.uk"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    if payload.get("hasError"):
        raise RuntimeError(f"API error for {guid}: {payload.get('message')}")
    model = payload.get("model")
    if not model or not model.get("salahTimings"):
        raise RuntimeError(f"No salahTimings in response for {guid}")
    return model


# ---------------------------------------------------------------------------
# Time + DST helpers
# ---------------------------------------------------------------------------

def _last_sunday(year: int, month: int) -> date:
    """Date of the last Sunday in the given month."""
    d = date(year, month, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - 6) % 7)


def is_uk_bst(d: date) -> bool:
    """
    True if the date falls within British Summer Time.

    BST runs from the last Sunday of March to the last Sunday of October.
    We treat the March transition Sunday as BST (clocks go forward at 01:00,
    so all prayers that day are BST) and the October transition Sunday as GMT
    (clocks go back at 02:00; treating the whole day as GMT is the safer call
    for prayer times). Sub-day precision isn't needed.
    """
    start = _last_sunday(d.year, 3)
    end = _last_sunday(d.year, 10)
    return start <= d < end


def parse_hhmm(t: str) -> int | None:
    """Parse 'HH:MM' (or 'H:MM') to minutes-since-midnight. None if unparseable."""
    if not t or ":" not in t:
        return None
    try:
        h, m = t.split(":")[:2]
        h, m = int(h), int(m)
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def fmt_minutes(total: int) -> str:
    """Format minutes-since-midnight to 'HH:MM' (wraps within a day)."""
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def shift(t: str, mins: int) -> str:
    """Add `mins` to an 'HH:MM' time. Pass-through if unparseable/empty."""
    base = parse_hhmm(t)
    if base is None:
        return t or ""
    return fmt_minutes(base + mins)


# ---------------------------------------------------------------------------
# Normalise
# ---------------------------------------------------------------------------

# Iqamah's 16-field CSV schema (must match providers/mawaqit/fetch.py output).
def _row(d: date, day_data: dict, jummah_iqamah: str, dst_mins: int) -> dict:
    def s(key: str) -> str:
        return shift(day_data.get(key, ""), dst_mins)

    fajr = s("fajr")
    zohar_jamaat = s("iqamah_Zuhr")
    # Friday → Jummah iqamah replaces the daily Dhuhr iqamah
    if d.weekday() == 4 and jummah_iqamah:
        zohar_jamaat = shift(jummah_iqamah, dst_mins) if False else jummah_iqamah

    return {
        "date": d.isoformat(),
        "day": d.strftime("%a"),
        "islamic_day": "",
        "sehri_ends": fajr,             # My-Masjid has no imsak; sehri = fajr start
        "fajr_start": fajr,
        "sunrise": s("shouruq"),
        "zawal": "",
        "zohr": s("zuhr"),
        "asr": s("asr"),
        "esha": s("isha"),
        "fajr_jamaat": s("iqamah_Fajr"),
        "zohar_jamaat": zohar_jamaat,
        "asr_jamaat": s("iqamah_Asr"),
        "maghrib_iftari": s("maghrib"),
        "maghrib_jamaat": s("iqamah_Maghrib"),
        "esha_jamaat": s("iqamah_Isha"),
    }


def normalise(model: dict, year: int) -> list[dict]:
    """Walk salahTimings → one 16-field row per day, with DST applied."""
    settings = model.get("masjidSettings") or {}
    is_dst_on = bool(settings.get("isDstOn"))

    jummah = ""
    jlist = model.get("jumahSalahIqamahTimings") or []
    if jlist:
        primary = next((j for j in jlist if j.get("isPrimary")), jlist[0])
        jummah = primary.get("iqamahTime") or ""
    if settings.get("jummahTimeEqualsZuhrTime"):
        jummah = ""  # let the daily Dhuhr iqamah stand

    rows = []
    for entry in model["salahTimings"]:
        day, month = entry.get("day"), entry.get("month")
        if not day or not month:
            continue
        try:
            d = date(year, month, day)
        except ValueError:
            continue  # e.g. Feb 29 in a non-leap year
        dst_mins = 60 if (is_dst_on and is_uk_bst(d)) else 0
        rows.append(_row(d, entry, jummah, dst_mins))

    rows.sort(key=lambda r: r["date"])
    return rows


# ---------------------------------------------------------------------------
# Quality checks
# ---------------------------------------------------------------------------

PRAYER_ORDER = ["fajr_start", "sunrise", "zohr", "asr", "maghrib_iftari", "esha"]
IQAMA_PAIRS = [
    ("fajr_start", "fajr_jamaat"), ("zohr", "zohar_jamaat"),
    ("asr", "asr_jamaat"), ("maghrib_iftari", "maghrib_jamaat"),
    ("esha", "esha_jamaat"),
]
# Window used ONLY to trigger the ±12h auto-correct (repair_glitches): a value
# outside this is a candidate for an AM/PM typo fix.
IQAMA_LO, IQAMA_HI = -10, 180

# Loose sanity window for flagging genuinely-broken (non-Fajr) jama'at times as
# needs_review. Wide enough to permit legitimate patterns we verified in real
# data — Jummah held before the calculated Dhuhr start (up to ~75min early),
# fixed jama'ats that drift before their start, and late-summer gaps — while
# still catching gross errors (e.g. a 5am Dhuhr jamaat that ±12h can't fix).
# Fajr is exempt: its real constraint is "before sunrise", checked separately.
JAMAAT_LO, JAMAAT_HI = -180, 240


def _pm_fix(value_min: int, lo: int, hi: int) -> int | None:
    """
    If a ±12h shift lands `value_min` cleanly inside [lo, hi], return the
    corrected minutes. This is the ONLY auto-correction we allow — it catches
    unambiguous AM/PM typos (e.g. a Dhuhr iqamah entered as 01:00 instead of
    13:00). Returns None when no single 12h shift resolves it, in which case
    the value is left untouched and flagged for review.
    """
    for delta in (720, -720):
        c = value_min + delta
        if lo <= c <= hi:
            return c
    return None


def repair_glitches(rows: list[dict]) -> list[dict]:
    """
    Auto-correct only the high-confidence AM/PM (±12h) errors, mutating rows
    in place. Two passes per row:
      1. Start times: if a start breaks the strict fajr<sunrise<zuhr<asr<
         maghrib<isha ordering, try ±12h to seat it between its valid
         neighbours.
      2. Iqamah times: if an iqamah falls outside [start-10, start+180], try
         ±12h to bring it into the window (anchored to the corrected start).
    Anything a single 12h shift can't resolve is left as-is for quality_check
    to flag as `time_glitch` → needs_review. Returns an audit list of
    {date, field, old, new}.
    """
    corrections = []
    for r in rows:
        # Pass 1 — start ordering
        starts = {f: parse_hhmm(r[f]) for f in PRAYER_ORDER}
        for idx, f in enumerate(PRAYER_ORDER):
            v = starts[f]
            if v is None:
                continue
            left = starts[PRAYER_ORDER[idx - 1]] if idx > 0 else None
            right = starts[PRAYER_ORDER[idx + 1]] if idx < len(PRAYER_ORDER) - 1 else None
            out_of_place = (left is not None and v <= left) or (right is not None and v >= right)
            if not out_of_place:
                continue
            lo = (left + 1) if left is not None else 0
            hi = (right - 1) if right is not None else 24 * 60 - 1
            if lo > hi:
                continue  # neighbours themselves broken — leave for flagging
            fixed = _pm_fix(v, lo, hi)
            if fixed is not None:
                corrections.append({"date": r["date"], "field": f, "old": r[f], "new": fmt_minutes(fixed)})
                r[f] = fmt_minutes(fixed)
                starts[f] = fixed

        # Pass 2 — iqamah windows (anchored to possibly-corrected starts)
        for start_f, iq_f in IQAMA_PAIRS:
            st = parse_hhmm(r[start_f])
            iq = parse_hhmm(r[iq_f])
            if st is None or iq is None:
                continue
            if IQAMA_LO <= (iq - st) <= IQAMA_HI:
                continue
            fixed = _pm_fix(iq, st + IQAMA_LO, st + IQAMA_HI)
            if fixed is not None:
                corrections.append({"date": r["date"], "field": iq_f, "old": r[iq_f], "new": fmt_minutes(fixed)})
                r[iq_f] = fmt_minutes(fixed)
    return corrections


def quality_check(rows: list[dict], acknowledged: list[str] | None = None,
                  corrections: list[dict] | None = None) -> dict:
    """
    Quality checks. Reuses the Mawaqit-style signals (fajr_after_sunrise,
    iqamas_unconfigured, sehri_unconfigured) plus a My-Masjid-specific
    `time_glitch` check for the AM/PM and entry errors seen in the data
    (e.g. a zuhr iqamah of 01:00, a zuhr start of 23:57).
    """
    acknowledged = set(acknowledged or [])
    warnings, issues = [], []

    # sehri unconfigured (always true — My-Masjid has no imsak field)
    warnings.append(
        "My-Masjid has no Suhoor field — sehri_ends equals fajr_start year-round. "
        "During Ramadan, users may expect Suhoor to end a few minutes earlier."
    )
    issues.append({
        "type": "sehri_unconfigured",
        "severity": "medium",
        "action_taken": "sehri_ends = fajr_start",
        "fix": "Set the masjid's actual Suhoor cutoff manually if needed",
    })

    # Fajr jamaat strictly after sunrise. Equality is allowed: My-Masjid clamps
    # the fajr jamaat down to sunrise in deep summer, so jamaat == sunrise is a
    # display artifact, not a masjid setting Fajr congregation past its window.
    fajr_after_sunrise = [
        r["date"] for r in rows
        if r["fajr_jamaat"] and r["sunrise"] and r["fajr_jamaat"] > r["sunrise"]
    ]
    if fajr_after_sunrise:
        warnings.append(
            f"Fajr jamaat after sunrise on {len(fajr_after_sunrise)} days "
            f"({fajr_after_sunrise[0]} to {fajr_after_sunrise[-1]})."
        )
        issues.append({
            "type": "fajr_after_sunrise", "severity": "high",
            "count": len(fajr_after_sunrise),
            "first_date": fajr_after_sunrise[0], "last_date": fajr_after_sunrise[-1],
            "affected_dates": fajr_after_sunrise,
            "action_taken": "none",
            "fix": "Investigate — likely a My-Masjid config error for this masjid",
        })

    # all iqamas empty
    iqama_fields = ["fajr_jamaat", "zohar_jamaat", "asr_jamaat", "maghrib_jamaat", "esha_jamaat"]
    if all(all(not r[f] for f in iqama_fields) for r in rows):
        warnings.append("All iqama fields empty year-round — masjid hasn't set jama'at times.")
        issues.append({
            "type": "iqamas_unconfigured", "severity": "high",
            "action_taken": "iqama fields left blank",
            "fix": "Reach out to masjid, or skip this masjid",
        })

    # Record any auto-corrections made by repair_glitches (visible, medium —
    # these are confidently-fixed AM/PM typos, masjid stays public).
    corrections = corrections or []
    if corrections:
        warnings.append(
            f"Auto-corrected {len(corrections)} obvious AM/PM (±12h) time errors "
            f"(e.g. {corrections[0]['field']} {corrections[0]['old']}→{corrections[0]['new']} "
            f"on {corrections[0]['date']})."
        )
        issues.append({
            "type": "time_corrected", "severity": "medium",
            "count": len(corrections),
            "action_taken": "Shifted each value by ±12h into its valid window",
            "corrections": corrections[:50],  # cap the audit list
            "fix": "None needed; verify upstream if you want the masjid to fix their config",
        })

    # Isha clamped to Maghrib (UK summer — no true Isha twilight). Real, common;
    # record as medium/visible like the Mawaqit provider rather than hiding.
    isha_clamped = [
        r["date"] for r in rows
        if parse_hhmm(r["maghrib_iftari"]) is not None
        and parse_hhmm(r["maghrib_iftari"]) == parse_hhmm(r["esha"])
    ]
    if isha_clamped:
        warnings.append(
            f"Isha equals Maghrib on {len(isha_clamped)} days "
            f"({isha_clamped[0]} to {isha_clamped[-1]}) — typical UK-summer combine."
        )
        issues.append({
            "type": "isha_clamped", "severity": "medium",
            "count": len(isha_clamped),
            "first_date": isha_clamped[0], "last_date": isha_clamped[-1],
            "action_taken": "none (UI flags affected days for users)",
            "fix": "Verify the masjid's summer Isha policy if these should differ from Maghrib",
        })

    # Residual glitches (HIGH → needs_review). After repair, we only hide a
    # masjid for things we genuinely can't trust:
    #   - an unparseable start time
    #   - broken start-time ordering (allowing the Maghrib==Isha clamp)
    #   - a non-Fajr jama'at grossly outside its prayer (beyond JAMAAT_LO/HI),
    #     which a ±12h fix couldn't resolve
    # Jummah-before-Dhuhr-start and late-summer Fajr gaps are NOT flagged —
    # they're legitimate (verified against real timetables).
    glitch_dates = []
    for r in rows:
        vals = [parse_hhmm(r[f]) for f in PRAYER_ORDER]
        if any(v is None for v in vals):
            glitch_dates.append(r["date"]); continue
        # strict order, but allow Maghrib == Isha (clamp). vals indices:
        # 0 fajr,1 sunrise,2 zohr,3 asr,4 maghrib,5 isha
        ordered = (vals[0] < vals[1] < vals[2] < vals[3] < vals[4]) and (vals[4] <= vals[5])
        if not ordered:
            glitch_dates.append(r["date"]); continue
        bad = False
        for start_f, iq_f in IQAMA_PAIRS:
            if start_f == "fajr_start":
                continue  # Fajr handled by fajr_after_sunrise
            st, iq = parse_hhmm(r[start_f]), parse_hhmm(r[iq_f])
            if st is None or iq is None:
                continue
            if not (JAMAAT_LO <= (iq - st) <= JAMAAT_HI):
                bad = True; break
        if bad:
            glitch_dates.append(r["date"])

    if glitch_dates:
        warnings.append(
            f"Implausible times on {len(glitch_dates)} days "
            f"({glitch_dates[0]} to {glitch_dates[-1]}) that couldn't be auto-corrected — "
            "likely entry errors in the masjid's My-Masjid config."
        )
        issues.append({
            "type": "time_glitch", "severity": "high",
            "count": len(glitch_dates),
            "first_date": glitch_dates[0], "last_date": glitch_dates[-1],
            "affected_dates": glitch_dates,
            "action_taken": "none (values kept; masjid hidden until reviewed)",
            "fix": "Verify against the masjid's real timetable; fix upstream or skip",
        })

    for issue in issues:
        if issue.get("type") in acknowledged:
            issue["acknowledged"] = True

    unacked = [i for i in issues if not i.get("acknowledged")]
    unacked_high = any(i.get("severity") == "high" for i in unacked)
    status = "ok" if not unacked else ("needs_review" if unacked_high else "warnings")

    return {
        "status": status,
        "checked_at": date.today().isoformat(),
        "row_count": len(rows),
        "warnings": warnings,
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# Config (preserve-on-refetch, same contract as Mawaqit)
# ---------------------------------------------------------------------------

def load_existing_config(config_path: Path) -> dict:
    if not config_path.exists():
        return {}
    try:
        with open(config_path, encoding="utf-8") as f:
            existing = json.load(f)
    except Exception as e:
        print(f"  Couldn't read existing config ({e}); treating as new masjid.")
        return {}
    if "lat" in existing and "latitude" not in existing:
        existing["latitude"] = existing.pop("lat")
    if "lon" in existing and "longitude" not in existing:
        existing["longitude"] = existing.pop("lon")
    if existing.get("address") and not existing.get("address_source"):
        existing["address_source"] = "manual"
    return existing


def prefer_existing(existing_value, new_value):
    if existing_value is None:
        return new_value
    if isinstance(existing_value, str) and existing_value.strip() == "":
        return new_value
    return existing_value


def build_address(details: dict) -> tuple[str, str]:
    """
    Build an address from My-Masjid's structured fields (house/street/zipCode),
    enriching city/ward from Postcodes.io. Returns (address, source).
    """
    house = (details.get("house") or "").strip()
    street = (details.get("street") or "").strip()
    postcode = (details.get("zipCode") or "").strip()

    street_part = " ".join(p for p in [house, street] if p).strip()
    city = ward = None
    info = lookup_uk_postcode(postcode) if postcode else None
    if info:
        ward = info.get("admin_ward")
        city = info.get("admin_district")

    parts = [street_part, ward, city, postcode]
    address = ", ".join(p for p in parts if p)
    return (address, "geocoded" if address else "none")


def resolve_address(model: dict, existing: dict) -> tuple[str, str]:
    existing_addr = (existing.get("address") or "").strip()
    existing_source = existing.get("address_source")
    if existing_addr and existing_source == "manual":
        return existing_addr, "manual"
    if existing_addr:
        return existing_addr, existing_source or "geocoded"
    return build_address(model.get("masjidDetails") or {})


def build_config(model: dict, guid: str, slug: str, quality: dict, existing: dict) -> dict:
    details = model.get("masjidDetails") or {}
    address, address_source = resolve_address(model, existing)

    def keep(field, new_value):
        return prefer_existing(existing.get(field), new_value)

    config = {
        "slug": slug,
        "display_name": keep("display_name", (details.get("name") or "").strip()),
        "city": keep("city", ""),
        "latitude": keep("latitude", details.get("latitude")),
        "longitude": keep("longitude", details.get("longitude")),
        "country_code": keep("country_code", "GB"),
        "website": keep("website", ""),
        "logo": keep("logo", ""),
        "address": address,
        "address_source": address_source,
        "phone": (existing.get("phone") or "").strip(),
        "email": (existing.get("email") or "").strip(),
        "notes": (existing.get("notes") or "").strip(),
        "association": keep("association", ""),
        "timezone": keep("timezone", "Europe/London"),
        "jummah_times": keep("jummah_times", _jummah_summary(model)),
        "csv": f"{slug}.csv",
        "provider": {
            "type": "mymasjid",
            "ref": {"guidId": guid, "masjid_id": details.get("id")},
            "source_url": SOURCE_URL.format(guid=guid),
        },
        "quality": quality,
        "acknowledged_issues": list(existing.get("acknowledged_issues") or []),
    }

    for k, v in existing.items():
        if k not in MANAGED_FIELDS and k not in config:
            config[k] = v
    return config


def _jummah_summary(model: dict) -> str:
    jlist = model.get("jumahSalahIqamahTimings") or []
    times = [j.get("iqamahTime") for j in jlist if j.get("iqamahTime")]
    return ", ".join(times)


# ---------------------------------------------------------------------------
# Write + pipeline
# ---------------------------------------------------------------------------

def write_csv(rows: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _run(model: dict, guid: str, slug: str, data_dir: Path, existing: dict) -> dict:
    year = date.today().year
    rows = normalise(model, year)
    if not rows:
        raise RuntimeError(f"No usable rows for {guid}")
    corrections = repair_glitches(rows)
    acknowledged = existing.get("acknowledged_issues") or []
    quality = quality_check(rows, acknowledged=acknowledged, corrections=corrections)
    config = build_config(model, guid, slug, quality, existing)

    write_csv(rows, data_dir / f"{slug}.csv")
    config_path = data_dir / "mosques" / f"{slug}.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    return {
        "slug": slug, "guid": guid,
        "display_name": config.get("display_name"),
        "status": quality["status"], "row_count": quality["row_count"],
        "config_path": str(config_path),
    }


def rebuild_from_cache(slug: str, data_dir: Path) -> dict:
    """Re-run offline from data/raw/{slug}.json (used by triage after acknowledgement)."""
    raw_path = data_dir / "raw" / f"{slug}.json"
    config_path = data_dir / "mosques" / f"{slug}.json"
    if not raw_path.exists():
        raise FileNotFoundError(f"No cached raw data at {raw_path} — run a fresh fetch first")
    existing = load_existing_config(config_path)
    if (existing.get("provider") or {}).get("type") != "mymasjid":
        raise ValueError(f"{slug} is not a mymasjid-provider masjid")
    guid = (existing["provider"].get("ref") or {}).get("guidId")
    with open(raw_path, encoding="utf-8") as f:
        model = json.load(f)
    return _run(model, guid, slug, data_dir, existing)


def fetch_one(guid: str, slug: str, data_dir: Path, verbose: bool = True) -> dict:
    """Full per-masjid pipeline. Does NOT regenerate index (caller decides)."""
    config_path = data_dir / "mosques" / f"{slug}.json"
    existing = load_existing_config(config_path)

    if verbose:
        print(f"Fetching {guid}...")
    model = fetch_timings(guid)
    if verbose:
        print(f"Loaded {(model.get('masjidDetails') or {}).get('name')} "
              f"— {len(model['salahTimings'])} days")

    raw_path = data_dir / "raw" / f"{slug}.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2, ensure_ascii=False)

    summary = _run(model, guid, slug, data_dir, existing)

    if verbose:
        print(f"\nQuality: {summary['status']}  ({summary['row_count']} days)")
        print(f"Wrote {raw_path}")
        print(f"Wrote {data_dir / (slug + '.csv')}")
        print(f"Wrote {summary['config_path']}")
    return summary


def main():
    parser = argparse.ArgumentParser(description="Fetch one masjid from My-Masjid (time.my-masjid.com).")
    parser.add_argument("guid", help="Masjid GuidId (from GetPublicFilteredMasjid)")
    parser.add_argument("--slug", help="Short slug for filenames (default: derived from name)")
    parser.add_argument("--data-dir", default="data", help="Base data directory (default: data)")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    # If no slug given, derive from the fetched name (done inside after fetch).
    if args.slug:
        slug = args.slug
    else:
        model = fetch_timings(args.guid)
        from providers.mymasjid.discover import slugify
        slug = slugify((model.get("masjidDetails") or {}).get("name") or args.guid)

    fetch_one(args.guid, slug, data_dir, verbose=True)
    count = regenerate_index(data_dir / "mosques")
    print(f"Wrote {data_dir / 'mosques' / 'index.json'} ({count} masjids)")


if __name__ == "__main__":
    main()
