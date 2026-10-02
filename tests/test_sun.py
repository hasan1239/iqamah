"""Tests for providers/sun.py. Run: python -m unittest tests.test_sun"""

import unittest
from datetime import date, timedelta

from providers.sun import (
    sun_time_issues, sunrise_sunset_local, uk_utc_offset_minutes, valid_coords,
)

BIRMINGHAM = (52.4862, -1.8904)
TODAY = date(2026, 10, 2)


def hhmm(minutes: float) -> str:
    m = round(minutes)
    return f"{m // 60:02d}:{m % 60:02d}"


def rows_for(days: int, shift: int = 0, start: date = TODAY, lat_lon=BIRMINGHAM):
    """Rows whose sunrise/maghrib match the sun, shifted by `shift` minutes."""
    out = []
    for n in range(days):
        d = start + timedelta(days=n)
        rise, sset = sunrise_sunset_local(d, *lat_lon)
        out.append({"date": d.isoformat(), "sunrise": hhmm(rise + shift), "maghrib_iftari": hhmm(sset + shift)})
    return out


class SunTimes(unittest.TestCase):
    def test_uk_clock_change_dates(self):
        self.assertEqual(uk_utc_offset_minutes(date(2026, 3, 28)), 0)
        self.assertEqual(uk_utc_offset_minutes(date(2026, 3, 29)), 60)   # last Sunday in March
        self.assertEqual(uk_utc_offset_minutes(date(2026, 10, 24)), 60)
        self.assertEqual(uk_utc_offset_minutes(date(2026, 10, 25)), 0)   # last Sunday in October
        self.assertEqual(uk_utc_offset_minutes(date(2025, 10, 26)), 0)

    def test_birmingham_sunrise_matches_published_values(self):
        # Amanah Masjid (Birmingham) Mawaqit: 2 Oct 2026 sunrise 07:10, maghrib 18:43
        rise, sset = sunrise_sunset_local(TODAY, *BIRMINGHAM)
        self.assertLessEqual(abs(rise - (7 * 60 + 10)), 3)
        self.assertLessEqual(abs(sset - (18 * 60 + 43)), 3)

    def test_correct_times_raise_nothing(self):
        self.assertEqual(sun_time_issues(rows_for(60, shift=3), *BIRMINGHAM, today=TODAY), [])

    def test_hour_late_is_high(self):
        issues = sun_time_issues(rows_for(30, shift=60), *BIRMINGHAM, today=TODAY)
        self.assertEqual([(i["type"], i["severity"]) for i in issues], [("sun_times_late", "high")])
        self.assertEqual(issues[0]["typical_offset_min"], 60)
        self.assertEqual(issues[0]["count"], 30)

    def test_hour_early_is_medium(self):
        issues = sun_time_issues(rows_for(30, shift=-60), *BIRMINGHAM, today=TODAY)
        self.assertEqual([(i["type"], i["severity"]) for i in issues], [("sun_times_early", "medium")])

    def test_one_or_two_late_days_are_medium(self):
        rows = rows_for(30)
        rows[22]["sunrise"] = hhmm(sunrise_sunset_local(date.fromisoformat(rows[22]["date"]), *BIRMINGHAM)[0] + 60)
        issues = sun_time_issues(rows, *BIRMINGHAM, today=TODAY)
        self.assertEqual([(i["type"], i["severity"], i["affected_dates"]) for i in issues],
                         [("sun_times_late", "medium", [rows[22]["date"]])])

    def test_only_upcoming_window_counts(self):
        past = rows_for(30, shift=60, start=TODAY - timedelta(days=40))
        later = rows_for(30, shift=60, start=TODAY + timedelta(days=90))
        self.assertEqual(sun_time_issues(past + later, *BIRMINGHAM, today=TODAY), [])

    def test_placeholder_or_missing_coords_skip_the_check(self):
        rows = rows_for(10, shift=60)
        self.assertFalse(valid_coords(54.0, -2.0))
        self.assertEqual(sun_time_issues(rows, 54.0, -2.0, today=TODAY), [])
        self.assertEqual(sun_time_issues(rows, None, None, today=TODAY), [])

    def test_blank_or_bad_values_are_ignored(self):
        rows = rows_for(5)
        rows[0]["sunrise"] = ""
        rows[1]["maghrib_iftari"] = "n/a"
        rows[2]["date"] = "not a date"
        self.assertEqual(sun_time_issues(rows, *BIRMINGHAM, today=TODAY), [])


if __name__ == "__main__":
    unittest.main()
