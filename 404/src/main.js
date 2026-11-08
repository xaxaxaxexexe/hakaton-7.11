import { motifSVG, bandSVG } from './ornament.js';
import * as sound from './audio/engine.js';

// ---------- маршруты ----------
const routes = [
  [/^\/$/, () => import('./pages/catalog.js').then((m) => m.home), 'home'],
  [/^\/match\/([0-9a-f-]{36})$/, () => import('./pages/catalog.js').then((m) => m.movie), 'home'],
  [/^\/sectors$/, () => import('./pages/halls.js').then((m) => m.halls), 'halls'],
  [/^\/sector\/([0-9a-f-]{36})$/, () => import('./pages/scene.js').then((m) => m.hallPage), 'halls'],
  [/^\/seats\/([0-9a-f-]{36})$/, () => import('./pages/scene.js').then((m) => m.sessionPage), 'home'],
  [/^\/checkout\/([0-9a-f-]{36})$/, () => import('./pages/orders.js').then((m) => m.checkout), 'tickets'],
  [/^\/pay\/([0-9a-f-]{36})$/, () => import('./pages/orders.js').then((m) => m.pay), null],
  [/^\/order\/([0-9a-f-]{36})$/, () => import('./pages/orders.js').then((m) => m.order), 'tickets'],
  [/^\/tickets$/, () => import('./pages/orders.js').then((m) => m.tickets), 'tickets'],
];

const view = document.getElementById('view');
let cleanup = null;
let renderId = 0;

export function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  render();
}

async function render() {
  const id = ++renderId;
  const url = new URL(location.href);
  const match = routes.map(([re, load, nav]) => ({ m: url.pathname.match(re), load, nav })).find((r) => r.m);
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  document.body.classList.remove('is-3d', 'in-seat', 'is-sandbox');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('is-current', a.dataset.nav === match?.nav));
  if (!match) {
    view.innerHTML = `<section class="page narrow"><h1 class="page-title">Такой страницы нет</h1><p class="lead">Возможно, ссылка устарела. Вернитесь к <a href="/">матчам</a>.</p></section>`;
    return;
  }
  view.innerHTML = '<div class="page-loading" aria-label="Загрузка"><span></span></div>';
  try {
    const page = await match.load();
    if (id !== renderId) return;
    window.scrollTo(0, 0);
    cleanup = await page({ view, params: match.m.slice(1), query: url.searchParams, navigate });
  } catch (e) {
    console.error(e);
    if (id !== renderId) return;
    view.innerHTML = `<section class="page narrow"><h1 class="page-title">Не получилось загрузить страницу</h1><p class="lead">${e.message || 'Попробуйте обновить страницу.'}</p><button class="btn btn-primary" onclick="location.reload()">Обновить</button></section>`;
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//')) return;
  e.preventDefault();
  sound.ui('tap');
  navigate(href);
});
window.addEventListener('popstate', render);

// ---------- шапка и звук ----------
document.querySelector('.brand-mark').innerHTML = motifSVG({ stroke: '#3ddc84', accent: '#e8ff3a', width: 5 });
document.documentElement.style.setProperty('--band', bandSVG('#3ddc84', 12));
document.documentElement.style.setProperty('--band-red', bandSVG('#e8ff3a', 12));
document.body.classList.add('ui-in');

const soundBtn = document.getElementById('soundBtn');
const paintSound = (on) => {
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.querySelector('span').textContent = on ? 'Звук включён' : 'Включить звук';
};
soundBtn.addEventListener('click', async () => {
  if (sound.isOn()) sound.disable(); else await sound.enable();
});
sound.onChange(paintSound);
paintSound(false);
if (sound.wantsSound()) sound.resumeOnGesture();

render();
