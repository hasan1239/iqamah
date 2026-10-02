"""
Sun-position sanity check for provider timetables.

Sunrise and the Maghrib start (sunset) are astronomical, so they're the same
whoever publishes them. Comparing a feed's values against the calculated
times at the masjid's location catches feeds that are wrong at source:
clock-change errors (the whole summer an hour out) and calendars generated
for the wrong place. Jama'at times are set by the masjid and aren't checked.

Severity follows the "too late is dangerous" rule: times later than the sun
allows make people miss the jama'at, so they block the masjid (high); early
times are flagged but stay visible (medium).

Uses the NOAA solar position approximation (accurate to about a minute at UK
latitudes) and the UK clock-change rule directly, so it needs no timezone
database (Windows Python ships without one).
"""

from __future__ import annotations

import math
from datetime import date, timedelta

THRESHOLD_MIN = 15      # beyond normal precaution offsets and minute rounding
WINDOW_DAYS = 60        # only the upcoming period matters for what users see
MIN_DAYS_FOR_HIGH = 3   # one or two odd days are a typo, not a broken feed


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
    dates) with the calculated times. Returns zero or more quality issues
    (sun_times_late / sun_times_early) in the provider issue format.
    """
    if not valid_coords(lat, lon):
        return []
    lat, lon = float(lat), float(lon)
    today = today or date.today()
    end = today + timedelta(days=WINDOW_DAYS)

    late, early, offsets = [], [], []
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
        worst = 0.0
        for field, expected in (("sunrise", sun[0]), ("maghrib_iftari", sun[1])):
            got = _minutes(row.get(field, ""))
            if got is None:
                continue
            diff = got - expected
            if abs(diff) > abs(worst):
                worst = diff
        if worst >= THRESHOLD_MIN:
            late.append(row["date"])
            offsets.append(worst)
        elif worst <= -THRESHOLD_MIN:
            early.append(row["date"])
            offsets.append(worst)

    def summary(days: list[str], sign: int) -> int:
        vals = sorted(o for o in offsets if (o > 0) == (sign > 0))
        return round(vals[len(vals) // 2]) if vals else 0

    issues = []
    if late:
        typical = summary(late, 1)
        issues.append({
            "type": "sun_times_late",
            "severity": "high" if len(late) >= MIN_DAYS_FOR_HIGH else "medium",
            "count": len(late),
            "first_date": late[0],
            "last_date": late[-1],
            "typical_offset_min": typical,
            "affected_dates": late,
            "action_taken": "none",
            "fix": ("Sunrise/Maghrib are about "
                    f"{typical} min later than the sun at this location. "
                    "Likely a clock-change or location error in the source; "
                    "users would miss jama'at. Check the masjid's source page, "
                    "or acknowledge if the location in our config is wrong."),
        })
    if early:
        typical = summary(early, -1)
        issues.append({
            "type": "sun_times_early",
            "severity": "medium",
            "count": len(early),
            "first_date": early[0],
            "last_date": early[-1],
            "typical_offset_min": typical,
            "affected_dates": early,
            "action_taken": "none (early times are shown; users arrive early)",
            "fix": (f"Sunrise/Maghrib are about {-typical} min earlier than the "
                    "sun at this location. Check the masjid's source page."),
        })
    return issues


def sun_time_warnings(issues: list[dict]) -> list[str]:
    out = []
    for i in issues:
        if i["type"] == "sun_times_late":
            out.append(f"Sunrise/Maghrib {i['typical_offset_min']} min LATER than the sun on "
                       f"{i['count']} upcoming days ({i['first_date']} to {i['last_date']}).")
        elif i["type"] == "sun_times_early":
            out.append(f"Sunrise/Maghrib {-i['typical_offset_min']} min earlier than the sun on "
                       f"{i['count']} upcoming days ({i['first_date']} to {i['last_date']}).")
    return out
