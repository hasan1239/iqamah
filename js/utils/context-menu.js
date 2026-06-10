// Reusable context menu — bottom sheet on touch devices, anchored popover on
// desktop. One menu at a time. The module owns its document-level listeners
// (Escape key) and removes them on close; views should still call
// closeContextMenu() in destroy() so a menu never outlives its view.
//
// Usage:
//   openContextMenu({
//     title: 'Masjid Aisha',
//     anchor: kebabButtonEl,        // optional — popover anchors to this on desktop
//     items: [
//       { icon: SVG_STRING, label: 'Set as My Masjid', checked: true, disabled: true, onSelect: fn },
//       { icon: SVG_STRING, label: 'Unfollow', onSelect: fn },
//     ],
//   });

let active = null; // { backdrop, panel, onKeyDown }

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>';

function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export function openContextMenu({ title = '', items = [], anchor = null } = {}) {
  closeContextMenu();

  const asSheet = isTouchDevice() || !anchor;

  // Backdrop — captures outside taps/clicks. Dimmed for the sheet,
  // transparent for the popover.
  const backdrop = document.createElement('div');
  backdrop.className = 'ctx-backdrop' + (asSheet ? '' : ' ctx-transparent');

  const panel = document.createElement('div');
  panel.className = asSheet ? 'ctx-sheet' : 'ctx-popover';
  panel.setAttribute('role', 'menu');
  if (title) panel.setAttribute('aria-label', title);

  panel.innerHTML = `
    ${asSheet ? '<div class="ctx-grabber"></div>' : ''}
    ${title ? `<div class="ctx-title">${title}</div>` : ''}
    ${items.map((item, i) => `
      <button type="button" class="ctx-item${item.disabled ? ' disabled' : ''}" data-ctx-index="${i}" role="menuitem"${item.disabled ? ' aria-disabled="true"' : ''}>
        ${item.icon ? `<span class="ctx-item-icon">${item.icon}</span>` : ''}
        <span class="ctx-item-label">${item.label}</span>
        ${item.checked ? `<span class="ctx-check">${CHECK_SVG}</span>` : ''}
      </button>`).join('')}
  `;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeContextMenu();
    }
  };

  backdrop.addEventListener('click', closeContextMenu);
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-item');
    if (!btn || btn.classList.contains('disabled')) return;
    e.preventDefault();
    e.stopPropagation();
    const item = items[parseInt(btn.dataset.ctxIndex, 10)];
    closeContextMenu();
    if (item && typeof item.onSelect === 'function') item.onSelect();
  });
  document.addEventListener('keydown', onKeyDown, true);

  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  // Position the popover near its anchor, clamped to the viewport.
  if (!asSheet) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    // Render invisibly first so we can measure.
    panel.style.visibility = 'hidden';
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = rect.right - pw; // right-align to the anchor (kebab sits at row end)
    let top = rect.bottom + 6;
    if (left < margin) left = Math.min(rect.left, window.innerWidth - pw - margin);
    if (left < margin) left = margin;
    if (top + ph > window.innerHeight - margin) top = rect.top - ph - 6; // flip above
    if (top < margin) top = margin;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = '';
  }

  requestAnimationFrame(() => {
    backdrop.classList.add('visible');
    panel.classList.add('visible');
  });

  // Focus the first enabled item for keyboard users.
  const firstItem = panel.querySelector('.ctx-item:not(.disabled)');
  if (firstItem && !isTouchDevice()) firstItem.focus({ preventScroll: true });

  active = { backdrop, panel, onKeyDown };
}

export function closeContextMenu() {
  if (!active) return;
  const { backdrop, panel, onKeyDown } = active;
  active = null;
  document.removeEventListener('keydown', onKeyDown, true);
  backdrop.classList.remove('visible');
  panel.classList.remove('visible');
  setTimeout(() => {
    backdrop.remove();
    panel.remove();
  }, 250);
}

export function isContextMenuOpen() {
  return active !== null;
}
