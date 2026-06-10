// Tasbih counter view — preset after-salah cycle (33/33/34) + free counter.
// Full-screen tap area, haptic feedback (opt-out), persisted lifetime total.
// Storage: localStorage 'iqamah-tasbih' (writes are coalesced — not per-tap).

const STORAGE_KEY = 'iqamah-tasbih';
const TAPS_PER_SAVE = 10;   // force a write every N taps
const SAVE_DELAY = 600;     // debounce delay (ms) after the last tap

// Haptic patterns (ms). navigator.vibrate is guarded — iOS Safari degrades silently.
const HAPTIC_TAP = 12;
const HAPTIC_TARGET = [25, 50, 25];
const HAPTIC_CYCLE = [40, 60, 40, 60, 90];

// SVG ring geometry (matches the viewBox in the markup)
const RING_RADIUS = 104;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// The after-salah tasbih cycle — constant, not stored.
const PRESET_CYCLE = [
  { translit: 'SubhanAllah', arabic: 'سُبْحَانَ ٱللَّٰهِ', meaning: 'Glory be to Allah', target: 33 },
  { translit: 'Alhamdulillah', arabic: 'ٱلْحَمْدُ لِلَّٰهِ', meaning: 'All praise is due to Allah', target: 33 },
  { translit: 'Allahu Akbar', arabic: 'ٱللَّٰهُ أَكْبَرُ', meaning: 'Allah is the Greatest', target: 34 },
];

const FREE_TARGET_CHIPS = [33, 99, 100, 0]; // 0 = no target
const DEFAULT_HINT = 'Tap anywhere to count';

const DEFAULTS = {
  mode: 'preset',    // 'preset' | 'free'
  count: 0,          // current count within the active preset segment
  segment: 0,        // index into PRESET_CYCLE
  freeCount: 0,      // free-mode count (kept separate so mode switches are lossless)
  freeTarget: 33,    // free-mode target (0 = no target)
  haptics: true,
  lifetimeTotal: 0,  // grand total across all sessions — never reset by the Reset button
};

const RESET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
const VIBRATE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="m2 8 2 2-2 2 2 2-2 2"/><path d="m22 8-2 2 2 2-2 2 2 2"/><rect width="8" height="14" x="8" y="5" rx="1"/><line class="tasbih-haptic-slash" x1="4" y1="2" x2="20" y2="22"/></svg>';

let state = null;
let els = null;
let tapsSinceSave = 0;
let saveTimer = null;
let advanceTimer = null;
let hintTimer = null;
let celebrateTimer = null;
let resetConfirmTimer = null;
let keyHandler = null;
let visibilityHandler = null;
let pageHideHandler = null;

// ---------- persistence ----------

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function loadState() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* corrupt JSON — fall back */ }
  const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  s.mode = s.mode === 'free' ? 'free' : 'preset';
  s.segment = clampInt(s.segment, 0, PRESET_CYCLE.length - 1, 0);
  s.count = clampInt(s.count, 0, Number.MAX_SAFE_INTEGER, 0);
  s.freeCount = clampInt(s.freeCount, 0, Number.MAX_SAFE_INTEGER, 0);
  s.freeTarget = clampInt(s.freeTarget, 0, 9999, 33);
  s.lifetimeTotal = clampInt(s.lifetimeTotal, 0, Number.MAX_SAFE_INTEGER, 0);
  s.haptics = s.haptics !== false;
  // Normalise stale "segment just completed" state saved mid-advance
  if (s.count >= PRESET_CYCLE[s.segment].target) {
    s.segment = (s.segment + 1) % PRESET_CYCLE.length;
    s.count = 0;
  }
  return s;
}

function saveNow() {
  if (!state) return;
  // Note: a pending segment advance is NOT committed here — saving mid-pause
  // writes the transient "count === target" state, which loadState() normalises
  // to the next segment on the next visit. Committing here would cut the
  // full-ring pause short whenever the every-N-taps save lands on a target.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  tapsSinceSave = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: state.mode,
      count: state.count,
      segment: state.segment,
      freeCount: state.freeCount,
      freeTarget: state.freeTarget,
      haptics: state.haptics,
      lifetimeTotal: state.lifetimeTotal,
    }));
  } catch { /* storage full/unavailable — counting still works in-memory */ }
}

function scheduleSave() {
  if (tapsSinceSave >= TAPS_PER_SAVE) { saveNow(); return; }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY);
}

// ---------- haptics ----------

function hapticsSupported() {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

function buzz(pattern) {
  if (!state || !state.haptics || !hapticsSupported()) return;
  try { navigator.vibrate(pattern); } catch { /* silently degrade */ }
}

// ---------- render ----------

export function render(container) {
  state = loadState();

  const chips = FREE_TARGET_CHIPS.map(v =>
    `<button class="tasbih-chip" data-target="${v}" aria-label="${v === 0 ? 'No target' : `Target ${v}`}">${v === 0 ? '&#8734;' : v}</button>`
  ).join('');

  container.innerHTML = `
    <div class="tasbih-view" id="tasbihView" data-mode="${state.mode}">
      <header class="tasbih-header">
        <h1>Tasbih</h1>
        <button class="tasbih-haptic-btn" id="tasbihHapticBtn" aria-pressed="${state.haptics}" aria-label="Haptic feedback" title="Haptic feedback">${VIBRATE_SVG}</button>
      </header>

      <div class="tasbih-dhikr">
        <div class="tasbih-translit" id="tasbihTranslit"></div>
        <div class="tasbih-arabic" id="tasbihArabic" lang="ar" dir="rtl"></div>
        <div class="tasbih-meaning" id="tasbihMeaning"></div>
        <div class="tasbih-segments" id="tasbihSegments" aria-hidden="true"></div>
      </div>

      <div class="tasbih-stage">
        <div class="tasbih-ring-wrap" id="tasbihRingWrap">
          <svg class="tasbih-ring" viewBox="0 0 232 232" aria-hidden="true">
            <defs>
              <linearGradient id="tasbihRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" class="tasbih-grad-a"/>
                <stop offset="100%" class="tasbih-grad-b"/>
              </linearGradient>
            </defs>
            <circle class="tasbih-ring-track" cx="116" cy="116" r="${RING_RADIUS}"/>
            <circle class="tasbih-ring-progress" id="tasbihRingProgress" cx="116" cy="116" r="${RING_RADIUS}"/>
          </svg>
          <div class="tasbih-ring-inner">
            <div class="tasbih-count" id="tasbihCount">0</div>
            <div class="tasbih-count-target" id="tasbihCountTarget"></div>
          </div>
        </div>
      </div>

      <div class="tasbih-hint" id="tasbihHint">${DEFAULT_HINT}</div>

      <div class="tasbih-free-targets" id="tasbihFreeTargets">
        <span class="tasbih-free-label">Target</span>
        ${chips}
        <input type="number" class="tasbih-chip-input" id="tasbihCustomTarget" inputmode="numeric" min="1" max="9999" placeholder="Custom" aria-label="Custom target">
      </div>

      <div class="tasbih-controls" id="tasbihControls">
        <button class="tasbih-reset-btn" id="tasbihResetBtn">${RESET_SVG}<span>Reset</span></button>
        <div class="tasbih-mode-toggle" id="tasbihModeToggle" data-active="${state.mode}" role="group" aria-label="Counter mode">
          <div class="tasbih-mode-slider"></div>
          <button data-mode="preset" class="${state.mode === 'preset' ? 'active' : ''}">Cycle</button>
          <button data-mode="free" class="${state.mode === 'free' ? 'active' : ''}">Free</button>
        </div>
        <div class="tasbih-total">
          <span class="tasbih-total-label">Total</span>
          <span class="tasbih-total-value" id="tasbihTotal">0</span>
        </div>
      </div>

      <div class="tasbih-ripple" id="tasbihRipple"></div>
    </div>
  `;

  els = {
    view: container.querySelector('#tasbihView'),
    hapticBtn: container.querySelector('#tasbihHapticBtn'),
    translit: container.querySelector('#tasbihTranslit'),
    arabic: container.querySelector('#tasbihArabic'),
    meaning: container.querySelector('#tasbihMeaning'),
    segments: container.querySelector('#tasbihSegments'),
    ringWrap: container.querySelector('#tasbihRingWrap'),
    ringProgress: container.querySelector('#tasbihRingProgress'),
    count: container.querySelector('#tasbihCount'),
    countTarget: container.querySelector('#tasbihCountTarget'),
    hint: container.querySelector('#tasbihHint'),
    freeTargets: container.querySelector('#tasbihFreeTargets'),
    customTarget: container.querySelector('#tasbihCustomTarget'),
    controls: container.querySelector('#tasbihControls'),
    resetBtn: container.querySelector('#tasbihResetBtn'),
    modeToggle: container.querySelector('#tasbihModeToggle'),
    total: container.querySelector('#tasbihTotal'),
    ripple: container.querySelector('#tasbihRipple'),
  };

  els.ringProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;

  bindEvents();
  updateDhikrUI();
  updateCountUI(false);
  updateTotalUI();
  updateHapticUI();
  syncFreeTargetUI();
}

export function destroy() {
  // Flush state before tearing down (a pending advance is normalised on next load)
  if (state) saveNow();

  [saveTimer, advanceTimer, hintTimer, celebrateTimer, resetConfirmTimer].forEach(t => { if (t) clearTimeout(t); });
  saveTimer = advanceTimer = hintTimer = celebrateTimer = resetConfirmTimer = null;
  tapsSinceSave = 0;

  if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; }
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null; }
  if (pageHideHandler) { window.removeEventListener('pagehide', pageHideHandler); pageHideHandler = null; }

  els = null;
  state = null;
}

// ---------- events ----------

function bindEvents() {
  // Full-screen tap area — the whole view counts...
  els.view.addEventListener('pointerdown', onTap);

  // ...except the controls, which swallow the tap before it reaches the view
  const swallow = (e) => e.stopPropagation();
  els.controls.addEventListener('pointerdown', swallow);
  els.freeTargets.addEventListener('pointerdown', swallow);
  els.hapticBtn.addEventListener('pointerdown', swallow);

  // Haptic feedback opt-out — hidden entirely where vibration is unsupported (e.g. iOS Safari)
  if (!hapticsSupported()) {
    els.hapticBtn.style.display = 'none';
  } else {
    els.hapticBtn.addEventListener('click', () => {
      state.haptics = !state.haptics;
      updateHapticUI();
      if (state.haptics) buzz(HAPTIC_TAP); // confirm re-enable with a pulse
      saveNow();
    });
  }

  // Mode toggle: Preset cycle <-> Free counter
  els.modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === state.mode) return;
    setMode(btn.dataset.mode);
  });

  // Reset — double-tap confirm (same pattern as Settings "Reset App")
  els.resetBtn.addEventListener('click', onResetClick);

  // Free-mode target chips
  els.freeTargets.addEventListener('click', (e) => {
    const chip = e.target.closest('.tasbih-chip');
    if (!chip) return;
    state.freeTarget = clampInt(chip.dataset.target, 0, 9999, 33);
    syncFreeTargetUI();
    updateCountUI(false);
    saveNow();
  });

  // Custom target input
  els.customTarget.addEventListener('change', applyCustomTarget);
  els.customTarget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.customTarget.blur();
  });

  // Keyboard counting (desktop): Space or Enter
  keyHandler = (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const t = e.target;
    if (t && t.closest && t.closest('a, button, input, textarea, [contenteditable]')) return;
    e.preventDefault();
    commitPendingAdvance();
    increment();
  };
  window.addEventListener('keydown', keyHandler);

  // Flush pending writes when the page is backgrounded or unloaded
  visibilityHandler = () => { if (document.hidden) saveNow(); };
  document.addEventListener('visibilitychange', visibilityHandler);
  pageHideHandler = () => saveNow();
  window.addEventListener('pagehide', pageHideHandler);
}

function onTap(e) {
  if (e.button > 0) return;     // ignore right/middle click
  if (!e.isPrimary) return;     // ignore extra fingers in a multi-touch
  commitPendingAdvance();
  increment();
  if (typeof e.clientX === 'number') spawnRipple(e.clientX, e.clientY);
}

function onResetClick() {
  const btn = els.resetBtn;
  if (btn.dataset.confirm) {
    delete btn.dataset.confirm;
    btn.classList.remove('tasbih-reset-confirm');
    btn.querySelector('span').textContent = 'Reset';
    if (resetConfirmTimer) { clearTimeout(resetConfirmTimer); resetConfirmTimer = null; }

    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
    if (state.mode === 'preset') {
      state.segment = 0;
      state.count = 0;
      updateDhikrUI();
    } else {
      state.freeCount = 0;
    }
    flashHint('Counter reset', 1200);
    updateCountUI(false);
    saveNow();
    return;
  }
  btn.dataset.confirm = '1';
  btn.classList.add('tasbih-reset-confirm');
  btn.querySelector('span').textContent = 'Confirm?';
  resetConfirmTimer = setTimeout(() => {
    resetConfirmTimer = null;
    if (!els) return;
    delete els.resetBtn.dataset.confirm;
    els.resetBtn.classList.remove('tasbih-reset-confirm');
    els.resetBtn.querySelector('span').textContent = 'Reset';
  }, 3000);
}

function applyCustomTarget() {
  const v = clampInt(els.customTarget.value, 1, 9999, 0);
  if (v > 0) {
    state.freeTarget = v;
    saveNow();
    updateCountUI(false);
  }
  syncFreeTargetUI();
}

// ---------- counting ----------

function increment() {
  state.lifetimeTotal += 1;
  tapsSinceSave += 1;

  if (state.mode === 'preset') {
    const seg = PRESET_CYCLE[state.segment];
    state.count += 1;
    if (state.count >= seg.target) {
      const cycleEnd = state.segment === PRESET_CYCLE.length - 1;
      buzz(cycleEnd ? HAPTIC_CYCLE : HAPTIC_TARGET);
      celebrate();
      flashHint(cycleEnd ? 'Tasbih complete · 100 dhikr' : `${seg.translit} complete`, cycleEnd ? 2000 : 1200);
      // Brief pause on the full ring, then advance. A tap landing inside this
      // window commits the advance first (commitPendingAdvance), so fast,
      // eyes-free tapping never loses a count.
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        advanceSegment();
        scheduleSave();
      }, cycleEnd ? 1000 : 550);
    } else {
      buzz(HAPTIC_TAP);
    }
  } else {
    state.freeCount += 1;
    if (state.freeTarget > 0 && state.freeCount === state.freeTarget) {
      buzz(HAPTIC_TARGET);
      celebrate();
      flashHint('Target reached', 1600);
    } else {
      buzz(HAPTIC_TAP);
    }
  }

  updateCountUI(true);
  updateTotalUI();
  scheduleSave();
}

function advanceSegment() {
  state.segment = (state.segment + 1) % PRESET_CYCLE.length;
  state.count = 0;
  if (els) {
    updateDhikrUI();
    updateCountUI(false);
  }
}

function commitPendingAdvance() {
  if (!advanceTimer) return;
  clearTimeout(advanceTimer);
  advanceTimer = null;
  advanceSegment();
}

function setMode(mode) {
  commitPendingAdvance();
  state.mode = mode;
  els.view.dataset.mode = mode;
  els.modeToggle.dataset.active = mode;
  els.modeToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  updateDhikrUI();
  updateCountUI(false);
  saveNow();
}

// ---------- UI updates ----------

function activeTarget() {
  return state.mode === 'preset' ? PRESET_CYCLE[state.segment].target : state.freeTarget;
}

function activeCount() {
  return state.mode === 'preset' ? state.count : state.freeCount;
}

function updateDhikrUI() {
  if (state.mode === 'preset') {
    const seg = PRESET_CYCLE[state.segment];
    els.translit.textContent = seg.translit;
    els.arabic.textContent = seg.arabic;
    els.meaning.textContent = seg.meaning;
    els.segments.innerHTML = PRESET_CYCLE.map((s, i) => {
      const cls = i === state.segment ? ' tasbih-dot-active' : (i < state.segment ? ' tasbih-dot-done' : '');
      return `<span class="tasbih-dot${cls}" title="${s.translit} ×${s.target}"></span>`;
    }).join('');
  } else {
    els.translit.textContent = 'Free Counter';
    els.arabic.textContent = '';
    els.meaning.textContent = 'Count any dhikr at your own pace';
    els.segments.innerHTML = '';
  }
}

function updateCountUI(pop) {
  const count = activeCount();
  const target = activeTarget();

  els.count.textContent = String(count);

  if (target > 0) {
    els.countTarget.textContent = `/ ${target}`;
    els.countTarget.style.display = '';
    const progress = Math.min(count / target, 1);
    els.ringProgress.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - progress)}`;
    els.ringProgress.style.opacity = '1';
  } else {
    // Free mode with no target — plain counter, no progress
    els.countTarget.style.display = 'none';
    els.ringProgress.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
    els.ringProgress.style.opacity = '0';
  }

  if (pop) {
    els.count.classList.remove('tasbih-count-pop');
    void els.count.offsetWidth; // restart the animation
    els.count.classList.add('tasbih-count-pop');
  }
}

function updateTotalUI() {
  els.total.textContent = state.lifetimeTotal.toLocaleString('en-GB');
}

function updateHapticUI() {
  els.hapticBtn.classList.toggle('tasbih-haptic-off', !state.haptics);
  els.hapticBtn.setAttribute('aria-pressed', String(state.haptics));
  els.hapticBtn.title = state.haptics ? 'Haptic feedback on' : 'Haptic feedback off';
}

function syncFreeTargetUI() {
  const matchesChip = FREE_TARGET_CHIPS.includes(state.freeTarget);
  els.freeTargets.querySelectorAll('.tasbih-chip').forEach(chip => {
    chip.classList.toggle('tasbih-chip-active', Number(chip.dataset.target) === state.freeTarget);
  });
  els.customTarget.classList.toggle('tasbih-chip-active', !matchesChip);
  els.customTarget.value = matchesChip ? '' : String(state.freeTarget);
}

function flashHint(text, ms) {
  els.hint.textContent = text;
  els.hint.classList.add('tasbih-hint-flash');
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintTimer = null;
    if (!els) return;
    els.hint.textContent = DEFAULT_HINT;
    els.hint.classList.remove('tasbih-hint-flash');
  }, ms);
}

function celebrate() {
  els.ringWrap.classList.remove('tasbih-ring-celebrate');
  void els.ringWrap.offsetWidth;
  els.ringWrap.classList.add('tasbih-ring-celebrate');
  if (celebrateTimer) clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => {
    celebrateTimer = null;
    if (els) els.ringWrap.classList.remove('tasbih-ring-celebrate');
  }, 700);
}

function spawnRipple(x, y) {
  const rect = els.view.getBoundingClientRect();
  els.ripple.style.left = `${x - rect.left}px`;
  els.ripple.style.top = `${y - rect.top}px`;
  els.ripple.classList.remove('tasbih-ripple-go');
  void els.ripple.offsetWidth;
  els.ripple.classList.add('tasbih-ripple-go');
}
