"""MasjidBox provider — daily-accumulating fetcher for api.masjidbox.com.

MasjidBox's public widget endpoint only returns today + tomorrow, so this
provider is run daily (via the 2am workflow): each run upserts today's and
tomorrow's rows into the masjid's CSV by date, accumulating a growing history.
Masjids are flagged `today_only` (month view hidden) since the forward window
is just one day.
"""
