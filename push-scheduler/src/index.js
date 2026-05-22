// Iqamah push-scheduler — standalone Cloudflare Worker (Cron Trigger, 1-minute).
//
// Pages Functions can't run cron, so this sidecar owns scheduling + sending. It
// shares the PUSH_SUBS KV namespace with the Pages worker (_worker.js).
//
// v1 model: per-minute SCAN. Each tick lists all subscriptions, resolves today's
// reminders to UTC instants, and sends any whose fire-time falls in the current
// minute. Simple and correct-on-subscribe (no nightly rebuild / incremental
// build needed). Cost note: ~1 KV get per subscription per minute — fine on the
// free tier to ~60 subs; beyond that move to the precomputed-bucket model in
// docs/push-notifications-spec.md §6, or use Workers Paid (1M reads).

import { parseCSV, rowForDate, buildReminderInstants, buildCopy } from './schedule.js';
import { sendWebPush } from './webpush.js';

function londonDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
}

async function endpointHash(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function listAllSubs(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.PUSH_SUBS.list({ prefix: 'sub:', cursor });
    for (const k of res.keys) {
      const record = await env.PUSH_SUBS.get(k.name, 'json');
      if (record) out.push({ key: k.name, record });
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

async function loadMasjid(origin, slug, cache) {
  if (cache.has(slug)) return cache.get(slug);
  let data = null;
  try {
    const cfgRes = await fetch(`${origin}/data/mosques/${slug}.json`);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      const csvRes = await fetch(`${origin}/data/${cfg.csv}`);
      if (csvRes.ok) data = { rows: parseCSV(await csvRes.text()), name: cfg.display_name || slug };
    }
  } catch { data = null; }
  cache.set(slug, data);
  return data;
}

async function fetchSeason(origin) {
  try {
    const res = await fetch(`${origin}/data/season.json`);
    if (res.ok) return (await res.json()).season || 'default';
  } catch { /* ignore */ }
  return 'default';
}

async function runMinute(env) {
  if (!env.PUSH_SUBS || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const origin = env.SITE_ORIGIN || 'https://iqamah.co.uk';
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:prayerly@hotmail.com',
  };

  const now = new Date();
  const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
  const minuteEnd = minuteStart + 60000;
  const dateStr = londonDateStr(now);

  const season = await fetchSeason(origin);
  const subs = await listAllSubs(env);
  const csvCache = new Map();

  for (const { record } of subs) {
    const prefs = record.prefs;
    const slug = record.slug;
    if (!prefs || !prefs.master || !slug) continue;

    const masjid = await loadMasjid(origin, slug, csvCache);
    if (!masjid) continue;
    const row = rowForDate(masjid.rows, dateStr);
    if (!row) continue;

    const use24h = record.tf !== '12';
    const reminders = buildReminderInstants(row, prefs, season, dateStr, record.tz || 'Europe/London');

    for (const r of reminders) {
      const fire = r.fireAt.getTime();
      if (fire < minuteStart || fire >= minuteEnd) continue;

      const hash = await endpointHash(record.endpoint);
      // Suppress jama'at/end once marked prayed today.
      if (r.kind === 'jamaat' || r.kind === 'end') {
        if (await env.PUSH_SUBS.get(`prayed:${hash}:${r.prayer}:${dateStr}`)) continue;
      }
      // Dedup: one send per device/prayer/kind/day.
      const sentKey = `sent:${hash}:${slug}:${r.prayer}:${r.kind}:${dateStr}`;
      if (await env.PUSH_SUBS.get(sentKey)) continue;

      const { title, body } = buildCopy(r, masjid.name, use24h);
      const payload = JSON.stringify({
        title, body,
        url: `/${slug}`,
        prayer: r.prayer,
        tag: `${dateStr}:${r.kind}:${r.prayer}`,
      });

      try {
        const res = await sendWebPush(record, payload, vapid);
        if (res.status === 404 || res.status === 410) {
          await env.PUSH_SUBS.delete(`sub:${hash}`); // gone — clean up
        } else if (res.ok) {
          await env.PUSH_SUBS.put(sentKey, '1', { expirationTtl: 36 * 3600 });
        }
      } catch { /* transient send error — retried next applicable minute */ }
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMinute(env));
  },
  // Health check / manual kick (optional). Not used by the cron path.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && env.SCHEDULER_SECRET && url.searchParams.get('key') === env.SCHEDULER_SECRET) {
      await runMinute(env);
      return new Response('ran', { status: 200 });
    }
    // TEMP (dev): send a real push to every subscription on demand, to verify the
    // server→device delivery path without waiting for a scheduled reminder.
    if (url.pathname === '/test-push' && env.SCHEDULER_SECRET && url.searchParams.get('key') === env.SCHEDULER_SECRET) {
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
        return new Response('VAPID not set', { status: 503 });
      }
      const vapid = {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT || 'mailto:prayerly@hotmail.com',
      };
      const subs = await listAllSubs(env);
      const results = [];
      for (const { record } of subs) {
        const payload = JSON.stringify({
          title: 'Iqamah server push works ✅',
          body: 'This came from the scheduler with the app closed.',
          url: record.slug ? `/${record.slug}` : '/',
          prayer: 'asr',
          tag: 'iqamah-server-test',
        });
        try {
          const res = await sendWebPush(record, payload, vapid);
          results.push(res.status);
        } catch (e) {
          results.push(`err:${e && e.message ? e.message : 'unknown'}`);
        }
      }
      return new Response(JSON.stringify({ subs: subs.length, results }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('iqamah push-scheduler', { status: 200 });
  },
};
