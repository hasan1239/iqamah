// ============================================================
// Worker API tests — the self-service upload flow
//
// Run with:  node --test tests/
// (no dependencies — uses Node's built-in test runner, Node 18+)
//
// These call the real _worker.js fetch handler with a fake env:
// in-memory KV, an ASSETS stub serving prompts/extraction.txt from
// disk, and a stubbed global fetch for GitHub / Claude / Turnstile /
// Nominatim. Run them after ANY change to _worker.js — they cover
// the /api/extract, /api/submit and /api/update paths end to end.
// ============================================================

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from '../_worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACTION_PROMPT = readFileSync(join(ROOT, 'prompts', 'extraction.txt'), 'utf8');

// --- Fakes ---------------------------------------------------

class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key, type) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, _opts) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  seed(key, obj) { this.store.set(key, JSON.stringify(obj)); }
  json(key) { const v = this.store.get(key); return v === undefined ? null : JSON.parse(v); }
}

function makeEnv(overrides = {}) {
  return {
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GITHUB_PAT: 'test-pat',
    ADMIN_NAME: 'AdminUser',
    RATE_LIMITS: new FakeKV(),
    ASSETS: {
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
        const path = new URL(url).pathname;
        if (path === '/prompts/extraction.txt') return new Response(EXTRACTION_PROMPT);
        return new Response('Not found', { status: 404 });
      },
    },
    ...overrides,
  };
}

const j = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Recorded outbound calls for assertions: [{ method, url, body }]
let fetchCalls = [];

// Install a fetch stub. `overrides` maps a URL substring to a handler
// ({ url, method, body }) => Response; unmatched URLs hit sane defaults.
function installFetch(overrides = {}) {
  fetchCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : null;
    fetchCalls.push({ url, method, body });
    for (const [substr, handler] of Object.entries(overrides)) {
      if (url.includes(substr)) return handler({ url, method, body });
    }
    return defaultRoutes({ url, method, body });
  };
}

function sampleExtraction() {
  const { rows, year } = sampleRows();
  return {
    mosque_name: 'Extracted Masjid Name',
    suggested_slug: '',
    address: '', phone: '', month: 'Test', year,
    islamic_month: '', jummah_times: '', eid_salah: '',
    sadaqatul_fitr: '', radio_frequency: '', notes: '',
    rows,
  };
}

function defaultRoutes({ url, method }) {
  if (url.includes('challenges.cloudflare.com')) return j({ success: true });
  if (url.includes('api.anthropic.com')) {
    return j({ content: [{ text: JSON.stringify(sampleExtraction()) }] });
  }
  if (url.includes('nominatim.openstreetmap.org')) return j([]);
  if (url.includes('api.github.com')) {
    if (url.endsWith('/git/ref/heads/main')) return j({ object: { sha: 'headsha' } });
    if (url.includes('/git/commits/headsha')) return j({ sha: 'headsha', tree: { sha: 'basetree' } });
    if (url.endsWith('/git/blobs')) return j({ sha: 'blobsha' });
    if (url.endsWith('/git/trees')) return j({ sha: 'newtree' });
    if (url.endsWith('/git/commits')) return j({ sha: 'newcommit' });
    if (url.includes('/git/refs/heads/main')) return j({ ok: true });
    if (url.endsWith('/issues')) return j({ number: 1 }, 201);
    if (url.includes('/dispatches')) return new Response(null, { status: 204 });
    if (method === 'PUT' && url.includes('/contents/')) return j({ content: {} }, 201);
    // Directory listing used by deduplicateSlug
    if (url.endsWith('/contents/data/mosques')) return j([]);
    if (url.includes('/contents/')) return new Response('Not Found', { status: 404 });
  }
  throw new Error(`Unexpected outbound fetch in test: ${method} ${url}`);
}

// --- Test data -----------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Three rows starting tomorrow, so date validation always passes.
function sampleRows() {
  const rows = [];
  let year = new Date().getUTCFullYear();
  for (let i = 1; i <= 3; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if (i === 1) year = d.getUTCFullYear(); // "year" = the first row's year
    rows.push({
      date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      day: DAYS[d.getUTCDay()],
      islamic_day: null,
      sehri_ends: '', fajr_start: '03:15', sunrise: '04:45', zawal: '',
      zohr: '01:18', asr: '05:39', esha: '',
      fajr_jamaat: '3:45', zohar_jamaat: '1:30', asr_jamaat: '6:00',
      maghrib_iftari: '09:44', maghrib_jamaat: '', esha_jamaat: '10:59',
    });
  }
  return { rows, year };
}

function pastRows() {
  return {
    rows: [{
      date: '1 Jan', day: 'Thu', islamic_day: null,
      sehri_ends: '', fajr_start: '06:15', sunrise: '08:15', zawal: '',
      zohr: '12:10', asr: '02:00', esha: '',
      fajr_jamaat: '6:45', zohar_jamaat: '12:30', asr_jamaat: '2:30',
      maghrib_iftari: '04:05', maghrib_jamaat: '', esha_jamaat: '07:00',
    }],
    year: 2020,
  };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extractRequest({ ip = '1.2.3.4', name = 'Test Masjid', withFile = true, headers = {} } = {}) {
  const fd = new FormData();
  if (withFile) fd.append('image', new File([PNG_BYTES], 'timetable.png', { type: 'image/png' }));
  if (name) fd.append('name', name);
  return new Request('https://iqamah.co.uk/api/extract', {
    method: 'POST', body: fd,
    headers: { 'CF-Connecting-IP': ip, ...headers },
  });
}

function submitRequest(body, { ip = '1.2.3.4', headers = {} } = {}) {
  return new Request('https://iqamah.co.uk/api/submit', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers },
  });
}

function updateRequest(body, { ip = '1.2.3.4', headers = {} } = {}) {
  return new Request('https://iqamah.co.uk/api/update', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers },
  });
}

// Existing masjid fixture for update tests
const EXISTING_CONFIG = { display_name: 'Test Masjid', slug: 'testmasjid', csv: 'testmasjid.csv' };
const EXISTING_CSV = [
  "Date,Day,Islamic Day,Sehri Ends,Fajr Start,Sunrise,Zawal,Zohr,Asr,Esha,Fajr Jama'at,Zohar Jama'at,Asr Jama'at,Maghrib Iftari,Maghrib Jama'at,Esha Jama'at",
  '1 Jan,Thu,,,06:15,08:15,,12:10,02:00,,6:45,12:30,2:30,04:05,,07:00',
].join('\n');

function updateOverrides() {
  return {
    'contents/data/mosques/testmasjid.json': () =>
      j({ content: btoa(JSON.stringify(EXISTING_CONFIG)), sha: 'cfgsha' }),
    'contents/data/testmasjid.csv': () =>
      j({ content: btoa(EXISTING_CSV), sha: 'csvsha' }),
    'contents/data/mosques/index.json': () =>
      j({ content: btoa(JSON.stringify([EXISTING_CONFIG])), sha: 'idxsha' }),
  };
}

// --- Tests ---------------------------------------------------

let env;
beforeEach(() => {
  env = makeEnv();
  installFetch();
});

// ---- /api/extract: rate limiting ----

test('extract: full bucket returns 429 with the real limit and a reset date', async () => {
  const start = Date.now() - 5 * 86400000;
  env.RATE_LIMITS.seed('extract:1.2.3.4', { count: 10, start });
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.match(body.error, /limit of 10 extractions/);
  assert.match(body.error, /try again after/i);
  // Quota not incremented further while blocked
  assert.equal(env.RATE_LIMITS.json('extract:1.2.3.4').count, 10);
});

test('extract: request below the limit is allowed through', async () => {
  env.RATE_LIMITS.seed('extract:1.2.3.4', { count: 9, start: Date.now() - 86400000 });
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 200);
  assert.equal(env.RATE_LIMITS.json('extract:1.2.3.4').count, 10);
});

test('extract: a failed request (no file) does NOT consume quota', async () => {
  const res = await worker.fetch(extractRequest({ withFile: false }), env);
  assert.equal(res.status, 400);
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

test('extract: a failed Turnstile check does NOT consume quota', async () => {
  env.TURNSTILE_SECRET = 'secret';
  // No cf-turnstile-response token in the form -> verification fails
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 403);
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

test('extract: a successful extraction consumes exactly one', async () => {
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(env.RATE_LIMITS.json('extract:1.2.3.4').count, 1);
});

test('extract: IPv6 addresses in the same /64 share one bucket', async () => {
  await worker.fetch(extractRequest({ ip: '2a04:4a43:883f:f41b:aaaa:1:2:3' }), env);
  await worker.fetch(extractRequest({ ip: '2a04:4a43:883f:f41b:bbbb:4:5:6' }), env);
  const bucket = env.RATE_LIMITS.json('extract:2a04:4a43:883f:f41b::/64');
  assert.ok(bucket, 'expected a /64-keyed bucket');
  assert.equal(bucket.count, 2);
  assert.equal(env.RATE_LIMITS.store.size, 1);
});

test('extract: admin header bypasses a full bucket', async () => {
  env.RATE_LIMITS.seed('extract:1.2.3.4', { count: 10, start: Date.now() });
  const res = await worker.fetch(extractRequest({ headers: { 'X-User-Name': 'AdminUser' } }), env);
  assert.equal(res.status, 200);
});

// ---- /api/extract: extraction behaviour ----

test('extract: happy path returns extracted rows and applies the name override', async () => {
  const res = await worker.fetch(extractRequest({ name: 'My Real Masjid' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.mosque_name, 'My Real Masjid');
  assert.equal(body.data.rows.length, 3);
  assert.ok(body.data.rows[0].date, 'rows survive validateAndFixRows');
});

test('extract: winter Zawal 11:55 before Dhuhr 12:00 is not swapped', async () => {
  // Bare 11:xx Dhuhr/Zawal times are morning (late-autumn GMT); reading them as
  // PM made Zawal 23:55 > Dhuhr 12:00 and swapped the columns.
  const extraction = sampleExtraction();
  extraction.rows = extraction.rows.map(r => ({ ...r, zawal: '11:55', zohr: '12:00', zohar_jamaat: '12:30' }));
  installFetch({ 'api.anthropic.com': () => j({ content: [{ text: JSON.stringify(extraction) }] }) });
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 200);
  const row = (await res.json()).data.rows[0];
  assert.equal(row.zawal, '11:55');
  assert.equal(row.zohr, '12:00');
  assert.equal(row.zohar_jamaat, '12:30');
});

test('extract: unparseable AI response returns a clear error', async () => {
  installFetch({ 'api.anthropic.com': () => j({ content: [{ text: 'not json at all' }] }) });
  const res = await worker.fetch(extractRequest(), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /parse/i);
});

// ---- /api/submit ----

test('submit: happy path commits CSV + config + index and returns the slug', async () => {
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({ data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.slug, 'test_masjid');
  assert.equal(body.pending, true);

  // The single commit's tree must contain the CSV, config and both indexes
  const treeCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'));
  assert.ok(treeCall, 'expected a git tree to be created');
  const paths = JSON.parse(treeCall.body).tree.map(t => t.path);
  for (const p of ['data/test_masjid.csv', 'data/mosques/test_masjid.json', 'data/mosques/index.json', 'data/mosques/index-slim.json']) {
    assert.ok(paths.includes(p), `tree missing ${p}`);
  }
  // Commit landed and a review notification was raised
  assert.ok(fetchCalls.some(c => c.method === 'PATCH' && c.url.includes('/git/refs/heads/main')));
  assert.ok(fetchCalls.some(c => c.method === 'POST' && c.url.endsWith('/issues')));
  // Quota consumed once
  assert.equal(env.RATE_LIMITS.json('submit:1.2.3.4').count, 1);
});

test('submit: outdated timetable is rejected and does not consume quota', async () => {
  const { rows, year } = pastRows();
  const res = await worker.fetch(submitRequest({ data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /outdated/i);
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

test('submit: likely duplicate returns 409 warning and does not consume quota', async () => {
  const existing = [{ display_name: 'Test Masjid', slug: 'existing', phone: '0121 111 2222', csv: 'existing.csv' }];
  installFetch({
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify(existing)), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({
    data: { mosque_name: 'Test Masjid', phone: '01211112222', rows, year },
  }), env);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.duplicate_warning, true);
  assert.ok(body.matches.length >= 1);
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

// Same name + same phone (the Faizul Islam case): near-certain duplicate
const STRONG_EXISTING = [{ display_name: 'Test Masjid', slug: 'existing', phone: '0121 111 2222', address: '1 High St, Birmingham, B20 3EA', csv: 'existing.csv' }];

test('submit: strong duplicate is flagged strong and cannot be overridden with confirm_not_duplicate', async () => {
  installFetch({
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify(STRONG_EXISTING)), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows();
  const data = { mosque_name: 'Test Masjid', phone: '01211112222', rows, year };

  const first = await worker.fetch(submitRequest({ data }), env);
  assert.equal(first.status, 409);
  const firstBody = await first.json();
  assert.equal(firstBody.strong, true);
  assert.equal(firstBody.matches[0].slug, 'existing');
  assert.equal(firstBody.matches[0].strong, true);

  const override = await worker.fetch(submitRequest({ data, confirm_not_duplicate: true }), env);
  assert.equal(override.status, 409);
  assert.equal((await override.json()).strong, true);
  assert.ok(!fetchCalls.some(c => c.url.endsWith('/git/trees')), 'nothing committed');
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

test('submit: shared phone with a different name is a weak match and can be overridden', async () => {
  const existing = [{ display_name: 'Green Lane Masjid', slug: 'green_lane', phone: '0121 111 2222', csv: 'green_lane.csv' }];
  installFetch({
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify(existing)), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows();
  const data = { mosque_name: 'Small Heath Branch', phone: '01211112222', rows, year };

  const first = await worker.fetch(submitRequest({ data }), env);
  assert.equal(first.status, 409);
  assert.equal((await first.json()).strong, false);

  const override = await worker.fetch(submitRequest({ data, confirm_not_duplicate: true }), env);
  assert.equal(override.status, 200);
  assert.equal((await override.json()).success, true);
});

test('submit: admin can override a strong duplicate', async () => {
  installFetch({
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify(STRONG_EXISTING)), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows();
  const data = { mosque_name: 'Test Masjid', phone: '01211112222', rows, year };
  const headers = { 'X-User-Name': 'AdminUser' };

  const first = await worker.fetch(submitRequest({ data }, { headers }), env);
  assert.equal(first.status, 409);
  assert.equal((await first.json()).strong, false, 'admins get the overridable warning');

  const override = await worker.fetch(submitRequest({ data, confirm_not_duplicate: true }, { headers }), env);
  assert.equal(override.status, 200);
  assert.ok(fetchCalls.some(c => c.method === 'POST' && c.url.endsWith('/git/trees')), 'admin override committed');
});

function indexWith(configs, extra = {}) {
  return {
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify(configs)), sha: 'idxsha' }),
    ...extra,
  };
}

test('submit: same name + same full postcode (no phone) is strong', async () => {
  installFetch(indexWith([{ display_name: 'Faizul Islam', slug: 'faizul', address: '1-8 The Broadway, Birmingham, B20 3EA', csv: 'faizul.csv' }]));
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({
    data: { mosque_name: 'Masjid Faizul Islam', address: 'The Broadway, Perry Barr, B20 3EA', rows, year },
    confirm_not_duplicate: true,
  }), env);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).strong, true);
});

test('submit: same name within 100m is strong, using provider latitude/longitude fields', async () => {
  // Mawaqit-style config: latitude/longitude, no lat/lon, no postcode
  installFetch(indexWith(
    [{ display_name: 'Faizul Islam', slug: 'faizul', latitude: 52.51060, longitude: -1.89120, csv: 'faizul.csv' }],
    { 'nominatim.openstreetmap.org': () => j([{ lat: '52.51065', lon: '-1.89125' }]) },
  ));
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({
    data: { mosque_name: 'Faizul Islam', address: 'The Broadway, Perry Barr', rows, year },
    confirm_not_duplicate: true,
  }), env);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.strong, true);
  assert.ok(body.matches[0].reasons.some(r => /<100m/.test(r)));
});

test('submit: name below the 85% bar with same postcode is weak and overridable', async () => {
  // "faizan islam" vs "faizul islam" = 83% similar
  installFetch(indexWith([{ display_name: 'Faizul Islam', slug: 'faizul', address: 'Birmingham, B20 3EA', csv: 'faizul.csv' }]));
  const { rows, year } = sampleRows();
  const data = { mosque_name: 'Faizan Islam', address: 'Birmingham, B20 3EA', rows, year };

  const first = await worker.fetch(submitRequest({ data }), env);
  assert.equal(first.status, 409);
  assert.equal((await first.json()).strong, false);

  const override = await worker.fetch(submitRequest({ data, confirm_not_duplicate: true }), env);
  assert.equal(override.status, 200);
});

test('submit: confirm_not_duplicate with a weak + strong mix returns only the strong match', async () => {
  installFetch(indexWith([
    { display_name: 'Test Masjid', slug: 'existing', address: 'Birmingham, B20 3EA', csv: 'existing.csv' },
    { display_name: 'Green Lane Masjid', slug: 'green_lane', phone: '0121 111 2222', csv: 'green_lane.csv' },
  ]));
  const { rows, year } = sampleRows();
  const data = { mosque_name: 'Test Masjid', phone: '01211112222', address: 'Birmingham, B20 3EA', rows, year };

  const first = await worker.fetch(submitRequest({ data }), env);
  assert.deepEqual((await first.json()).matches.map(m => m.slug).sort(), ['existing', 'green_lane']);

  const override = await worker.fetch(submitRequest({ data, confirm_not_duplicate: true }), env);
  assert.equal(override.status, 409);
  const body = await override.json();
  assert.equal(body.strong, true);
  assert.deepEqual(body.matches.map(m => m.slug), ['existing']);
});

test('submit: missing masjid name is rejected', async () => {
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({ data: { mosque_name: '', rows, year } }), env);
  assert.equal(res.status, 400);
});

// ---- /api/update ----

// Map of committed path -> decoded content (null for deletions). Blobs are
// created in the same order as the tree's non-deleted entries.
function committedFiles() {
  const treeCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'));
  if (!treeCall) return null;
  const blobs = fetchCalls.filter(c => c.method === 'POST' && c.url.endsWith('/git/blobs'));
  const out = {};
  let i = 0;
  for (const entry of JSON.parse(treeCall.body).tree) {
    if (entry.sha === null) { out[entry.path] = null; continue; }
    const b64 = JSON.parse(blobs[i++].body).content;
    out[entry.path] = Buffer.from(b64, 'base64').toString('utf8');
  }
  return out;
}

// Live-feed (Mawaqit) masjid: provider-format CSV with snake_case + ISO dates
const FEED_CONFIG = {
  display_name: 'Test Masjid', slug: 'testfeed', csv: 'testfeed.csv',
  provider: { type: 'mawaqit', ref: { path: 'test-masjid-birmingham' }, source_url: 'https://mawaqit.net/en/m/test' },
};
function isoDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}
const FEED_CSV = [
  'date,day,islamic_day,sehri_ends,fajr_start,sunrise,zawal,zohr,asr,esha,fajr_jamaat,zohar_jamaat,asr_jamaat,maghrib_iftari,maghrib_jamaat,esha_jamaat',
  `${isoDate(1)},Mon,,,05:00,06:30,,13:00,16:00,20:00,05:30,13:30,16:30,19:00,19:05,20:30`,
  `${isoDate(40)},Tue,,,05:10,06:40,,13:00,15:50,19:50,05:40,13:30,16:20,18:50,18:55,20:20`,
].join('\n');

function feedOverrides(extra = {}) {
  return {
    'contents/data/mosques/testfeed.json': () => j({ content: btoa(JSON.stringify(FEED_CONFIG)), sha: 'cfgsha' }),
    'contents/data/testfeed.csv': () => j({ content: btoa(FEED_CSV), sha: 'csvsha' }),
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify([FEED_CONFIG])), sha: 'idxsha' }),
    ...extra,
  };
}

test('update: live-feed masjid stores the upload as a backup and leaves the feed untouched', async () => {
  installFetch(feedOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({
    slug: 'testfeed',
    data: { mosque_name: 'Test Masjid', rows, year, jummah_times: '1:30pm' },
    image: 'data:image/png;base64,' + btoa('fakepng'),
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.backup, true);
  assert.equal(body.pending, false);

  const files = committedFiles();
  assert.ok(files['data/backup/testfeed.csv'], 'backup CSV committed');
  assert.ok(!('data/testfeed.csv' in files), 'feed CSV not rewritten');
  assert.ok(files['data/sources/testfeed_backup.png'] !== undefined, 'backup image committed');
  assert.ok(files['data/backup/testfeed.json'] !== undefined, 'raw extraction stored with the backup');
  assert.ok(!('data/testfeed.json' in files));

  const cfg = JSON.parse(files['data/mosques/testfeed.json']);
  assert.deepEqual(cfg.provider, FEED_CONFIG.provider, 'provider record unchanged');
  assert.equal(cfg.backup_csv, 'backup/testfeed.csv');
  assert.equal(cfg.backup_source_image, 'sources/testfeed_backup.png');
  assert.match(cfg.backup_updated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cfg.source_image, undefined);
  assert.equal(cfg.pending_update, undefined, 'feed times are not flagged pending');
  assert.equal(cfg.jummah_times, '1:30pm', 'metadata still updated');

  const slim = JSON.parse(files['data/mosques/index-slim.json']);
  assert.equal(slim[0].backup_csv, 'backup/testfeed.csv', 'slim index carries backup_csv');

  const commit = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/git/commits'));
  assert.match(JSON.parse(commit.body).message, /^Backup timetable: /);
});

test('update: a non-admin backup is marked pending review and raises a backup issue', async () => {
  installFetch(feedOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({ slug: 'testfeed', data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const cfg = JSON.parse(committedFiles()['data/mosques/testfeed.json']);
  assert.equal(cfg.backup_pending, true);
  const issue = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/issues'));
  assert.ok(issue, 'notification issue created');
  const { title, body } = JSON.parse(issue.body);
  assert.match(title, /^Backup timetable: /);
  assert.match(body, /saved as a \*\*backup\*\*/);
  assert.match(body, /data\/backup\/testfeed\.csv/);
});

test('update: an admin backup is not marked pending', async () => {
  installFetch(feedOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest(
    { slug: 'testfeed', data: { mosque_name: 'Test Masjid', rows, year } },
    { headers: { 'X-User-Name': 'AdminUser' } },
  ), env);
  assert.equal(res.status, 200);
  const cfg = JSON.parse(committedFiles()['data/mosques/testfeed.json']);
  assert.equal(cfg.backup_pending, undefined);
  assert.ok(!fetchCalls.some(c => c.method === 'POST' && c.url.endsWith('/issues')), 'no issue for admin uploads');
});

test('admin approve clears backup_pending in the config and index', async () => {
  const pendingCfg = { ...FEED_CONFIG, backup_csv: 'backup/testfeed.csv', backup_pending: true };
  installFetch(feedOverrides({
    'contents/data/mosques/testfeed.json': () => j({ content: btoa(JSON.stringify(pendingCfg)), sha: 'cfgsha' }),
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify([pendingCfg])), sha: 'idxsha' }),
  }));
  const res = await worker.fetch(new Request('https://iqamah.co.uk/api/admin/approve', {
    method: 'POST', body: JSON.stringify({ slug: 'testfeed' }),
    headers: { 'Content-Type': 'application/json', 'X-User-Name': 'AdminUser' },
  }), env);
  assert.equal(res.status, 200);
  const files = committedFiles();
  assert.equal(JSON.parse(files['data/mosques/testfeed.json']).backup_pending, undefined);
  const indexEntry = JSON.parse(files['data/mosques/index.json']).find(c => c.slug === 'testfeed');
  assert.equal(indexEntry.backup_pending, undefined);
  assert.equal(indexEntry.backup_csv, 'backup/testfeed.csv', 'the backup itself is kept');
});

test('update: a second upload for a live-feed masjid merges into the existing backup', async () => {
  const existingBackup = [
    "Date,Day,Islamic Day,Sehri Ends,Fajr Start,Sunrise,Zawal,Zohr,Asr,Esha,Fajr Jama'at,Zohar Jama'at,Asr Jama'at,Maghrib Iftari,Maghrib Jama'at,Esha Jama'at",
    '1 Jan,Thu,,,06:15,08:15,,12:10,02:00,,6:45,12:30,2:30,04:05,,07:00',
  ].join('\n');
  installFetch(feedOverrides({
    'contents/data/backup/testfeed.csv': () => j({ content: btoa(existingBackup), sha: 'bksha' }),
  }));
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({ slug: 'testfeed', data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const csv = committedFiles()['data/backup/testfeed.csv'];
  assert.match(csv, /^1 Jan,/m, 'earlier backup rows kept');
  assert.equal(csv.trim().split('\n').length, 1 + 1 + rows.length);
});

test('update: merging keeps existing rows from a snake_case/ISO CSV and dedupes across date formats', async () => {
  // Image masjid whose CSV is in provider format (e.g. it used to be a feed)
  const cfg = { display_name: 'Test Masjid', slug: 'testmasjid', csv: 'testmasjid.csv', provider: { type: 'image' } };
  installFetch({
    'contents/data/mosques/testmasjid.json': () => j({ content: btoa(JSON.stringify(cfg)), sha: 'cfgsha' }),
    'contents/data/testmasjid.csv': () => j({ content: btoa(FEED_CSV), sha: 'csvsha' }),
    'contents/data/mosques/index.json': () => j({ content: btoa(JSON.stringify([cfg])), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows(); // first row is tomorrow, in "D Mon" format
  const res = await worker.fetch(updateRequest({ slug: 'testmasjid', data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const lines = committedFiles()['data/testmasjid.csv'].trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'Date');
  // FEED_CSV has tomorrow (overlaps the upload) + day 40: 3 uploaded + 1 kept
  assert.equal(lines.length, 1 + rows.length + 1, lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith(isoDate(40) + ',')), 'non-overlapping existing row kept');
  const tomorrow = lines.filter(l => l.startsWith(isoDate(1) + ','));
  assert.equal(tomorrow.length, 1, 'overlapping date replaced by the upload, not duplicated');
  assert.ok(tomorrow[0].includes(',3:45,'), 'the uploaded row wins');
});

test('submit: uploaded "1 Oct" dates are stored as ISO dates using the timetable year', async () => {
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({ data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const lines = committedFiles()['data/test_masjid.csv'].trim().split('\n').slice(1);
  assert.deepEqual(lines.map(l => l.split(',')[0]), [1, 2, 3].map(isoDate));
});

test('update: a December-January timetable rolls over into the next year', async () => {
  installFetch(updateOverrides());
  const y = new Date().getUTCFullYear();
  const row = (date, day) => ({ ...sampleRows().rows[0], date, day });
  const rows = [row('30 Dec', 'Wed'), row('31 Dec', 'Thu'), row('1 Jan', 'Fri'), row('2 Jan', 'Sat')];
  const res = await worker.fetch(updateRequest({ slug: 'testmasjid', data: { mosque_name: 'Test Masjid', rows, year: y } }), env);
  assert.equal(res.status, 200);
  const dates = committedFiles()['data/testmasjid.csv'].trim().split('\n').slice(1).map(l => l.split(',')[0]);
  for (const d of [`${y}-12-30`, `${y}-12-31`, `${y + 1}-01-01`, `${y + 1}-01-02`]) {
    assert.ok(dates.includes(d), `${d} in ${dates.join(' ')}`);
  }
  // Sorted chronologically: next January comes after this December
  assert.ok(dates.indexOf(`${y + 1}-01-01`) > dates.indexOf(`${y}-12-31`));
});

test('update: non-ASCII text in the config and index survives a round trip unchanged', async () => {
  // GitHub serves base64 of UTF-8 bytes; decoding with atob() alone garbled
  // "£"/"—"/"ā" and re-encoded the garbage on every write.
  const cfg = { ...EXISTING_CONFIG, sadaqatul_fitr: 'Minimum £6.00', notes: 'Sub’h Ṣādiq — 5 min' };
  const other = { display_name: 'Ānnoor', slug: 'annoor', notes: 'Ṣādiq', csv: 'annoor.csv' };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  installFetch({
    'contents/data/mosques/testmasjid.json': () => j({ content: b64(cfg), sha: 'cfgsha' }),
    'contents/data/testmasjid.csv': () => j({ content: btoa(EXISTING_CSV), sha: 'csvsha' }),
    'contents/data/mosques/index.json': () => j({ content: b64([other, cfg]), sha: 'idxsha' }),
  });
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({ slug: 'testmasjid', data: { mosque_name: 'Test Masjid', rows, year } }), env);
  assert.equal(res.status, 200);
  const files = committedFiles();
  const saved = JSON.parse(files['data/mosques/testmasjid.json']);
  assert.equal(saved.sadaqatul_fitr, 'Minimum £6.00');
  assert.equal(saved.notes, cfg.notes);
  const index = JSON.parse(files['data/mosques/index.json']);
  assert.equal(index.find(c => c.slug === 'annoor').notes, 'Ṣādiq', 'untouched index entries keep their text');
  assert.equal(index.find(c => c.slug === 'annoor').display_name, 'Ānnoor');
});

test('update: image masjid still replaces provider and source_image as before', async () => {
  installFetch(updateOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({
    slug: 'testmasjid', data: { mosque_name: 'Test Masjid', rows, year },
    image: 'data:image/jpeg;base64,' + btoa('fakejpg'),
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.backup, false);
  assert.equal(body.pending, true);
  const files = committedFiles();
  const cfg = JSON.parse(files['data/mosques/testmasjid.json']);
  assert.equal(cfg.source_image, 'sources/testmasjid.jpg');
  assert.equal(cfg.provider.type, 'image');
  assert.equal(cfg.pending_update, true);
  assert.equal(cfg.backup_csv, undefined);
  assert.ok('data/sources/testmasjid.jpg' in files);
});

test('update: happy path merges the CSV and commits', async () => {
  installFetch(updateOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({
    slug: 'testmasjid',
    data: { mosque_name: 'Test Masjid', rows, year },
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.match(body.message, /Test Masjid/);

  const treeCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'));
  assert.ok(treeCall, 'expected a git tree to be created');
  const paths = JSON.parse(treeCall.body).tree.map(t => t.path);
  assert.ok(paths.includes('data/testmasjid.csv'), 'updated CSV committed');
  assert.ok(paths.includes('data/mosques/testmasjid.json'), 'updated config committed');
  assert.equal(env.RATE_LIMITS.json('update:1.2.3.4').count, 1);
});

test('update: wrong timetable (name mismatch) is rejected without consuming quota', async () => {
  installFetch(updateOverrides());
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({
    slug: 'testmasjid',
    data: { mosque_name: 'Completely Different Islamic Centre Somewhere', rows, year },
  }), env);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /doesn't appear to be the timetable/);
  assert.equal(env.RATE_LIMITS.store.size, 0);
});

test('update: unknown slug returns 404 Masjid not found', async () => {
  const { rows, year } = sampleRows();
  const res = await worker.fetch(updateRequest({
    slug: 'no_such_masjid',
    data: { mosque_name: 'Test Masjid', rows, year },
  }), env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /not found/i);
});
