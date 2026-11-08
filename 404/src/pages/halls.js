import { api, esc, rub, planSVG, plural } from '../lib.js';
import { sessionChip } from './catalog.js';

export async function halls({ view }) {
  view.innerHTML = `<section class="page"><div class="skeleton-list">${'<div class="sk"></div>'.repeat(3)}</div></section>`;
  const data = await api('/halls');
  const card = (h) => {
    const types = h.seat_types || {};
    const seatsLine = [
      types.sofa ? `${types.sofa} мест для двоих` : null,
      types.accessible ? `${types.accessible} для колясок` : null,
    ].filter(Boolean).join(', ');
    return `
    <article class="hall-card${h.category === 'vip' ? ' is-vip' : ''}" style="--hn:'${h.hall_number}'">
      <header class="hall-card-head">
        <span class="hall-num" aria-hidden="true">${h.hall_number}</span>
        <div>
          <h3 class="hall-name">${esc(h.name)}</h3>
          <p class="hall-sub">${esc(h.subtitle || '')}</p>
        </div>
      </header>
      <div class="hall-plan">${planSVG(h.plan)}</div>
      <dl class="hall-facts">
        <div><dt>Мест</dt><dd>${h.capacity}</dd></div>
        <div><dt>Рядов</dt><dd>${h.rows}</dd></div>
        <div><dt>До поля</dt><dd>от ${Math.max(4, Math.round(Number(h.room_depth_m) / 3))} м</dd></div>
        <div><dt>Билет</dt><dd>от ${rub(h.price_from)}</dd></div>
      </dl>
      <p class="hall-tech">${h.category === 'vip' ? 'Закрытая ложа с панорамным видом на поле.' : 'Открытая трибуна, места с номерами, подъём рядов для обзора.'}${seatsLine ? ' ' + seatsLine + '.' : ''}</p>
      <ul class="feature-list">${(h.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${h.next?.length ? `<div class="hall-next"><p class="mini-label">Ближайшие матчи</p><div class="chips small">${h.next.map((s) => sessionChip(s, s.title)).join('')}</div></div>` : ''}
      <a class="btn btn-ghost hall-cta" href="/sector/${h.id}">Открыть сектор в 3D и посмотреть на поле</a>
    </article>`;
  };
  const std = data.halls.filter((h) => h.category === 'standard');
  const vip = data.halls.filter((h) => h.category === 'vip');
  view.innerHTML = `
  <section class="page">
    <h1 class="page-title">Сектора стадиона</h1>
    <p class="lead">На арене восемь секторов. В каждом можно сесть на любое место, посмотреть на поле и услышать трибуны так, как они звучат с этой точки.</p>
    <h2 class="section-title with-count">Трибуны <span>${std.length}</span></h2>
    <div class="hall-grid">${std.map(card).join('')}</div>
    <h2 class="section-title with-count vip">VIP-ложи <span>${vip.length}</span></h2>
    <p class="section-note">Мягкие кресла, обслуживание и увеличенный шаг рядов. Из центральной ложи поле видно как тактическую схему.</p>
    <div class="hall-grid vip">${vip.map(card).join('')}</div>
  </section>`;
}
