"""Tests for providers/quality.py and the Masjidal widget parser.
Run: python -m unittest tests.test_quality"""

import unittest
from datetime import date, timedelta

from providers.masjidal.fetch import parse_widget
from providers.quality import feed_quality
from providers.sun import sunrise_sunset_local

BIRMINGHAM = (52.4862, -1.8904)
TODAY = date(2026, 10, 2)


def hhmm(minutes: float) -> str:
    m = round(minutes)
    return f"{m // 60:02d}:{m % 60:02d}"


def row(d: date, shift: int = 0, fajr_jamaat: str = "06:00") -> dict:
    rise, sset = sunrise_sunset_local(d, *BIRMINGHAM)
    return {"date": d.isoformat(), "sunrise": hhmm(rise + shift),
            "maghrib_iftari": hhmm(sset + shift), "fajr_jamaat": fajr_jamaat}


class FeedQuality(unittest.TestCase):
    def test_good_feed_is_ok(self):
        rows = [row(TODAY), row(TODAY + timedelta(days=1))]
        q = feed_quality(rows, *BIRMINGHAM, today=TODAY)
        self.assertEqual((q["status"], q["issues"]), ("ok", []))

    def test_two_day_feed_with_both_days_an_hour_late_is_hidden(self):
        # MasjidBox only has today + tomorrow: "3+ days" must cap at what exists
        rows = [row(TODAY, 60), row(TODAY + timedelta(days=1), 60)]
        q = feed_quality(rows, *BIRMINGHAM, today=TODAY)
        self.assertEqual(q["status"], "needs_review")
        self.assertEqual(q["issues"][0]["type"], "sun_times_late")

    def test_one_bad_day_of_two_stays_visible(self):
        rows = [row(TODAY, 60), row(TODAY + timedelta(days=1))]
        self.assertEqual(feed_quality(rows, *BIRMINGHAM, today=TODAY)["status"], "warnings")

    def test_past_rows_are_ignored(self):
        # Daily feeds accumulate history; an old bad day mustn't keep a masjid hidden
        rows = [row(TODAY - timedelta(days=3), 60, fajr_jamaat="09:00"), row(TODAY)]
        self.assertEqual(feed_quality(rows, *BIRMINGHAM, today=TODAY)["status"], "ok")

    def test_fajr_after_sunrise_upcoming_is_hidden(self):
        q = feed_quality([row(TODAY, fajr_jamaat="07:30")], *BIRMINGHAM, today=TODAY)
        self.assertEqual(q["status"], "needs_review")
        self.assertEqual(q["issues"][0]["type"], "fajr_after_sunrise")

    def test_acknowledged_issue_does_not_block(self):
        rows = [row(TODAY, 60), row(TODAY + timedelta(days=1), 60)]
        q = feed_quality(rows, *BIRMINGHAM, acknowledged=["sun_times_late"], today=TODAY)
        self.assertEqual(q["status"], "ok")
        self.assertTrue(q["issues"][0]["acknowledged"])

    def test_suppressed_cells_are_skipped(self):
        r = row(TODAY)
        r.update(sunrise="-", fajr_jamaat="-")
        self.assertEqual(feed_quality([r], *BIRMINGHAM, today=TODAY)["status"], "ok")


DAY_BLOCK = """<div class="carousel-item"><p>{date}</p><table>
<tr><td>Fajr</td><td><span>5:32 AM</span></td><td><b>5:57 AM</b></td></tr>
<tr><td>Sunrise</td><td><span>7:00 AM</span></td></tr>
<tr><td>Dhuhr</td><td><span>12:55 PM</span></td><td><b>1:10 PM</b></td></tr>
<tr><td>Asr</td><td><span>3:55 PM</span></td><td><b>4:10 PM</b></td></tr>
<tr><td>Maghrib</td><td><span>6:39 PM</span></td><td><b>6:49 PM</b></td></tr>
<tr><td>Isha</td><td><span>7:57 PM</span></td><td><b>8:07 PM</b></td></tr>
</table></div>"""


class MasjidalParser(unittest.TestCase):
    def test_full_and_abbreviated_month_names(self):
        html = DAY_BLOCK.format(date="Friday, October 2, 2026") + DAY_BLOCK.format(date="Saturday, Oct 3, 2026")
        rows = parse_widget(html)
        self.assertEqual([r["date"] for r in rows], ["2026-10-02", "2026-10-03"])
        self.assertEqual((rows[0]["sunrise"], rows[0]["maghrib_iftari"], rows[0]["esha_jamaat"]),
                         ("07:00", "18:39", "20:07"))


if __name__ == "__main__":
    unittest.main()
