// Client-side lockscreen renderer — reproduces the v4 lockscreen design
// (templates/lockscreen_v4_ramadan[_light].html / lockscreen_v4_default[_light].html)
// on a 1080x2400 canvas so ANY masjid gets an on-demand wallpaper, with no
// dependence on CI-generated PNGs.
//
// Self-contained: no imports from views. Pure Canvas 2D (no OffscreenCanvas),
// canvas.toBlob with a dataURL fallback for older Safari.
//
// The v4 templates are authored in a 390x844 design space; the CI pipeline
// renders that at 3x (1170x2532) and Pillow-resizes to 1080x2400, which
// slightly stretches the design vertically. We reproduce the same result by
// drawing in design units under a non-uniform scale (1080/390, 2400/844).

import { formatHijriDate } from './hijri.js';

const OUT_W = 1080;
const OUT_H = 2400;
const DESIGN_W = 390;
const DESIGN_H = 844;

// Two-zone layout (design units): top zone is decoration-only behind the
// phone clock; all prayer content lives in the bottom zone; nothing in the
// bottom ~145px where the torch/camera icons sit.
const ZONE_TOP = 285;
const ZONE_BOTTOM = DESIGN_H - 145; // 699
const PAD_X = 22;

const THEMES = {
  dark: {
    bgStops: [[0, '#050c18'], [0.4, '#0a1628'], [1, '#0d1f15']],
    radials: [
      // CSS farthest-corner ellipse radii: rx = dx*sqrt(2), ry = dy*sqrt(2)
      { x: 195, y: -84, rx: 276, ry: 1312, colour: '26,74,58', fade: 0.6 },   // #1a4a3a at 50% -10%
      { x: 390, y: 422, rx: 552, ry: 597, colour: '13,45,64', fade: 0.5 },    // #0d2d40 at 100% 50%
      { x: 0, y: 675, rx: 552, ry: 955, colour: '26,42,13', fade: 0.5 },      // #1a2a0d at 0% 80%
    ],
    pattern: 'rgba(212,175,55,0.03)',
    particle: 'star',
    text: '#f0e6c8',
    moonGrad: ['#d4af37', '#f5d56a'],
    moonCut: '#0a1628',
    moonGlow: '212,175,55',
    moonGlowAlphas: [0.4, 0.15],
    dividerLine: 'rgba(212,175,55,0.5)',
    diamond: 'rgba(212,175,55,0.6)',
    bannerBg: 'rgba(255,255,255,0.03)',
    bannerBorderSehri: 'rgba(212,175,55,0.35)',
    bannerBorderMaghrib: 'rgba(80,180,120,0.3)',
    bannerLabel: 'rgba(240,230,200,0.7)',
    bannerSubtitle: 'rgba(240,230,200,0.45)',
    timeGold: '#f5d56a',
    timeGreen: '#6ed89a',
    cardBg: 'rgba(255,255,255,0.04)',
    cardBorder: 'rgba(212,175,55,0.2)',
    cardDividerStrong: 'rgba(212,175,55,0.15)',
    cardDividerFaint: 'rgba(212,175,55,0.08)',
    sunZawalLabel: 'rgba(240,230,200,0.5)',
    sunZawalTime: 'rgba(240,230,200,0.8)',
    sunZawalDivider: 'rgba(212,175,55,0.25)',
    headerCol: 'rgba(212,175,55,0.5)',
    timeStart: 'rgba(240,230,200,0.7)',
    timeName: 'rgba(240,230,200,0.9)',
    footerText: 'rgba(212,175,55,0.4)',
    footerBrand: 'rgba(212,175,55,0.3)',
  },
  light: {
    bgStops: [[0, '#faf6ef'], [0.4, '#f5eed9'], [1, '#f0ebe0']],
    radials: [
      { x: 195, y: -84, rx: 276, ry: 1312, colour: '212,232,208', fade: 0.6 }, // #d4e8d0 at 50% -10%
      { x: 390, y: 422, rx: 552, ry: 597, colour: '204,224,236', fade: 0.5 },  // #cce0ec at 100% 50%
      { x: 0, y: 675, rx: 552, ry: 955, colour: '232,224,200', fade: 0.5 },    // #e8e0c8 at 0% 80%
    ],
    pattern: 'rgba(180,140,30,0.04)',
    particle: 'mote',
    text: '#1a1a2e',
    moonGrad: ['#b8941f', '#9a7a10'],
    moonCut: '#f5eed9',
    moonGlow: '180,140,30',
    moonGlowAlphas: [0.3, 0.1],
    dividerLine: 'rgba(180,140,30,0.4)',
    diamond: 'rgba(184,148,31,0.5)',
    bannerBg: 'rgba(255,255,255,0.6)',
    bannerBorderSehri: 'rgba(180,140,30,0.3)',
    bannerBorderMaghrib: 'rgba(45,122,79,0.3)',
    bannerLabel: 'rgba(26,26,46,0.5)',
    bannerSubtitle: 'rgba(26,26,46,0.35)',
    timeGold: '#9a7a10',
    timeGreen: '#2d7a4f',
    cardBg: 'rgba(255,255,255,0.75)',
    cardBorder: 'rgba(180,140,30,0.2)',
    cardDividerStrong: 'rgba(180,140,30,0.12)',
    cardDividerFaint: 'rgba(180,140,30,0.06)',
    sunZawalLabel: 'rgba(26,26,46,0.45)',
    sunZawalTime: 'rgba(26,26,46,0.7)',
    sunZawalDivider: 'rgba(180,140,30,0.2)',
    headerCol: 'rgba(180,140,30,0.5)',
    timeStart: 'rgba(26,26,46,0.6)',
    timeName: 'rgba(26,26,46,0.85)',
    footerText: 'rgba(180,140,30,0.4)',
    footerBrand: 'rgba(180,140,30,0.3)',
  },
};

// --- Fonts -----------------------------------------------------------------

// The SPA's <head> already links Lato 300/400/700 (plus Amiri and Cinzel)
// from Google Fonts. Note the v4 lockscreen templates use Lato exclusively —
// Cinzel/Amiri in their <link> are vestigial from v3 — so the canvas only
// needs Lato. We make sure the weights we draw with are genuinely loaded;
// if any are missing (stylesheet blocked, standalone usage) we fetch the
// woff2 directly through the FontFace API as a fallback.
const FONT_WEIGHTS = ['300', '400', '700'];
let fontsReadyPromise = null;

async function ensureFonts() {
  if (!fontsReadyPromise) fontsReadyPromise = loadFonts();
  return fontsReadyPromise;
}

async function loadFonts() {
  if (!document.fonts) return; // very old browser — sans-serif fallback
  try { await document.fonts.ready; } catch { /* ignore */ }

  const missing = [];
  for (const weight of FONT_WEIGHTS) {
    const spec = `${weight} 16px 'Lato'`;
    try { await document.fonts.load(spec); } catch { /* ignore */ }
    if (!document.fonts.check(spec)) missing.push(weight);
  }
  if (missing.length === 0 || typeof FontFace === 'undefined') return;

  // FontFace API fallback: fetch the Google Fonts css2 stylesheet and pull
  // the latin woff2 URL for each missing weight.
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=Lato:wght@${missing.join(';')}&display=swap`;
    const css = await (await fetch(cssUrl)).text();
    const faceRe = /@font-face\s*\{([^}]+)\}/g;
    const latinUrls = {}; // weight -> url (latin block is last per weight)
    let m;
    while ((m = faceRe.exec(css)) !== null) {
      const block = m[1];
      const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1];
      const url = (block.match(/src:\s*url\(([^)]+\.woff2)\)/) || [])[1];
      if (weight && url) latinUrls[weight] = url;
    }
    await Promise.all(missing.map(async (weight) => {
      const url = latinUrls[weight];
      if (!url) return;
      const face = new FontFace('Lato', `url(${url}) format('woff2')`, { weight });
      await face.load();
      document.fonts.add(face);
    }));
  } catch { /* non-fatal — canvas falls back to sans-serif */ }
}

// --- Small helpers ----------------------------------------------------------

// Deterministic-ish particle placement (seeded PRNG, fixed seed).
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
    return c && 'letterSpacing' in c;
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

// Draw text with optional letter-spacing; align around x like CSS centring.
function drawText(ctx, str, x, y, { size = 10, weight = 400, colour = '#fff', align = 'center', ls = 0 } = {}) {
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

// --- Time/date formatting (matches generate.py's CI output: bare 12h) -------

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
  const v = to12h(t);
  return v || '-';
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

// --- Drawing ----------------------------------------------------------------

function drawBackground(ctx, theme) {
  const bg = ctx.createLinearGradient(0, 0, 0, DESIGN_H);
  theme.bgStops.forEach(([stop, colour]) => bg.addColorStop(stop, colour));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  // Radial ellipse washes (body::before in the templates)
  for (const r of theme.radials) {
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

  // Islamic geometric pattern: 1px gold lines every 29px at +/-60deg
  const diag = Math.ceil(Math.hypot(DESIGN_W, DESIGN_H));
  for (const angle of [60, -60]) {
    ctx.save();
    ctx.translate(DESIGN_W / 2, DESIGN_H / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.fillStyle = theme.pattern;
    for (let x = -diag; x <= diag; x += 29) {
      ctx.fillRect(x, -diag, 1, diag * 2);
    }
    ctx.restore();
  }
}

function drawParticles(ctx, theme) {
  const rand = mulberry32(1447);
  const maxY = DESIGN_H * 0.55;
  for (let i = 0; i < 60; i++) {
    const x = rand() * DESIGN_W;
    const y = rand() * maxY;
    if (theme.particle === 'star') {
      const sizeRoll = rand();
      const size = sizeRoll > 0.85 ? 3 : sizeRoll > 0.5 ? 2 : 1;
      const opacity = 0.2 + rand() * 0.7; // twinkle range frozen mid-animation
      ctx.fillStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const size = 3 + rand() * 5;
      const opacity = 0.3 + rand() * 0.2; // drift opacity range
      const radius = size / 2;
      ctx.save();
      ctx.translate(x, y);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      g.addColorStop(0, `rgba(180,140,30,${(0.4 * opacity).toFixed(3)})`);
      g.addColorStop(1, 'rgba(180,140,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

// Crescent moon: 50px gold circle at (right:30, top:63) with a 44px circle of
// page-background colour offset top -6/right -10, the whole group at 45%
// opacity with a soft gold glow. Composited on a scratch canvas so the glow,
// disc and cut-out blend exactly like the CSS element group.
function drawMoon(ctx, theme) {
  const moonX = DESIGN_W - 30 - 50; // 310
  const moonY = 63;
  const moonR = 25;
  const mcx = moonX + 25; // 335
  const mcy = moonY + 25; // 88
  const cutR = 22;
  const ccx = moonX + 50 + 10 - cutR; // right edge +10 → centre 348
  const ccy = moonY - 6 + cutR;        // top -6 → centre 79

  // Scratch region big enough for the 60px glow
  const rx = mcx - 100, ry = mcy - 100, rw = 200, rh = 200;
  const scale = 3;
  const scratch = document.createElement('canvas');
  scratch.width = rw * scale;
  scratch.height = rh * scale;
  const s = scratch.getContext('2d');
  s.scale(scale, scale);
  s.translate(-rx, -ry);

  // Glow (approximates box-shadow 0 0 20px / 0 0 60px — a gaussian blur of
  // the disc edge, so alpha at the edge is roughly half the shadow colour's)
  const glows = [
    { from: moonR, to: moonR + 20, alpha: theme.moonGlowAlphas[0] * 0.55 },
    { from: moonR, to: moonR + 55, alpha: theme.moonGlowAlphas[1] * 0.55 },
  ];
  for (const gl of glows) {
    const g = s.createRadialGradient(mcx, mcy, Math.max(0, gl.from), mcx, mcy, gl.to);
    g.addColorStop(0, `rgba(${theme.moonGlow},${gl.alpha})`);
    g.addColorStop(1, `rgba(${theme.moonGlow},0)`);
    s.fillStyle = g;
    s.beginPath();
    s.arc(mcx, mcy, gl.to, 0, Math.PI * 2);
    s.fill();
  }

  // Moon disc with 135deg gradient
  const mg = s.createLinearGradient(mcx - moonR * 0.707, mcy - moonR * 0.707, mcx + moonR * 0.707, mcy + moonR * 0.707);
  mg.addColorStop(0, theme.moonGrad[0]);
  mg.addColorStop(1, theme.moonGrad[1]);
  s.fillStyle = mg;
  s.beginPath();
  s.arc(mcx, mcy, moonR, 0, Math.PI * 2);
  s.fill();

  // Cut-out circle painted in solid page-background colour (as the CSS does)
  s.fillStyle = theme.moonCut;
  s.beginPath();
  s.arc(ccx, ccy, cutR, 0, Math.PI * 2);
  s.fill();

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.drawImage(scratch, rx, ry, rw, rh);
  ctx.restore();
}

function drawDivider(ctx, theme, cy) {
  const lineGrad = (x0, x1) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, theme.dividerLine);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  };
  // Lines either side of the 8px diamond (8px margins)
  ctx.fillStyle = lineGrad(PAD_X, 183);
  ctx.fillRect(PAD_X, cy - 0.5, 183 - PAD_X, 1);
  ctx.fillStyle = lineGrad(207, DESIGN_W - PAD_X);
  ctx.fillRect(207, cy - 0.5, DESIGN_W - PAD_X - 207, 1);
  // Diamond
  ctx.save();
  ctx.translate(DESIGN_W / 2, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = theme.diamond;
  ctx.fillRect(-4, -4, 8, 8);
  ctx.restore();
}

function drawBanner(ctx, theme, x, y, w, h, { label, subtitle, time, border, timeColour }) {
  roundRectPath(ctx, x, y, w, h, 12);
  ctx.fillStyle = theme.bannerBg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12);
  ctx.stroke();

  const cx = x + w / 2;
  let ty = y + 8;
  drawText(ctx, label.toUpperCase(), cx, ty + 5.5, { size: 9, weight: 400, colour: theme.bannerLabel, ls: 1.5 });
  ty += 11 + 2;
  drawText(ctx, subtitle, cx, ty + 4.2, { size: 7, weight: 400, colour: theme.bannerSubtitle });
  ty += 8.4 + 4;
  drawText(ctx, time, cx, ty + 18, { size: 30, weight: 700, colour: timeColour });
}

function drawSunZawalRow(ctx, theme, cardX, cardW, y, h, sunrise, zawal) {
  const mid = cardX + cardW / 2;
  const cy = y + h / 2;
  const cells = [
    { label: 'SUNRISE', time: sunrise, cx: cardX + 14 + (cardW / 2 - 14 - 10.5) / 2 },
    { label: 'ZAWAL', time: zawal, cx: mid + 10.5 + (cardW / 2 - 14 - 10.5) / 2 },
  ];
  for (const cell of cells) {
    setFont(ctx, 400, 8);
    const labelW = measureWidth(ctx, cell.label, 1);
    setFont(ctx, 700, 13);
    const timeW = measureWidth(ctx, cell.time, 0);
    const total = labelW + 6 + timeW;
    const startX = cell.cx - total / 2;
    drawText(ctx, cell.label, startX, cy, { size: 8, weight: 400, colour: theme.sunZawalLabel, ls: 1, align: 'left' });
    drawText(ctx, cell.time, startX + labelW + 6, cy, { size: 13, weight: 700, colour: theme.sunZawalTime, align: 'left' });
  }
  // Vertical divider between the two cells
  ctx.fillStyle = theme.sunZawalDivider;
  ctx.fillRect(mid - 0.5, cy - 9, 1, 18);
  // Bottom border
  ctx.fillStyle = theme.cardDividerStrong;
  ctx.fillRect(cardX, y + h - 1, cardW, 1);
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
    sunrise: fmt(row['Sunrise']),
    zawal: fmt(row['Zawal']),
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
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  const english = `${weekday} ${d.getDate()} ${month} ${d.getFullYear()}`;
  let hijri = '';
  try { hijri = formatHijriDate(d); } catch { /* Intl calendar unsupported */ }
  return { english, hijri };
}

function drawBottomZone(ctx, theme, values, dates, masjidName) {
  let y = ZONE_TOP;
  const contentW = DESIGN_W - PAD_X * 2; // 346

  // Date row: two flex halves with an 8px gap
  const halfW = (contentW - 8) / 2;
  drawText(ctx, dates.english, PAD_X + halfW / 2, y + 6, { size: 10, weight: 300, colour: theme.text });
  drawText(ctx, dates.hijri, PAD_X + halfW + 8 + halfW / 2, y + 6, { size: 10, weight: 300, colour: theme.text });
  y += 12 + 8;

  // Gold divider with diamond
  drawDivider(ctx, theme, y + 4);
  y += 8 + 8;

  // Sehri/Iftari banners (ramadan season only)
  if (values.isRamadan) {
    const bH = 77;
    const bW = halfW;
    drawBanner(ctx, theme, PAD_X, y, bW, bH, {
      label: 'Sehri Ends', subtitle: 'Stop eating before',
      time: values.sehri, border: theme.bannerBorderSehri, timeColour: theme.timeGold,
    });
    drawBanner(ctx, theme, PAD_X + bW + 8, y, bW, bH, {
      label: 'Maghrib Iftari', subtitle: 'Break your fast',
      time: values.iftari, border: theme.bannerBorderMaghrib, timeColour: theme.timeGreen,
    });
    y += bH + 8;
  }

  // Main card fills the space down to the footer
  const footerH = 32;
  const cardX = PAD_X;
  const cardW = contentW;
  const cardH = ZONE_BOTTOM - y - footerH;
  roundRectPath(ctx, cardX, y, cardW, cardH, 16);
  ctx.fillStyle = theme.cardBg;
  ctx.fill();
  ctx.strokeStyle = theme.cardBorder;
  ctx.lineWidth = 1;
  roundRectPath(ctx, cardX + 0.5, y + 0.5, cardW - 1, cardH - 1, 16);
  ctx.stroke();

  // Clip interior so dividers respect the rounded corners
  ctx.save();
  roundRectPath(ctx, cardX, y, cardW, cardH, 16);
  ctx.clip();

  // Sunrise / Zawal split row
  const szH = 32;
  drawSunZawalRow(ctx, theme, cardX, cardW, y, szH, values.sunrise, values.zawal);
  let rowY = y + szH;

  // Column geometry: grid 1fr 1.2fr 1fr inside 14px padding
  const gridX = cardX + 14;
  const gridW = cardW - 28;
  const f = gridW / 3.2;
  const colStart = gridX + f / 2;
  const colName = gridX + f + (1.2 * f) / 2;
  const colJamaat = gridX + 2.2 * f + f / 2;

  // Table header
  const headH = 22;
  const headCY = rowY + headH / 2;
  drawText(ctx, 'START', colStart, headCY, { size: 7, weight: 400, colour: theme.headerCol, ls: 1.5 });
  drawText(ctx, 'PRAYER', colName, headCY, { size: 7, weight: 400, colour: theme.headerCol, ls: 1.5 });
  drawText(ctx, "JAMA'AT", colJamaat, headCY, { size: 7, weight: 400, colour: theme.headerCol, ls: 1.5 });
  ctx.fillStyle = theme.cardDividerStrong;
  ctx.fillRect(cardX, rowY + headH - 1, cardW, 1);
  rowY += headH;

  // Prayer rows share the remaining height equally
  const rowH = (y + cardH - rowY) / values.rows.length;
  values.rows.forEach((row, i) => {
    const cy = rowY + rowH * i + rowH / 2;
    drawText(ctx, row.start, colStart, cy, { size: 14, weight: 400, colour: theme.timeStart });
    drawText(ctx, row.name, colName, cy, { size: 11, weight: 400, colour: theme.timeName });
    drawText(ctx, row.jamaat, colJamaat, cy, { size: 14, weight: 700, colour: theme.timeGold });
    if (i < values.rows.length - 1) {
      ctx.fillStyle = theme.cardDividerFaint;
      ctx.fillRect(cardX, rowY + rowH * (i + 1) - 0.5, cardW, 1);
    }
  });
  ctx.restore();

  // Footer: masjid name + brand
  const footerTop = ZONE_BOTTOM - footerH + 6;
  let nameSize = 10;
  setFont(ctx, 400, nameSize);
  while (nameSize > 7 && measureWidth(ctx, masjidName, 2) > contentW) {
    nameSize -= 0.5;
    setFont(ctx, 400, nameSize);
  }
  drawText(ctx, masjidName, DESIGN_W / 2, footerTop + 6, { size: nameSize, weight: 400, colour: theme.footerText, ls: 2 });
  drawText(ctx, 'Iqamah', DESIGN_W / 2, footerTop + 12 + 4 + 5, { size: 8, weight: 400, colour: theme.footerBrand, ls: 1.5 });
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

// --- Public API ---------------------------------------------------------------

/**
 * Render a 1080x2400 lockscreen PNG for a masjid, in the browser.
 *
 * @param {object} opts
 * @param {object} opts.config   Masjid config (display_name used)
 * @param {object} opts.todayRow Normalised CSV row for today (title-case keys)
 * @param {string} opts.season   'ramadan' | 'eid' | 'default'
 * @param {boolean} opts.light   true → light variant, false → dark variant
 * @returns {Promise<Blob>} PNG blob
 */
export async function renderLockscreen({ config, todayRow, season = 'default', light = false }) {
  if (!todayRow) throw new Error('renderLockscreen: no timetable row for today');
  const theme = light ? THEMES.light : THEMES.dark;

  // Fonts and (optional) logo load in parallel; the logo is decorative and
  // skipped silently if unavailable.
  const [, logo] = await Promise.all([
    ensureFonts(),
    loadImage('/iqamah-icon-transparent.png'),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderLockscreen: 2D canvas unavailable');

  // Draw in 390x844 design units (matches the CI pipeline's slight vertical
  // stretch from 390:844 to 1080:2400).
  ctx.scale(OUT_W / DESIGN_W, OUT_H / DESIGN_H);

  drawBackground(ctx, theme);
  drawParticles(ctx, theme);
  drawMoon(ctx, theme);
  if (logo) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(logo, 30, 63, 45, 45);
    ctx.restore();
  }

  const values = buildValues(todayRow, season);
  const dates = buildDates(todayRow);
  const masjidName = (config && config.display_name) || '';
  drawBottomZone(ctx, theme, values, dates, masjidName);

  return canvasToBlob(canvas);
}
