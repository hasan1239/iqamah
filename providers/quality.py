"""
Shared quality block for feed providers that don't have their own checks
(MasjidBox, Masjidal, LondonPrayerTimes). Mawaqit and My-Masjid build their
own richer quality_check but use the same sun check and status rules.

Only upcoming rows are judged: the daily feeds accumulate history in their
CSVs, and an old bad day shouldn't keep a masjid hidden after the feed is
fixed.
"""

from __future__ import annotations

import re
from datetime import date

from providers.sun import sun_time_issues, sun_time_warnings

_HHMM = re.compile(r"^\d{2}:\d{2}$")


def fajr_after_sunrise_issue(rows: list[dict], today: date) -> dict | None:
    dates = []
    for r in rows:
        try:
            if date.fromisoformat(r.get("date", "")) < today:
                continue
        except ValueError:
            continue
        fajr, sunrise = (r.get("fajr_jamaat") or "").strip(), (r.get("sunrise") or "").strip()
        if _HHMM.match(fajr) and _HHMM.match(sunrise) and fajr >= sunrise:
            dates.append(r["date"])
    if not dates:
        return None
    return {
        "type": "fajr_after_sunrise",
        "severity": "high",
        "count": len(dates),
        "first_date": dates[0],
        "last_date": dates[-1],
        "affected_dates": dates,
        "action_taken": "none",
        "fix": "Investigate: Fajr jama'at must be before sunrise. Likely a data error at source",
    }


def feed_quality(rows: list[dict], lat, lon, acknowledged=None,
                 warnings: list[str] | None = None, today: date | None = None) -> dict:
    """
    rows: provider-format CSV rows (ISO `date`, 24h HH:MM times).
    Returns the config `quality` block: status ok / warnings / needs_review.
    """
    today = today or date.today()
    acknowledged = set(acknowledged or [])
    warnings = list(warnings or [])
    issues = []

    fajr = fajr_after_sunrise_issue(rows, today)
    if fajr:
        issues.append(fajr)
        warnings.append(f"Fajr jama'at is at or after sunrise on {fajr['count']} upcoming days "
                        f"({fajr['first_date']} to {fajr['last_date']}).")

    sun = sun_time_issues(rows, lat, lon, today=today)
    issues.extend(sun)
    warnings.extend(sun_time_warnings(sun))

    for issue in issues:
        if issue["type"] in acknowledged:
            issue["acknowledged"] = True
    unacked = [i for i in issues if not i.get("acknowledged")]
    if not unacked:
        status = "ok"
    elif any(i["severity"] == "high" for i in unacked):
        status = "needs_review"
    else:
        status = "warnings"

    return {
        "status": status,
        "checked_at": today.isoformat(),
        "row_count": len(rows),
        "warnings": warnings,
        "issues": issues,
    }
