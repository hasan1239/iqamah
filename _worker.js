// ============================================================
// Prayerly — Cloudflare Pages Worker
// Handles clean URL routing + Add Your Masjid API endpoints
// ============================================================

// --- Rate limiting (persistent via Cloudflare KV) ---
const RATE_LIMITS_CONFIG = {
  extract: { max: 3, windowSecs: 30 * 24 * 60 * 60 }, // 3 per month
  submit: { max: 3, windowSecs: 30 * 24 * 60 * 60 },  // 3 per month
  update: { max: 5, windowSecs: 30 * 24 * 60 * 60 },  // 5 per month
};

async function isRateLimited(ip, action, env) {
  if (!env.RATE_LIMITS) return false;
  const config = RATE_LIMITS_CONFIG[action];
  if (!config) return false;
  const key = `${action}:${ip}`;
  const data = await env.RATE_LIMITS.get(key, 'json');
  const now = Date.now();

  if (!data) {
    await env.RATE_LIMITS.put(key, JSON.stringify({ count: 1, start: now }), { expirationTtl: config.windowSecs });
    return false;
  }

  if (data.count >= config.max) return true;

  data.count++;
  const elapsed = Math.floor((now - data.start) / 1000);
  const remaining = Math.max(config.windowSecs - elapsed, 60);
  await env.RATE_LIMITS.put(key, JSON.stringify(data), { expirationTtl: remaining });
  return false;
}

// --- Turnstile verification ---
async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return true; // skip if not configured
  if (!token) return false;
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${encodeURIComponent(env.TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip)}`,
  });
  const result = await resp.json();
  return result.success === true;
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
  // If h >= 13 or === 0, already in 24h format — skip forcePm conversion
  const already24h = h >= 13 || h === 0;
  const hour = (!already24h && forcePm && h >= 1 && h <= 11) ? h + 12 : h;
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

// Commit multiple files in a single commit using the Git Data API
// Retries on ref update failure (race condition with concurrent commits)
async function githubCommitFiles(files, message, env) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers = {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      };
      const api = `https://api.github.com/repos/${GITHUB_REPO}`;

      // 1. Get HEAD ref
      const refResp = await fetch(`${api}/git/ref/heads/main`, { headers });
      if (!refResp.ok) throw new Error('Failed to get HEAD ref');
      const refData = await refResp.json();
      const headSha = refData.object.sha;

      // 2. Get base tree
      const commitResp = await fetch(`${api}/git/commits/${headSha}`, { headers });
      if (!commitResp.ok) throw new Error('Failed to get HEAD commit');
      const commitData = await commitResp.json();
      const baseTreeSha = commitData.tree.sha;

      // 3. Create blobs in parallel (content-addressed, safe to re-create)
      const blobPromises = files.map(async (f) => {
        const blobResp = await fetch(`${api}/git/blobs`, {
          method: 'POST', headers,
          body: JSON.stringify({
            content: f.base64 || btoa(unescape(encodeURIComponent(f.content))),
            encoding: 'base64',
          }),
        });
        if (!blobResp.ok) throw new Error(`Failed to create blob for ${f.path}`);
        const blob = await blobResp.json();
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
      });
      const tree = await Promise.all(blobPromises);

      // 4. Create tree
      const treeResp = await fetch(`${api}/git/trees`, {
        method: 'POST', headers,
        body: JSON.stringify({ base_tree: baseTreeSha, tree }),
      });
      if (!treeResp.ok) throw new Error('Failed to create tree');
      const treeData = await treeResp.json();

      // 5. Create commit
      const newCommitResp = await fetch(`${api}/git/commits`, {
        method: 'POST', headers,
        body: JSON.stringify({ message, tree: treeData.sha, parents: [headSha] }),
      });
      if (!newCommitResp.ok) throw new Error('Failed to create commit');
      const newCommit = await newCommitResp.json();

      // 6. Update ref
      const updateRefResp = await fetch(`${api}/git/refs/heads/main`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ sha: newCommit.sha }),
      });
      if (!updateRefResp.ok) throw new Error('Failed to update ref');
      return newCommit;
    } catch (e) {
      if (attempt < maxRetries && e.message.includes('Failed to update ref')) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// --- GitHub Issue notifications ---

async function createNotificationIssue(slug, mosqueName, imageExt, env) {
  try {
    let issueBody = `A new masjid has been submitted for review.\n\n**Name:** ${mosqueName}\n**Slug:** \`${slug}\`\n**View page:** [iqamah.co.uk/${slug}](https://iqamah.co.uk/${slug})\n\n**To approve**, run the [Approve Masjid](https://github.com/${GITHUB_REPO}/actions/workflows/approve_masjid.yml) workflow with slug \`${slug}\`.`;
    if (imageExt) {
      const imageUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/sources/${slug}.${imageExt}`;
      issueBody += `\n\n**Source timetable:**\n![Timetable](${imageUrl})`;
    }
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `New masjid submitted: ${mosqueName}`,
        body: issueBody,
        labels: ['new-masjid'],
      }),
    });
  } catch (e) {
    console.error('Failed to create notification issue:', e);
  }
}

async function triggerLockscreenGeneration(slug, env) {
  try {
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/generate.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { mosque: slug },
      }),
    });
  } catch (e) {
    console.error('Failed to trigger lockscreen generation:', e);
  }
}

async function uploadImageToRepo(imageBase64, ext, env) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `data/extraction-logs/${timestamp}.${ext}`;
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Extraction log image ${timestamp}`,
        content: imageBase64,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.content.download_url;
    }
  } catch (e) {
    console.error('Failed to upload extraction image:', e);
  }
  return null;
}

async function createExtractionNotification(mosqueName, ip, success, errorMsg, env, extracted, imageBase64, mediaType) {
  try {
    const title = success
      ? `Extraction succeeded: ${mosqueName || 'Unknown'}`
      : `Extraction failed: ${mosqueName || 'Unknown'}`;
    let body = success
      ? `A timetable extraction completed successfully.\n\n**Name:** ${mosqueName || '(none)'}\n**IP:** \`${ip}\`\n**Time:** ${new Date().toISOString()}`
      : `A timetable extraction failed.\n\n**Name:** ${mosqueName || '(none)'}\n**IP:** \`${ip}\`\n**Time:** ${new Date().toISOString()}\n**Error:** ${errorMsg || 'Unknown'}`;

    // Upload image and include in issue
    if (imageBase64) {
      const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
      const ext = extMap[mediaType] || 'jpg';
      const imageUrl = await uploadImageToRepo(imageBase64, ext, env);
      if (imageUrl && ext !== 'pdf') {
        body += `\n\n**Uploaded timetable:**\n![Timetable](${imageUrl})`;
      } else if (imageUrl) {
        body += `\n\n**Uploaded timetable:** [View PDF](${imageUrl})`;
      }
    }

    if (success && extracted) {
      body += `\n\n<details><summary>Extracted JSON</summary>\n\n\`\`\`json\n${JSON.stringify(extracted, null, 2)}\n\`\`\`\n\n</details>`;
    }
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels: ['extraction-attempt'] }),
    });
  } catch (e) {
    console.error('Failed to create extraction notification:', e);
  }
}

// --- Timetable date validation ---

function validateTimetableDates(rows, year) {
  if (!year) return null; // can't validate without year
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  let latestDate = null;
  for (const row of rows) {
    if (!row.date) continue;
    const parts = row.date.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const day = parseInt(parts[0]);
    const mon = months[parts[1]];
    if (isNaN(day) || mon === undefined) continue;
    const d = new Date(Date.UTC(year, mon, day));
    if (!latestDate || d > latestDate) latestDate = d;
  }
  if (!latestDate) return null; // can't parse, skip
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (latestDate < today) {
    return 'This timetable appears to be outdated — all dates are in the past. Please upload a current timetable.';
  }
  return null;
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

    // www → non-www canonical redirect
    if (url.hostname === 'www.iqamah.co.uk') {
      url.hostname = 'iqamah.co.uk';
      return Response.redirect(url.toString(), 301);
    }

    // --- API endpoints ---

    if (path === '/api/extract' && request.method === 'POST') {
      return handleExtract(request, env);
    }

    if (path === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    if (path === '/api/update' && request.method === 'POST') {
      return handleUpdate(request, env);
    }

    // --- SPA routing ---

    // SPA routes must be served before static assets (Cloudflare auto-strips .html)
    const segment = path.replace(/^\//, '').replace(/\/$/, '');

    if (segment.startsWith('update/')) {
      return serveStaticPage('index.html', request, env);
    }

    if (segment && !segment.includes('.') && !segment.includes('/')) {
      return serveStaticPage('index.html', request, env);
    }

    // Try serving static asset
    return env.ASSETS.fetch(request);
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
  if (await isRateLimited(ip, 'extract', env)) {
    return errorResponse('You\'ve reached the limit of 3 extractions per month. Please try again next month.', 429);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return errorResponse('Invalid form data');
  }

  // Verify Turnstile
  const turnstileToken = formData.get('cf-turnstile-response');
  if (!await verifyTurnstile(turnstileToken, ip, env)) {
    return errorResponse('Security check failed. Please refresh and try again.', 403);
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
        temperature: 0,
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
      await createExtractionNotification(mosqueName, ip, false, `Claude API ${claudeResp.status}`, env, null, imageBase64, mediaType);
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
      await createExtractionNotification(mosqueName, ip, false, 'Failed to parse AI response', env, null, imageBase64, mediaType);
      return errorResponse('Failed to parse AI response. Please try with a clearer file.', 502);
    }

    // Strip column_map (used by prompt for accuracy, not needed in saved data)
    delete extracted.column_map;

    // Apply validation fixes
    const notes = extracted.notes || '';
    const { rows } = validateAndFixRows(extracted.rows || [], notes);
    extracted.rows = rows;

    // Override mosque name with user-provided name if given
    if (mosqueName) extracted.mosque_name = mosqueName;

    // Notify about successful extraction (use extracted name as fallback)
    const notifName = mosqueName || extracted.mosque_name || '';
    await createExtractionNotification(notifName, ip, true, null, env, extracted, imageBase64, mediaType);

    return jsonResponse({ success: true, data: extracted });
  } catch (e) {
    console.error('Extract error:', e);
    await createExtractionNotification(mosqueName, ip, false, e.message, env, null, imageBase64, mediaType);
    return errorResponse('Extraction failed: ' + e.message, 500);
  }
}

// --- Duplicate detection helpers ---

function normalisePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('44')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function extractPostcode(address) {
  if (!address) return null;
  const m = address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i);
  if (!m) return null;
  return { outcode: m[1].toUpperCase(), incode: m[2].toUpperCase(), full: m[1].toUpperCase() + ' ' + m[2].toUpperCase() };
}

function normaliseName(name) {
  let s = (name || '').toLowerCase();
  s = s.replace(/\b(masjid|mosque|islamic\s+centre|islamic\s+center|trust|foundation)\b/gi, '');
  s = s.replace(/\b(al-|al\s|e-|e\s)/gi, '');
  s = s.replace(/[^a-z0-9\s]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function levenshteinRatio(a, b) {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

function haversineDistanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findDuplicates(name, address, phone, lat, lon, existingConfigs) {
  const normPhone = normalisePhone(phone);
  const normName = normaliseName(name);
  const postcode = extractPostcode(address);
  const matches = [];

  for (const cfg of existingConfigs) {
    let score = 0;
    const reasons = [];

    // Phone match
    if (normPhone && cfg.phone) {
      const cfgPhone = normalisePhone(cfg.phone);
      if (cfgPhone && normPhone === cfgPhone) {
        score += 100;
        reasons.push('Same phone number');
      }
    }

    // Name similarity
    if (normName) {
      const cfgName = normaliseName(cfg.display_name);
      if (cfgName) {
        const ratio = levenshteinRatio(normName, cfgName);
        if (ratio > 0.7) {
          score += Math.round(ratio * 40);
          reasons.push(`Similar name (${Math.round(ratio * 100)}% match)`);
        }
      }
    }

    // Postcode match
    if (postcode && cfg.address) {
      const cfgPostcode = extractPostcode(cfg.address);
      if (cfgPostcode) {
        if (postcode.full === cfgPostcode.full) {
          score += 50;
          reasons.push('Same postcode');
        } else if (postcode.outcode === cfgPostcode.outcode) {
          score += 25;
          reasons.push('Same postcode area');
        }
      }
    }

    // Proximity
    if (lat != null && lon != null && cfg.lat != null && cfg.lon != null) {
      const dist = haversineDistanceMetres(lat, lon, cfg.lat, cfg.lon);
      if (dist < 100) {
        score += 40;
        reasons.push('Very close location (<100m)');
      } else if (dist < 300) {
        score += 25;
        reasons.push('Nearby location (<300m)');
      } else if (dist < 500) {
        score += 15;
        reasons.push('In the same area (<500m)');
      }
    }

    if (score >= 60) {
      matches.push({
        slug: cfg.slug,
        display_name: cfg.display_name,
        address: cfg.address || '',
        score,
        reasons,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

// ============================================================
// POST /api/submit — Commit new masjid to GitHub
// ============================================================

async function handleSubmit(request, env) {
  if (!env.GITHUB_PAT) {
    return errorResponse('Server configuration error: missing GitHub token', 500);
  }

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(ip, 'submit', env)) {
    return errorResponse('You\'ve reached the limit of 3 submissions per month. Please try again next month.', 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body');
  }

  // Verify Turnstile
  const turnstileToken = body['cf-turnstile-response'];
  if (!await verifyTurnstile(turnstileToken, ip, env)) {
    return errorResponse('Security check failed. Please refresh and try again.', 403);
  }

  const { data, image } = body;
  if (!data || !data.rows || !data.rows.length) {
    return errorResponse('No timetable data provided');
  }

  const mosqueName = sanitiseMasjidName(data.mosque_name || '');
  if (!mosqueName) {
    return errorResponse('Masjid name is required');
  }

  // Validate timetable dates aren't stale
  const dateError = validateTimetableDates(data.rows, data.year);
  if (dateError) {
    return errorResponse(dateError);
  }

  // Server-side field length truncation
  const MAX_LENGTHS = { address: 200, phone: 60, notes: 500, jummah_times: 100, eid_salah: 100, sadaqatul_fitr: 50, radio_frequency: 20 };
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (data[field]) data[field] = data[field].substring(0, max);
  }

  const address = data.address || '';
  const phone = data.phone || '';

  // Geocode address early (reused for both duplicate check and config)
  let geoLat = null, geoLon = null;
  if (address) {
    const { lat, lon } = await geocodeAddress(address);
    if (lat !== null) { geoLat = lat; geoLon = lon; }
  }

  // Fetch existing configs early (reused for both duplicate check and index update)
  let indexFile = null;
  let existingConfigs = [];
  try {
    indexFile = await githubGetFile('data/mosques/index.json', env);
    if (indexFile) {
      existingConfigs = JSON.parse(atob(indexFile.content.replace(/\n/g, '')));
    }
  } catch (e) {
    // If index fetch fails, skip duplicate check and proceed
  }

  // Duplicate detection (skip if user confirmed)
  if (!body.confirm_not_duplicate && existingConfigs.length > 0) {
    const duplicates = findDuplicates(mosqueName, address, phone, geoLat, geoLon, existingConfigs);
    if (duplicates.length > 0) {
      return jsonResponse({
        duplicate_warning: true,
        matches: duplicates,
        message: 'We found existing masjids that may be the same. Please check before submitting.',
      }, 409);
    }
  }

  // Generate slug
  let slug = data.suggested_slug || slugify(mosqueName);
  slug = slugify(slug); // Ensure it's properly slugified
  slug = await deduplicateSlug(slug, address, env);

  // Build CSV
  const csvContent = generateCsvString(data.rows);

  // Build config JSON
  const config = {
    display_name: mosqueName,
    slug,
    csv: `${slug}.csv`,
    address,
    phone,
    month: data.month || '',
    islamic_month: data.islamic_month || '',
    jummah_times: data.jummah_times || '',
    eid_salah: data.eid_salah || '',
    sadaqatul_fitr: data.sadaqatul_fitr || '',
    radio_frequency: data.radio_frequency || '',
    approved: false,
    is_stale: false,
    notes: data.notes || '',
  };

  // Set source image path in config
  if (image) {
    const imgMatch = image.match(/^data:image\/(\w+);base64,/);
    if (imgMatch) {
      const ext = imgMatch[1] === 'jpeg' ? 'jpg' : imgMatch[1];
      config.source_image = `sources/${slug}.${ext}`;
    }
  }

  // Apply geocoded coordinates
  if (geoLat !== null) {
    config.lat = geoLat;
    config.lon = geoLon;
  }

  try {
    // Build list of files to commit
    const files = [
      { path: `data/${slug}.csv`, content: csvContent },
      { path: `data/${slug}.json`, content: JSON.stringify(data, null, 2) },
      { path: `data/mosques/${slug}.json`, content: JSON.stringify(config, null, 2) },
    ];

    // Source timetable image
    let sourceImageExt = null;
    if (image) {
      const imgMatch = image.match(/^data:image\/(\w+);base64,(.+)$/);
      if (imgMatch) {
        sourceImageExt = imgMatch[1] === 'jpeg' ? 'jpg' : imgMatch[1];
        files.push({ path: `data/sources/${slug}.${sourceImageExt}`, base64: imgMatch[2] });
      }
    }

    // Updated index.json (reuse already-fetched data, or create if missing)
    existingConfigs.push(config);
    existingConfigs.sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', ignorePunctuation: true }));
    files.push({ path: 'data/mosques/index.json', content: JSON.stringify(existingConfigs) });

    // Single commit for all files
    await githubCommitFiles(files, `Add ${mosqueName}`, env);

    // Create GitHub issue notification
    await createNotificationIssue(slug, mosqueName, sourceImageExt, env);

    // Trigger lockscreen generation workflow
    triggerLockscreenGeneration(slug, env);

    return jsonResponse({
      success: true,
      slug,
      url: `/${slug}`,
      pending: true,
      message: `${mosqueName} has been submitted for review!`,
    });
  } catch (e) {
    console.error('Submit error:', e);
    return errorResponse('Failed to save masjid: ' + e.message, 500);
  }
}

// ============================================================
// CSV merge logic
// ============================================================

function parseDateForSort(dateStr) {
  if (!dateStr) return 0;
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length < 2) return 0;
  const day = parseInt(parts[0]);
  const mon = months[parts[1]];
  if (isNaN(day) || mon === undefined) return 0;
  // Use a sortable number: month * 100 + day
  return mon * 100 + day;
}

function mergeCsvRows(existingCsvText, newRows) {
  // Parse existing CSV into Map keyed by date string
  const lines = existingCsvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const existingMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    const dateKey = row['Date'] || '';
    if (dateKey) existingMap.set(dateKey.trim(), row);
  }

  // Generate new CSV string and parse it
  const newCsvText = generateCsvString(newRows);
  const newLines = newCsvText.trim().split('\n');
  const newHeaders = newLines[0].split(',').map(h => h.trim());

  for (let i = 1; i < newLines.length; i++) {
    const values = newLines[i].split(',').map(v => v.trim());
    const row = {};
    newHeaders.forEach((h, idx) => { row[h] = values[idx] || ''; });
    const dateKey = row['Date'] || '';
    if (dateKey) existingMap.set(dateKey.trim(), row);
  }

  // Sort all rows by date
  const allRows = Array.from(existingMap.values());
  allRows.sort((a, b) => parseDateForSort(a['Date']) - parseDateForSort(b['Date']));

  // Rebuild CSV with standard headers
  const standardHeaders = [
    'Date', 'Day', 'Islamic Day', 'Sehri Ends', 'Fajr Start', 'Sunrise',
    'Zawal', 'Zohr', 'Asr', 'Esha',
    "Fajr Jama'at", "Zohar Jama'at", "Asr Jama'at",
    'Maghrib Iftari', "Maghrib Jama'at", "Esha Jama'at",
  ];

  let csv = standardHeaders.join(',') + '\n';
  for (const row of allRows) {
    const vals = standardHeaders.map(h => row[h] || '');
    csv += vals.join(',') + '\n';
  }
  return csv;
}

// ============================================================
// POST /api/update — Update existing masjid timetable
// ============================================================

async function createUpdateNotificationIssue(slug, mosqueName, newRowCount, ip, env) {
  try {
    const issueBody = `A timetable update has been submitted.\n\n**Name:** ${mosqueName}\n**Slug:** \`${slug}\`\n**New rows:** ${newRowCount}\n**IP:** \`${ip}\`\n**Time:** ${new Date().toISOString()}\n**View page:** [iqamah.co.uk/${slug}](https://iqamah.co.uk/${slug})\n\n**To approve**, run the [Approve Masjid](https://github.com/${GITHUB_REPO}/actions/workflows/approve_masjid.yml) workflow with slug \`${slug}\`.`;
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GITHUB_PAT}`,
        'User-Agent': 'Prayerly-Worker/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Timetable updated: ${mosqueName}`,
        body: issueBody,
        labels: ['timetable-update'],
      }),
    });
  } catch (e) {
    console.error('Failed to create update notification issue:', e);
  }
}

async function handleUpdate(request, env) {
  if (!env.GITHUB_PAT) {
    return errorResponse('Server configuration error: missing GitHub token', 500);
  }

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(ip, 'update', env)) {
    return errorResponse('You\'ve reached the limit of 5 timetable updates per month. Please try again next month.', 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('Invalid JSON body');
  }

  // Verify Turnstile
  const turnstileToken = body['cf-turnstile-response'];
  if (!await verifyTurnstile(turnstileToken, ip, env)) {
    return errorResponse('Security check failed. Please refresh and try again.', 403);
  }

  const { data, slug, image } = body;
  if (!data || !data.rows || !data.rows.length) {
    return errorResponse('No timetable data provided');
  }
  if (!slug) {
    return errorResponse('Masjid slug is required');
  }

  // Fetch existing config
  const configFile = await githubGetFile(`data/mosques/${slug}.json`, env);
  if (!configFile) {
    return errorResponse('Masjid not found', 404);
  }

  let existingConfig;
  try {
    existingConfig = JSON.parse(atob(configFile.content.replace(/\n/g, '')));
  } catch (e) {
    return errorResponse('Failed to read existing masjid config', 500);
  }

  // Masjid name check — compare extracted name with existing display_name
  const extractedName = sanitiseMasjidName(data.mosque_name || '');
  if (extractedName) {
    const ratio = levenshteinRatio(
      normaliseName(extractedName),
      normaliseName(existingConfig.display_name)
    );
    if (ratio < 0.5) {
      return errorResponse(
        `This doesn't appear to be the timetable for ${existingConfig.display_name}. Please make sure you uploaded the correct timetable.`
      );
    }
  }

  // Validate timetable dates — reject if all in the past
  const dateError = validateTimetableDates(data.rows, data.year);
  if (dateError) {
    return errorResponse(dateError);
  }

  // Apply validation fixes on new rows
  const notes = data.notes || existingConfig.notes || '';
  const { rows: fixedRows } = validateAndFixRows(data.rows, notes);

  // Server-side field length truncation
  const MAX_LENGTHS = { address: 200, phone: 60, notes: 500, jummah_times: 100, eid_salah: 100, sadaqatul_fitr: 50, radio_frequency: 20 };
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (data[field]) data[field] = data[field].substring(0, max);
  }

  // Fetch existing CSV
  const csvFile = await githubGetFile(`data/${existingConfig.csv || slug + '.csv'}`, env);
  let mergedCsv;
  if (csvFile) {
    const existingCsvText = atob(csvFile.content.replace(/\n/g, ''));
    mergedCsv = mergeCsvRows(existingCsvText, fixedRows);
  } else {
    mergedCsv = generateCsvString(fixedRows);
  }

  // Update config — only overwrite non-empty metadata fields
  const metaFields = ['address', 'phone', 'jummah_times', 'eid_salah', 'sadaqatul_fitr', 'radio_frequency', 'notes'];
  for (const field of metaFields) {
    if (data[field] && data[field].trim()) {
      existingConfig[field] = data[field].trim();
    }
  }
  existingConfig.is_stale = false;
  existingConfig.pending_update = true;
  if (data.month) existingConfig.month = data.month;
  if (data.islamic_month) existingConfig.islamic_month = data.islamic_month;

  // Re-geocode if address changed
  if (data.address && data.address.trim() && data.address.trim() !== (existingConfig.address || '')) {
    const { lat, lon } = await geocodeAddress(data.address.trim());
    if (lat !== null) {
      existingConfig.lat = lat;
      existingConfig.lon = lon;
    }
  }

  // Source image update
  if (image) {
    const imgMatch = image.match(/^data:image\/(\w+);base64,/);
    if (imgMatch) {
      const ext = imgMatch[1] === 'jpeg' ? 'jpg' : imgMatch[1];
      existingConfig.source_image = `sources/${slug}.${ext}`;
    }
  }

  try {
    // Build file list
    const files = [
      { path: `data/${existingConfig.csv || slug + '.csv'}`, content: mergedCsv },
      { path: `data/mosques/${slug}.json`, content: JSON.stringify(existingConfig, null, 2) },
      { path: `data/${slug}.json`, content: JSON.stringify(data, null, 2) },
    ];

    // Source timetable image
    if (image) {
      const imgMatch = image.match(/^data:image\/(\w+);base64,(.+)$/);
      if (imgMatch) {
        const ext = imgMatch[1] === 'jpeg' ? 'jpg' : imgMatch[1];
        files.push({ path: `data/sources/${slug}.${ext}`, base64: imgMatch[2] });
      }
    }

    // Update index.json
    let indexFile = null;
    let existingConfigs = [];
    try {
      indexFile = await githubGetFile('data/mosques/index.json', env);
      if (indexFile) {
        existingConfigs = JSON.parse(atob(indexFile.content.replace(/\n/g, '')));
      }
    } catch (e) { /* proceed */ }

    // Replace the config in the index
    const cfgIdx = existingConfigs.findIndex(c => c.slug === slug);
    if (cfgIdx !== -1) {
      existingConfigs[cfgIdx] = existingConfig;
    } else {
      existingConfigs.push(existingConfig);
    }
    existingConfigs.sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', ignorePunctuation: true }));
    files.push({ path: 'data/mosques/index.json', content: JSON.stringify(existingConfigs) });

    // Single commit
    await githubCommitFiles(files, `Update timetable: ${existingConfig.display_name}`, env);

    // Create notification issue
    await createUpdateNotificationIssue(slug, existingConfig.display_name, fixedRows.length, ip, env);

    // Trigger lockscreen generation
    triggerLockscreenGeneration(slug, env);

    return jsonResponse({
      success: true,
      slug,
      url: `/${slug}`,
      pending: true,
      message: `Timetable for ${existingConfig.display_name} has been updated!`,
    });
  } catch (e) {
    console.error('Update error:', e);
    return errorResponse('Failed to update timetable: ' + e.message, 500);
  }
}
