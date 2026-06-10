# Follow Multiple Masjids — Spec

**Status:** Planning (not built) — design finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

Let a user **follow several masjids** (home, work, Jummah) instead of just one, surface them in a **"Your Masjids"** section on Home, and keep one as the **primary** ("My Masjid") that drives the hero card and the Times tab. myMasjid allows following up to 5 with a primary; this brings Iqamah to parity while reusing patterns already in the app.

## 2. Current state (what exists today)

- **Single pin:** `iqamah-pinned-masjid` (one slug). Set via the star button / long-press in `js/views/masjids.js` (`togglePin`), shown as the **hero "My Masjid"** card in `js/views/home.js` (`renderHero`), and used by the **Times tab** in `js/nav.js` (`getTimesPath`). Changes broadcast via the `iqamah-pin-changed` CustomEvent (home, masjids, settings all listen).
- **Recently Viewed already exists:** `iqamah-recent-masjids` (array of slugs), rendered as the `.recent-section` block on Home (`renderRecentlyViewed`, home.js:644), showing up to 3, excluding the pinned one. **This is the section pattern to clone for "Your Masjids."**

## 3. Scope decisions (decided)

- **Followed set** = `iqamah-followed-masjids` (array of slugs, ordered). **Cap at 5** (like myMasjid).
- **Primary** stays `iqamah-pinned-masjid` (one slug, always also a member of the followed set). Reuse the existing key so the hero card, Times tab, and `iqamah-pin-changed` plumbing keep working unchanged.
- **Migration:** on first load after release, if `iqamah-pinned-masjid` exists and `iqamah-followed-masjids` doesn't, seed `followed = [pinned]`. (Follows the existing migration pattern in `js/app.js`.)
- **Star = follow/unfollow** (favourite). Setting primary happens via a **long-press context menu** (see §4). This re-purposes the current star (which today toggles the single pin) and the current long-press (which today pins directly).
- **Zero-UI-friendly:** "Your Masjids" only appears once the user follows ≥1 masjid; never an empty placeholder competing with Recently Viewed.

---

## 4. Interaction model

| Action | Result |
|---|---|
| Tap **star** on a masjid card (masjids list / hero / map popup) | Follow / unfollow (favourite). First follow becomes primary automatically. Filled star = followed. |
| **Long-press** a card (touch) / tap **⋯ kebab** (non-touch) | Open a **context menu** (see below). |
| Unfollow the **primary** | Promote the next followed masjid to primary; if none remain, clear primary. |
| Reach the **cap (5)** | Toast "You can follow up to 5 masjids" — block the 6th. |

### Context menu (long-press / kebab)
A small action sheet (bottom sheet on mobile, popover on desktop):
```
┌──────────────────────────────┐
│  Masjid Aisha                 │
│  ★  Set as My Masjid          │  ← promote to primary (follows if not already)
│  ☆  Follow / Unfollow         │  ← toggle membership (favourite)
│  🕌  View times               │  ← navigate /{slug}
└──────────────────────────────┘
```
- The **primary** is marked among followed with a small **crown / "My Masjid" badge**; in the menu, "Set as My Masjid" is disabled/checked when already primary.
- Long-press is **touch-only**; non-touch gets the **⋯ kebab** on the card opening the identical menu. (Today's `setupLongPress` in `masjids.js` already handles touchstart/vibrate/contextmenu — repurpose it to open the menu instead of pinning directly.)
- All mutations dispatch `iqamah-pin-changed` (kept for back-compat with hero/Times-tab/settings listeners) plus a new `iqamah-follow-changed` event so every view re-renders consistently.

---

## 5. UI

### Home "Your Masjids" section (clone of `.recent-section`)
```
┌─ Your Masjids ───────────────────  Edit › ┐
│ ┌───────────────┐ ┌───────────────┐        │
│ │ ★ Masjid Aisha│ │  Quba Masjid  │  …      │  horizontal scroll, like recently-viewed
│ │ Asr  6:45 PM  │ │ Asr  6:50 PM  │         │  next jama'at per card (reuse loadCardPrayers)
│ │ ★ My Masjid   │ │               │         │  crown/badge marks primary
│ └───────────────┘ └───────────────┘        │
└──────────────────────────────────────────────┘
```
- Render order: **primary first**, then follow order.
- Reuse the `masjid-card` markup + `getNextJamaatFromRow` / `loadRecentCardPrayers` already in `home.js` (no new prayer-loading logic).
- Place **above** Recently Viewed (followed > incidental). Recently Viewed continues to exclude both primary and followed slugs to avoid dupes.

### Settings
- "My Masjid" group becomes **"Your Masjids"**: list followed masjids with a radio/crown to pick primary and a remove (×) per row. Extends the existing `pinnedMasjidSetting` block in `js/views/settings.js`.

---

## 6. Data model

```jsonc
// localStorage
"iqamah-pinned-masjid": "masjid_aisha",                 // primary (unchanged key)
"iqamah-followed-masjids": ["masjid_aisha","quba","central"]  // ordered, primary included, max 5
```
- Helpers (new `js/utils/follow.js`): `getFollowed()`, `isFollowed(slug)`, `follow(slug)`, `unfollow(slug)`, `getPrimary()`, `setPrimary(slug)` — all guard the cap and keep `pinned ∈ followed` invariant, then dispatch events.

---

## 7. Files

**New**
| File | Purpose |
|---|---|
| `js/utils/follow.js` | follow set + primary helpers, invariants, events |
| `js/utils/context-menu.js` | reusable action-sheet/popover (bottom sheet on touch, popover on desktop) used by the card long-press / kebab |

**Changed**
| File | Change |
|---|---|
| `js/views/masjids.js` | star → follow/unfollow via `follow.js`; **repurpose `setupLongPress` to open the context menu** (not pin directly); add ⋯ kebab for non-touch; filled-star = followed; crown/"My Masjid" badge on primary; cap toast |
| `js/views/home.js` | new "Your Masjids" section (clone `renderRecentlyViewed`); exclude followed from Recently Viewed; listen for `iqamah-follow-changed` |
| `js/views/settings.js` | "Your Masjids" group: list, set-primary, remove |
| `js/nav.js` | `getTimesPath()` unchanged (still uses primary `iqamah-pinned-masjid`) — verify no behaviour change |
| `js/app.js` | migration: seed `iqamah-followed-masjids` from existing pinned |
| `css` | `.your-masjids-*` (mostly reuse `.recent-section` / `.masjid-grid`), primary crown/badge, filled-star state |

---

## 8. Resolved decisions

1. **"Your Masjids" section** — ✅ a clone of the existing `.recent-section`, sitting **above** Recently Viewed.
2. **Cap** — ✅ **5** (myMasjid parity).
3. **Star semantics** — ✅ **star = follow/unfollow**; **long-press (touch) / ⋯ kebab (desktop) opens a context menu** to set primary or follow/unfollow. Replaces today's long-press-pins-directly behaviour.

### Still to confirm
- **Map popups** — add the follow star / kebab to map popups for parity? (popup currently links to `/{slug}` only.) Leaning v1.1.
- **Notifications target** — push spec's target defaults to primary; allowing reminders for *all* followed masjids is future v2 (noted in [push-notifications-spec.md](push-notifications-spec.md)).

---

## 9. Versioning / rules (from CLAUDE.md)

- **Minor bump** on merge to `main` only.
- Opaque card backgrounds; Lato only (no Cinzel) in SPA.
- Prefer automatic behaviour (auto-promote next primary, auto-seed migration) over extra prompts.
