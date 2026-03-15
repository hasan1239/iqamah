// Background effects — twinkling stars (dark mode) + golden dust motes (light mode)

export function initBackground() {
  generateStars();
  generateDustMotes();
}

function generateStars() {
  const container = document.getElementById('stars');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 0; i < 60; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    star.style.left = Math.random() * 100 + '%';
    star.style.top = Math.random() * 100 + '%';
    star.style.animationDelay = (Math.random() * 3) + 's';
    star.style.animationDuration = (2 + Math.random() * 2) + 's';
    const size = Math.random() > 0.85 ? 3 : (Math.random() > 0.5 ? 2 : 1);
    star.style.width = size + 'px';
    star.style.height = size + 'px';
    container.appendChild(star);
  }
}

function generateDustMotes() {
  const container = document.getElementById('dustMotes');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 0; i < 60; i++) {
    const mote = document.createElement('div');
    mote.className = 'mote';
    mote.style.left = Math.random() * 100 + '%';
    mote.style.top = Math.random() * 100 + '%';
    mote.style.animationDelay = (Math.random() * 8) + 's';
    mote.style.animationDuration = (6 + Math.random() * 6) + 's';
    const size = 3 + Math.random() * 5;
    mote.style.width = size + 'px';
    mote.style.height = size + 'px';
    container.appendChild(mote);
  }
}
