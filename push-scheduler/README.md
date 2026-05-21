# Iqamah push-scheduler

Standalone Cloudflare Worker that sends prayer-time Web Push notifications.
Cloudflare **Pages** Functions can't run cron, so this sidecar owns the schedule
and the VAPID sending. It shares the `PUSH_SUBS` KV namespace with the Pages
worker (`_worker.js`). Full design: `docs/push-notifications-spec.md`.

## One-time setup

```bash
# 1. Generate VAPID keys (keep the private key secret — never commit it)
npx web-push generate-vapid-keys

# 2. Create the shared KV namespace, then paste its id into wrangler.toml
wrangler kv namespace create PUSH_SUBS

# 3. Set secrets on this Worker
cd push-scheduler
wrangler secret put VAPID_PUBLIC_KEY     # paste the public key
wrangler secret put VAPID_PRIVATE_KEY    # paste the private key
# (VAPID_SUBJECT + SITE_ORIGIN are plain vars in wrangler.toml)

# 4. Deploy
wrangler deploy
```

### Pages side (in the Cloudflare dashboard)
- Bind the **same** `PUSH_SUBS` KV namespace to the `prayerly` Pages project
  (Settings → Bindings) so `/api/push/*` can read/write subscriptions.
- Add `VAPID_PUBLIC_KEY` as a Pages **environment variable** (the client fetches
  it from `GET /api/push/vapid-public-key`). The private key is NOT needed on Pages.

## How it runs

- Cron `* * * * *` fires `scheduled()` every minute → `runMinute()`.
- `runMinute` lists all `sub:*` records, loads each masjid's CSV + `season.json`
  from `SITE_ORIGIN`, resolves today's reminders to UTC instants
  (`Europe/London` wall-clock → UTC, DST per-date), and sends any whose fire
  time lands in the current minute.
- Dedup via `sent:*` markers (one per device/prayer/kind/day); `prayed:*` markers
  suppress jama'at/end after a "Prayed" tap; `404/410` responses delete the sub.

## Scale note

Per-minute scan = ~1 KV get per subscription per minute. Comfortable to ~60 subs
on the KV free tier (100k reads/day); beyond that switch to the precomputed
minute-bucket model (spec §6) or Workers Paid (1M reads/day, ~$5/mo).

## Local

```bash
wrangler dev          # local; trigger a tick at http://localhost:8787/run?key=<SCHEDULER_SECRET>
wrangler tail         # live logs from the deployed Worker
```
