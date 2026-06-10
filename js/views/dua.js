// Daily Dua view — today's dua large (Arabic + transliteration + English +
// source), share/copy buttons, plus the full browsable collection below.
import { getAllDuas, getTodayDua } from '../utils/duas.js';

const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

let actionsClickHandler = null;
let listClickHandler = null;
let listKeyHandler = null;
let todayTranslitHandler = null;

// Length-aware Arabic sizing tiers. Counted on the diacritic-stripped string
// (harakat roughly double the raw length without adding width). Calibrated
// against the current dataset: most duas are <= 75 stripped chars, a middle
// band sits around 87-118, and Sayyidul Istighfar tops out at 174.
const ARABIC_MEDIUM_FROM = 76;  // stripped chars at/above this -> medium tier
const ARABIC_LONG_FROM = 141;   // stripped chars at/above this -> long tier
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

function arabicSizeClass(arabic) {
  const len = String(arabic || '').replace(ARABIC_DIACRITICS, '').length;
  if (len >= ARABIC_LONG_FROM) return 'dua-arabic-long';
  if (len >= ARABIC_MEDIUM_FROM) return 'dua-arabic-medium';
  return 'dua-arabic-short';
}

// No em dashes in user-facing text. Occasion strings in the dataset may join
// parts with one ("Morning and evening — Sayyidul Istighfar"); the dataset is
// under scholarly review, so rewrite at display time instead of editing it.
function formatOccasion(text) {
  return String(text || '').replace(/\s*[–—]\s*/g, ' · ');
}

function duaBodyHTML(dua) {
  return `
    <div class="dua-arabic ${arabicSizeClass(dua.arabic)}" lang="ar" dir="rtl">${dua.arabic}</div>
    <div class="dua-translit-block">
      <button type="button" class="dua-translit-toggle" aria-expanded="false"><span class="dua-translit-toggle-label">Show transliteration</span>${CHEVRON_SVG}</button>
      <p class="dua-transliteration">${dua.transliteration}</p>
    </div>
    <p class="dua-english">&ldquo;${dua.english}&rdquo;</p>
    <div class="dua-source-line"><span class="dua-source-chip">${dua.source}</span></div>`;
}

function shareText(dua) {
  return `${dua.arabic}\n\n${dua.transliteration}\n\n"${dua.english}"\n(${dua.source})`;
}

function flashLabel(btn, label) {
  const labelEl = btn.querySelector('.dua-btn-label');
  if (!labelEl) return;
  const original = labelEl.textContent;
  labelEl.textContent = label;
  setTimeout(() => { labelEl.textContent = original; }, 2000);
}

async function copyDua(dua, btn) {
  if (!navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(`${shareText(dua)}\n\n${window.location.origin}/dua`);
    flashLabel(btn, 'Copied!');
  } catch (err) { /* clipboard unavailable */ }
}

async function shareDua(dua, btn) {
  if (window.goatcounter) {
    window.goatcounter.count({ path: '/share/dua', title: 'Share - Daily Dua', event: true });
  }
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Dua of the Day - Iqamah',
        text: shareText(dua),
        url: `${window.location.origin}/dua`,
      });
    } catch (err) { /* user cancelled */ }
  } else {
    // No Web Share API (desktop browsers) — fall back to copying.
    await copyDua(dua, btn);
  }
}

function toggleItem(item) {
  const expanded = item.classList.toggle('dua-item-expanded');
  item.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

// Collapsible transliteration — collapsed by default on every visit
// (deliberately not persisted).
function toggleTranslit(btn) {
  const block = btn.closest('.dua-translit-block');
  if (!block) return;
  const open = block.classList.toggle('dua-translit-open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const label = btn.querySelector('.dua-translit-toggle-label');
  if (label) label.textContent = open ? 'Hide transliteration' : 'Show transliteration';
}

export async function render(container) {
  container.innerHTML = `
    <div class="dua-view">
      <header class="dua-header">
        <h1>Daily Dua</h1>
        <p class="dua-subtitle">One authentic dua, every day</p>
      </header>
      <div class="dua-loading">
        <div class="skeleton-bone" style="width:100%;height:260px;border-radius:16px;margin-bottom:28px"></div>
        <div class="skeleton-bone" style="width:100%;height:64px;border-radius:14px;margin-bottom:10px"></div>
        <div class="skeleton-bone" style="width:100%;height:64px;border-radius:14px;margin-bottom:10px"></div>
        <div class="skeleton-bone" style="width:100%;height:64px;border-radius:14px"></div>
      </div>
    </div>`;

  let duas, today;
  try {
    duas = await getAllDuas();
    today = await getTodayDua();
  } catch (err) {
    console.error('Error loading duas:', err);
  }

  const slot = container.querySelector('.dua-loading');
  if (!slot) return; // view was destroyed while loading

  if (!duas || !duas.length || !today) {
    slot.innerHTML = '<div class="dua-error">Could not load the dua collection. Please try again later.</div>';
    return;
  }

  const listHTML = duas.map((d, i) => `
    <div class="dua-item${d.id === today.id ? ' dua-item-today' : ''}"
         role="button" tabindex="0" aria-expanded="false" data-index="${i}">
      <div class="dua-item-row">
        <div class="dua-item-meta">
          <span class="dua-item-occasion">${formatOccasion(d.occasion)}</span>
          <span class="dua-item-snippet">${d.english}</span>
        </div>
        ${d.id === today.id ? '<span class="dua-item-chip">Today</span>' : ''}
        <span class="dua-item-chevron">${CHEVRON_SVG}</span>
      </div>
      <div class="dua-item-full">${duaBodyHTML(d)}</div>
    </div>`).join('');

  slot.outerHTML = `
    <section class="dua-today-card">
      <div class="dua-today-top">
        <span class="dua-today-badge">Dua of the Day</span>
        <span class="dua-occasion">${formatOccasion(today.occasion)}</span>
      </div>
      ${duaBodyHTML(today)}
      <div class="dua-actions">
        <button type="button" class="dua-share-btn" id="duaShareBtn">${SHARE_SVG}<span class="dua-btn-label">Share</span></button>
        <button type="button" class="dua-copy-btn" id="duaCopyBtn">${COPY_SVG}<span class="dua-btn-label">Copy</span></button>
      </div>
    </section>
    <section class="dua-collection">
      <h2 class="dua-collection-title">Full collection <span class="dua-collection-count">(${duas.length})</span></h2>
      <div class="dua-list">${listHTML}</div>
    </section>`;

  // Share / copy actions on the today card
  const actionsEl = container.querySelector('.dua-actions');
  actionsClickHandler = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'duaShareBtn') shareDua(today, btn);
    else if (btn.id === 'duaCopyBtn') copyDua(today, btn);
  };
  if (actionsEl) actionsEl.addEventListener('click', actionsClickHandler);

  // Transliteration toggle on the today card (list items handle theirs in the
  // delegated list click handler below)
  const todayCardEl = container.querySelector('.dua-today-card');
  todayTranslitHandler = (e) => {
    const btn = e.target.closest('.dua-translit-toggle');
    if (btn) toggleTranslit(btn);
  };
  if (todayCardEl) todayCardEl.addEventListener('click', todayTranslitHandler);

  // Expand/collapse items in the collection list
  const listEl = container.querySelector('.dua-list');
  listClickHandler = (e) => {
    const toggle = e.target.closest('.dua-translit-toggle');
    if (toggle) { toggleTranslit(toggle); return; } // don't collapse the item
    const item = e.target.closest('.dua-item');
    if (item) toggleItem(item);
  };
  listKeyHandler = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // The translit toggle is a real <button>; let its native key handling
    // fire the click instead of collapsing the surrounding item.
    if (e.target.closest('.dua-translit-toggle')) return;
    const item = e.target.closest('.dua-item');
    if (!item) return;
    e.preventDefault();
    toggleItem(item);
  };
  if (listEl) {
    listEl.addEventListener('click', listClickHandler);
    listEl.addEventListener('keydown', listKeyHandler);
  }
}

export function destroy() {
  actionsClickHandler = null;
  listClickHandler = null;
  listKeyHandler = null;
  todayTranslitHandler = null;
}
