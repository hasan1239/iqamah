"""Tests for providers/quality.py and the Masjidal widget parser.
Run: python -m unittest tests.test_quality"""

import csv
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from providers.feed_health import missing_today
from providers.masjidal.fetch import parse_widget
from providers.requalify import requalify
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
        self.assertEqual(q["issues"][0]["type"], "sun_times_unsafe")

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
        q = feed_quality(rows, *BIRMINGHAM, acknowledged=["sun_times_unsafe"], today=TODAY)
        self.assertEqual(q["status"], "ok")
        self.assertTrue(q["issues"][0]["acknowledged"])

    def test_suppressed_cells_are_skipped(self):
        r = row(TODAY)
        r.update(sunrise="-", fajr_jamaat="-")
        self.assertEqual(feed_quality([r], *BIRMINGHAM, today=TODAY)["status"], "ok")


def write_masjid(data_dir: Path, slug: str, ptype: str, rows: list[dict], **extra) -> None:
    (data_dir / "mosques").mkdir(parents=True, exist_ok=True)
    cfg = {"slug": slug, "csv": f"{slug}.csv", "provider": {"type": ptype},
           "latitude": BIRMINGHAM[0], "longitude": BIRMINGHAM[1], **extra}
    (data_dir / "mosques" / f"{slug}.json").write_text(json.dumps(cfg), encoding="utf-8")
    with open(data_dir / f"{slug}.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "sunrise", "maghrib_iftari", "fajr_jamaat"])
        w.writeheader()
        w.writerows(rows)


class FeedHealth(unittest.TestCase):
    def test_lists_live_feeds_without_a_row_for_today(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            write_masjid(d, "fresh", "mawaqit", [row(TODAY)])
            write_masjid(d, "ended", "mawaqit", [row(TODAY - timedelta(days=1))])  # e.g. 1 January
            write_masjid(d, "hidden_one", "masjidbox", [], hidden=True)
            write_masjid(d, "uploaded", "image", [])                               # not a live feed
            self.assertEqual(missing_today(d, today=TODAY), ["ended (mawaqit)"])
            self.assertEqual(missing_today(d, types=("masjidbox",), today=TODAY), [])


class Requalify(unittest.TestCase):
    def test_replaces_sun_issues_and_keeps_others(self):
        cfg = {"latitude": BIRMINGHAM[0], "longitude": BIRMINGHAM[1], "quality": {
            "status": "needs_review", "warnings": ["Sunrise/Maghrib old", "other warning"],
            "issues": [{"type": "sun_times_late", "severity": "high"},
                       {"type": "isha_clamped", "severity": "medium"}]}}
        q = requalify(cfg, [row(TODAY + timedelta(days=n)) for n in range(5)], today=TODAY)
        self.assertEqual([i["type"] for i in q["issues"]], ["isha_clamped"])
        self.assertEqual(q["warnings"], ["other warning"])
        self.assertEqual(q["status"], "warnings")

    def test_hides_when_unsafe_days_come_into_the_window(self):
        # An hour out from day 20: visible now, hidden once within 14 days
        rows = [row(TODAY + timedelta(days=n), -60) for n in range(20, 40)]
        cfg = {"latitude": BIRMINGHAM[0], "longitude": BIRMINGHAM[1], "quality": {"issues": []}}
        self.assertEqual(requalify(cfg, rows, today=TODAY)["status"], "warnings")
        self.assertEqual(requalify(cfg, rows, today=TODAY + timedelta(days=10))["status"], "needs_review")


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
