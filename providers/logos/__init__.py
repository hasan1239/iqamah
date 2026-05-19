"""
providers/logos/ — fill in masjid logos.

Two-step cascade per masjid:
  1. Website scrape — try og:image, largest apple-touch-icon, twitter:image,
     icon links, then /favicon.ico against config.website. Download to
     data/logos/{slug}.{ext}.
  2. Mawaqit search — hit mawaqit.net's public search API by display_name
     (+ postcode hint), and reuse the masjid's logo URL on Mawaqit's CDN.

Hybrid storage: Mawaqit logos stay as URLs (matching providers/mawaqit/fetch.py);
website-sourced logos are downloaded so they don't hotlink to flaky sites. The
frontend (js/views/home.js) treats both forms identically as `<img src>`.
"""
import io
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image, UnidentifiedImageError


HEADERS = {"User-Agent": "iqamah.co.uk"}

MIN_LOGO_DIMENSION = 96

# Content-Type → file extension. SVGs bypass Pillow probing because Pillow
# either can't parse them or pulls in an optional plugin; ICOs are excluded
# because they're typically tiny low-res favicons.
CONTENT_TYPE_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
}

MAWAQIT_SEARCH_API = "https://mawaqit.net/api/2.0/mosque/search"
MAWAQIT_BASE_URL = "https://mawaqit.net"
MAWAQIT_CDN = "https://cdn.mawaqit.net"


def fetch_bytes(url, max_size=2_000_000, timeout=15):
    """
    GET a URL up to max_size bytes. Returns (body, content_type) or None on
    any failure. Lowercases the content type and strips parameters.
    """
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = (resp.headers.get_content_type() or "").lower()
            body = resp.read(max_size + 1)
            if len(body) > max_size:
                return None
            return body, ctype
    except Exception:
        return None


class _LogoScanner(HTMLParser):
    """
    Walk a page and collect logo candidate URLs. We tolerate malformed markup
    silently because mosque websites are often hand-rolled.
    """
    def __init__(self):
        super().__init__()
        self.og_image = None
        self.twitter_image = None
        self.apple_icons = []   # (size_px, href)
        self.icons = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            prop = (a.get("property") or "").lower()
            name = (a.get("name") or "").lower()
            content = a.get("content")
            if not content:
                return
            if prop == "og:image" and not self.og_image:
                self.og_image = content
            elif name == "twitter:image" and not self.twitter_image:
                self.twitter_image = content
        elif tag == "link":
            rel = (a.get("rel") or "").lower()
            href = a.get("href")
            if not href:
                return
            if "apple-touch-icon" in rel:
                size = 0
                m = re.search(r"(\d+)\s*x\s*(\d+)", a.get("sizes") or "")
                if m:
                    size = max(int(m.group(1)), int(m.group(2)))
                self.apple_icons.append((size, href))
            elif "icon" in rel.split() or rel == "shortcut icon":
                self.icons.append(href)


def extract_logo_candidates(html, base_url):
    """
    Parse a page and return logo candidate URLs in priority order:
      og:image → largest apple-touch-icon → twitter:image → icon links → /favicon.ico
    Absolutised against base_url and deduped.
    """
    scanner = _LogoScanner()
    try:
        scanner.feed(html)
    except Exception:
        pass

    raw = []
    if scanner.og_image:
        raw.append(scanner.og_image)
    scanner.apple_icons.sort(key=lambda x: -x[0])
    raw.extend(href for _, href in scanner.apple_icons)
    if scanner.twitter_image:
        raw.append(scanner.twitter_image)
    raw.extend(scanner.icons)
    raw.append("/favicon.ico")

    absolutised = []
    seen = set()
    for c in raw:
        absolute = urllib.parse.urljoin(base_url, (c or "").strip())
        if not absolute or absolute in seen:
            continue
        seen.add(absolute)
        absolutised.append(absolute)
    return absolutised


def is_valid_logo(data, content_type):
    """
    Verify bytes look like a usable logo. Returns (True, ext) or (False, None).

    SVGs pass on content-type alone (Pillow can't reliably probe them) plus a
    crude `<svg` sniff. Raster images must decode via Pillow and meet
    MIN_LOGO_DIMENSION on the shorter side.
    """
    ext = CONTENT_TYPE_EXT.get(content_type)
    if not ext:
        return (False, None)
    if ext == "svg":
        if b"<svg" in data[:2048]:
            return (True, "svg")
        return (False, None)
    try:
        img = Image.open(io.BytesIO(data))
        w, h = img.size
        if min(w, h) < MIN_LOGO_DIMENSION:
            return (False, None)
        return (True, ext)
    except (UnidentifiedImageError, Exception):
        return (False, None)


def save_logo(data, slug, ext, logos_dir):
    """
    Write data/logos/{slug}.{ext}. Returns the repo-relative POSIX path the
    config should reference. Assumes logos_dir is data/logos under the repo;
    the returned string is fixed-format so the frontend can serve it.
    """
    logos_dir.mkdir(parents=True, exist_ok=True)
    (logos_dir / f"{slug}.{ext}").write_bytes(data)
    return f"data/logos/{slug}.{ext}"


_NAME_STOPWORDS = {
    "masjid", "mosque", "and", "the", "of", "centre", "center",
    "islamic", "muslim", "association", "trust", "uk",
}


def _token_overlap(a, b):
    """Fraction of significant tokens in `a` that also appear in `b`."""
    ta = {t for t in re.findall(r"[a-z0-9]+", a.lower()) if t and t not in _NAME_STOPWORDS}
    tb = {t for t in re.findall(r"[a-z0-9]+", b.lower()) if t and t not in _NAME_STOPWORDS}
    if not ta:
        return 0.0
    return len(ta & tb) / len(ta)


def _mawaqit_logo_url(image_field):
    """Mawaqit's `image` field can be a full URL, a leading-slash path, or a bare path."""
    if not image_field:
        return None
    s = image_field.strip()
    if not s:
        return None
    if s.startswith(("http://", "https://")):
        return s
    if s.startswith("/"):
        return f"{MAWAQIT_BASE_URL}{s}"
    return f"{MAWAQIT_CDN}/{s.lstrip('/')}"


_POSTCODE_IN_TEXT_RE = re.compile(
    r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b",
    re.IGNORECASE,
)


def _normalise_postcode(text):
    """Return the first UK postcode in `text` as a no-space lowercase string, or None."""
    if not text:
        return None
    m = _POSTCODE_IN_TEXT_RE.search(text)
    if not m:
        return None
    return (m.group(1) + m.group(2)).lower()


def mawaqit_search(query, postcode_hint=None):
    """
    Hit mawaqit.net's public search API for `query`. Return the best match
    as {path, display_name, logo_url} or None.

    Match rules:
      - Drop results with no logo (useless here).
      - If postcode_hint is set AND a result has a UK postcode, the postcodes
        must match — otherwise the result is rejected outright. This prevents
        "Birmingham Central Mosque" matching "South Birmingham Central Masjid"
        at a different postcode just because the names share tokens.
      - Otherwise rank by name-token overlap; require >= 0.5 to count.
    """
    try:
        url = f"{MAWAQIT_SEARCH_API}?{urllib.parse.urlencode({'word': query})}"
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as resp:
            results = json.loads(resp.read())
    except Exception:
        return None

    if not isinstance(results, list) or not results:
        return None

    pc = _normalise_postcode(postcode_hint) if postcode_hint else None
    scored = []
    for r in results:
        logo = _mawaqit_logo_url(r.get("image"))
        if not logo:
            continue
        slug = r.get("slug") or ""
        loc = r.get("localisation") or ""
        name = (r.get("name") or "").strip()

        result_pc = _normalise_postcode(loc) or _normalise_postcode(slug)
        is_uk = (
            slug.endswith("-united-kingdom")
            or "united kingdom" in loc.lower()
            or result_pc is not None
        )

        # When we have a UK postcode hint, restrict to UK masjids and require
        # an exact postcode match if the result has one. This prevents
        # coincidental name matches in other countries (e.g. "Central Krichim
        # Mosque" in Bulgaria for "Birmingham Central Mosque") and stops
        # different UK masjids that just share name tokens.
        if pc:
            if not is_uk:
                continue
            if result_pc and result_pc != pc:
                continue
            pc_boost = 10 if result_pc == pc else 0
        else:
            pc_boost = 0

        overlap = _token_overlap(query, name)
        scored.append((overlap + pc_boost, overlap, {
            "path": slug,
            "display_name": name,
            "logo_url": logo,
        }))

    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    _, best_overlap, best = scored[0]
    # Require strong name agreement on top of any geographic check. With a
    # postcode hit (+10) anything passes; without one we demand most of the
    # query's significant tokens to be present in the result name.
    if best_overlap < 0.6:
        return None
    return best
