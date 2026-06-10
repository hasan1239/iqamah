// Eid Greeting Card view — personalise an "Eid Mubarak" card and share it to WhatsApp.
// Client-side Canvas 2D port of templates/eid_mubarak.html (purple/gold, string
// lights, lanterns, gold crescent, Arabic dua, Iqamah watermark).

const CARD_SIZE = 1080;
const FILE_NAME = 'eid_mubarak_iqamah.png';
const MAX_NAME_LEN = 40;

const ARABIC_DUA = 'تَقَبَّلَ اللهُ مِنَّا وَمِنكُم';
const DUA_TRANSLITERATION = 'Taqabbalallahu minna wa minkum';

const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

// Static sparkle field (x/y as fractions of the canvas, r in px, a = alpha)
const SPARKLES = [
  { x: 0.15, y: 0.35, r: 4, a: 0.45 }, { x: 0.80, y: 0.25, r: 4, a: 0.40 },
  { x: 0.25, y: 0.70, r: 4, a: 0.35 }, { x: 0.70, y: 0.65, r: 4, a: 0.45 },
  { x: 0.50, y: 0.16, r: 3, a: 0.40 }, { x: 0.10, y: 0.55, r: 3, a: 0.35 },
  { x: 0.85, y: 0.50, r: 4, a: 0.40 }, { x: 0.40, y: 0.82, r: 3, a: 0.35 },
  { x: 0.60, y: 0.45, r: 3, a: 0.30 }, { x: 0.35, y: 0.13, r: 3, a: 0.40 },
  { x: 0.92, y: 0.40, r: 3, a: 0.35 }, { x: 0.05, y: 0.75, r: 3, a: 0.35 },
  { x: 0.45, y: 0.30, r: 2, a: 0.30 }, { x: 0.75, y: 0.80, r: 3, a: 0.35 },
  { x: 0.20, y: 0.50, r: 2, a: 0.30 }, { x: 0.66, y: 0.20, r: 2, a: 0.35 },
  { x: 0.30, y: 0.42, r: 2, a: 0.25 }, { x: 0.88, y: 0.68, r: 3, a: 0.35 },
  { x: 0.12, y: 0.22, r: 3, a: 0.35 }, { x: 0.55, y: 0.74, r: 2, a: 0.30 },
];

// Bulbs along the string lights (template coords, 540-wide space)
const BULBS_BRIGHT = [
  [30, 8], [67, 22], [100, 18], [135, 10], [170, 5], [200, 8], [235, 14],
  [270, 15], [305, 18], [337, 22], [370, 15], [405, 10], [440, 5], [472, 4], [510, 3],
];
const BULBS_DIM = [
  [50, 18], [120, 20], [190, 6], [260, 16], [330, 24], [400, 18], [460, 8],
];

// Lanterns: x = left edge in template 540-space, top, displayed width (540-space),
// cord length in lantern-local units (viewBox is 30 wide), opacity, tilt in degrees
const LANTERNS = [
  { x: 20,  top: 11, w: 24, cord: 30, op: 1.0, tilt: -2.5 },
  { x: 75,  top: 17, w: 20, cord: 42, op: 0.5, tilt: 2 },
  { x: 140, top: 12, w: 18, cord: 35, op: 0.4, tilt: -1.5 },
  { x: 382, top: 18, w: 18, cord: 30, op: 0.4, tilt: 2 },
  { x: 445, top: 13, w: 20, cord: 38, op: 0.5, tilt: -2 },
  { x: 496, top: 6,  w: 24, cord: 22, op: 1.0, tilt: 1.5 },
];

let renderToken = 0;
let canvasEl = null;
let inputEl = null;
let statusEl = null;
let iconImage = null;       // HTMLImageElement | null once loaded
let crescentLayer = null;   // cached offscreen canvas
let currentName = '';

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function render(container, params) {
  const token = ++renderToken;

  container.innerHTML = `
    <div class="eid-greeting-view">
      <header class="eid-greeting-header">
        <h1>Eid Greeting Card</h1>
        <p class="eid-greeting-sub">Personalise an Eid Mubarak card and share it with family and friends</p>
      </header>

      <div class="eid-card-preview">
        <canvas class="eid-card-canvas" id="eidCardCanvas" width="${CARD_SIZE}" height="${CARD_SIZE}" aria-label="Eid Mubarak greeting card preview"></canvas>
      </div>

      <div class="eid-card-controls">
        <label class="eid-card-label" for="eidCardFrom">From (optional)</label>
        <input class="eid-card-input" id="eidCardFrom" type="text"
               maxlength="${MAX_NAME_LEN}" autocomplete="off" spellcheck="false"
               placeholder="e.g. the Khan family">
        <p class="eid-card-hint">Appears on the card as &ldquo;From the Khan family&rdquo; &mdash; leave blank for no name.</p>

        <div class="eid-card-actions">
          <button class="btn-primary eid-card-btn" id="eidCardShare">${SHARE_SVG}Share</button>
          <button class="btn-secondary eid-card-btn" id="eidCardDownload">${DOWNLOAD_SVG}Download</button>
        </div>
        <p class="eid-card-status" id="eidCardStatus" role="status"></p>
      </div>
    </div>`;

  canvasEl = container.querySelector('#eidCardCanvas');
  inputEl = container.querySelector('#eidCardFrom');
  statusEl = container.querySelector('#eidCardStatus');
  currentName = '';

  // First paint straight away (system-font fallback), then redraw once the
  // display fonts and the watermark icon are ready.
  drawCard(canvasEl, currentName);

  inputEl.addEventListener('input', () => {
    currentName = sanitiseName(inputEl.value);
    drawCard(canvasEl, currentName);
  });

  container.querySelector('#eidCardShare').addEventListener('click', (e) => {
    handleShare(e.currentTarget);
  });
  container.querySelector('#eidCardDownload').addEventListener('click', (e) => {
    handleDownload(e.currentTarget);
  });

  await loadAssets();
  if (token !== renderToken || !canvasEl || !canvasEl.isConnected) return;
  drawCard(canvasEl, currentName);
}

export function destroy() {
  renderToken++;
  canvasEl = null;
  inputEl = null;
  statusEl = null;
}

// ---------------------------------------------------------------------------
// Input sanitisation
// ---------------------------------------------------------------------------

function sanitiseName(raw) {
  return (raw || '')
    .replace(/[\u0000-\u001f<>]/g, '')  // strip control chars + angle brackets
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME_LEN)
    .trim();
}

// ---------------------------------------------------------------------------
// Asset loading (fonts + watermark icon)
// ---------------------------------------------------------------------------

async function loadAssets() {
  const wanted = [
    '700 92px Cinzel',
    '600 46px Cinzel',
    '400 56px Amiri',
    'italic 400 35px Lato',
    '400 27px Lato',
  ];
  const loads = wanted.map((f) => document.fonts.load(f).catch(() => {}));
  loads.push(loadIcon());
  // Don't block the preview forever if a font CDN stalls
  await Promise.race([
    Promise.all(loads),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
}

function loadIcon() {
  if (iconImage) return Promise.resolve(iconImage);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { iconImage = img; resolve(img); };
    img.onerror = () => resolve(null);  // watermark text still renders
    img.src = '/iqamah-icon-transparent.png';
  });
}

// ---------------------------------------------------------------------------
// Card drawing — 1080x1080, ported from templates/eid_mubarak.html (540-space x2)
// ---------------------------------------------------------------------------

function drawCard(canvas, fromName) {
  const ctx = canvas.getContext('2d');
  const W = CARD_SIZE;
  const cx = W / 2;

  ctx.save();
  ctx.clearRect(0, 0, W, W);

  drawBackground(ctx, W);
  drawVignette(ctx, W, cx);
  drawSparkles(ctx, W);
  drawStringLights(ctx);
  for (const l of LANTERNS) {
    drawLantern(ctx, l.x * 2, l.top * 2, l.w * 2, l.cord, l.op, (l.tilt * Math.PI) / 180);
  }
  drawCrescent(ctx, cx, 352);
  drawText(ctx, cx, fromName);
  drawWatermark(ctx, cx);

  ctx.restore();
}

function drawBackground(ctx, W) {
  // Deep purple vertical gradient (matches the HTML template body)
  const g = ctx.createLinearGradient(0, 0, 0, W);
  g.addColorStop(0, '#1a1028');
  g.addColorStop(0.3, '#2a1a3a');
  g.addColorStop(0.6, '#1e1230');
  g.addColorStop(1, '#150d20');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, W);

  // Soft gold aura behind the crescent
  const aura = ctx.createRadialGradient(W / 2, 360, 0, W / 2, 360, 400);
  aura.addColorStop(0, 'rgba(212,175,55,0.12)');
  aura.addColorStop(1, 'rgba(212,175,55,0)');
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, W, W);
}

function drawVignette(ctx, W, cx) {
  const v = ctx.createRadialGradient(cx, cx, W * 0.38, cx, cx, W * 0.74);
  v.addColorStop(0, 'rgba(10,5,18,0)');
  v.addColorStop(1, 'rgba(10,5,18,0.32)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, W);
}

function drawSparkles(ctx, W) {
  ctx.save();
  for (const s of SPARKLES) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = '#d4af37';
    ctx.shadowColor = 'rgba(212,175,55,0.8)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * W, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStringLights(ctx) {
  ctx.save();
  ctx.lineCap = 'round';

  // Two sagging wires across the top (template paths, 540-space x2)
  ctx.strokeStyle = '#c9a227';
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(134, 70, 270, 30);
  ctx.quadraticCurveTo(404, -10, 540, 30);
  ctx.quadraticCurveTo(674, 70, 810, 30);
  ctx.quadraticCurveTo(944, -10, 1080, 0);
  ctx.stroke();

  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(160, 80, 320, 36);
  ctx.quadraticCurveTo(480, -4, 640, 36);
  ctx.quadraticCurveTo(800, 76, 960, 30);
  ctx.quadraticCurveTo(1040, 10, 1080, 0);
  ctx.stroke();

  // Bright bulbs with a warm glow
  ctx.shadowColor = 'rgba(240,208,96,0.9)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#f0d060';
  BULBS_BRIGHT.forEach(([x, y], i) => {
    ctx.globalAlpha = [0.7, 0.8, 0.6][i % 3];
    ctx.beginPath();
    ctx.arc(x * 2, y * 2, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Dimmer secondary bulbs
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#d4af37';
  BULBS_DIM.forEach(([x, y], i) => {
    ctx.globalAlpha = i % 2 ? 0.5 : 0.45;
    ctx.beginPath();
    ctx.arc(x * 2, y * 2, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();
}

// One hanging lantern. Local units follow the template's 30-wide viewBox:
// cord from y=0 to y=cord, cap at y=cord-2, body from y=cord to y=cord+38.
function drawLantern(ctx, x, top, w, cord, opacity, tilt) {
  const s = w / 30;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(x + w / 2, top);
  ctx.rotate(tilt);
  ctx.scale(s, s);
  ctx.translate(-15, 0);

  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.lineTo(15, cord);
  ctx.stroke();

  // Cap
  ctx.fillStyle = '#c9a227';
  ctx.fillRect(10, cord - 2, 10, 4);

  // Body — rounded shoulders, round-bottomed
  const b = cord + 2;
  ctx.beginPath();
  ctx.moveTo(7, b + 2);
  ctx.quadraticCurveTo(7, b, 9, b);
  ctx.lineTo(21, b);
  ctx.quadraticCurveTo(23, b, 23, b + 2);
  ctx.lineTo(23, b + 28);
  ctx.quadraticCurveTo(23, b + 36, 15, b + 36);
  ctx.quadraticCurveTo(7, b + 36, 7, b + 28);
  ctx.closePath();
  ctx.fillStyle = 'rgba(212,175,55,0.12)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Inner glow
  const gy = b + 16;
  ctx.fillStyle = 'rgba(212,175,55,0.25)';
  ctx.beginPath();
  ctx.ellipse(15, gy, 4, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(240,208,96,0.35)';
  ctx.shadowColor = 'rgba(240,208,96,0.8)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.ellipse(15, gy, 2, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Build the crescent on an offscreen layer (so the punched-out hole doesn't
// erase the background), then composite it with a soft gold glow.
function buildCrescentLayer() {
  const size = 520;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const mid = size / 2;
  const R = 190;

  const g = ctx.createLinearGradient(mid - R, mid - R, mid + R, mid + R);
  g.addColorStop(0, '#f4d97a');
  g.addColorStop(0.5, '#d4af37');
  g.addColorStop(1, '#a8821c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(mid, mid, R, 0, Math.PI * 2);
  ctx.fill();

  // Punch the offset circle out — horns point to the upper right
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(mid + 62, mid - 58, 158, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  return c;
}

function drawCrescent(ctx, cx, cy) {
  if (!crescentLayer) crescentLayer = buildCrescentLayer();
  const half = crescentLayer.width / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-10 * Math.PI) / 180);

  ctx.shadowColor = 'rgba(212,175,55,0.55)';
  ctx.shadowBlur = 60;
  ctx.drawImage(crescentLayer, -half, -half);
  ctx.shadowBlur = 0;

  // Companion star in the crescent's embrace
  ctx.fillStyle = '#f0d060';
  ctx.shadowColor = 'rgba(240,208,96,0.9)';
  ctx.shadowBlur = 18;
  star4(ctx, 92, -92, 30);
  ctx.fill();
  ctx.shadowBlur = 10;
  ctx.globalAlpha = 0.85;
  star4(ctx, 152, -28, 12);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(40, -160, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Four-point sparkle star with concave sides
function star4(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.closePath();
}

// Shrink the font size until the text fits maxWidth. Returns the size used.
function fitFont(ctx, text, weightStyle, baseSize, family, maxWidth) {
  let size = baseSize;
  while (size > 18) {
    ctx.font = `${weightStyle} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function drawText(ctx, cx, fromName) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Headline — Cinzel, gold gradient, soft glow then crisp pass
  fitFont(ctx, 'Eid Mubarak!', '700', 92, "Cinzel, 'Times New Roman', serif", 960);
  const titleY = 668;
  const tg = ctx.createLinearGradient(0, titleY - 80, 0, titleY + 10);
  tg.addColorStop(0, '#f2d56b');
  tg.addColorStop(1, '#c9921e');
  ctx.fillStyle = tg;
  ctx.shadowColor = 'rgba(212,175,55,0.45)';
  ctx.shadowBlur = 36;
  ctx.fillText('Eid Mubarak!', cx, titleY);
  ctx.shadowBlur = 0;
  ctx.fillText('Eid Mubarak!', cx, titleY);

  // Arabic dua — Amiri (canvas applies full shaping/bidi)
  ctx.save();
  ctx.direction = 'rtl';
  ctx.font = "400 56px Amiri, 'Traditional Arabic', serif";
  ctx.fillStyle = 'rgba(222,189,92,0.92)';
  ctx.fillText(ARABIC_DUA, cx, 786);
  ctx.restore();

  // Transliteration — Lato italic
  ctx.font = "italic 400 35px Lato, 'Segoe UI', sans-serif";
  ctx.fillStyle = 'rgba(212,175,55,0.65)';
  ctx.fillText(DUA_TRANSLITERATION, cx, 848);

  // Optional from-line with an ornamental divider
  if (fromName) {
    const divY = 910;
    ctx.strokeStyle = 'rgba(212,175,55,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 150, divY);
    ctx.lineTo(cx - 28, divY);
    ctx.moveTo(cx + 28, divY);
    ctx.lineTo(cx + 150, divY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(212,175,55,0.7)';
    ctx.save();
    ctx.translate(cx, divY);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-6, -6, 12, 12);
    ctx.restore();

    // Don't double up if the user already typed "From ..."
    const line = /^from\s/i.test(fromName) ? fromName : `From ${fromName}`;
    fitFont(ctx, line, '600', 46, "Cinzel, 'Times New Roman', serif", 920);
    ctx.fillStyle = '#e9cf6f';
    ctx.shadowColor = 'rgba(212,175,55,0.35)';
    ctx.shadowBlur = 20;
    ctx.fillText(line, cx, 974);
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

function drawWatermark(ctx, cx) {
  ctx.save();
  const text = 'iqamah.co.uk';
  ctx.font = "400 27px Lato, 'Segoe UI', sans-serif";
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const iconSize = iconImage ? 42 : 0;
  const gap = iconImage ? 12 : 0;
  const textW = ctx.measureText(text).width;
  const totalW = iconSize + gap + textW;
  const startX = cx - totalW / 2;
  const midY = 1022;

  if (iconImage) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(iconImage, startX, midY - iconSize / 2, iconSize, iconSize);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(212,175,55,0.55)';
  ctx.fillText(text, startX + iconSize + gap, midY);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Share / Download
// ---------------------------------------------------------------------------

function getCardBlob() {
  return new Promise((resolve, reject) => {
    if (!canvasEl) { reject(new Error('No canvas')); return; }
    canvasEl.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not create image'))),
      'image/png'
    );
  });
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg || '';
}

function trackEvent(path) {
  if (window.goatcounter) {
    window.goatcounter.count({ path, event: true });
  }
}

async function handleShare(btn) {
  btn.disabled = true;
  setStatus('Preparing your card…');
  try {
    const blob = await getCardBlob();
    const file = new File([blob], FILE_NAME, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      trackEvent('/eid-card/share');
      try {
        await navigator.share({ files: [file], title: 'Eid Mubarak' });
        setStatus('');
      } catch (err) {
        // User cancelling the share sheet is not an error
        if (err && err.name !== 'AbortError') {
          triggerDownload(blob);
          setStatus('Sharing failed, so the card has been downloaded instead.');
        } else {
          setStatus('');
        }
      }
    } else {
      trackEvent('/eid-card/share-fallback');
      triggerDownload(blob);
      setStatus('Sharing is not supported on this device, so the card has been downloaded instead.');
    }
  } catch (err) {
    setStatus('Sorry, something went wrong creating the image.');
  } finally {
    btn.disabled = false;
  }
}

async function handleDownload(btn) {
  btn.disabled = true;
  setStatus('Preparing your card…');
  try {
    const blob = await getCardBlob();
    trackEvent('/eid-card/download');
    triggerDownload(blob);
    setStatus('');
  } catch (err) {
    setStatus('Sorry, something went wrong creating the image.');
  } finally {
    btn.disabled = false;
  }
}

function triggerDownload(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
