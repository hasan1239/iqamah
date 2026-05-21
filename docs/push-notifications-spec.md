# Push Notifications — Spec

**Status:** Planning (not built). Last updated 2026-05-21.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

Let a user opt into reminders for their pinned masjid's prayer times — e.g. *"Asr jama'at at 6:45 PM, in 15 minutes"* — delivered to the lock screen even when the app is backgrounded.

## 2. Delivery mechanism (decided — do not relitigate)

- **Server-scheduled Web Push (VAPID).** A client-side `setTimeout` won't fire when the app is closed, and the Notification Triggers API never shipped reliably. We need a subscription store + a server scheduler that pushes at the right time.
- **Build on existing infra:** Cloudflare Pages + `_worker.js` (sends/stores), plus a cron-driven sender. No new platform.
- **iOS:** Web Push only works for PWAs added to the home screen (iOS 16.4+). Settings UI must detect non-installed iOS Safari and show an "Add to Home Screen first" state instead of a dead toggle (`isIOSSafari()` / `isStandalone()` already exist in `js/utils/pwa.js`).

---

## 3. Architecture

**Critical constraint:** Cloudflare **Pages Functions cannot run cron** — there is no `scheduled()` handler on Pages. GitHub Actions cron (used for the daily lockscreen) can't do per-minute precision (5-min floor + documented 15–60min delays). So the scheduler is a **separate standalone Cloudflare Worker** with a 1-minute Cron Trigger, sharing one KV namespace with the Pages worker.

```
┌─ SPA (settings.js) ──────────┐     ┌─ Pages _worker.js ───────────┐
│ Notification settings UI      │────▶│ POST /api/push/subscribe     │
│ Permission request            │     │ POST /api/push/update        │  writes
│ SW registration (pwa.js)      │     │ POST /api/push/unsubscribe   │──┐ KV
└──────────────┬───────────────┘     │ GET  /api/push/vapid-public-key  │
               │ push / notificationclick                            │  │
               ▼                      └──────────────────────────────┘  │
        ┌─ sw.js ──────────┐                                            ▼
        │ push handler     │◀──── Web Push (VAPID) ───┐     ┌─ PUSH_SUBS (KV) ─┐
        │ notificationclick│                          │     │ subs + buckets   │
        └──────────────────┘                          │     └─────────┬────────┘
                                       ┌─ push-scheduler Worker ───────▼──┐
                                       │ scheduled() — 1-min Cron Trigger  │
                                       │ + nightly schedule rebuild        │
                                       │ + VAPID Web Push send / 410-clean │
                                       └───────────────────────────────────┘
```

- **Subscribe/update/unsubscribe + vapid-public-key** → existing Pages `_worker.js` (same origin, no CORS, reuses `jsonResponse` / `isRateLimited` / KV patterns).
- **Cron + send** → new `push-scheduler/` Worker. Binds the **same** `PUSH_SUBS` KV namespace.
- **New deploy surface:** the scheduler Worker is NOT auto-deployed by the Pages-on-push flow. Needs its own `wrangler deploy` (add a `.github/workflows/deploy-scheduler.yml` running `wrangler deploy` on `push-scheduler/**` changes).
- **Alternative (future):** Durable Object `alarm()` per subscription for exact-time, no-polling precision. Heavier primitive; revisit if ±60s isn't good enough.

---

## 4. Settings model (FINALISED)

UI mirrors `js/views/settings.js` patterns: `settings-group`, `toggle-switch`, `theme-segmented`. Lead options render as **wrapping chips** (5 options don't fit a 3-slot slider).

### Layout

```
┌─ Prayer Reminders ────────────────────────┐
│ 🔔  Notifications              [ ●——]      ◀ master toggle
│ 🕌  Remind me for      Masjid Faizul  ›    ◀ target (default = pinned)
└────────────────────────────────────────────┘

┌─ Prayers ──────────────────────────────────┐  ◀ accordion: collapsed summary, tap to expand
│ Fajr            Start                  ▾   │
│   ┌ Start time        [ ●—— ]  [at·5·10·15·30m]
│   ┌ Jama'at time      [ ●—— ]  [at·5·10·15·30m]
│   ┌ Ends soon         [ ●—— ]  [15·30·45·60m]
│ Dhuhr           Start                  ▾   │   (same three rows)
│ Asr             Start                  ▾   │   (same three rows)
│ Maghrib         Start                  ▾   │
│   ┌ Start time        [ ●—— ]  [at·5·10·15·30m]
│   ┌ Jama'at time      [ ●—— ]  [at·5·10·15·30m]
│   └ ⓘ Pray Maghrib as soon as possible        ◀ no "ends soon"
│ Esha            Start                  ▾   │
│   ┌ Start time        [ ●—— ]  [at·5·10·15·30m]
│   ┌ Jama'at time      [ ●—— ]  [at·5·10·15·30m]   ◀ no "ends soon"
└────────────────────────────────────────────┘

┌─ Ramadan ──── (only when season.json = ramadan)
│ Suhoor ends     [ ●—— ]  [..·30·45·60m]    ◀ before "Sehri Ends"
│ Iftar           [ ●—— ]  [at·5·10m]        ◀ at/before "Maghrib Iftari"
└────────────────────────────────────────────┘
```

### Rules

- **Reminder kinds:** `start · jamaat · end · suhoor · iftar`.
- **Per-prayer granularity** — each prayer's Start, Jama'at, Ends-soon are independent toggles, each with its own lead. A prayer can fire at **both** start and jama'at.
- **"Prayer enabled" is implicit** — on if any sub-reminder is on. Collapsed row summarises ("Off" / "Start" / "Start · Jama'at · Ends 30m").
- **Ends soon** applies to **Fajr, Dhuhr, Asr only.** Excluded for Maghrib (short window → "pray ASAP" note) and Esha (no clean CSV end time — Islamic-midnight calc deliberately skipped).
- **Lead chips:** start/jamaat = `at-time · 5 · 10 · 15 · 30m` (before the time). Ends-soon = `15 · 30 · 45 · 60m` (before window end).
- **Master off** collapses/disables everything below. **iOS Safari not installed** → whole group replaced by "Add to Home Screen to enable reminders" card.
- **Target masjid** defaults to `iqamah-pinned-masjid`; if not user-overridden, follows the `iqamah-pin-changed` CustomEvent already dispatched by `settings.js`.
- **Jummah: out of scope for v1** (Jummah time is free-text in config `jummah_times`, not in the CSV).

### Defaults on first enable

All 5 **starts ON at-time**; all **jama'at OFF** (lead 15m when enabled); all **ends-soon OFF** (lead 30m when enabled); Ramadan **Suhoor ON 30m**, **Iftar ON at-time**.

### Prefs schema (`iqamah-notif-prefs` in localStorage v0 → subscription record v1)

```jsonc
{
  "master": true,
  "slug": null,                                  // null = follow iqamah-pinned-masjid
  "prayers": {
    "fajr":    { "start": {"on":true,"lead":0}, "jamaat": {"on":false,"lead":15}, "end": {"on":false,"lead":30} },
    "dhuhr":   { "start": {"on":true,"lead":0}, "jamaat": {"on":false,"lead":15}, "end": {"on":false,"lead":30} },
    "asr":     { "start": {"on":true,"lead":0}, "jamaat": {"on":false,"lead":15}, "end": {"on":false,"lead":30} },
    "maghrib": { "start": {"on":true,"lead":0}, "jamaat": {"on":false,"lead":15} },
    "esha":    { "start": {"on":true,"lead":0}, "jamaat": {"on":false,"lead":15} }
  },
  "ramadanExtras": { "suhoor": {"on":true,"lead":30}, "iftar": {"on":true,"lead":0} }
}
```

### Time sources (CSV columns; see `js/views/prayer-times.js` for canonical mapping)

| Reminder | Time from | Notes |
|---|---|---|
| `*.start` | Fajr=`Sehri Ends`/`Fajr Start`, Dhuhr=`Zohr`, Asr=`Asr`, Maghrib=`Maghrib Iftari`, Esha=`Esha` | Ramadan Fajr start = `Sehri Ends` |
| `*.jamaat` | `Fajr Jama'at` / `Zohar Jama'at` (default `1:00`) / `Asr Jama'at` / `Maghrib Jama'at`→`Maghrib Iftari` / `Esha Jama'at` | mirror `getNextPrayer` |
| `fajr.end` | `Sunrise` | window end |
| `dhuhr.end` | `Asr` | next prayer start |
| `asr.end` | `Maghrib Iftari` | next prayer start |
| `suhoor` | `Sehri Ends` | Ramadan only |
| `iftar` | `Maghrib Iftari` | Ramadan only |

### Sample notification copy

- start → "Asr has begun · 4:30 PM"
- jama'at (lead) → "Asr jama'at in 15 min · 6:45 PM"  ·  (at-time) → "Asr jama'at now · 6:45 PM"
- end → "Asr ends in 30 min · pray before 7:00 PM"
- suhoor → "Suhoor ends in 30 min · 4:12 AM"
- iftar → "Iftar — time to break your fast · 8:45 PM"

### Notification actions

Every reminder (and the dev test notification) carries two action buttons. They
render on Android / installed PWAs; iOS ignores them gracefully.

- **View times** — opens the masjid page (`data.url` = `/{slug}`).
- **Prayed** — marks that salah done **for today** so its remaining **jama'at and end**
  reminders are suppressed (the user has already prayed; don't nag). Does NOT open the app.

Notification `data` includes `{ url, prayer }`. `notificationclick` in `sw.js` branches on
`event.action`: `prayed` posts `{type:'iqamah-prayed', prayer}` to open clients and returns
without opening; anything else focuses/opens `data.url`.

**Prayed-guard wiring:**
- **v0** — the page receives the SW message, records the prayer in `iqamah-notif-prayed`
  (localStorage, `{ "YYYY-MM-DD": [prayerKeys] }`, pruned to today), and reschedules; the
  foreground loop skips `jamaat`/`end` for any prayed prayer. (Limitation: app-open only — if
  the app is fully closed the page can't record it, but in v0 nothing fires then anyway.)
- **v1** — the "Prayed" tap must reach the server to cancel the already-scheduled pushes. Add
  `POST /api/push/prayed { endpoint, prayer }` (called from the SW's `notificationclick`, or
  relayed via the page) that writes a `prayed:{endpointHash}:{slug}:{prayer}:{date}` KV marker
  (TTL ~36h); the per-minute cron skips a `jamaat`/`end` send when that marker exists. The SW
  relay is already in place from v0, so this is an additive endpoint + a cron check.

---

## 5. Subscription storage — Cloudflare KV (`PUSH_SUBS`)

KV is already used (`env.RATE_LIMITS`); eventually-consistent reads are fine; access pattern is key lookups + a nightly list. (Flag D1 as the upgrade if we later need "all subs for masjid X" queries or analytics.)

| Key | Value | Purpose |
|---|---|---|
| `sub:{endpointHash}` | subscription record (below) | source of truth, one per device |
| `bucket:{YYYY-MM-DDTHH:mm}` (UTC) | `[{endpointHash, slug, prayer, kind, label}]` | precomputed per-minute send list |
| `sent:{endpointHash}:{slug}:{prayer}:{kind}:{date}` | `1`, TTL ~36h | dedup marker |

`endpointHash` = SHA-256 of the push `endpoint`.

```jsonc
// sub:{endpointHash}
{
  "endpoint": "https://web.push.apple.com/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "slug": "faizul",
  "tz": "Europe/London",
  "prefs": { /* the prefs object from §4 */ },
  "created": 1716200000000,
  "updated": 1716200000000
}
```

---

## 6. Scheduling model

> **v1 ships with the per-minute SCAN model** (`push-scheduler/src/index.js`),
> not the bucket model below. Rationale: one copy of the build logic (in the
> scheduler), correct immediately on subscribe (no nightly rebuild / incremental
> build, no triple-duplicated logic), simplest to reason about at launch scale.
> Each tick lists all `sub:*`, resolves today's reminders to UTC instants, and
> sends any landing in the current minute. Dedup via `sent:*`; suppression via
> `prayed:*`; `404/410` deletes the sub. **Cost:** ~1 KV get per subscription per
> minute → comfortable to ~60 subs on the free tier; beyond that, switch to the
> bucket model below or Workers Paid (1M reads/day). The bucket model remains the
> documented scale upgrade:

### Precomputed minute-buckets (scale upgrade — not built)

**Nightly rebuild** (~00:30 UK, after the lockscreen pipeline commits fresh CSVs):
1. `KV.list({ prefix: "sub:" })` → all subscriptions.
2. Group by `slug`; fetch each masjid CSV **once** (`/data/{slug}.csv`) + `season.json`.
3. For each enabled prayer/kind: read today's row, get the time, apply `lead`, convert `Europe/London`→UTC for that date, floor to the minute, append to `bucket:{minuteUTC}`.
4. Ramadan extras only when `season.json` = ramadan.
5. Write buckets with ~48h TTL.

**Per-minute cron:** read `bucket:{nowMinuteUTC}`; for each entry check the `sent:` marker → send → set marker. Missing bucket = cheap no-op.

- **Precision:** ±60s (acceptable). Cloudflare cron min interval = 1 min.
- **Cost (free tier: 100k reads, 1k writes/day):** ~1,440 reads/day from the cron; writes ≈ daily notifications sent + bucket writes. With "both start & jama'at" + ends-soon, up to ~12–15 pushes/device/day → write count scales with subscribers and approaches the 1k/day ceiling sooner. Mitigations before paying: batch bucket writes; chunk the nightly rebuild across cron ticks to stay under the **50-subrequest/invocation** free-plan cap if subs span >50 distinct masjids. $5/mo Workers Paid lifts both limits massively.

---

## 7. Timezone / DST

- CSV times are **`Europe/London` wall-clock** (what the SPA displays verbatim and what UK users see correctly; provider fetch already did GMT→local). Scheduler interprets each CSV time as London-local **on that date** and converts to UTC using that date's actual offset. Nightly per-date rebuild makes the BST/GMT switch automatic.
- **Non-UK users (v1):** prayer times are tied to the masjid's UK location; the push fires at the **instant** the prayer occurs (a UTC moment), correct regardless of the user's location.
- **Verify before build:** confirm a mawaqit/mymasjid CSV around the 29 Mar 2026 BST switch stores London wall-clock, not GMT-base. If any provider stores GMT in the CSV, add a per-provider offset rule. (Check `providers/*/fetch.py` DST handling.)

---

## 8. Dedup / unsubscribe / privacy

- **Dedup:** `sent:` marker (TTL ~36h) guarantees one push per prayer/kind/device/day even on cron overlap. Overlap rule: if two of a device's reminders resolve to the same minute (e.g. Ramadan Fajr-start vs Suhoor, or Maghrib-start vs Iftar), send **one** (prefer the Ramadan-specific label).
- **Unsubscribe/expiry:** push send returning **404/410 Gone** → delete `sub:{endpointHash}`. Prefs change → `/api/push/update` rewrites the record. Master-off / removal → `/api/push/unsubscribe` + client `pushManager.getSubscription().unsubscribe()`. Buckets are derived state with TTL — no manual cleanup.
- **Privacy:** stored = push endpoint + `p256dh`/`auth` keys + masjid slug + prefs + IANA tz. **No name, email, or precise location.** Endpoint is a bearer secret → hashed for KV keys, kept in private KV (not the public repo). This is the **first server-side per-user state** in an otherwise static/localStorage app — note it in CLAUDE.md. Add a one-line privacy note in the settings notifications section.

---

## 9. VAPID keys

- Generate once: `npx web-push generate-vapid-keys`.
- Cloudflare **secrets** (same pattern as `ANTHROPIC_API_KEY`/`GITHUB_PAT`): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (on the scheduler Worker), `VAPID_SUBJECT` (`mailto:prayerly@hotmail.com`).
- Client gets the public key from `GET /api/push/vapid-public-key` (no hardcoding) before `pushManager.subscribe({ applicationServerKey })`.
- **Sending from a Worker** needs a VAPID JWT (ES256 via WebCrypto — supported) + `aes128gcm` payload encryption. **Vendor a small Workers-compatible Web Push helper** — Node's `web-push` won't run on Workers. ⚠️ Payload encryption is the most error-prone part; test Apple (APNs) and FCM endpoints separately.

---

## 10. Phased rollout

### v0 — "best-effort, app-open" (BUILT on branch `feature/salah-notifications`; zero infra)
- No server / VAPID / KV. Full settings UI (§4) writing to `iqamah-notif-prefs`.
- Foreground scheduler: while the app is open, fires `registration.showNotification(...)` at the right times via `js/utils/prayer-schedule.js` + `js/utils/notifications.js`.
- Branded icon/badge + action buttons (View times / Prayed). `notificationclick` handler in `sw.js`.
- TEMP dev-only "Send test notification" button (remove/gate before merge).
- The app-open caveat note was dropped (Hasan-only on the branch until v1 lands).
- **Validates** copy, settings UX, branding, and the per-prayer/lead model before the hard server work.

### v1 — server push
- Add VAPID, `PUSH_SUBS` KV, the Pages endpoints (`subscribe`/`update`/`unsubscribe`/`vapid-public-key` + `prayed`), `sw.js` `push` handler, the `push-scheduler` Worker (cron + nightly rebuild + 410-cleanup).
- Real permission flow + iOS install gate.
- Migrate v0 localStorage prefs into the subscription record on first subscribe.
- Wire the "Prayed" action to `POST /api/push/prayed` so server-scheduled jama'at/end pushes are cancelled (see §4 Notification actions). SW relay already exists from v0.

### v2 (future, optional)
DO-alarm precision; masjid-initiated announcements (needs query-friendly store); Jummah; "remind in my own local clock" for travellers.

---

## 11. Files

**New**
| File | Purpose |
|---|---|
| `js/views/notifications-settings.js` *(or a section in `settings.js`)* | accordion UI, chips, iOS gate, season-gated Ramadan group |
| `js/utils/notifications.js` | permission, `pushManager.subscribe`, fetch VAPID key, POST `/api/push/*`, prefs persistence, `iqamah-pin-changed` listener |
| `js/utils/prayer-schedule.js` | shared pure helpers (column→time, isAM map, jama'at fallbacks) reused by v0 client + scheduler so logic matches |
| `push-scheduler/wrangler.toml` | cron `* * * * *`, `PUSH_SUBS` binding, VAPID secrets |
| `push-scheduler/src/index.js` | `scheduled()`: per-minute consume + send; nightly rebuild; 410-cleanup |
| `push-scheduler/src/webpush.js` | Workers VAPID JWT + `aes128gcm` payload (vendored) |
| `push-scheduler/src/schedule.js` | CSV fetch/parse + London→UTC bucket builder (mirrors `csv.js`/`prayer-times.js`) |
| `.github/workflows/deploy-scheduler.yml` | `wrangler deploy` on `push-scheduler/**` |

**Changed**
| File | Change |
|---|---|
| `sw.js` | `notificationclick` (View/Prayed actions: open `/{slug}` or relay `iqamah-prayed`) — done in v0; add `push` (showNotification) in v1; bump `APP_VERSION` on merge |
| `_worker.js` | routes `POST /api/push/{subscribe,update,unsubscribe}`, `GET /api/push/vapid-public-key`; reuse `isRateLimited`/`jsonResponse`; add `PUSH_SUBS` binding |
| `js/utils/pwa.js` | export `canUsePush()` = `isStandalone()`/`isIOSSafari()`/`'PushManager' in window` |
| `js/views/settings.js` | mount the Notifications group |
| `CLAUDE.md` | new "Push notifications" section: separate deploy surface, KV namespace, VAPID secrets table, first server-side per-user state, sync-logic hazard |

---

## 12. Cloudflare setup (one-time)

1. **Create KV namespace `PUSH_SUBS`** (Workers & Pages → KV).
2. **Bind `PUSH_SUBS` to the Pages project** (`prayerly` → Settings → Bindings).
3. **Create the `push-scheduler` Worker** (`wrangler deploy`).
4. **Bind `PUSH_SUBS` + Cron Trigger** in `push-scheduler/wrangler.toml` (`[triggers] crons = ["* * * * *"]`).
5. **Add VAPID secrets** (`wrangler secret put VAPID_PRIVATE_KEY` etc.) on the scheduler Worker.

> Pushing to `main` auto-deploys Pages but **not** the scheduler Worker — that's the `deploy-scheduler.yml` action / a manual `wrangler deploy`.

---

## 13. Versioning / deployment rules (from CLAUDE.md)

- **Minor bump** (new feature) — only when merged to `main`, **never on the feature branch.**
- Pre-commit hook auto-bumps `version.json` on main; set `sw.js` `APP_VERSION` to match (sync with `sync_sw_version.yml`). Any `sw.js` change triggers the `controllerchange` reload in `pwa.js` — expected.
- **No `Co-Authored-By: Claude`** on commits in this repo.
- Two deploy surfaces (Pages auto; scheduler manual/Action) — don't ship one and forget the other.

---

## 14. Top risks

1. **Web Push payload encryption on Workers** — hardest, most bug-prone; test Apple + FCM separately; vendored helper, not Node `web-push`.
2. **Two deploy surfaces** — mitigated by the deploy action.
3. **CSV timezone assumption** — verify across the 29 Mar 2026 BST boundary before trusting London→UTC.
4. **iOS reliability** — even installed PWAs throttle/coalesce background pushes; set UI expectations.
5. **Column-logic duplication** — scheduler re-implements `prayer-times.js` mapping; extract shared `prayer-schedule.js` to reduce drift (see CLAUDE.md JS/Python sync hazard).
6. **KV write ceiling** — "both + ends-soon" raises daily writes; batch + chunk before the free-tier 1k/day bites.
