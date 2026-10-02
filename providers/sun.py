"""
Sun-position sanity check for provider timetables.

Sunrise and the Maghrib start (sunset) are astronomical, so they're the same
whoever publishes them. Comparing a feed's values against the calculated
times at the masjid's location catches feeds that are wrong at source:
clock-change errors (the whole summer an hour out) and calendars generated
for the wrong place. Jama'at times are set by the masjid and aren't checked.

Each field is judged in its unsafe direction: a late sunrise (Fajr shown as
valid after the real sunrise) and an early Maghrib (fast broken / Maghrib
prayed before sunset) are dangerous, as is any whole-calendar shift. "Early is
harmless" only holds for jama'at times, not start times.

Uses the NOAA solar position approximation (accurate to about a minute at UK
latitudes) and the UK clock-change rule directly, so it needs no timezone
database (Windows Python ships without one).
"""

from __future__ import annotations

import math
from datetime import date, timedelta

THRESHOLD_MIN = 15      # beyond normal precaution offsets and minute rounding
WINDOW_DAYS = 60        # only the upcoming period matters for what users see
SHIFT_MIN = 45          # a whole-calendar shift (clock-change error) either way
HIDE_DAYS = 14          # hide only when the unsafe days are this close; every feed
                        # is re-checked at least weekly, so it's hidden before they arrive
MIN_DAYS_FOR_HIGH = 3   # one or two odd days are a typo, not a broken feed
                        # (capped at the number of upcoming days a short-window
                        # feed like MasjidBox actually has)


def _last_sunday(year: int, month: int) -> date:
    d = (date(year, month + 1, 1) if month < 12 else date(year + 1, 1, 1)) - timedelta(days=1)
    while d.weekday() != 6:
        d -= timedelta(days=1)
    return d


def uk_utc_offset_minutes(d: date) -> int:
    """BST (+60) from the last Sunday in March up to the day before the last
    Sunday in October. Whole-day granularity; rows are one per day."""
    return 60 if _last_sunday(d.year, 3) <= d < _last_sunday(d.year, 10) else 0


def _declination_and_eqt(d: date) -> tuple[float, float]:
    jd = d.toordinal() + 1721424.5 + 0.5  # Julian day at 12:00 UTC
    t = (jd - 2451545) / 36525
    l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360
    m = math.radians(357.52911 + t * (35999.05029 - 0.0001537 * t))
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    c = (math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * m) * (0.019993 - 0.000101 * t) + math.sin(3 * m) * 0.000289)
    omega = math.radians(125.04 - 1934.136 * t)
    lam = math.radians(l0 + c - 0.00569 - 0.00478 * math.sin(omega))
    eps = math.radians(23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
                       + 0.00256 * math.cos(omega))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    y = math.tan(eps / 2) ** 2
    l0r = math.radians(l0)
    eqt = 4 * math.degrees(y * math.sin(2 * l0r) - 2 * e * math.sin(m)
                           + 4 * e * y * math.sin(m) * math.cos(2 * l0r)
                           - 0.5 * y * y * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * m))
    return dec, eqt


def sunrise_sunset_local(d: date, lat: float, lon: float) -> tuple[float, float] | None:
    """Sunrise and sunset in UK local minutes after midnight, or None if the
    sun doesn't rise/set (not a UK concern)."""
    dec, eqt = _declination_and_eqt(d)
    phi = math.radians(lat)
    cos_h = ((math.sin(math.radians(-0.833)) - math.sin(phi) * math.sin(dec))
             / (math.cos(phi) * math.cos(dec)))
    if not -1 <= cos_h <= 1:
        return None
    half_day = 4 * math.degrees(math.acos(cos_h))
    noon = 720 - 4 * lon - eqt + uk_utc_offset_minutes(d)
    return noon - half_day, noon + half_day


def _minutes(value: str) -> int | None:
    try:
        h, m = (value or "").strip().split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def valid_coords(lat, lon) -> bool:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    # 54.0,-2.0 is My-Masjid's UK-wide placeholder; 0,0 is unset
    return (lat, lon) not in {(54.0, -2.0), (0.0, 0.0)} and 49 <= lat <= 61 and -9 <= lon <= 3


def sun_time_issues(rows: list[dict], lat, lon, today: date | None = None) -> list[dict]:
    """
    Compare each upcoming row's sunrise and maghrib_iftari (24h HH:MM, ISO
    dates) with the calculated times. Returns zero or more quality issues in
    the provider issue format:

    - sun_times_unsafe: a day where the times could make someone pray at
      the wrong time. That's a LATE sunrise (Fajr shown as still valid after
      the real sunrise), an EARLY Maghrib (fast broken / Maghrib prayed before
      sunset), or a shift of SHIFT_MIN+ in either direction (a clock-change
      error makes every start time wrong). High severity
      (masjid hidden) when it hits enough days within the next HIDE_DAYS;
      otherwise medium, and the masjid page shows a per-day notice.
    - sun_times_off: 15+ min off only in the harmless direction (early
      sunrise, late Maghrib). Medium.
    """
    if not valid_coords(lat, lon):
        return []
    lat, lon = float(lat), float(lon)
    today = today or date.today()
    end = today + timedelta(days=WINDOW_DAYS)
    hide_end = today + timedelta(days=HIDE_DAYS)

    unsafe, off = [], []          # (iso date, signed worst offset)
    checked_soon = 0
    for row in rows:
        try:
            d = date.fromisoformat(row.get("date", ""))
        except ValueError:
            continue
        if not today <= d < end:
            continue
        sun = sunrise_sunset_local(d, lat, lon)
        if sun is None:
            continue
        rise_got = _minutes(row.get("sunrise", ""))
        set_got = _minutes(row.get("maghrib_iftari", ""))
        diffs = {}
        if rise_got is not None:
            diffs["sunrise"] = rise_got - sun[0]
        if set_got is not None:
            diffs["maghrib"] = set_got - sun[1]
        if not diffs:
            continue
        if d < hide_end:
            checked_soon += 1
        worst = max(diffs.values(), key=abs)
        is_unsafe = (
            diffs.get("sunrise", 0) >= THRESHOLD_MIN
            or diffs.get("maghrib", 0) <= -THRESHOLD_MIN
            or abs(worst) >= SHIFT_MIN
        )
        if is_unsafe:
            unsafe.append((row["date"], worst))
        elif abs(worst) >= THRESHOLD_MIN:
            off.append((row["date"], worst))

    def median(vals):
        vals = sorted(vals)
        return round(vals[len(vals) // 2]) if vals else 0

    issues = []
    if unsafe:
        dates = [d for d, _ in unsafe]
        soon = [d for d in dates if d < hide_end.isoformat()]
        high = len(soon) >= max(1, min(MIN_DAYS_FOR_HIGH, checked_soon))
        typical = median([o for _, o in unsafe])
        issues.append({
            "type": "sun_times_unsafe",
            "severity": "high" if high else "medium",
            "count": len(dates),
            "first_date": dates[0],
            "last_date": dates[-1],
            "typical_offset_min": typical,
            "affected_dates": dates,
            "action_taken": "none" if high else "none (per-day notice on the masjid page)",
            "fix": (f"Sunrise/Maghrib are typically {typical:+d} min from the sun at this "
                    "location, in a direction that could make users pray at the wrong "
                    "time. Likely a clock-change or location error in the source. Check "
                    "the masjid's source page, or acknowledge if our config's location "
                    "is wrong."),
        })
    if off:
        dates = [d for d, _ in off]
        typical = median([o for _, o in off])
        issues.append({
            "type": "sun_times_off",
            "severity": "medium",
            "count": len(dates),
            "first_date": dates[0],
            "last_date": dates[-1],
            "typical_offset_min": typical,
            "affected_dates": dates,
            "action_taken": "none (harmless direction: early sunrise / late Maghrib)",
            "fix": (f"Sunrise/Maghrib are typically {typical:+d} min from the sun at this "
                    "location. Check the masjid's source page."),
        })
    return issues


def sun_time_warnings(issues: list[dict]) -> list[str]:
    out = []
    for i in issues:
        if i["type"] in ("sun_times_unsafe", "sun_times_off"):
            label = "UNSAFE" if i["type"] == "sun_times_unsafe" else "off"
            out.append(f"Sunrise/Maghrib {label}: typically {i['typical_offset_min']:+d} min from the "
                       f"sun on {i['count']} upcoming days ({i['first_date']} to {i['last_date']}).")
    return out
