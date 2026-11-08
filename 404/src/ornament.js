// Вайнахский орнамент: ромб с «бараньими рогами» по углам (мотив истангов),
// и бегущая спираль для бордюров. Одни и те же контуры идут в SVG и в canvas.

export const RHOMB = 'M50 22 L78 50 L50 78 L22 50 Z';
export const RHOMB_IN = 'M50 37 L63 50 L50 63 L37 50 Z';
export const RHOMB_CORE = 'M50 45 L55 50 L50 55 L45 50 Z';
export const HORN_L = 'M50 22 C45 13 34 7 25 10 C16 13 14 25 21 30 C27 34 34 30 32 24 C30.5 20 25.5 20.5 25.5 24.5';
export const HORN_R = 'M50 22 C55 13 66 7 75 10 C84 13 86 25 79 30 C73 34 66 30 68 24 C69.5 20 74.5 20.5 74.5 24.5';
// Звено бордюра, 30×20
export const BAND_UNIT = 'M0 16 L6 16 C13 16 16 12 16 8 C16 3.5 11 2 8.6 5.2 C7 7.4 8.6 10 11 9.4';

const ROT = [0, 90, 180, 270];

/** Знак стадиона как SVG-разметка (viewBox 0 0 100 100): чаша трибун и поле. */
export function motifSVG({ stroke = 'currentColor', fill = 'none', accent = 'currentColor', width = 3, draw = false, cls = '' } = {}) {
  const pl = draw ? ' pathLength="1"' : '';
  return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
    <g fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">
      <path${pl} d="M50 8 C82 8 94 26 94 50 C94 74 82 92 50 92 C18 92 6 74 6 50 C6 26 18 8 50 8 Z"/>
      <path${pl} d="M24 30 H76 V70 H24 Z"/>
      <path${pl} d="M50 30 V70"/>
      <path${pl} d="M50 41 A9 9 0 1 1 49.9 41"/>
      <path${pl} d="M24 42 H31 V58 H24 M76 42 H69 V58 H76"/>
    </g>
    <circle class="m-in" cx="50" cy="50" r="4.5" fill="${accent}"/>
  </svg>`;
}

/** Бордюр как SVG <pattern>-строка для фона. */
export function bandSVG(color = '#c9a04a', h = 14) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20" viewBox="0 0 30 20"><path d="${BAND_UNIT}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/><path d="M0 16 L30 16" stroke="${color}" stroke-width="1.6"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") repeat-x left center / auto ${h}px`;
}

// ---------- canvas ----------
const P = typeof Path2D !== 'undefined' ? {
  rh: new Path2D(RHOMB), rin: new Path2D(RHOMB_IN), core: new Path2D(RHOMB_CORE),
  hl: new Path2D(HORN_L), hr: new Path2D(HORN_R), band: new Path2D(BAND_UNIT),
} : null;

export function drawMotif(ctx, x, y, size, { stroke, accent, width = 3.2 }) {
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 100, size / 100);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(P.rh);
  for (const a of ROT) {
    ctx.save();
    ctx.translate(50, 50); ctx.rotate((a * Math.PI) / 180); ctx.translate(-50, -50);
    ctx.stroke(P.hl); ctx.stroke(P.hr);
    ctx.restore();
  }
  ctx.fillStyle = accent; ctx.fill(P.rin);
  ctx.fillStyle = stroke; ctx.fill(P.core);
  ctx.restore();
}

export function drawBand(ctx, x, y, w, h, color, flip = false) {
  const s = h / 20;
  ctx.save();
  ctx.translate(x, y);
  if (flip) { ctx.translate(0, h); ctx.scale(1, -1); }
  ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  const units = Math.ceil(w / s / 30) + 1;
  for (let i = 0; i < units; i++) {
    ctx.save(); ctx.translate(i * 30, 0); ctx.stroke(P.band); ctx.restore();
  }
  ctx.beginPath(); ctx.moveTo(0, 16); ctx.lineTo(units * 30, 16); ctx.stroke();
  ctx.restore();
}

/** Текстура панели стены: войлок, бордюры, колонка мотивов. */
export function panelCanvas({ w = 512, h = 1024, bg = '#3a1420', stroke = '#c9a04a', accent = '#9e2236' } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  // войлочная фактура
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const m = 34;
  ctx.strokeStyle = stroke; ctx.lineWidth = 3;
  ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(m + 10, m + 10, w - 2 * m - 20, h - 2 * m - 20);
  drawBand(ctx, m + 20, m + 22, w - 2 * m - 40, 36, stroke);
  drawBand(ctx, m + 20, h - m - 58, w - 2 * m - 40, 36, stroke, true);
  const size = w * 0.62;
  const ys = [h * 0.3, h * 0.5, h * 0.7];
  ys.forEach((yy, i) => drawMotif(ctx, w / 2, yy, i === 1 ? size * 1.15 : size * 0.8, { stroke, accent, width: 3.4 }));
  return c;
}

/** Ковролин: мелкий тёмный повтор мотива. */
export function carpetCanvas({ size = 256, bg = '#191c36', fg = '#262a4d' } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
  drawMotif(ctx, size / 2, size / 2, size * 0.7, { stroke: fg, accent: fg, width: 4 });
  [[0, 0], [size, 0], [0, size], [size, size]].forEach(([x, y]) =>
    drawMotif(ctx, x, y, size * 0.36, { stroke: fg, accent: bg, width: 5 }));
  return c;
}

/** Длинный бордюр для фронта сцены. */
export function bandCanvas({ w = 2048, h = 96, bg = '#1a0d14', stroke = '#c9a04a' } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  drawBand(ctx, 0, h * 0.08, w, h * 0.42, stroke);
  drawBand(ctx, 15 * (h * 0.42) / 20, h * 0.5, w, h * 0.42, stroke, true);
  return c;
}
