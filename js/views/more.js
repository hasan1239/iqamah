// "More" hub view — a grid of feature tiles driven by the FEATURES registry.
import { FEATURES } from '../features.js';
import { navigate } from '../router.js';

let clickHandler = null;

function tileHTML(f) {
  const disabled = !f.enabled;
  const badge = f.badge
    ? `<span class="beta-badge more-tile-badge">${f.badge}</span>`
    : '';
  const desc = f.desc ? `<span class="more-tile-desc">${f.desc}</span>` : '';

  return `
    <a class="more-tile${disabled ? ' more-tile-disabled' : ''}"
       href="${disabled ? '#' : f.route}"
       data-route="${f.route}"
       data-enabled="${f.enabled ? '1' : '0'}"
       ${disabled ? 'aria-disabled="true"' : 'data-link'}>
      <span class="more-tile-icon">${f.icon}</span>
      <span class="more-tile-label">${f.label}${badge}</span>
      ${desc}
    </a>`;
}

export function render(container) {
  const tiles = FEATURES
    .filter(f => (typeof f.show === 'function' ? f.show() : true))
    .map(tileHTML)
    .join('');

  container.innerHTML = `
    <div class="more-view">
      <header class="more-header">
        <h1>More</h1>
      </header>
      <div class="more-grid">
        ${tiles}
      </div>
    </div>`;

  clickHandler = (e) => {
    const tile = e.target.closest('.more-tile');
    if (!tile) return;
    e.preventDefault();
    if (tile.dataset.enabled !== '1') return; // SOON tiles don't navigate
    navigate(tile.dataset.route);
  };
  container.querySelector('.more-grid').addEventListener('click', clickHandler);
}

export function destroy() {
  clickHandler = null;
}
