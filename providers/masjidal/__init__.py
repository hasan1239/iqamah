"""Masjidal / Athan+ provider — scrapes the AthanPlus widget (timing.athanplus.com).

Masjidal (mymasjidal.com) masjids embed an AthanPlus widget that server-renders
~7 days of real per-masjid times (adhan + iqamah). There's no public JSON API,
so we parse the widget HTML. Daily-accumulating + today_only, like MasjidBox.

Discovery: each masjid's website embeds the widget with its masjid_id, e.g.
iccuk.org -> timing.athanplus.com/masjid/widgets/embed?masjid_id=QKMqqaKB
"""
