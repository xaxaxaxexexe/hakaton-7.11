import QRCode from 'qrcode';
import { api, esc, rub, time, fullDate, plural, poster, orders, toast } from '../lib.js';
import { motifSVG } from '../ornament.js';
import * as sound from '../audio/engine.js';

const hallName = (h) => h.name;
const STATUS = { pending: 'Ждёт оплаты', paid: 'Оплачен', expired: 'Бронь истекла', cancelled: 'Отменён', refunded: 'Возвращён' };

function needToken(id) {
  const o = orders.get(id);
  if (!o) throw new Error('Этот заказ открыт на другом устройстве или в другом браузере. Билеты доступны там, где вы их бронировали.');
  return o.token;
}
function ticketHead(o) {
  const sc = o.screening;
  return `<div class="tk-head">
    <div class="tk-poster">${poster(sc.movie)}</div>
    <div><h2 class="tk-title">${esc(sc.movie.title)}</h2>
      <p class="tk-when">${fullDate(sc.starts_at)}</p>
      <p class="tk-where">${esc(sc.cinema.name)}, ${esc(sc.cinema.address)}. ${esc(hallName(sc.hall))}</p></div>
  </div>`;
}

// ---------- Оформление: таймер брони и переход к оплате ----------
export async function checkout({ view, params, query, navigate }) {
  const id = params[0]; const token = needToken(id);
  let o = await api(`/orders/${id}?token=${token}`);
  if (o.status === 'paid') { navigate('/order/' + id, { replace: true }); return; }
  const declined = query.get('declined') === '1';
  view.innerHTML = `
  <section class="page narrow">
    <a class="back-link" href="/seats/${o.screening.id}">Вернуться к выбору мест</a>
    <h1 class="page-title">Оплата брони</h1>
    ${declined ? '<p class="notice">Банк отклонил платёж. Деньги не списаны, места всё ещё за вами. Попробуйте ещё раз.</p>' : ''}
    <article class="ticket-card">
      ${ticketHead(o)}
      <div class="ticket-perf" aria-hidden="true"></div>
      <ul class="tk-seats">${o.seats.map((s) => `<li><span>Ряд ${s.row}, место ${s.num}</span><span>${rub(s.price)}</span></li>`).join('')}
        <li class="t-total"><span>Итого</span><span>${rub(o.total)}</span></li></ul>
      <div class="hold" id="hold"></div>
      <div class="tk-actions" id="actions"></div>
    </article>
  </section>`;
  const $ = (s) => view.querySelector(s);
  const actions = () => {
    if (o.status === 'pending') {
      $('#actions').innerHTML = `<button class="btn btn-primary" id="payBtn">Оплатить ${rub(o.total)}</button><button class="btn btn-quiet" id="cancelBtn">Отменить бронь</button>`;
      $('#payBtn').onclick = async () => {
        $('#payBtn').disabled = true; $('#payBtn').textContent = 'Переходим к оплате…';
        try { const p = await api(`/orders/${id}/payment`, { method: 'POST', body: { token } }); navigate(`/pay/${p.session_id}?order=${id}`); }
        catch (e) { toast(e.message); o = await api(`/orders/${id}?token=${token}`); actions(); }
      };
      $('#cancelBtn').onclick = async () => {
        try { await api(`/orders/${id}/cancel`, { method: 'POST', body: { token } }); o = await api(`/orders/${id}?token=${token}`); toast('Бронь отменена, места снова свободны.'); actions(); }
        catch (e) { toast(e.message); }
      };
    } else {
      $('#hold').innerHTML = '';
      $('#actions').innerHTML = `<p class="muted">${o.status === 'expired' ? 'Бронь истекла, места вернулись в продажу.' : STATUS[o.status]}</p><a class="btn btn-primary" href="/seats/${o.screening.id}">Выбрать места заново</a>`;
    }
  };
  actions();
  const tick = () => {
    if (o.status !== 'pending') return;
    const left = Math.max(0, new Date(o.expires_at).getTime() - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    $('#hold').innerHTML = `<span class="hold-time">${mm}:${String(ss).padStart(2, '0')}</span><span>столько ещё места держатся за вами</span>`;
    $('#hold').classList.toggle('is-low', left < 120000);
    if (left === 0) { o.status = 'expired'; actions(); }
  };
  tick();
  const t = setInterval(tick, 1000);
  return () => clearInterval(t);
}

// ---------- Тестовый платёжный шлюз ----------
export async function pay({ view, params, query, navigate }) {
  document.body.classList.add('is-sandbox');
  const s = await api('/sandbox/' + params[0]);
  const orderId = query.get('order') || s.order_id;
  view.innerHTML = `
  <section class="sandbox">
    <div class="sbx-card">
      <div class="sbx-brand"><span class="sbx-logo" aria-hidden="true"></span><strong>Sandbox Pay</strong><span class="sbx-tag">тестовый режим</span></div>
      <p class="sbx-note">Это учебный платёжный шлюз для демонстрации. Данные карты не нужны, деньги не списываются.</p>
      <dl class="sbx-lines">
        <div><dt>Получатель</dt><dd>Sphera 3D, демо</dd></div>
        <div><dt>Назначение</dt><dd>${esc('Билеты на матч')}</dd></div>
        <div class="sbx-sum"><dt>К оплате</dt><dd>${rub(s.amount)}</dd></div>
      </dl>
      <div class="sbx-actions">
        <button class="btn sbx-pay" id="ok">Оплатить ${rub(s.amount)}</button>
        <button class="btn sbx-decline" id="no">Отклонить платёж</button>
      </div>
      <p class="sbx-fine">Шлюз подписывает уведомление об оплате, а магазин проверяет подпись и сумму перед выдачей билетов.</p>
    </div>
  </section>`;
  const finish = async (outcome) => {
    view.querySelectorAll('.sbx-actions button').forEach((b) => (b.disabled = true));
    view.querySelector(outcome === 'success' ? '#ok' : '#no').textContent = outcome === 'success' ? 'Проводим платёж…' : 'Отклоняем…';
    try {
      const r = await api(`/sandbox/${params[0]}/complete`, { method: 'POST', body: { outcome } });
      if (r.status === 'succeeded') navigate('/order/' + orderId, { replace: true });
      else if (r.status === 'declined') navigate(`/checkout/${orderId}?declined=1`, { replace: true });
      else navigate('/order/' + orderId, { replace: true });
    } catch (e) { toast(e.message); view.querySelectorAll('.sbx-actions button').forEach((b) => (b.disabled = false)); }
  };
  view.querySelector('#ok').onclick = () => finish('success');
  view.querySelector('#no').onclick = () => finish('decline');
  if (s.status !== 'open') navigate('/order/' + orderId, { replace: true });
}

// ---------- Билеты заказа ----------
export async function order({ view, params }) {
  const id = params[0]; const token = needToken(id);
  const o = await api(`/orders/${id}?token=${token}`);
  if (o.status === 'paid') {
    const qrs = await Promise.all(o.tickets.map((t) => QRCode.toString(t.code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#13201a', light: '#0000' } })));
    view.innerHTML = `
    <section class="page narrow">
      <p class="paid-mark" aria-hidden="true">${motifSVG({ stroke: '#3ddc84', accent: '#168a4a', width: 3, draw: true })}</p>
      <h1 class="page-title center">Билеты оплачены</h1>
      <p class="lead center">${o.tickets.length} ${plural(o.tickets.length, 'билет', 'билета', 'билетов')} на ${o.email}. Покажите QR-код на входе на стадион.</p>
      <div class="tickets">${o.tickets.map((t, i) => `
        <article class="ticket-card qr">
          ${ticketHead(o)}
          <div class="ticket-perf" aria-hidden="true"></div>
          <div class="tk-qr-row">
            <div class="tk-qr" role="img" aria-label="QR-код билета">${qrs[i]}</div>
            <dl class="tk-seat"><div><dt>Ряд</dt><dd>${t.row}</dd></div><div><dt>Место</dt><dd>${t.num}</dd></div>
              <div class="tk-code"><dt>Код</dt><dd>${t.code.slice(0, 8).toUpperCase()}</dd></div></dl>
          </div>
          <a class="btn btn-ghost" href="/seats/${o.screening.id}?seat=${o.seats.find((s) => s.row === t.row && s.num === t.num)?.seat_id}">Посмотреть вид и звук с этого места</a>
        </article>`).join('')}</div>
      <p class="center"><a href="/tickets">Все мои билеты</a></p>
    </section>`;
    sound.ui('success');
    const o2 = orders.get(id); if (o2) orders.save({ ...o2, status: 'paid' });
    return;
  }
  view.innerHTML = `<section class="page narrow"><h1 class="page-title">${STATUS[o.status] || o.status}</h1>
    <article class="ticket-card">${ticketHead(o)}</article>
    ${o.status === 'pending' ? `<a class="btn btn-primary" href="/checkout/${id}">Перейти к оплате</a>` : `<a class="btn btn-primary" href="/seats/${o.screening.id}">Выбрать места заново</a>`}
    ${o.payment?.status === 'failed_late' ? '<p class="notice">Оплата пришла после окончания брони. В реальном магазине деньги вернулись бы автоматически.</p>' : ''}
  </section>`;
}

// ---------- Мои билеты ----------
export async function tickets({ view }) {
  const list = orders.all();
  view.innerHTML = `<section class="page narrow"><h1 class="page-title">Мои билеты</h1><div id="list" class="order-list">${list.length ? '<div class="skeleton-list"><div class="sk"></div></div>' : ''}</div></section>`;
  if (!list.length) {
    view.querySelector('#list').innerHTML = '<div class="empty"><p>Здесь появятся билеты, которые вы забронируете в этом браузере.</p><a class="btn btn-primary" href="/">Перейти к матчам</a></div>';
    return;
  }
  const rows = await Promise.all(list.map(async (x) => { try { return await api(`/orders/${x.id}?token=${x.token}`); } catch { return null; } }));
  view.querySelector('#list').innerHTML = rows.filter(Boolean).map((o) => `
    <a class="order-line" href="${o.status === 'pending' ? '/checkout/' : '/order/'}${o.id}">
      <span class="ol-poster">${poster(o.screening.movie)}</span>
      <span class="ol-main"><strong>${esc(o.screening.movie.title)}</strong><span>${fullDate(o.screening.starts_at)}, ${esc(hallName(o.screening.hall))}</span>
      <span>${o.seats.map((s) => `ряд ${s.row}, место ${s.num}`).join('; ')}</span></span>
      <span class="ol-status st-${o.status}">${STATUS[o.status] || o.status}</span>
    </a>`).join('') || '<div class="empty"><p>Заказы не найдены.</p></div>';
}
