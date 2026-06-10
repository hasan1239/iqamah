# Tasbih Counter — Spec

**Status:** Planning (not built) — design finalised. Last updated 2026-05-22.
**Owner:** Hasan. This file is the single source of truth — update it as decisions change.

---

## 1. Goal

A digital tasbih (dhikr counter): a big tap target that increments a count, with haptic feedback, target rings (e.g. 33 / 99 / custom), preset adhkar, and a persisted lifetime total. Small, self-contained, expected in "Islamic lifestyle" apps (Athan, Sadiq). Pure client-side.

## 2. Scope decisions (decided)

- **Client-only**, all state in `localStorage`. No backend.
- **Preset dhikr cycle** for after-salah tasbih: SubhanAllah ×33 → Alhamdulillah ×33 → Allahu Akbar ×34 (auto-advances at each target, light haptic at target, stronger haptic at cycle end). Plus a **free counter** mode with a user-set target.
- **Haptics:** `navigator.vibrate()` (already used in `js/views/masjids.js`). Short pulse per tap (opt-out toggle), distinct pulse on reaching a target. iOS Safari ignores `vibrate` silently — that's fine, no error.
- **Full-screen tap area (decided)** — tap anywhere to count, controls pinned to the bottom; usable one-handed, eyes-free. Volume-key counting is **not** possible on web — out of scope.
- **One preset cycle + free mode in v1 (decided)** — the after-salah cycle (33/33/34) plus a free counter with a custom target. A multi-preset library (Astaghfirullah ×100, Salawat, etc.) is **v2**.
- **Resume mid-cycle (decided)** — persist `segment` + `count` so closing/reopening continues where you left off (not always-fresh).
- **No per-tap sound (decided)** — haptics only; web audio per tap is janky.

---

## 3. Where it lives (navigation)

Primary access is a **tile in the More hub** (see [more-hub-spec.md](more-hub-spec.md) — add one `FEATURES` entry). Also:
- **Settings → Tools group** link ("Tasbih").
- Dedicated `/tasbih` page.

---

## 4. UI

```
┌──────────────────────────────────────┐
│            SubhanAllah                │   ← current dhikr (preset mode)
│            سُبْحَانَ ٱللَّٰه               │   ← Arabic (Amiri font — allowed for Arabic)
│                                       │
│                 12                    │   ← big count
│              ───── / 33               │   ← progress ring + target
│                                       │
│   [ tap anywhere to count ]           │
│                                       │
│  ↺ Reset      ⚙ Mode      Total 1,240 │
└──────────────────────────────────────┘
```
- **Count** large and central; progress ring fills toward target.
- **Arabic** rendered in **Amiri** (the one place Amiri is allowed in the SPA, like Hijri lines); transliteration + count in **Lato**.
- **Mode toggle:** Preset cycle ↔ Free counter (set any target, or no target).
- **Reset** zeroes the current count (confirm tap, like settings "Reset" double-tap pattern). Lifetime total is separate and persists.
- Opaque card/background; light/night/dark theme support.
- Prevent the tap area from triggering text selection / double-tap zoom.

---

## 5. Data model

### localStorage `iqamah-tasbih`
```jsonc
{
  "mode": "preset",            // "preset" | "free"
  "count": 12,                 // current count in the active dhikr/segment
  "segment": 0,                // index into preset cycle (0=SubhanAllah,1=Alhamdulillah,2=AllahuAkbar)
  "freeTarget": 33,            // target in free mode (0 = no target)
  "haptics": true,
  "lifetimeTotal": 1240        // grand total across all sessions
}
```
- Preset cycle is a constant in code (not stored): `[{ar, translit, target:33}, …, {target:34}]`.
- Increment writes are debounced/coalesced before persisting (don't hit `localStorage` on every single tap at speed — write on idle / on blur / every N taps).

---

## 6. Files

**New**
| File | Purpose |
|---|---|
| `js/views/tasbih.js` | `/tasbih` page: tap handling, ring, mode toggle, reset, persistence |

**Changed**
| File | Change |
|---|---|
| `js/router.js` | add `clean === 'tasbih'` → `{ view: 'tasbih' }` in `resolvePath` (before single-segment-slug fallback) |
| `js/app.js` | add `'tasbih': () => import('./views/tasbih.js')` to `moduleMap` |
| `js/nav.js` | add `tasbih` to `TAB_INDEX` |
| `js/views/settings.js` | add "Tasbih" link (Tools group) + optional "Haptic feedback" toggle |
| `_worker.js` | ensure `/tasbih` serves the SPA shell on hard refresh (match existing named-route handling) |
| `css` | `.tasbih-*` styles, progress ring (SVG or conic-gradient), tap-area, Amiri for Arabic |

---

## 7. Resolved decisions

1. **Tap target** — ✅ **Full-screen tap area**, controls pinned bottom.
2. **Presets** — ✅ **One after-salah cycle (33/33/34) + free mode** in v1; preset library is v2.
3. **Resume mid-cycle** — ✅ persist `segment` + `count`.
4. **Sound** — ✅ none; haptics only (opt-out toggle).

### Still to confirm
- v2 preset library contents (which adhkar + counts) — settle when v2 is scheduled.

---

## 8. Versioning / rules (from CLAUDE.md)

- **Minor bump** on merge to `main` only.
- Amiri permitted for Arabic dhikr; everything else Lato. No Cinzel in the SPA.
- Opaque backgrounds.
