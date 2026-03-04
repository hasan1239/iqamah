// ============================================================
// Prayerly — Cloudflare Pages Worker
// Handles clean URL routing + Add Your Masjid API endpoints
// ============================================================

// --- Rate limiting (in-memory, per-isolate) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5; // max extractions per IP per window

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// --- Extraction prompt (ported from extract_timetable.py) ---
const EXTRACTION_PROMPT = `You are extracting prayer times from a mosque timetable image into a standardised JSON format. Your goal is 100% accuracy — every time value must exactly match what is printed on the timetable.

This prompt works for ANY mosque timetable — any month, any location, any format.

STEP 1: SURVEY THE ENTIRE IMAGE
Before extracting any data, scan the FULL image including:
- The main table with rows and columns
- Column headers (which may be in Arabic, English, or both)
- Vertical/rotated text running alongside columns (commonly used for Fajr Jama'at rules, Zuhr Jama'at times, and Maghrib Jama'at rules)
- Footnotes, bottom text, and side notes (these frequently contain fixed jama'at times, Jumu'ah times, Eid salah times, Sadaqatul Fitr amounts, and radio frequencies)
- The mosque name, address, and contact details (usually at the top or bottom)
- The month, year, and Islamic month/year (e.g. "Ramadan 1447 AH", "June 2025", "Dhul Hijjah 1446")

STEP 2: IDENTIFY COLUMN MAPPING
Timetables vary widely in column names. Map each column you see to the correct output field:

  Sehri Ends / End of Suhoor / Suhur End / End of Sehri / Sehri / Fajr Begins / Fajr Start / Subha Sadiq → "sehri_ends"
  Sunrise / Sun-Rise → "sunrise"
  Zohr / Zuhr / Dhuhr Start / Dhuhr Begins / Zuhr Start / Zuhr Begins → "zohr"
  Asr Start / Asr Begins → "asr"
  Esha / Isha Start / Isha Begins → "esha"
  Fajr Jama'at / Fajr Jamaat / Fajar Jamaat → "fajr_jamaat"
  Zohar Jama'at / Zuhr Jama'at / Dhuhr Jama'at / Dhuhr Jamaat / Zuhr Jamaat / Zohr & Juma → "zohar_jamaat"
  Asr Jama'at / Asr Jamaat → "asr_jamaat"
  Maghrib / Iftaar / Iftar / Maghrib Azan / Iftaar Maghrib / Maghrib Azan & Iftari → "maghrib_iftari"
  Esha Jama'at / Isha Jama'at / Isha Jamaat / Taraweeh Jamaat → "esha_jamaat"

IMPORTANT COLUMN DISAMBIGUATION:

Sunset vs Maghrib/Iftar: Some timetables have BOTH a "Sunset" column AND a separate "Maghrib" or "Iftar" column. These are different values — Sunset is the astronomical event, while Maghrib/Iftar is a few minutes later when the prayer begins and the fast is broken. If both columns exist, ALWAYS use the Maghrib/Iftar column for "maghrib_iftari", NOT the Sunset column. If only one of these columns exists, use whichever is available.

Sehri Ends vs Fajr Start: Some timetables have both "End of Suhoor" and "Fajr Start" as separate columns. Others only have one (treating them as the same). Use whichever column represents the earliest pre-dawn time — typically "End of Suhoor/Sehri Ends" if both exist. If only "Fajr Start" exists, use that.

Zawal/Zenith vs Zohr/Zuhr: Some timetables have BOTH a "Zawal" / "Zenith" / "After Zenith" column AND a separate "Zohr" / "Zuhr" / "Dhuhr Start" column. These are different — Zawal is when the sun passes its zenith (and prayer is NOT permitted), while Zohr/Zuhr is when the Dhuhr prayer window begins (a few minutes later). If both columns exist, ALWAYS use the Zohr/Zuhr/Dhuhr column for "zohr", NOT the Zawal/Zenith column. If only one exists, use whichever is available.

NOTE ON PRE-MONTH ROWS:
Some timetables include rows before the main month begins (e.g. a Ramadan timetable starting from the day before Ramadan). Include ALL rows shown in the timetable — do not skip or renumber them.

STEP 3: HANDLE SPECIAL PATTERNS

DITTO MARKS — CRITICAL:
Many timetables use ditto marks to mean "same as the row above". These appear as:
  " (double quote)
  '' (two single quotes)
  "" (two double quotes)
  « (guillemet)
  ″ (double prime)
  Empty/blank cells that clearly should have a value
You MUST resolve ALL of these to the actual repeated value. Walk down each column: if a cell has a ditto mark, copy the value from the nearest non-ditto row above it. NEVER output a ditto mark — every cell must have an explicit time value or be genuinely empty.

VERTICAL/ROTATED TEXT:
Some columns have a rule written vertically instead of individual values per row. Common examples:
  - "FIFTEEN MINUTES AFTER SEHRI ENDS" / "Fajr will be 15 minutes after suhur end" / "TEN MINUTES AFTER SEHRI ENDS" / "15 minutes after Fajr start" → for fajr_jamaat, calculate the actual time for each row by adding the stated minutes to the value the rule references. Pay close attention to what the rule says: if it says "after Sehri ends" add to the sehri_ends value; if it says "after Fajr start" or "after Fajr beginning time" add to the Fajr Start column (even if that is a different column from sehri_ends). Output the calculated time, not a formula (e.g. Sehri 5:42 + 15 mins → fajr_jamaat "5:57"). HOWEVER: if the Fajr Jama'at column also contains explicit per-row time values, ALWAYS use the explicit values from the table — they take priority over any rule or note. The rule may be approximate guidance while the table values are the mosque's actual scheduled times.
  - "Zuhar Jamat 1:00" / "Jumu'ah Jamat 1:00" → set zohar_jamaat to "1:00" for all rows (or apply Jumu'ah-specific time on Fridays if different). ALSO extract any Jumu'ah time mentioned here into the "jummah_times" metadata field — do not just put it in "notes".
  - "Maghrib Jama'at, 10 minutes after Azan" / "5 minutes after Iftar" / "straight after breaking fast" → there is no maghrib_jamaat field in the output. Note the rule in the "notes" field instead.

HEADER NOTES AND ANNOUNCEMENTS:
Some timetables show key information in large text ABOVE the table (not in footnotes). For example:
  - "ZOHR 1:00PM & JUMUAH @ 1:15PM" → extract into jummah_times metadata (e.g. "1:15pm") AND apply: zohar_jamaat = "1:00" on non-Fridays, "1:15" on Fridays.
  - "Fajr Jamaat will be 15 mins after Sehri Ends" → apply the rule (but explicit table values take priority if present).
  Treat these header notes the same as footnotes — extract relevant data into the correct metadata fields.

FOOTNOTES AND BOTTOM NOTES:
Look carefully at text below or beside the table. Common patterns:
  - "Daily Zuhr Jama'at: 1:00pm" / "Zuhr Jamaat - 12:40pm" → apply this time to zohar_jamaat for all non-Friday rows
  - "Jumu'ah at 12:30pm & 1:40pm" / "First Jamaat @ 12:45pm Second Jamaat @ 1:30pm" → extract into jummah_times metadata AND use the FIRST jumu'ah time as zohar_jamaat on Fridays
  - "Eid Salah: 7:30am & 9:00am" → extract into eid_salah metadata
  - "Sadaqatul Fitr: £X" / "Sadq-E-Fitr £5.00" / "Fitrana £6 per person" → extract into sadaqatul_fitr metadata
  - "Radio Frequency: 454.3500" / "Freq: 461.2375" → extract into radio_frequency metadata

FRIDAY OVERRIDES FOR ZOHAR JAMA'AT:
On Fridays, the Zuhr/Dhuhr Jama'at time often changes to a Jumu'ah time. Check:
1. Does the table show explicit different values on Friday rows? → Use those values.
2. Does a footnote specify a Jumu'ah time different from the daily Zuhr Jama'at? → Use the first Jumu'ah time on Fridays, the daily time on other days.
3. If no distinction is made, use the same time for all days.

DATE FORMATTING:
Some timetables show full dates ("18 Feb"), others show only day numbers ("18", "19", "20"...) without the month. If only day numbers are shown, you must infer the month from context: look at the timetable title, headers, or footnotes for the month/year information, and combine it with the day numbers. If the timetable spans two months (e.g. February into March), determine where the month changes by looking at when day numbers reset from a high number back to 1 (e.g. 28 → 1 means Feb → Mar). Always output dates in "DD Mon" format (e.g. "18 Feb", "1 Mar").

STEP 4: OUTPUT FORMAT

Return this exact JSON structure:
{
  "mosque_name": "Full Mosque Name as shown on the timetable",
  "suggested_slug": "faizul",
  "address": "Full address as shown on the timetable",
  "phone": "Phone number as shown on the timetable",
  "month": "February-March 2026",
  "islamic_month": "Ramadan 1447",
  "jummah_times": "1st Jumu'ah: 12:30pm, 2nd Jumu'ah: 1:40pm",
  "eid_salah": "7:30am & 9:00am",
  "sadaqatul_fitr": "£7 per person",
  "radio_frequency": "454.3500",
  "notes": "Any other relevant notes not captured above: Maghrib jama'at rules, Taraweeh details, etc.",
  "rows": [
    {
      "date": "18 Feb",
      "day": "Wed",
      "islamic_day": 1,
      "sehri_ends": "5:42",
      "sunrise": "7:17",
      "zohr": "12:27",
      "asr": "2:55",
      "esha": "",
      "fajr_jamaat": "5:57",
      "zohar_jamaat": "12:40",
      "asr_jamaat": "4:30",
      "maghrib_iftari": "5:28",
      "esha_jamaat": "7:15"
    }
  ]
}

METADATA FIELD DEFINITIONS:
- "mosque_name": Full name as shown on the image
- "suggested_slug": A short, URL-safe slug (lowercase, no spaces, underscores only) derived from the most distinctive word(s) in the mosque name. Strip common prefixes like Masjid, Masjid-e, Masjid-al, Jam-e, Jamia, Al, and common suffixes like Trust, Foundation, Association, Society, Centre, Mosque, Islamic Centre. Use what remains as the slug. If the remaining word is very long, abbreviate sensibly. Examples: "Masjid Faizul Islam" → "faizul", "Birmingham Jam-e-Masjid" → "jame", "Eden Foundation" → "eden", "Masjid Al Falaah" → "falaah", "Masjid Abu Bakr" → "abubakr", "Great Barr Muslim Foundation" → "gbmf", "Madinatul Uloom Al-Islamyah" → "muai".
- "address": Full street address including postcode/ZIP if visible. Set to "" if not shown.
- "phone": Phone number(s) as shown. Include multiple if listed (e.g. "0121 554 9157 / 07980 924 816"). Set to "" if not shown.
- "month": The Gregorian month(s) and year covered (e.g. "June 2025", "February-March 2026")
- "islamic_month": The Islamic month and Hijri year if shown (e.g. "Ramadan 1447", "Dhul Hijjah 1446"). Set to "" if not shown.
- "jummah_times": Jumu'ah/Friday prayer time(s) exactly as stated. Many mosques have multiple Jumu'ah salahs — include all with khutbah/speech times if listed (e.g. "1st: 12:30pm (Khutbah 12:10pm), 2nd: 1:30pm"). Set to "" if not shown.
- "eid_salah": Eid salah time(s) exactly as stated (e.g. "7:30am & 9:00am", "1st Salah: 7:00am, 2nd Salah: 8:00am"). Include all listed times. Set to "" if not shown.
- "sadaqatul_fitr": Sadaqatul Fitr / Sadqa-e-Fitr / Fitrana amount exactly as stated including currency (e.g. "£7 per person", "£4.50", "£6 per person (min)"). Set to "" if not shown.
- "radio_frequency": Radio receiver frequency if shown (e.g. "454.3500", "461.2375"). Set to "" if not shown.
- "notes": Any other relevant notes not captured by the fields above: Maghrib jama'at rules, Taraweeh details, special programmes, etc.

ROW FIELD DEFINITIONS:
- "date": "DD Mon" format (e.g. "18 Feb", "1 Mar", "15 Jun"). Always include the month abbreviation even if the timetable only shows day numbers.
- "day": Three-letter day name (e.g. "Wed", "Thu", "Fri")
- "islamic_day": The Islamic/Hijri day number if shown in the timetable. Set to null if not present.
- "sehri_ends": When suhoor/sehri must stop OR Fajr start time (pre-dawn time)
- "sunrise": Sunrise time
- "zohr": Dhuhr/Zuhr START time (beginning of prayer window, NOT jama'at)
- "asr": Asr START time (beginning of prayer window, NOT jama'at)
- "esha": Esha/Isha START time (beginning of prayer window, NOT jama'at). Set to "" if the timetable does not have this column.
- "fajr_jamaat": Fajr congregational prayer time. If the Fajr Jama'at column has explicit per-row values, ALWAYS use those — even if a note or header also states a rule like "15 minutes after Sehri ends". Only calculate from the rule if the column itself has no individual values (e.g. vertical text only, or all ditto marks with no starting value). Set to "" if not present.
- "zohar_jamaat": Dhuhr/Zuhr congregational prayer time. Apply Friday Jumu'ah overrides if applicable. Set to "" if not present.
- "asr_jamaat": Asr congregational prayer time. Set to "" if not present.
- "maghrib_iftari": Maghrib/Iftar time (when the fast breaks and Maghrib prayer begins). If both Sunset and Maghrib columns exist, use the Maghrib/Iftar column.
- "esha_jamaat": Esha/Isha congregational prayer time. Set to "" if not present.

EVERY row must include ALL 13 fields listed above (date through esha_jamaat), even if the value is "" (empty string) because the timetable doesn't have that column.

TIME FORMAT RULES:
- Always use colons, not dots (convert "5.40" to "5:40")
- Keep the same hour format as the timetable (if it shows "5:24" for Fajr and "12:28" for Dhuhr, keep that — do not convert between 12h/24h)
- Do not add leading zeros unless the timetable uses them
- If a column genuinely doesn't exist in the timetable, use "" (empty string)

STEP 5: VALIDATE YOUR OUTPUT

Before returning, check:
1. Row count: Count the rows in the timetable image and ensure your output matches exactly.
2. Monotonic trends: Over any given month, sehri/fajr times should trend consistently (getting earlier or later depending on season and hemisphere) and maghrib should trend consistently the opposite way. If values jump erratically, re-read the image.
3. Day sequence: Days should follow a consistent weekly cycle (Mon, Tue, Wed, Thu, Fri, Sat, Sun). Verify the first date's day matches what is shown.
4. No ditto marks remain: Every cell must be a time value or "". No " or '' ditto characters anywhere in the output.
5. Every row has all 13 fields with no missing keys.
6. Fajr Jama'at values are actual calculated times, never "SEHRI+15" or similar formulas.
7. Zohar Jama'at on Fridays reflects any Jumu'ah override found in the timetable.
8. All dates include month abbreviation in "DD Mon" format.

Return ONLY valid JSON, no markdown fences, no explanation, no preamble.`;

// --- Validation helpers (ported from extract_timetable.py) ---

function timeToMinutes(t, forcePm = false) {
  if (!t || !t.trim()) return null;
  t = t.trim().toLowerCase().replace('am', '').replace('pm', '').trim();
  const parts = t.split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  const hour = (forcePm && h >= 1 && h <= 11) ? h + 12 : h;
  return hour * 60 + m;
}

function parseZoharJamaatFromNotes(notes) {
  if (!notes) return {};
  const pattern = notes.match(/(?:zuhr|zohr|zohar|dhuhr)\s*(?:jama['']?a?t)\s*[:\-]\s*(.+?)(?:\.|$)/i);
  if (!pattern) return {};
  const text = pattern[1].trim();
  const result = {};
  const dayExpand = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const segments = text.split(/,\s*/);
  let firstTime = null;

  for (const seg of segments) {
    const timeMatch = seg.match(/(\d{1,2}:\d{2})\s*(?:am|pm)?/i);
    if (!timeMatch) continue;
    const timeVal = timeMatch[1];
    if (firstTime === null) firstTime = timeVal;

    const segLower = seg.toLowerCase();
    const foundDays = [];
    const rangeParts = [...segLower.matchAll(/(mon|tue|wed|thu|fri|sat|sun)(?:\s*-\s*(mon|tue|wed|thu|fri|sat|sun))?/g)];
    const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    for (const [, startDay, endDay] of rangeParts) {
      if (endDay) {
        const si = allDays.indexOf(startDay);
        const ei = allDays.indexOf(endDay);
        if (si <= ei) foundDays.push(...allDays.slice(si, ei + 1));
        else foundDays.push(...allDays.slice(si), ...allDays.slice(0, ei + 1));
      } else {
        foundDays.push(startDay);
      }
    }

    if (foundDays.length > 0) {
      for (const d of foundDays) result[dayExpand[d]] = timeVal;
    } else if (Object.keys(result).length === 0) {
      result.default = timeVal;
    }
  }

  if (!result.default && firstTime) result.default = firstTime;
  return result;
}

function validateAndFixRows(rows, notes) {
  const fixCounts = { zohar_shift: 0, esha_move: 0, asr_swap: 0, esha_swap: 0, zohar_notes: 0 };

  for (const row of rows) {
    let zohrMins = timeToMinutes(row.zohr || '', true);
    let zoharJMins = timeToMinutes(row.zohar_jamaat || '', true);
    let asrMins = timeToMinutes(row.asr || '', true);
    let asrJMins = timeToMinutes(row.asr_jamaat || '', true);
    let eshaMins = timeToMinutes(row.esha || '', false);
    let eshaJMins = timeToMinutes(row.esha_jamaat || '', false);

    // Fix 1: Zohar jamaat looks like Asr start (>90min after Dhuhr start)
    if (zohrMins !== null && zoharJMins !== null && (zoharJMins - zohrMins) > 90) {
      row.asr_jamaat = row.asr || '';
      row.asr = row.zohar_jamaat || '';
      row.zohar_jamaat = '';
      fixCounts.zohar_shift++;
      asrMins = timeToMinutes(row.asr || '', true);
      asrJMins = timeToMinutes(row.asr_jamaat || '', true);
    }

    // Fix 2: Esha exists but esha_jamaat empty
    if (row.esha && !row.esha_jamaat) {
      row.esha_jamaat = row.esha;
      row.esha = '';
      fixCounts.esha_move++;
      eshaMins = null;
      eshaJMins = timeToMinutes(row.esha_jamaat || '', false);
    }

    // Fix 3: Asr start > Asr jamaat
    asrMins = timeToMinutes(row.asr || '', true);
    asrJMins = timeToMinutes(row.asr_jamaat || '', true);
    if (asrMins !== null && asrJMins !== null && asrMins > asrJMins) {
      [row.asr, row.asr_jamaat] = [row.asr_jamaat, row.asr];
      fixCounts.asr_swap++;
    }

    // Fix 4: Esha start > Esha jamaat
    eshaMins = timeToMinutes(row.esha || '', false);
    eshaJMins = timeToMinutes(row.esha_jamaat || '', false);
    if (eshaMins !== null && eshaJMins !== null && eshaMins > eshaJMins) {
      [row.esha, row.esha_jamaat] = [row.esha_jamaat, row.esha];
      fixCounts.esha_swap++;
    }
  }

  // Fix 5: Fill zohar_jamaat from notes if empty
  const zoharFromNotes = parseZoharJamaatFromNotes(notes);
  if (Object.keys(zoharFromNotes).length > 0) {
    for (const row of rows) {
      if (!row.zohar_jamaat) {
        const day = row.day || '';
        const timeVal = zoharFromNotes[day] || zoharFromNotes.default || '';
        if (timeVal) {
          row.zohar_jamaat = timeVal;
          fixCounts.zohar_notes++;
        }
      }
    }
  }

  return { rows, fixCounts };
}

// --- Slug helpers ---

function slugify(name) {
  let s = name.toLowerCase().trim();
  s = s.replace(/[^\w\s-]/g, '');
  s = s.replace(/[\s_-]+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  return s;
}

function sanitiseMasjidName(name) {
  // Allow alphanumeric, spaces, hyphens, apostrophes, periods, ampersands
  return name.replace(/[^a-zA-Z0-9\s\-''.&]/g, '').trim().substring(0, 100);
}

async function deduplicateSlug(slug, address, env) {
  const existingSlugs = new Set();
  try {
    const indexUrl = `https://api.github.com/repos/hasan1239/ramadan-lockscreen/contents/data/mosques`;
    const resp = await fetch(indexUrl, {
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    if (resp.ok) {
      const files = await resp.json();
      for (const f of files) {
        if (f.name.endsWith('.json') && f.name !== 'index.json') {
          existingSlugs.add(f.name.replace('.json', ''));
        }
      }
    }
  } catch (e) {
    // If we can't check, proceed with the slug as-is
  }

  if (!existingSlugs.has(slug)) return slug;

  // Try address parts
  if (address) {
    const parts = address.split(',').map(p => p.trim().toLowerCase());
    for (const part of parts.slice(1)) {
      const words = part.trim().split(/\s+/);
      const area = words[0] ? words[0].replace(/[^\w]/g, '') : '';
      if (area) {
        const candidate = `${slug}_${area}`;
        if (!existingSlugs.has(candidate)) return candidate;
      }
    }
  }

  // Numeric suffix fallback
  let i = 2;
  while (existingSlugs.has(`${slug}_${i}`)) i++;
  return `${slug}_${i}`;
}

// --- CSV generation ---

function generateCsvString(rows) {
  const headers = [
    'Date', 'Day', 'Islamic Day', 'Sehri Ends', 'Sunrise',
    'Zohr', 'Asr', 'Esha',
    'Fajr Jama\'at', 'Zohar Jama\'at', 'Asr Jama\'at',
    'Maghrib Iftari', 'Esha Jama\'at',
  ];

  const fieldMap = {
    'Date': 'date',
    'Day': 'day',
    'Islamic Day': r => (r.islamic_day != null ? String(r.islamic_day) : (r.ramadan_day || '')),
    'Sehri Ends': 'sehri_ends',
    'Sunrise': 'sunrise',
    'Zohr': 'zohr',
    'Asr': 'asr',
    'Esha': 'esha',
    "Fajr Jama'at": 'fajr_jamaat',
    "Zohar Jama'at": 'zohar_jamaat',
    "Asr Jama'at": 'asr_jamaat',
    'Maghrib Iftari': 'maghrib_iftari',
    "Esha Jama'at": 'esha_jamaat',
  };

  let csv = headers.join(',') + '\n';
  for (const row of rows) {
    const vals = headers.map(h => {
      const mapper = fieldMap[h];
      if (typeof mapper === 'function') return mapper(row);
      if (typeof mapper === 'string') return row[mapper] || '';
      return '';
    });
    csv += vals.join(',') + '\n';
  }
  return csv;
}

// --- GitHub API helpers ---

const GITHUB_REPO = 'hasan1239/ramadan-lockscreen';

async function githubGetFile(path, env) {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'User-Agent': 'Prayerly-Worker/1.0',
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function githubCreateFile(path, content, message, env) {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'User-Agent': 'Prayerly-Worker/1.0',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GitHub create ${path} failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

async function githubUpdateFile(path, content, sha, message, env) {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${env.GITHUB_PAT}`,
      'User-Agent': 'Prayerly-Worker/1.0',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GitHub update ${path} failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

// --- Geocoding ---

async function geocodeAddress(address) {
  try {
    const query = encodeURIComponent(address);
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Prayerly/1.0' } }
    );
    if (!resp.ok) return { lat: null, lon: null };
    const results = await resp.json();
    if (results && results.length > 0) {
      return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    }
    return { lat: null, lon: null };
  } catch (e) {
    return { lat: null, lon: null };
  }
}

// --- Serve static page helper ---

async function serveStaticPage(pageName, request, env) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = `/${pageName}`;
  let res = await env.ASSETS.fetch(assetUrl.toString());

  // Follow redirect if Cloudflare strips .html
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('Location');
    if (loc) {
      res = await env.ASSETS.fetch(new URL(loc, assetUrl).toString());
    }
  }

  return new Response(res.body, {
    status: 200,
    headers: res.headers,
  });
}

// --- JSON response helpers ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ============================================================
// Main fetch handler
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // --- API endpoints ---

    if (path === '/api/extract' && request.method === 'POST') {
      return handleExtract(request, env);
    }

    if (path === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    // --- Static asset routing ---

    // Try serving static asset first
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) {
      return response;
    }

    // If 404, try clean URL routing
    const segment = path.replace(/^\//, '').replace(/\/$/, '');
    if (segment && !segment.includes('.') && !segment.includes('/')) {
      // /add → serve add.html
      if (segment === 'add') {
        return serveStaticPage('add.html', request, env);
      }

      // Other single-segment paths → serve masjid.html (slug routing)
      return serveStaticPage('masjid.html', request, env);
    }

    return response;
  },
};

// ============================================================
// POST /api/extract — Extract prayer times from image via Claude
// ============================================================

async function handleExtract(request, env) {
  // Check required env vars
  if (!env.ANTHROPIC_API_KEY) {
    return errorResponse('Server configuration error: missing API key', 500);
  }

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return errorResponse('Rate limit exceeded. Please try again later.', 429);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return errorResponse('Invalid form data');
  }

  const imageFile = formData.get('image');
  const mosqueName = sanitiseMasjidName(formData.get('name') || '');

  if (!imageFile || !imageFile.size) {
    return errorResponse('No file provided');
  }

  if (imageFile.size > 10 * 1024 * 1024) {
    return errorResponse('File too large (max 10MB)');
  }

  // Convert image to base64
  const imageBuffer = await imageFile.arrayBuffer();
  // Chunk the conversion to avoid call stack overflow on large images
  const bytes = new Uint8Array(imageBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const imageBase64 = btoa(binary);

  // Determine media type
  const fileName = imageFile.name || '';
  const ext = fileName.split('.').pop().toLowerCase();
  const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
  const mediaType = mediaTypeMap[ext] || 'image/jpeg';
  const isPdf = mediaType === 'application/pdf';

  // Call Claude API
  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            isPdf ? {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: imageBase64,
              },
            } : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT,
            },
          ],
        }],
      }),
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      console.error('Claude API error:', claudeResp.status, errBody);
      return errorResponse('AI extraction failed. Please try again.', 502);
    }

    const claudeData = await claudeResp.json();
    let responseText = claudeData.content[0].text.trim();

    // Clean markdown fences if present
    if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let extracted;
    try {
      extracted = JSON.parse(responseText);
    } catch (e) {
      return errorResponse('Failed to parse AI response. Please try with a clearer file.', 502);
    }

    // Apply validation fixes
    const notes = extracted.notes || '';
    const { rows } = validateAndFixRows(extracted.rows || [], notes);
    extracted.rows = rows;

    // Override mosque name with user-provided name if given
    if (mosqueName) extracted.mosque_name = mosqueName;

    return jsonResponse({ success: true, data: extracted });
  } catch (e) {
    console.error('Extract error:', e);
    return errorResponse('Extraction failed: ' + e.message, 500);
  }
}

// ============================================================
// POST /api/submit — Commit new masjid to GitHub
// ============================================================

async function handleSubmit(request, env) {
  if (!env.GITHUB_PAT) {
    return errorResponse('Server configuration error: missing GitHub token', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body');
  }

  const { data } = body;
  if (!data || !data.rows || !data.rows.length) {
    return errorResponse('No timetable data provided');
  }

  const mosqueName = sanitiseMasjidName(data.mosque_name || '');
  if (!mosqueName) {
    return errorResponse('Masjid name is required');
  }

  // Generate slug
  let slug = data.suggested_slug || slugify(mosqueName);
  slug = slugify(slug); // Ensure it's properly slugified
  const address = data.address || '';
  slug = await deduplicateSlug(slug, address, env);

  // Build CSV
  const csvContent = generateCsvString(data.rows);

  // Build config JSON
  const config = {
    display_name: mosqueName,
    slug,
    csv: `${slug}.csv`,
    address: data.address || '',
    phone: data.phone || '',
    month: data.month || '',
    islamic_month: data.islamic_month || '',
    jummah_times: data.jummah_times || '',
    eid_salah: data.eid_salah || '',
    sadaqatul_fitr: data.sadaqatul_fitr || '',
    radio_frequency: data.radio_frequency || '',
    is_stale: false,
    notes: data.notes || '',
  };

  // Geocode address
  if (config.address) {
    const { lat, lon } = await geocodeAddress(config.address);
    if (lat !== null) {
      config.lat = lat;
      config.lon = lon;
    }
  }

  try {
    // 1. Create CSV file
    await githubCreateFile(
      `data/${slug}.csv`,
      csvContent,
      `Add timetable for ${mosqueName}`,
      env
    );

    // 2. Create config JSON
    await githubCreateFile(
      `data/mosques/${slug}.json`,
      JSON.stringify(config, null, 2),
      `Add config for ${mosqueName}`,
      env
    );

    // 3. Update index.json
    const indexFile = await githubGetFile('data/mosques/index.json', env);
    if (indexFile) {
      const existingIndex = JSON.parse(atob(indexFile.content.replace(/\n/g, '')));
      existingIndex.push(config);
      existingIndex.sort((a, b) => a.display_name.localeCompare(b.display_name));
      await githubUpdateFile(
        'data/mosques/index.json',
        JSON.stringify(existingIndex),
        indexFile.sha,
        `Add ${mosqueName} to index`,
        env
      );
    }

    return jsonResponse({
      success: true,
      slug,
      url: `/${slug}`,
      message: `${mosqueName} has been added successfully!`,
    });
  } catch (e) {
    console.error('Submit error:', e);
    return errorResponse('Failed to save masjid: ' + e.message, 500);
  }
}
