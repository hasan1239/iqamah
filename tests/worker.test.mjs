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
    year = d.getUTCFullYear();
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

test('submit: missing masjid name is rejected', async () => {
  const { rows, year } = sampleRows();
  const res = await worker.fetch(submitRequest({ data: { mosque_name: '', rows, year } }), env);
  assert.equal(res.status, 400);
});

// ---- /api/update ----

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
