// Share-card renderer — a 1080x1350 (4:5 portrait) Iqamah-branded image of
// today's prayer times, designed to be forwarded around WhatsApp groups.
//
// Deliberately ALWAYS dark navy/gold branding regardless of the app theme:
// a forwarded card is an advert, and brand recognition beats theme fidelity.
//
// Self-contained artwork: follows the canvas conventions used by
// js/utils/lockscreen-render.js (document.fonts loading, seeded decorations,
// toBlob with a dataURL fallback) but does not import from it — this is a
// separate, simpler composition, not a wallpaper.

import { formatHijriDate } from './hijri.js';

const W = 1080;
const H = 1350;
const PAD = 72;
const CONTENT_W = W - PAD * 2; // 936

// Brand palette (matches the dark v4 lockscreen / site branding)
const C = {
  bgStops: [[0, '#050c18'], [0.45, '#0a1628'], [1, '#0d1f15']],
  radials: [
    { x: W * 0.5, y: -120, rx: 780, ry: 900, colour: '26,74,58', fade: 0.6 },   // teal-green wash, top
    { x: W, y: H * 0.45, rx: 900, ry: 820, colour: '13,45,64', fade: 0.5 },     // blue wash, right
    { x: 0, y: H * 0.85, rx: 900, ry: 900, colour: '26,42,13', fade: 0.5 },     // olive wash, bottom-left
  ],
  pattern: 'rgba(212,175,55,0.03)',
  cream: '#f0e6c8',
  gold: '#d4af37',
  goldBright: '#f5d56a',
  green: '#6ed89a',
  caption: 'rgba(212,175,55,0.7)',
  dateText: 'rgba(240,230,200,0.85)',
  dividerLine: 'rgba(212,175,55,0.5)',
  diamond: 'rgba(212,175,55,0.6)',
  bannerBg: 'rgba(255,255,255,0.04)',
  bannerBorderSehri: 'rgba(212,175,55,0.4)',
  bannerBorderMaghrib: 'rgba(80,180,120,0.35)',
  bannerLabel: 'rgba(240,230,200,0.65)',
  cardBg: 'rgba(255,255,255,0.04)',
  cardBorder: 'rgba(212,175,55,0.25)',
  cardDividerStrong: 'rgba(212,175,55,0.15)',
  cardDividerFaint: 'rgba(212,175,55,0.08)',
  headerCol: 'rgba(212,175,55,0.55)',
  timeStart: 'rgba(240,230,200,0.75)',
  timeName: 'rgba(240,230,200,0.92)',
  sunZawalLabel: 'rgba(240,230,200,0.5)',
  sunZawalTime: 'rgba(240,230,200,0.8)',
  sunZawalDivider: 'rgba(212,175,55,0.25)',
  footerUrl: '#d4af37',
};

// --- Fonts (page already links Lato 300/400/700 from Google Fonts) ----------

let fontsReadyPromise = null;

function ensureFonts() {
  if (!fontsReadyPromise) fontsReadyPromise = loadFonts();
  return fontsReadyPromise;
}

async function loadFonts() {
  if (!document.fonts) return; // very old browser — sans-serif fallback
  try { await document.fonts.ready; } catch { /* ignore */ }
  for (const weight of ['300', '400', '700']) {
    try { await document.fonts.load(`${weight} 16px 'Lato'`); } catch { /* ignore */ }
  }
}

// --- Small helpers -----------------------------------------------------------

// Deterministic star placement (seeded PRNG, fixed seed — same convention as
// the lockscreen renderer so every card of a given build looks identical).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function setFont(ctx, weight, size) {
  ctx.font = `${weight} ${size}px 'Lato', sans-serif`;
}

const supportsLetterSpacing = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    return !!c && 'letterSpacing' in c;
  } catch { return false; }
})();

function measureWidth(ctx, str, ls) {
  if (!ls) return ctx.measureText(str).width;
  if (supportsLetterSpacing) {
    ctx.letterSpacing = `${ls}px`;
    const w = ctx.measureText(str).width;
    ctx.letterSpacing = '0px';
    return w;
  }
  let w = 0;
  for (const ch of str) w += ctx.measureText(ch).width + ls;
  return w;
}

// Draw text with optional letter-spacing; centred/left/right around x.
function drawText(ctx, str, x, y, { size = 24, weight = 400, colour = '#fff', align = 'center', ls = 0 } = {}) {
  if (!str) return;
  setFont(ctx, weight, size);
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  if (!ls) {
    ctx.textAlign = align;
    ctx.fillText(str, x, y);
    return;
  }
  if (supportsLetterSpacing) {
    ctx.letterSpacing = `${ls}px`;
    ctx.textAlign = align;
    ctx.fillText(str, x, y);
    ctx.letterSpacing = '0px';
    return;
  }
  // Manual per-character fallback (mimics CSS: spacing after every char).
  const chars = [...str];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + ls * chars.length;
  let cx = x;
  if (align === 'center') cx = x - total / 2;
  else if (align === 'right' || align === 'end') cx = x - total;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + ls;
  });
}

function loadImage(src, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), timeoutMs);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    } catch { resolve(null); }
  });
}

// --- Time/date formatting (12h compact, missing → em dash) ------------------

function to12h(t) {
  const s = (t == null ? '' : String(t)).trim();
  if (!s || s === '-' || s === '—') return '';
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m[2]}`;
}

function fmt(t) {
  return to12h(t) || '—';
}

function parseRowDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  // Legacy image-extraction format "18 Feb" (2026 timetables)
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parts = s.split(/\s+/);
  const day = parseInt(parts[0], 10);
  const mon = months[parts[1]];
  if (isNaN(day) || mon === undefined) return null;
  return new Date(2026, mon, day);
}

function buildValues(todayRow, season) {
  const isRamadan = season === 'ramadan';
  const row = todayRow || {};
  const fajrStart = isRamadan
    ? row['Sehri Ends']
    : (row['Fajr Start'] || row['Subha Sadiq'] || row['Sehri Ends']);
  return {
    isRamadan,
    sehri: fmt(row['Sehri Ends']),
    iftari: fmt(row['Maghrib Iftari']),
    sunrise: to12h(row['Sunrise']),
    zawal: to12h(row['Zawal']),
    rows: [
      { name: 'Fajr', start: fmt(fajrStart), jamaat: fmt(row["Fajr Jama'at"]) },
      { name: 'Dhuhr', start: fmt(row['Zohr']), jamaat: fmt(row["Zohar Jama'at"] || '1:00') },
      { name: 'Asr', start: fmt(row['Asr']), jamaat: fmt(row["Asr Jama'at"]) },
      { name: 'Maghrib', start: fmt(row['Maghrib Iftari']), jamaat: fmt(row["Maghrib Jama'at"] || row['Maghrib Iftari']) },
      { name: 'Esha', start: fmt(row['Esha']), jamaat: fmt(row["Esha Jama'at"]) },
    ],
  };
}

function buildDates(todayRow) {
  const d = parseRowDate(todayRow && todayRow['Date']) || new Date();
  const english = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let hijri = '';
  try { hijri = formatHijriDate(d); } catch { /* Intl islamic calendar unsupported */ }
  return { english, hijri };
}

// --- Decorations --------------------------------------------------------------

function drawBackground(ctx) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  C.bgStops.forEach(([stop, colour]) => bg.addColorStop(stop, colour));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Soft radial colour washes
  for (const r of C.radials) {
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.scale(r.rx, r.ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${r.colour},1)`);
    g.addColorStop(r.fade, `rgba(${r.colour},0)`);
    g.addColorStop(1, `rgba(${r.colour},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  // Faint Islamic geometric pattern: thin gold lines at +/-60 degrees
  const diag = Math.ceil(Math.hypot(W, H));
  for (const angle of [60, -60]) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.fillStyle = C.pattern;
    for (let x = -diag; x <= diag; x += 80) {
      ctx.fillRect(x, -diag, 2, diag * 2);
    }
    ctx.restore();
  }
}

function drawStars(ctx) {
  const rand = mulberry32(1447);
  const maxY = H * 0.55;
  for (let i = 0; i < 54; i++) {
    const x = rand() * W;
    const y = rand() * maxY;
    const sizeRoll = rand();
    const r = sizeRoll > 0.85 ? 2.6 : sizeRoll > 0.5 ? 1.8 : 1.1;
    const opacity = 0.12 + rand() * 0.4; // restrained
    ctx.fillStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Four-point sparkle (subtle gold accent either side of the crescent)
function drawSparkle(ctx, x, y, s, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = `rgba(245,213,106,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.quadraticCurveTo(s * 0.18, -s * 0.18, s, 0);
  ctx.quadraticCurveTo(s * 0.18, s * 0.18, 0, s);
  ctx.quadraticCurveTo(-s * 0.18, s * 0.18, -s, 0);
  ctx.quadraticCurveTo(-s * 0.18, -s * 0.18, 0, -s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Crescent built on a scratch canvas with destination-out so the cut-out is
// genuinely transparent (no page-colour matching needed).
function drawCrescent(ctx, cx, cy, r) {
  // Glow on the main canvas first
  const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.6);
  glow.addColorStop(0, 'rgba(212,175,55,0.18)');
  glow.addColorStop(1, 'rgba(212,175,55,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2);
  ctx.fill();

  const pad = 8;
  const size = (r + pad) * 2;
  const scratch = document.createElement('canvas');
  scratch.width = size;
  scratch.height = size;
  const s = scratch.getContext('2d');
  s.translate(size / 2, size / 2);
  const g = s.createLinearGradient(-r * 0.7, -r * 0.7, r * 0.7, r * 0.7);
  g.addColorStop(0, '#d4af37');
  g.addColorStop(1, '#f5d56a');
  s.fillStyle = g;
  s.beginPath();
  s.arc(0, 0, r, 0, Math.PI * 2);
  s.fill();
  s.globalCompositeOperation = 'destination-out';
  s.beginPath();
  s.arc(r * 0.42, -r * 0.28, r * 0.86, 0, Math.PI * 2);
  s.fill();

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.drawImage(scratch, cx - size / 2, cy - size / 2);
  ctx.restore();
}

function drawDivider(ctx, cy) {
  const lineGrad = (x0, x1) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, C.dividerLine);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  };
  const mid = W / 2;
  ctx.fillStyle = lineGrad(PAD, mid - 26);
  ctx.fillRect(PAD, cy - 1, mid - 26 - PAD, 2);
  ctx.fillStyle = lineGrad(mid + 26, W - PAD);
  ctx.fillRect(mid + 26, cy - 1, W - PAD - (mid + 26), 2);
  ctx.save();
  ctx.translate(mid, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = C.diamond;
  ctx.fillRect(-7, -7, 14, 14);
  ctx.restore();
}

// --- Text layout ---------------------------------------------------------------

function wrapWords(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const tryLine = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(tryLine).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = tryLine;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Fit the masjid name into at most two centred lines, shrinking as needed.
function fitName(ctx, name, maxW) {
  for (let size = 58; size >= 38; size -= 2) {
    setFont(ctx, 700, size);
    const lines = wrapWords(ctx, name, maxW);
    if (lines.length <= 2 && lines.every((l) => ctx.measureText(l).width <= maxW)) {
      return { size, lines };
    }
  }
  setFont(ctx, 700, 38);
  let lines = wrapWords(ctx, name, maxW);
  if (lines.length > 2) {
    lines = lines.slice(0, 2);
    let second = lines[1];
    while (second && ctx.measureText(`${second}…`).width > maxW) {
      second = second.slice(0, -1);
    }
    lines[1] = `${second}…`;
  }
  return { size: 38, lines };
}

// --- Card sections --------------------------------------------------------------

function drawBanner(ctx, x, y, w, h, { label, time, border, timeColour }) {
  roundRectPath(ctx, x, y, w, h, 20);
  ctx.fillStyle = C.bannerBg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  roundRectPath(ctx, x + 1, y + 1, w - 2, h - 2, 20);
  ctx.stroke();

  const cx = x + w / 2;
  drawText(ctx, label, cx, y + 42, { size: 22, weight: 400, colour: C.bannerLabel, ls: 3 });
  drawText(ctx, time, cx, y + h - 52, { size: 54, weight: 700, colour: timeColour });
}

function drawSunZawalRow(ctx, cardX, cardW, y, h, sunrise, zawal) {
  const mid = cardX + cardW / 2;
  const cy = y + h / 2;
  const both = !!sunrise && !!zawal;
  const cells = [];
  if (sunrise) cells.push({ label: 'SUNRISE', time: sunrise, cx: both ? cardX + cardW / 4 : mid });
  if (zawal) cells.push({ label: 'ZAWAL', time: zawal, cx: both ? mid + cardW / 4 : mid });
  for (const cell of cells) {
    setFont(ctx, 400, 19);
    const labelW = measureWidth(ctx, cell.label, 2);
    setFont(ctx, 700, 27);
    const timeW = measureWidth(ctx, cell.time, 0);
    const total = labelW + 14 + timeW;
    const startX = cell.cx - total / 2;
    drawText(ctx, cell.label, startX, cy + 1, { size: 19, weight: 400, colour: C.sunZawalLabel, ls: 2, align: 'left' });
    drawText(ctx, cell.time, startX + labelW + 14, cy, { size: 27, weight: 700, colour: C.sunZawalTime, align: 'left' });
  }
  if (both) {
    ctx.fillStyle = C.sunZawalDivider;
    ctx.fillRect(mid - 1, cy - 16, 2, 32);
  }
  ctx.fillStyle = C.cardDividerStrong;
  ctx.fillRect(cardX, y + h - 1, cardW, 1);
}

function drawTimesTable(ctx, values, top, bottom) {
  const cardX = PAD;
  const cardW = CONTENT_W;
  const cardH = bottom - top;
  roundRectPath(ctx, cardX, top, cardW, cardH, 24);
  ctx.fillStyle = C.cardBg;
  ctx.fill();
  ctx.strokeStyle = C.cardBorder;
  ctx.lineWidth = 2;
  roundRectPath(ctx, cardX + 1, top + 1, cardW - 2, cardH - 2, 24);
  ctx.stroke();

  // Clip interior so dividers respect the rounded corners
  ctx.save();
  roundRectPath(ctx, cardX, top, cardW, cardH, 24);
  ctx.clip();

  let rowY = top;
  const hasSunZawal = !!(values.sunrise || values.zawal);
  if (hasSunZawal) {
    const szH = 58;
    drawSunZawalRow(ctx, cardX, cardW, rowY, szH, values.sunrise, values.zawal);
    rowY += szH;
  }

  // Column geometry: 1fr | 1.2fr | 1fr inside 28px side padding (matches app)
  const gridX = cardX + 28;
  const gridW = cardW - 56;
  const f = gridW / 3.2;
  const colStart = gridX + f / 2;
  const colName = gridX + f + (1.2 * f) / 2;
  const colJamaat = gridX + 2.2 * f + f / 2;

  const headH = 58;
  const headCY = rowY + headH / 2 + 1;
  drawText(ctx, 'START', colStart, headCY, { size: 20, weight: 400, colour: C.headerCol, ls: 3 });
  drawText(ctx, 'PRAYER', colName, headCY, { size: 20, weight: 400, colour: C.headerCol, ls: 3 });
  drawText(ctx, "JAMA'AT", colJamaat, headCY, { size: 20, weight: 400, colour: C.headerCol, ls: 3 });
  ctx.fillStyle = C.cardDividerStrong;
  ctx.fillRect(cardX, rowY + headH - 1, cardW, 1);
  rowY += headH;

  const rowH = (top + cardH - rowY) / values.rows.length;
  values.rows.forEach((row, i) => {
    const cy = rowY + rowH * i + rowH / 2;
    drawText(ctx, row.start, colStart, cy, { size: 34, weight: 400, colour: C.timeStart });
    drawText(ctx, row.name, colName, cy, { size: 30, weight: 400, colour: C.timeName });
    drawText(ctx, row.jamaat, colJamaat, cy, { size: 38, weight: 700, colour: C.goldBright });
    if (i < values.rows.length - 1) {
      ctx.fillStyle = C.cardDividerFaint;
      ctx.fillRect(cardX, rowY + rowH * (i + 1) - 1, cardW, 1);
    }
  });
  ctx.restore();
}

function drawFooter(ctx, slug, icon) {
  // Thin gradient rule above the footer
  const ruleY = H - 116;
  const g = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  g.addColorStop(0, 'rgba(212,175,55,0)');
  g.addColorStop(0.5, 'rgba(212,175,55,0.3)');
  g.addColorStop(1, 'rgba(212,175,55,0)');
  ctx.fillStyle = g;
  ctx.fillRect(PAD, ruleY, CONTENT_W, 1);

  const url = slug ? `iqamah.co.uk/${slug}` : 'iqamah.co.uk';
  const cy = H - 62;
  let size = 32;
  setFont(ctx, 700, size);
  const iconSize = 44;
  const gap = icon ? 16 : 0;
  while (size > 22 && (icon ? iconSize + gap : 0) + measureWidth(ctx, url, 0.5) > CONTENT_W) {
    size -= 1;
    setFont(ctx, 700, size);
  }
  const textW = measureWidth(ctx, url, 0.5);
  const total = (icon ? iconSize + gap : 0) + textW;
  let x = W / 2 - total / 2;
  if (icon) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(icon, x, cy - iconSize / 2, iconSize, iconSize);
    ctx.restore();
    x += iconSize + gap;
  }
  drawText(ctx, url, x, cy + 1, { size, weight: 700, colour: C.footerUrl, ls: 0.5, align: 'left' });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fromDataUrl = () => {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const bin = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) { reject(err); }
    };
    try {
      canvas.toBlob((blob) => {
        if (done) return;
        done = true;
        if (blob) resolve(blob);
        else fromDataUrl();
      }, 'image/png');
    } catch {
      done = true;
      fromDataUrl();
    }
  });
}

// --- Public API -------------------------------------------------------------------

/**
 * Render a 1080x1350 (4:5) share card of today's prayer times.
 * Always dark Iqamah branding, regardless of the app theme.
 *
 * @param {object} opts
 * @param {object} opts.config   Masjid config (display_name + slug used)
 * @param {object} opts.todayRow Normalised CSV row for today (title-case keys)
 * @param {string} opts.season   'ramadan' | 'eid' | 'default'
 * @returns {Promise<Blob>} PNG blob
 */
export async function renderShareCard({ config, todayRow, season = 'default' }) {
  if (!todayRow) throw new Error('renderShareCard: no timetable row for today');

  const [, icon] = await Promise.all([
    ensureFonts(),
    loadImage('/iqamah-icon-transparent.png'),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderShareCard: 2D canvas unavailable');

  drawBackground(ctx);
  drawStars(ctx);

  // Top ornament: small centred crescent flanked by two sparkles
  drawCrescent(ctx, W / 2, 106, 36);
  drawSparkle(ctx, W / 2 - 150, 92, 11, 0.55);
  drawSparkle(ctx, W / 2 + 152, 118, 9, 0.45);

  drawText(ctx, "TODAY'S PRAYER TIMES", W / 2, 204, { size: 24, weight: 400, colour: C.caption, ls: 6 });

  // Masjid name (1–2 centred lines, auto-shrunk)
  const name = (config && config.display_name) || '';
  const { size: nameSize, lines: nameLines } = fitName(ctx, name, CONTENT_W);
  const lineH = nameSize * 1.22;
  const firstLineCY = 276;
  nameLines.forEach((line, i) => {
    drawText(ctx, line, W / 2, firstLineCY + i * lineH, { size: nameSize, weight: 700, colour: C.cream });
  });
  let y = firstLineCY + (nameLines.length - 1) * lineH + nameSize / 2;

  // Dates
  const dates = buildDates(todayRow);
  const englishY = y + 54;
  drawText(ctx, dates.english, W / 2, englishY, { size: 33, weight: 300, colour: C.dateText });
  let afterDates = englishY + 24;
  if (dates.hijri) {
    const hijriY = englishY + 50;
    drawText(ctx, dates.hijri, W / 2, hijriY, { size: 31, weight: 400, colour: C.green });
    afterDates = hijriY + 24;
  }

  // Gold divider with diamond
  const dividerY = afterDates + 28;
  drawDivider(ctx, dividerY);

  // Sehri / Iftar emphasis banners (ramadan only)
  const values = buildValues(todayRow, season);
  let tableTop;
  if (values.isRamadan) {
    const bH = 148;
    const bW = (CONTENT_W - 24) / 2;
    const bY = dividerY + 38;
    drawBanner(ctx, PAD, bY, bW, bH, {
      label: 'SEHRI ENDS', time: values.sehri,
      border: C.bannerBorderSehri, timeColour: C.goldBright,
    });
    drawBanner(ctx, PAD + bW + 24, bY, bW, bH, {
      label: 'MAGHRIB · IFTAR', time: values.iftari,
      border: C.bannerBorderMaghrib, timeColour: C.green,
    });
    tableTop = bY + bH + 36;
  } else {
    tableTop = dividerY + 44;
  }

  // Times table fills down to the footer, capped so rows never look stretched
  const tableBottom = H - 152;
  const maxTableH = 680;
  if (tableBottom - tableTop > maxTableH) {
    tableTop += (tableBottom - tableTop - maxTableH) / 2;
  }
  drawTimesTable(ctx, values, tableTop, tableBottom);

  drawFooter(ctx, config && config.slug, icon);

  return canvasToBlob(canvas);
}
