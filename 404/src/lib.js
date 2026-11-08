// Общие помощники: API, форматирование, постеры, сохранённые заказы.
import { stadiumize, sectorOf } from './stadium.js';

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Сервис временно недоступен, попробуйте ещё раз'), { status: res.status });
  return stadiumize(data);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const rub = (n) => Math.round(Number(n)).toLocaleString('ru-RU') + ' ₽';
const TZ = 'Europe/Moscow';
export const time = (d) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d));
export const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
export function dayLabel(key) {
  const today = dayKey(new Date());
  const tomorrow = dayKey(Date.now() + 864e5);
  const d = new Date(key + 'T12:00:00+03:00');
  const wd = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: TZ }).format(d);
  const dm = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: TZ }).format(d);
  return { top: key === today ? 'Сегодня' : key === tomorrow ? 'Завтра' : wd.charAt(0).toUpperCase() + wd.slice(1), bottom: dm };
}
export const fullDate = (d) => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d));
export const dateLong = (d) => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date(d));
export const duration = (m) => `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
export const plural = (n, a, b, c) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b;
  return c;
};
export const hallLabel = (h) => sectorOf(h.hall_number).name;
export const hallShort = (s) => s.category === 'vip' ? s.hall_name : s.hall_name;
export const phaseOf = (id = '') => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

// ---------- карточка матча из палитры и мотива ----------
const MOTIF = {
  tower: '<path d="M36 70V36l2-6 2 6v34z" fill="C3"/><path d="M37 42h2M37 50h2M37 58h2" stroke="C1" stroke-width=".8" opacity=".7"/>',
  mountains: '<path d="M0 64 14 40l8 10 12-20 12 18 6-8 8 10v34H0z" fill="C3" opacity=".9"/><path d="M34 30l-4 6h8z" fill="#fff" opacity=".8"/>',
  city: '<g fill="C3"><rect x="6" y="48" width="8" height="36"/><rect x="16" y="38" width="7" height="46"/><rect x="25" y="26" width="9" height="58"/><rect x="36" y="34" width="8" height="50"/><rect x="46" y="44" width="9" height="40"/></g><g fill="C1" opacity=".9"><rect x="27" y="32" width="2" height="2"/><rect x="31" y="40" width="2" height="2"/><rect x="18" y="46" width="2" height="2"/><rect x="38" y="42" width="2" height="2"/></g>',
  bird: '<path d="M14 40c8-6 14-6 16 0 2-6 10-8 18-2-8 0-12 4-17 10-5-6-9-8-17-8z" fill="C3"/><path d="M0 72c20-8 40-8 60 0v12H0z" fill="C3" opacity=".8"/>',
  stars: '<circle cx="42" cy="22" r="7" fill="C3" opacity=".9"/><g fill="#fff"><circle cx="10" cy="14" r=".8"/><circle cx="22" cy="30" r=".6"/><circle cx="50" cy="44" r=".7"/><circle cx="14" cy="50" r=".5"/><circle cx="32" cy="10" r=".6"/></g><path d="M0 74c16-6 44-6 60 0v10H0z" fill="C3"/>',
  future: '<circle cx="30" cy="34" r="14" fill="none" stroke="C3" stroke-width="2"/><path d="M12 84V58h10v26M26 84V48h8v36M38 84V54h10v30" fill="C3"/>',
  sea: '<path d="M26 70V36h6v34z" fill="C3"/><path d="M29 36 6 26M29 36l24-10" stroke="C1" stroke-width="1.6" opacity=".8"/><path d="M0 70c10-3 20 3 30 0s20-3 30 0v14H0z" fill="C3"/>',
  peak: '<path d="M0 70 30 18l30 52z" fill="C3"/><path d="M30 18l-7 12 4-2 3 4 3-4 4 2z" fill="#fff"/>',
};
const initials = (n = '') => n.replace(/[^A-Za-zА-Яа-яЁё0-9 -]/g, '').split(/[\s-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function crest(x, y, color, name) {
  return `<g transform="translate(${x} ${y})"><path d="M0 -11 L10 -7 V3 C10 9 5 12 0 14 C-5 12 -10 9 -10 3 V-7 Z" fill="${color}" stroke="#fff" stroke-width="1.2"/>
    <text y="4" text-anchor="middle" font-size="8" font-weight="700" font-family="Unbounded, sans-serif" fill="${color === '#f4f4f0' ? '#0d2a1b' : '#fff'}">${esc(initials(name))}</text></g>`;
}
export function poster(m, cls = 'poster-svg') {
  const [c1, c2] = m.colors?.length ? m.colors : ['#1fa35a', '#f4f4f0'];
  const id = 'pg' + (m.id || '').slice(0, 8);
  return `<svg class="${cls}" viewBox="0 0 60 84" role="img" aria-label="Матч: ${esc(m.title)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1f15"/><stop offset="1" stop-color="#14532d"/></linearGradient></defs>
    <rect width="60" height="84" fill="url(#${id})"/>
    <g fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width=".8"><rect x="6" y="52" width="48" height="28"/><path d="M30 52v28"/><circle cx="30" cy="66" r="6"/></g>
    <g fill="#ffffff" opacity=".55">${Array.from({ length: 14 }, (_, i) => `<circle cx="${4 + i * 4}" cy="${8 + (i % 3)}" r=".7"/>`).join('')}</g>
    ${crest(17, 32, c1, m.home)}${crest(43, 32, c2, m.away)}
    <text x="30" y="35" text-anchor="middle" font-size="6" font-weight="700" font-family="Unbounded, sans-serif" fill="#e8ff3a">VS</text>
  </svg>`;
}

// ---------- мини-план зала ----------
export function planSVG(plan, cls = 'plan') {
  if (!plan?.length) return '';
  const xs = plan.map((p) => p.x), zs = plan.map((p) => p.z);
  const minX = Math.min(...xs) - 0.6, maxX = Math.max(...xs) + 0.6, minZ = Math.min(...zs) - 0.6, maxZ = Math.max(...zs) + 0.6;
  const w = maxX - minX, h = maxZ - minZ + 1.4;
  const dots = plan.map((p) => `<rect x="${(p.x - minX - 0.25).toFixed(2)}" y="${(p.z - minZ + 1.4 - 0.25).toFixed(2)}" width=".5" height=".5" rx=".12" class="pd ${p.t}"/>`).join('');
  return `<svg class="${cls}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" aria-hidden="true"><path d="M${(w * 0.08).toFixed(2)} .5 Q${(w / 2).toFixed(2)} 0 ${(w * 0.92).toFixed(2)} .5" class="pscreen"/>${dots}</svg>`;
}

// ---------- сохранённые заказы ----------
const OK = 'sphera-orders';
export const orders = {
  all() { try { return JSON.parse(localStorage.getItem(OK) || '[]'); } catch { return []; } },
  get(id) { return this.all().find((o) => o.id === id); },
  save(o) { try { const list = this.all().filter((x) => x.id !== o.id); list.unshift(o); localStorage.setItem(OK, JSON.stringify(list.slice(0, 30))); } catch {} },
};
export const rememberEmail = (e) => { try { if (e) localStorage.setItem('sphera-email', e); return localStorage.getItem('sphera-email') || ''; } catch { return ''; } };

let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('is-on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('is-on'), 3200);
}
