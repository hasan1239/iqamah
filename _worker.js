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
  const fixCounts = { day_fix: 0, fajr_start_swap: 0, zawal_swap: 0, zohar_shift: 0, esha_move: 0, asr_swap: 0, esha_swap: 0, maghrib_swap: 0, zohar_notes: 0 };

  const validDays = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  const dayFixes = { 'Thur': 'Thu', 'Tues': 'Tue', 'Weds': 'Wed' };

  for (const row of rows) {
    // Fix day: standardise to exactly three letters
    const day = (row.day || '').trim();
    if (day && !validDays.has(day)) {
      const fixed = dayFixes[day] || day.substring(0, 3);
      if (validDays.has(fixed)) {
        row.day = fixed;
        fixCounts.day_fix++;
      }
    }

    // Fix: Sehri Ends > Fajr Start — swap them
    let sehriMins = timeToMinutes(row.sehri_ends || '', false);
    let fajrStartMins = timeToMinutes(row.fajr_start || '', false);
    if (sehriMins !== null && fajrStartMins !== null && sehriMins > fajrStartMins) {
      [row.sehri_ends, row.fajr_start] = [row.fajr_start, row.sehri_ends];
      fixCounts.fajr_start_swap++;
    }

    // Fix 0: Zawal > Zohr — swap them (model confused the columns)
    let zawalMins = timeToMinutes(row.zawal || '', true);
    let zohrMins = timeToMinutes(row.zohr || '', true);
    if (zawalMins !== null && zohrMins !== null && zawalMins > zohrMins) {
      [row.zawal, row.zohr] = [row.zohr, row.zawal];
      fixCounts.zawal_swap++;
      zohrMins = timeToMinutes(row.zohr || '', true);
    }

    zohrMins = timeToMinutes(row.zohr || '', true);
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

    // Fix 4: Maghrib iftari > Maghrib jamaat (swap if confused)
    let maghribMins = timeToMinutes(row.maghrib_iftari || '', false);
    let maghribJMins = timeToMinutes(row.maghrib_jamaat || '', false);
    if (maghribMins !== null && maghribJMins !== null && maghribMins > maghribJMins) {
      [row.maghrib_iftari, row.maghrib_jamaat] = [row.maghrib_jamaat, row.maghrib_iftari];
      fixCounts.maghrib_swap++;
    }

    // Fix 5: Esha start > Esha jamaat
    eshaMins = timeToMinutes(row.esha || '', false);
    eshaJMins = timeToMinutes(row.esha_jamaat || '', false);
    if (eshaMins !== null && eshaJMins !== null && eshaMins > eshaJMins) {
      [row.esha, row.esha_jamaat] = [row.esha_jamaat, row.esha];
      fixCounts.esha_swap++;
    }
  }

  // Fix 6: Fill zohar_jamaat from notes if empty
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

function assignIslamicMonths(rows) {
  const days = rows.map(r => {
    const v = r.islamic_day != null ? r.islamic_day : (r.ramadan_day || 0);
    return parseInt(v) || 0;
  });
  const n = days.length;
  const resets = [];
  for (let i = 1; i < n; i++) {
    if (days[i] < days[i - 1]) resets.push(i);
  }

  if (resets.length === 0) {
    return days.map(d => d > 30 ? 'Shaw' : 'Ram');
  }
  if (resets.length === 1) {
    const reset = resets[0];
    if (days[0] === 1) {
      return days.map((_, i) => i < reset ? 'Ram' : 'Shaw');
    } else if (days[n - 1] >= 28) {
      return days.map((_, i) => i < reset ? 'Sha' : 'Ram');
    } else {
      return days.map((_, i) => i < reset ? 'Ram' : 'Shaw');
    }
  }
  const [r1, r2] = resets;
  return days.map((_, i) => i < r1 ? 'Sha' : i < r2 ? 'Ram' : 'Shaw');
}

function generateCsvString(rows) {
  const headers = [
    'Date', 'Day', 'Islamic Day', 'Sehri Ends', 'Fajr Start', 'Sunrise',
    'Zawal', 'Zohr', 'Asr', 'Esha',
    'Fajr Jama\'at', 'Zohar Jama\'at', 'Asr Jama\'at',
    'Maghrib Iftari', 'Maghrib Jama\'at', 'Esha Jama\'at',
  ];

  const months = assignIslamicMonths(rows);

  const fieldMap = {
    'Date': 'date',
    'Day': 'day',
    'Islamic Day': (r, i) => {
      const v = r.islamic_day != null ? r.islamic_day : (r.ramadan_day || '');
      if (v === '' || v == null) return '';
      let dayNum = parseInt(v);
      if (months[i] === 'Shaw' && dayNum > 30) dayNum -= 30;
      return `${dayNum} ${months[i]}`;
    },
    'Sehri Ends': 'sehri_ends',
    'Fajr Start': 'fajr_start',
    'Sunrise': 'sunrise',
    'Zawal': 'zawal',
    'Zohr': 'zohr',
    'Asr': 'asr',
    'Esha': 'esha',
    "Fajr Jama'at": 'fajr_jamaat',
    "Zohar Jama'at": 'zohar_jamaat',
    "Asr Jama'at": 'asr_jamaat',
    'Maghrib Iftari': 'maghrib_iftari',
    "Maghrib Jama'at": 'maghrib_jamaat',
    "Esha Jama'at": 'esha_jamaat',
  };

  let csv = headers.join(',') + '\n';
  rows.forEach((row, idx) => {
    const vals = headers.map(h => {
      const mapper = fieldMap[h];
      if (typeof mapper === 'function') return mapper(row, idx);
      if (typeof mapper === 'string') return row[mapper] || '';
      return '';
    });
    csv += vals.join(',') + '\n';
  });
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

  // Load extraction prompt from static asset
  let extractionPrompt;
  try {
    const promptRes = await env.ASSETS.fetch(new URL('/prompts/extraction.txt', request.url));
    extractionPrompt = await promptRes.text();
  } catch (e) {
    console.error('Failed to load extraction prompt:', e);
    return errorResponse('Server configuration error: missing extraction prompt', 500);
  }

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
              text: extractionPrompt,
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
