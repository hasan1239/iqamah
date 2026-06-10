#!/usr/bin/env python3
"""Build data/duas.json from trusted sources, driven by data/duas_manifest.json.

The manifest is the hand-curated mapping (one entry per dua, in display order,
which the daily rotation depends on). This script fetches the actual texts:

  * kind "quran"  - Quran.com API v4 (text_uthmani + Saheeh International,
                    translation id 20). Supports single ayah ("2:201") or a
                    range ("20:25-28"). Optional from_word/to_word slice the
                    Arabic to the dua portion (dua books quote portions);
                    the English is sliced with the quoted-span rule (Saheeh
                    wraps the spoken dua in double quotes) plus an optional
                    en_to cut, otherwise the full ayah translation is kept.
                    Transliteration comes from alquran.cloud (Tanzil's
                    en.transliteration edition), sliced to the same dua
                    portion via anchored token alignment (see
                    slice_transliteration); emitted with
                    "transliteration_source": "alquran.cloud". If the slice
                    cannot be anchored safely the transliteration is left
                    empty ("") rather than guessed, and the frontend hides
                    the transliteration toggle for that entry.
  * kind "hisn"   - sunnah.com Hisn al-Muslim page N. Arabic, transliteration,
                    English and the reference line are all parsed from the
                    page's stable CSS classes (arabic_text_details,
                    transliteration, translation, hisn_english_reference).

Every shipped text is fetched from one of those sources; the script refuses
to emit anything it could not fetch and parse.

Output schema per entry (the frontend reads the first six fields and ignores
the provenance extras): id, type, arabic, transliteration, english, source,
occasion, source_url, fetched_at (+ transliteration_source / hisn_reference
where applicable).

Politeness: pages and API responses are cached on disk for the run (default
cache lives under the system temp dir), and live fetches are throttled to
1 request/second for sunnah.com.

Usage:
    python build_duas.py                 # writes data/duas.json
    python build_duas.py --keep-cache    # leave the page cache behind

If any entry fails to fetch or parse, the error is reported, the remaining
entries are still processed, and the output file is NOT written.

Stdlib only (urllib, json, re, html, time).
"""

import argparse
import html
import json
import re
import shutil
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "data" / "duas_manifest.json"
OUTPUT_PATH = ROOT / "data" / "duas.json"
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "duas_build_cache"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "IqamahDuaBuild/1.0 (+https://iqamah.co.uk; dua dataset build script)"
)

QURAN_API = (
    "https://api.quran.com/api/v4/verses/by_key/{ref}"
    "?fields=text_uthmani&translations=20"  # 20 = Saheeh International
)
TRANSLIT_API = (
    "https://api.alquran.cloud/v1/ayah/{ref}/en.transliteration"
)
HISN_URL = "https://sunnah.com/hisn:{n}"

# Minimum seconds between live requests, per host.
THROTTLE = {"sunnah.com": 1.0, "api.quran.com": 0.5, "api.alquran.cloud": 0.5}
_last_request = {}

RE_SUP = re.compile(r"<sup\b[^>]*>.*?</sup>", re.S)  # translation footnotes
RE_TAG = re.compile(r"<[^>]+>")


class HisnPageParser(HTMLParser):
    """Collects the dua content from a sunnah.com hisn page.

    Verified against the live HTML: Arabic lives in
    <div class="arabic_hadith_full arabic"> (usually wrapped in an
    arabic_text_details span, but a handful of pages put the text directly in
    the div, and some nest a hisn_arabic_instructions span, e.g. a
    "(three times)" marker, inside it, so naive regexes truncate). The
    transliteration, translation and reference line live in spans with those
    class names. <sup> footnote markers inside the translation are skipped.
    """

    BUCKET_CLASSES = {
        "arabic_hadith_full": "arabic",
        "transliteration": "translit",
        "translation": "english",
        "hisn_english_reference": "reference",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._stack = []  # (tag, bucket-or-None) for every open tag
        self._sup_depth = 0
        self.parts = {name: [] for name in self.BUCKET_CLASSES.values()}

    def handle_starttag(self, tag, attrs):
        classes = (dict(attrs).get("class") or "").split()
        bucket = next((b for c, b in self.BUCKET_CLASSES.items()
                       if c in classes), None)
        if bucket:
            # Separator so adjacent spans never glue together
            # (e.g. hisn:66 has consecutive transliteration spans).
            self.parts[bucket].append(" ")
        if tag == "sup":
            self._sup_depth += 1
        self._stack.append((tag, bucket))

    def handle_endtag(self, tag):
        if tag == "sup" and self._sup_depth:
            self._sup_depth -= 1
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                del self._stack[i:]
                break

    def handle_data(self, data):
        if self._sup_depth:
            return  # footnote marker text
        bucket = next((b for _, b in reversed(self._stack) if b), None)
        if bucket:
            self.parts[bucket].append(data)

    def text(self, name):
        return re.sub(r"\s+", " ", "".join(self.parts[name])).strip()


# --------------------------------------------------------------------------
# Fetching (disk cache + per-host throttle)
# --------------------------------------------------------------------------

def fetch(url, cache_file):
    """Return (text, fetched_at_iso). Serves from cache when available."""
    if cache_file.exists() and cache_file.stat().st_size > 0:
        stamp = datetime.fromtimestamp(cache_file.stat().st_mtime, timezone.utc)
        return cache_file.read_text(encoding="utf-8"), _iso(stamp)

    host = url.split("/")[2]
    wait = THROTTLE.get(host, 1.0) - (time.monotonic() - _last_request.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    _last_request[host] = time.monotonic()

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(text, encoding="utf-8")
    return text, _iso(datetime.now(timezone.utc))


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Text normalisation
# --------------------------------------------------------------------------

def clean_html_text(raw):
    """Strip tags/entities and collapse whitespace (footnote sups removed)."""
    text = RE_SUP.sub("", raw)
    text = RE_TAG.sub(" ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def clean_english(text):
    """English-facing cleanup: no em dashes in user-facing text."""
    text = re.sub(r"\s*—\s*", ", ", text)   # em dash
    text = re.sub(r"\s+–\s+", ", ", text)   # spaced en dash
    return re.sub(r"\s+", " ", text).strip()


def clean_arabic(text):
    """Arabic is kept exactly as fetched, beyond whitespace tidying."""
    return re.sub(r"\s+", " ", text).strip()


def tidy_hisn_english(text):
    """Page-specific tidying of the hisn translation text.

    Some pages embed footnote markers as plain digits (not <sup>), e.g.
    'a new day 1 and' or 'the grave.3'. Removes digits attached after
    sentence punctuation, and single digits standing alone between words
    (footnotes are single digits; genuine counts in these translations are
    spelled out, e.g. 'three times'). Also moves a colon trapped inside a
    closing parenthesis, '(... again adding :)', outside it so the text
    does not read as an emoticon."""
    text = re.sub(r"(?<=[.!?,;:])\d{1,2}\b", "", text)
    text = re.sub(r"(?<=[a-z]) \d (?=[a-z])", " ", text)
    text = re.sub(r"\s*:\s*\)", "):", text)
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------
# Quran entries
# --------------------------------------------------------------------------

def parse_ref(ref):
    """'2:201' -> (2, 201, 201); '20:25-28' -> (20, 25, 28)."""
    surah, _, ayat = ref.partition(":")
    first, _, last = ayat.partition("-")
    return int(surah), int(first), int(last or first)


def fetch_ayah(ref, cache_dir):
    cache_file = cache_dir / f"quran_{ref.replace(':', '_')}.json"
    text, fetched_at = fetch(QURAN_API.format(ref=ref), cache_file)
    verse = json.loads(text)["verse"]
    arabic = verse["text_uthmani"]
    english = clean_html_text(verse["translations"][0]["text"])
    return arabic, english, fetched_at


def fetch_translit(ref, cache_dir):
    """Tanzil transliteration of one ayah, from alquran.cloud."""
    cache_file = cache_dir / f"translit_{ref.replace(':', '_')}.json"
    text, _ = fetch(TRANSLIT_API.format(ref=ref), cache_file)
    payload = json.loads(text)
    if payload.get("code") != 200:
        raise ValueError(f"alquran.cloud returned code {payload.get('code')}")
    return re.sub(r"\s+", " ", payload["data"]["text"]).strip()


def arabic_slice_indices(tokens, from_word, to_word):
    """Token indices [start, end) of the quoted dua portion."""
    start = 0
    if from_word:
        if from_word not in tokens:
            raise ValueError(f"from_word {from_word!r} not found in ayah text")
        start = tokens.index(from_word)
    end = len(tokens)
    if to_word:
        if to_word not in tokens[start:]:
            raise ValueError(f"to_word {to_word!r} not found after from_word")
        end = tokens.index(to_word, start) + 1
    return start, end


# --------------------------------------------------------------------------
# Transliteration slicing (anchored token alignment)
#
# Tanzil's en.transliteration is word-based but NOT strictly token-aligned
# with the Uthmani text: the Arabic carries standalone stop-sign tokens
# (U+06D6..), while the transliteration splits proclitics ("wa minhum" for
# one Arabic token) and merges elisions ("Rabbir hamhumaa" for
# "rabbi irham-huma", "lhasbiyal" for "...qul hasbiya l-..."). A pure
# count-offset slice therefore drifts. Instead, each manifest slice word is
# anchored: find every token matching the anchor pattern on BOTH sides,
# require the counts to agree, and map the Arabic occurrence to the
# transliteration occurrence of the same rank. Any disagreement aborts the
# slice and the transliteration is left empty -- never guessed.
# --------------------------------------------------------------------------

# Strips harakat/tanwin/shadda/sukun, Quranic annotation signs, superscript
# alef, hamza marks and tatweel; normalises alif and ya variants.
RE_AR_MARKS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")


def strip_arabic(token):
    t = RE_AR_MARKS.sub("", token)
    t = re.sub(r"[آأإٱ]", "ا", t)  # alif variants
    return t.replace("ي", "ى")                     # ya -> dotless ya


def norm_latin(token):
    """Lowercase letters only ('Rabbanaaa,' -> 'rabbanaaa')."""
    return re.sub(r"[^a-z]", "", token.lower())


# Anchor table covering the manifest's from_word/to_word forms (keys are
# strip_arabic output). Each entry: how a candidate matches on the Arabic
# side ("exact" stripped equality / "prefix" startswith) and the regex a
# normalised transliteration token must match. The optional leading [a-z]
# absorbs Tanzil's elision merges (e.g. "lhasbiyal").
ANCHORS = {
    "ربنا":  # ربنا (rabbana)
        ("exact", re.compile(r"^[a-z]?rabban[aeiou]+$")),
    "رب":              # رب (rabbi)
        ("prefix", re.compile(r"^[a-z]?rabb")),
    "لا":              # لا (laa)
        ("exact", re.compile(r"^[a-z]?l[aeiou]+$")),
    "حسبى":  # حسبى (hasbiya)
        ("exact", re.compile(r"^[a-z]?[aeiou]?hasb")),
    "اخطانا":  # اخطانا (akhta'na)
        ("exact", re.compile(r"^[a-z]?akhta")),
}


def _anchor_matches(tokens, key, mode):
    """Indices of Arabic tokens matching the anchor key."""
    out = []
    for i, token in enumerate(tokens):
        stripped = strip_arabic(token)
        if (stripped == key) if mode == "exact" else stripped.startswith(key):
            out.append(i)
    return out


def anchor_translit_index(ar_tokens, tr_tokens, anchor_word, ar_index):
    """Map the Arabic token at ar_index (an occurrence of anchor_word) to the
    corresponding transliteration token index, by occurrence rank."""
    key = strip_arabic(anchor_word)
    if key not in ANCHORS:
        raise ValueError(f"no anchor pattern for {anchor_word!r}")
    mode, tr_re = ANCHORS[key]
    ar_hits = _anchor_matches(ar_tokens, key, mode)
    tr_hits = [i for i, t in enumerate(tr_tokens) if tr_re.match(norm_latin(t))]
    if ar_index not in ar_hits:
        raise ValueError(f"slice word {anchor_word!r} does not match its own "
                         f"anchor pattern")
    if len(ar_hits) != len(tr_hits):
        raise ValueError(
            f"anchor {anchor_word!r}: {len(ar_hits)} Arabic matches vs "
            f"{len(tr_hits)} transliteration matches (cannot align safely)")
    return tr_hits[ar_hits.index(ar_index)]


def slice_transliteration(ar_tokens, translit, from_word, to_word, ar_start, ar_end):
    """Slice the full-ayah transliteration to the dua portion, anchored on
    the same manifest words used to slice the Arabic. Raises ValueError when
    the anchors cannot be located unambiguously."""
    tr_tokens = translit.split()
    if not tr_tokens:
        raise ValueError("empty transliteration text")

    start = (anchor_translit_index(ar_tokens, tr_tokens, from_word, ar_start)
             if from_word else 0)
    end = (anchor_translit_index(ar_tokens, tr_tokens, to_word, ar_end - 1) + 1
           if to_word else len(tr_tokens))
    if start >= end:
        raise ValueError("transliteration slice is empty after anchoring")

    # Sanity check (also covers the unsliced case): the first kept token must
    # plausibly romanise the first kept Arabic token.
    first_key = strip_arabic(from_word or ar_tokens[ar_start])
    if first_key in ANCHORS:
        mode, tr_re = ANCHORS[first_key]
        if not tr_re.match(norm_latin(tr_tokens[start])):
            raise ValueError(
                f"sanity check failed: token {tr_tokens[start]!r} does not "
                f"romanise {from_word or ar_tokens[ar_start]!r}")

    # Tidy the seam left by a mid-ayah end cut (e.g. 'akhtaanaa;').
    return " ".join(tr_tokens[start:end]).strip().rstrip(";,")


def slice_english(text, en_to):
    """Quoted-span rule: Saheeh International wraps the spoken dua in double
    quotes. Returns (sliced_text, note). Falls back to the full translation
    when there is no quoted span."""
    opening = text.find('"')
    if opening == -1:
        return text, "english: full ayah translation (no quoted span)"
    closing = text.find('"', opening + 1)
    span = text[opening + 1: closing if closing != -1 else len(text)].strip()
    note = "english: quoted dua span"
    if en_to:
        cut = span.find(en_to)
        if cut == -1:
            raise ValueError(f"en_to {en_to!r} not found in translation span")
        span = span[: cut + len(en_to)].strip()
        note += " (cut at en_to)"
    # Tidy the seam left by slicing mid-sentence.
    span = span.rstrip(",;").strip()
    if span and span[-1] not in ".!?":
        span += "."
    return span, note


def build_quran_entry(item, cache_dir):
    src = item["source"]
    ref = src["ref"]
    surah, first, last = parse_ref(ref)

    arabic_parts, english_parts, translit_parts, fetched_at = [], [], [], None
    translit_error = None
    for ayah in range(first, last + 1):
        a, e, fetched_at = fetch_ayah(f"{surah}:{ayah}", cache_dir)
        arabic_parts.append(a)
        english_parts.append(e)
        if translit_error is None:
            try:
                translit_parts.append(fetch_translit(f"{surah}:{ayah}", cache_dir))
            except Exception as exc:
                translit_error = f"fetch failed: {exc}"

    ar_tokens = clean_arabic(" ".join(arabic_parts)).split()
    start, end = arabic_slice_indices(
        ar_tokens, src.get("from_word"), src.get("to_word"))
    arabic = " ".join(ar_tokens[start:end])
    english, note = slice_english(
        clean_english(" ".join(english_parts)), src.get("en_to"))

    translit = ""
    if translit_error is None:
        try:
            translit = slice_transliteration(
                ar_tokens, " ".join(translit_parts),
                src.get("from_word"), src.get("to_word"), start, end)
        except Exception as exc:
            translit_error = str(exc)
    if translit_error:
        note += f"; translit BLANKED ({translit_error})"
        print(f"WARNING [{item['id']}] transliteration blanked: "
              f"{translit_error}", file=sys.stderr)
    else:
        note += "; translit: alquran.cloud (anchored slice)"

    span = f"{first}-{last}" if last != first else str(first)
    entry = {
        "id": item["id"],
        "type": "dua",
        "arabic": arabic,
        "transliteration": translit,
        "english": english,
        "source": f"Quran {surah}:{span}",
        "occasion": clean_english(item["occasion"]),
        "source_url": f"https://quran.com/{surah}/{span}",
        "fetched_at": fetched_at,
    }
    if translit:
        entry["transliteration_source"] = "alquran.cloud"
    return entry, note


# --------------------------------------------------------------------------
# Hisn al-Muslim entries
# --------------------------------------------------------------------------

# Hadith collections recognised when condensing a reference line for the
# small source chip. The first one cited (with its volume/page if directly
# attached) is used, e.g. 'Al-Bukhari 1/152, and the addition between
# brackets is from Al-Bayhaqi...' -> 'Al-Bukhari 1/152'.
RE_COLLECTION = re.compile(
    r"(Al-Bukhari|Muslim|Abu Dawud|At-Tirmidhi|An-Nasa'i|Ibn Majah"
    r"|Ibn Hibban|Ahmad|Malik|Ad-Darimi|Al-Hakim|Ibn As-Sunni)"
    r"(\s+\d+\s*/\s*\d+|\s+no\.\s*\d+)?")


def condense_reference(reference):
    """Pick the first recognisable collection citation out of the (often
    discursive) hisn reference line. Returns '' when nothing usable is found
    (e.g. 'ibid.'), in which case the source chip omits the parenthetical."""
    match = RE_COLLECTION.search(reference)
    if not match:
        return ""
    citation = match.group(1)
    if match.group(2):
        citation += " " + re.sub(r"\s*/\s*", "/", match.group(2).strip())
    return re.sub(r"\s+", " ", citation).strip()


def build_hisn_entry(item, cache_dir):
    n = item["source"]["number"]
    url = HISN_URL.format(n=n)
    page, fetched_at = fetch(url, cache_dir / f"hisn_{n}.html")

    parser = HisnPageParser()
    parser.feed(page)
    arabic = clean_arabic(parser.text("arabic"))
    translit = clean_english(parser.text("translit"))
    english = tidy_hisn_english(clean_english(parser.text("english")))
    reference = clean_english(parser.text("reference"))

    for label, value in (("arabic", arabic), ("transliteration", translit),
                         ("english", english), ("reference", reference)):
        if not value:
            raise ValueError(f"hisn:{n} parse failure: empty {label}")

    # Manifest may pin the chip citation when the mechanical pick is
    # misleading (e.g. several collections cited, ours not first).
    citation = item["source"].get("ref_label") or condense_reference(reference)
    source = f"Hisn al-Muslim {n}" + (f" ({citation})" if citation else "")

    entry = {
        "id": item["id"],
        "type": "dua",
        "arabic": arabic,
        "transliteration": translit,
        "english": english,
        "source": source,
        "occasion": clean_english(item["occasion"]),
        "source_url": url,
        "fetched_at": fetched_at,
        "hisn_reference": reference,
    }
    return entry, "all texts from sunnah.com"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE,
                        help="page/API cache directory (default: %(default)s)")
    parser.add_argument("--keep-cache", action="store_true",
                        help="do not delete the cache directory on success")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    builders = {"quran": build_quran_entry, "hisn": build_hisn_entry}

    entries, rows, failures = [], [], 0
    for item in manifest:
        kind = item["source"]["kind"]
        ref = item["source"].get("ref") or item["source"].get("number") or "?"
        try:
            if kind not in builders:
                raise ValueError(f"unknown source kind {kind!r}")
            entry, note = builders[kind](item, args.cache_dir)
            entries.append(entry)
            rows.append((item["id"], kind, str(ref), "ok", note))
        except Exception as exc:  # fail loudly per entry, keep going
            failures += 1
            rows.append((item["id"], kind, str(ref), "FAILED", str(exc)))
            print(f"ERROR [{item['id']}] {exc}", file=sys.stderr)

    # Summary table
    widths = [max(len(r[i]) for r in rows + [("id", "kind", "ref", "status", "")])
              for i in range(4)]
    print()
    print("  ".join(h.ljust(w) for h, w in zip(("id", "kind", "ref", "status"), widths))
          + "  note")
    print("-" * (sum(widths) + 40))
    for r in rows:
        print("  ".join(v.ljust(w) for v, w in zip(r[:4], widths)) + f"  {r[4]}")
    blanked = sum("translit BLANKED" in r[4] for r in rows)
    print(f"\n{len(entries)} built, {failures} failed, {len(manifest)} total"
          + (f", {blanked} transliteration(s) blanked" if blanked else ""))

    if failures:
        print("Output NOT written (fix the failures above and re-run).",
              file=sys.stderr)
        return 1

    args.out.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    print(f"Wrote {args.out} ({len(entries)} entries)")

    if not args.keep_cache and args.cache_dir.exists():
        shutil.rmtree(args.cache_dir, ignore_errors=True)
        print(f"Removed cache {args.cache_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
