// 404 Not Found view

export function render(container) {
  container.innerHTML = `
    <div class="not-found">
      <div class="not-found-code">404</div>
      <p class="not-found-message">This page could not be found.<br>The masjid you're looking for may not exist yet.</p>
      <a href="/" class="not-found-link" data-link>Go Home</a>
    </div>
  `;
}

export function destroy() {}
