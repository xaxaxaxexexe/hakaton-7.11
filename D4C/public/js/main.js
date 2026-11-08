import * as api from './api.js'; import { renderMap } from './seatmap.js'; import { createView } from './view3d.js'; import { playSeat } from './sound.js';
const $ = s => document.querySelector(s), app = $('#app');
const S = { cinemas: [], cinema: null, sessions: [], day: null, session: null, seats: [], seat: null, busy: false, movies: null, from: null, mid: null, timer: null };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = n => Number(n).toLocaleString('ru') + ' ₽', tm = d => new Date(d).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const dt = d => new Date(d).toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'long' });
const STEPS = ['Стадион', 'Матч', 'Место', 'Покупка'];
function shell(step, html) { clearInterval(S.timer); $('#steps').hidden = step < 0; $('#steps').innerHTML = STEPS.map((t, i) => `<li class="${i === step ? 'on' : step >= 0 && i < step ? 'done' : ''}">${t}</li>`).join(''); app.innerHTML = html; }
async function guard(step, fn) {
  shell(step, '<p class="note">Загрузка…</p>');
  try { await fn(); } catch (e) { shell(step, `<div class="err"><p>${esc(e.message)}</p><button class="cta" id="retry">Повторить</button></div>`); $('#retry').onclick = () => guard(step, fn); }
}

const cinemasView = () => guard(0, async () => {
  S.cinemas = await api.cinemas();
  if (!S.cinemas.length) return shell(0, '<h1>Стадионов пока нет</h1><p class="note">Выполните <code>npm run seed</code>, чтобы заполнить базу.</p>');
  shell(0, `<h1>Выберите стадион</h1><div class="grid">${S.cinemas.map(c => `<button class="card cin" data-id="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.address)}</span><small>${esc(c.description)}</small></button>`).join('')}</div>`);
  app.querySelectorAll('.cin').forEach(b => b.onclick = () => { S.cinema = S.cinemas.find(c => c.id == b.dataset.id); S.session = S.seat = S.day = null; S.from = null; sessionsView(); });
});

const sessionsView = () => guard(1, async () => {
  S.sessions = await api.sessions(S.cinema.id);
  const days = [...new Set(S.sessions.map(s => new Date(s.starts_at).toDateString()))];
  if (!days.length) { shell(1, `<button class="link" id="back">← Стадионы</button><h1>Матчей пока нет</h1><p class="note">В «${esc(S.cinema.name)}» нет ближайших матчей. Выберите другой стадион.</p>`); $('#back').onclick = cinemasView; return; }
  if (!days.includes(S.day)) S.day = days[0];
  const list = S.sessions.filter(s => new Date(s.starts_at).toDateString() === S.day), movies = [...new Map(list.map(s => [s.movie_id, s])).values()];
  shell(1, `<button class="link" id="back">← Стадионы</button><h1>${esc(S.cinema.name)}</h1>
    <div class="tabs">${days.map(d => `<button data-d="${d}" class="${d === S.day ? 'on' : ''}">${dt(d)}</button>`).join('')}</div>
    ${movies.map(m => `<div class="card film"><div class="poster" style="--h:${m.hue}"></div><div><h2>${esc(m.title)}</h2><small>${esc(m.genre)} · ${m.duration} мин</small><p>${esc(m.description)}</p>
      <div class="times">${list.filter(s => s.movie_id === m.movie_id).map(s => `<button class="time" data-id="${s.id}" ${s.free ? '' : 'disabled'}><b>${tm(s.starts_at)}</b> ${esc(s.format)}<br><small>${esc(s.hall)} · ${s.free ? s.free + ' мест' : 'мест нет'}</small></button>`).join('')}</div></div></div>`).join('')}`);
  $('#back').onclick = cinemasView;
  app.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.day = b.dataset.d; sessionsView(); });
  app.querySelectorAll('.time').forEach(b => b.onclick = () => { S.seat = null; S.from = null; seatsView(+b.dataset.id); });
});

const seatsView = (id = S.session.id, msg = '') => guard(2, async () => {
  [S.session, S.seats] = await Promise.all([api.session(id), api.seats(id)]);
  S.seat = S.seat && S.seats.find(s => s.id === S.seat.id && !s.taken) || null;
  const tiers = new Map(); S.seats.forEach(s => { const k = s.seat_type + s.price, t = tiers.get(k) || { type: s.seat_type, price: s.price, a: 99, b: 0 }; t.a = Math.min(t.a, s.row_num); t.b = Math.max(t.b, s.row_num); tiers.set(k, t); });
  const free = S.seats.filter(s => !s.taken).length;
  shell(2, `<button class="link" id="back">${S.from === 'movie' ? '← К матчу' : '← Расписание'}</button><h1>${esc(S.session.title)}</h1><p class="note">${esc(S.session.cinema)} · ${esc(S.session.hall)} · ${dt(S.session.starts_at)}, ${tm(S.session.starts_at)}</p>
    ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}${free ? '' : '<p class="msg">Свободных мест на этот матч нет.</p>'}
    <div class="hall"><div><div id="map"></div><div class="legend"><span><i style="border:1.6px solid #eef3ee"></i>Свободно</span><span><i style="background:#2c3a32"></i>Занято</span><span><i style="background:#1fa35a"></i>Ваше место</span></div></div>
    <aside class="card" id="panel"></aside></div>`);
  $('#back').onclick = () => S.from === 'movie' ? movieView(S.mid) : sessionsView();
  const draw = () => {
    renderMap($('#map'), S.seats, S.seat?.id, S.session.screen_w, pid => { S.seat = S.seats.find(s => s.id === pid); draw(); });
    const t = [...tiers.values()].map(t => `<li><b>${rub(t.price)}</b> <small>${t.type === 'sofa' ? 'Ложи' : t.a === t.b ? 'Ряд ' + t.a : 'Ряды ' + t.a + '–' + t.b}</small></li>`).join('');
    $('#panel').innerHTML = S.seat ? `<small>Ваше место</small><h2>${esc(S.seat.label)}</h2><div class="price">${rub(S.seat.price)}</div><button class="cta" id="see">Сесть и посмотреть на поле</button><button class="ghost" id="buy">Купить билет</button><ul class="tiers">${t}</ul>`
      : `<h2>Выберите место</h2><p class="note">Нажмите на свободное место на схеме: покажем цену и вид на поле.</p><ul class="tiers">${t}</ul>`;
    if (S.seat) { $('#see').onclick = open3d; $('#buy').onclick = () => checkoutView(); }
  };
  draw();
});

// ---- 3D-вид ----
let view = null;
function open3d() {
  const box = $('#view'); box.hidden = false; $('#v-note').textContent = '';
  const close = () => { view?.dispose(); view = null; box.hidden = true; seatsView(); };
  const upd = () => { $('#v-title').textContent = S.seat.label; $('#v-buy').textContent = `Купить за ${rub(S.seat.price)}`; };
  try { view = createView($('#host'), S.session, S.seats); view.setSeat(S.seat); upd(); }
  catch { $('#v-title').textContent = ''; $('#v-note').textContent = 'WebGL недоступен в этом браузере — 3D-вид показать нельзя. Вернитесь к местам.'; }
  $('#v-back').onclick = close; $('#v-buy').onclick = () => { view?.dispose(); view = null; box.hidden = true; checkoutView(); };
  $('#v-snd').onclick = () => { $('#v-note').textContent = playSeat(S.seat, S.session.screen_w); };
  // ?debug — быстрые кнопки трёх контрольных мест
  $('#v-dbg').innerHTML = location.search.includes('debug') ? ['1:3', '6:12', 'L:L'].map(k => `<button data-k="${k}">${k}</button>`).join('') : '';
  $('#v-dbg').onclick = e => { const k = e.target.dataset.k; if (!k || !view) return; const mr = Math.max(...S.seats.map(s => s.row_num)), [r, n] = k.split(':'), rr = r === 'L' ? mr : +r;
    const row = S.seats.filter(s => s.row_num === rr), s = n === 'L' ? row[row.length - 1] : row.find(s => s.seat_num === +n); if (s) { S.seat = s; view.setSeat(s); upd(); } };
}

// ---- Аккаунт ----
let ME = null; const tokOn = () => !!localStorage.getItem('tok');
async function loadMe() { ME = null; if (!tokOn()) return; try { ME = await api.me(); } catch (e) { if (e.status === 401) localStorage.removeItem('tok'); } }
function nav() { $('#nav').innerHTML = ME ? `<a href="#/tickets">Мои билеты</a><a href="#/account">${esc(ME.user.name)} · ${rub(ME.user.balance)}</a>` : '<a href="#/login">Войти</a>'; }
const needLogin = () => { if (!ME) { location.hash = '#/login'; return true; } };
const cd = ms => { if (ms <= 0) return 'матч начался'; const m = Math.floor(ms / 6e4), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return d ? `${d} дн ${h} ч` : h ? `${h} ч ${m % 60} мин` : `${m} мин`; };
setInterval(() => document.querySelectorAll('[data-cd]').forEach(e => e.textContent = cd(new Date(e.dataset.cd) - Date.now())), 30000);
const back = () => { history.replaceState(null, '', location.pathname); S.seat && S.session ? checkoutView() : accountView(); };

function authView(mode) {
  const reg = mode === 'register';
  shell(-1, `<h1>${reg ? 'Регистрация' : 'Вход'}</h1><form id="f" class="card" style="max-width:420px">${reg ? '<label>Имя<input name="name" required maxlength="80"></label>' : ''}<label>Email<input name="email" type="email" required></label><label>Пароль<input name="password" type="password" required minlength="6"></label>
    <p class="msg" id="err"></p><button class="cta">${reg ? 'Создать аккаунт' : 'Войти'}</button><small>${reg ? 'Уже есть аккаунт? <a href="#/login">Войти</a>' : 'Нет аккаунта? <a href="#/register">Зарегистрироваться</a>'}</small></form>`);
  $('#f').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { localStorage.setItem('tok', (await api.auth(mode, f)).token); await loadMe(); nav(); back(); } catch (x) { $('#err').textContent = x.message; } };
}
const accountView = () => guard(-1, async () => {
  await loadMe(); nav(); if (needLogin()) return; const u = ME.user, n = ME.next;
  shell(-1, `<h1>Личный кабинет</h1><div class="grid"><div class="card"><h2>${esc(u.name)}</h2><small>${esc(u.email)}</small><div class="price">${rub(u.balance)}</div><a class="cta" href="#/topup">Пополнить баланс</a></div>
    <div class="card"><h2>Билеты</h2><div class="price">${ME.tickets}</div><small>активных</small><a href="#/tickets">Мои билеты</a></div>
    <div class="card"><h2>Ближайший матч</h2>${n ? `<b>${esc(n.title)}</b><small>${dt(n.starts_at)}, ${tm(n.starts_at)}</small><div class="price" data-cd="${n.starts_at}">${cd(new Date(n.starts_at) - Date.now())}</div>` : '<small>Билетов на будущие матчи нет. <a href="/">Выбрать матч</a></small>'}</div></div>
    <p><a href="#/history">История операций</a> · <small>Возврат: не позже чем за ${ME.rules.minutes} мин до матча, ${ME.rules.percent}% на баланс</small></p><button class="ghost" id="out">Выйти</button>`);
  $('#out').onclick = async () => { await api.logout().catch(() => {}); localStorage.removeItem('tok'); ME = null; nav(); location.hash = '#/login'; };
});
const topupView = () => guard(-1, async () => {
  await loadMe(); nav(); if (needLogin()) return; let amount = 1000;
  shell(-1, `<button class="link" id="b">← Кабинет</button><h1>Пополнение баланса</h1><form id="f" class="card" style="max-width:460px"><small>Сейчас на балансе: ${rub(ME.user.balance)}</small>
    <div class="tabs">${[500, 1000, 2000, 5000].map(a => `<button type="button" data-a="${a}">${rub(a)}</button>`).join('')}</div><label>Сумма, ₽<input name="amount" type="number" min="100" max="50000" step="1" value="1000" required></label>
    <label class="r"><input type="radio" name="m" value="card" checked> Банковская карта</label><label class="r"><input type="radio" name="m" value="sbp"> СБП</label>
    <p class="msg" id="err"></p><button class="cta">Пополнить (демо)</button><small>ДЕМО-ОПЛАТА: платёжный провайдер не подключён, реальные деньги не списываются.</small></form>`);
  $('#b').onclick = accountView; app.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { $('[name=amount]').value = b.dataset.a; });
  $('#f').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); try { await api.topup({ amount: +f.get('amount'), method: f.get('m') }); await loadMe(); nav(); back(); } catch (x) { $('#err').textContent = x.message; } };
});
const TYPES = { topup: 'Пополнение', purchase: 'Покупка билета', refund: 'Возврат' };
const historyView = (type = '') => guard(-1, async () => {
  await loadMe(); nav(); if (needLogin()) return; const rows = await api.transactions(type);
  shell(-1, `<button class="link" id="b">← Кабинет</button><h1>История операций</h1><div class="tabs">${[['', 'Все'], ...Object.entries(TYPES)].map(([k, v]) => `<button data-t="${k}" class="${k === type ? 'on' : ''}">${v}</button>`).join('')}</div>
    ${rows.length ? rows.map(x => `<div class="card" style="margin-bottom:8px"><b>${TYPES[x.type]}${x.title ? ' · ' + esc(x.title) : ''}</b><small>${new Date(x.created_at).toLocaleString('ru')} · ${esc(x.method)} · ${x.status === 'success' ? 'выполнено' : esc(x.status)}</small><div class="price" style="font-size:22px;${x.amount < 0 ? 'color:var(--cream)' : ''}">${x.amount > 0 ? '+' : ''}${rub(x.amount)}</div></div>`).join('') : '<p class="note">Операций пока нет.</p>'}`);
  $('#b').onclick = accountView; app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => historyView(b.dataset.t));
});
const ticketsView = (tab = 'up') => guard(-1, async () => {
  await loadMe(); nav(); if (needLogin()) return; const all = await api.myTickets(), now = Date.now();
  const tabs = { up: ['Предстоящие', t => t.status === 'paid' && new Date(t.starts_at) > now], past: ['Завершённые', t => t.status === 'paid' && new Date(t.starts_at) <= now], ref: ['Возвращённые', t => t.status === 'refunded'] };
  const list = all.filter(tabs[tab][1]); if (tab !== 'past') list.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  shell(-1, `<h1>Мои билеты</h1><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${v[0]} (${all.filter(v[1]).length})</button>`).join('')}</div>
    ${list.length ? list.map(t => `<div class="card film"><div class="poster" style="--h:${t.hue}"></div><div><h2>${esc(t.title)}</h2><div>${esc(t.cinema)}, ${esc(t.address)}<br>${esc(t.hall)} · <b>${esc(t.label)}</b><br>${dt(t.starts_at)}, ${tm(t.starts_at)} · ${rub(t.price)}</div>
      ${tab === 'up' ? `<div class="price" style="font-size:22px" data-cd="${t.starts_at}">${cd(new Date(t.starts_at) - now)}</div>` : ''}
      <div class="times"><a class="time" href="#/ticket/${t.token}">Открыть билет</a>${t.can_refund ? `<button class="time" data-r="${t.id}" data-a="${t.refund_amount}">Вернуть билет</button>` : ''}</div></div></div>`).join('') : '<p class="note">Здесь пока пусто.</p>'}`);
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => ticketsView(b.dataset.t));
  app.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => {
    if (!confirm(`Вернуть билет? На баланс вернётся ${rub(b.dataset.a)}. Место освободится.`)) return;
    try { await api.refund(b.dataset.r); await loadMe(); nav(); ticketsView(tab); } catch (x) { alert(x.message); } });
});

// ---- Покупка ----
function checkoutView(err = '') {
  const bal = ME?.user.balance ?? 0, p = S.seat.price, short = ME && bal < p;
  shell(3, `<button class="link" id="back">← К схеме</button><h1>Оформление</h1><div class="hall"><div class="card"><h2>${esc(S.session.title)}</h2><p>${esc(S.session.cinema)}, ${esc(S.session.hall)}<br>${dt(S.session.starts_at)}, ${tm(S.session.starts_at)}<br><b>${esc(S.seat.label)}</b></p></div>
    <form id="f" class="card"><div class="price">${rub(p)}</div>${ME ? `<small>Ваш баланс: ${rub(bal)}</small><label class="r"><input type="radio" name="m" value="balance" ${short ? 'disabled' : 'checked'}> Оплатить с баланса</label>
      ${short ? `<p class="msg">Не хватает ${rub(p - bal)}. <a href="#/topup">Пополнить баланс</a></p>` : ''}<label class="r"><input type="radio" name="m" value="demo" ${short ? 'checked' : ''}> Демо-оплата картой</label>`
      : `<label>Имя<input name="name" required maxlength="80" autocomplete="name"></label><label>Email (необязательно)<input name="email" type="email"></label><small><a href="#/login">Войдите</a>, чтобы платить с баланса и видеть билеты в кабинете.</small>`}
    <p class="msg" id="err">${esc(err)}</p><button class="cta" id="pay">Подтвердить покупку</button><small>Демо-оплата картой: реальные деньги не списываются.</small></form></div>`);
  $('#back').onclick = () => seatsView();
  $('#f').onsubmit = async e => {
    e.preventDefault(); if (S.busy) return; S.busy = true; $('#pay').disabled = true; $('#pay').textContent = 'Покупаем…'; const f = new FormData(e.target);
    try { const r = await api.purchase({ sessionId: S.session.id, seatId: S.seat.id, name: f.get('name'), email: f.get('email'), method: ME ? f.get('m') : 'demo' }); S.seat = null; await loadMe(); nav(); location.hash = '#/ticket/' + r.token; }
    catch (x) { if (x.status === 409) { S.seat = null; seatsView(S.session.id, x.message); } else { $('#err').textContent = x.message; $('#pay').disabled = false; $('#pay').textContent = 'Подтвердить покупку'; } }
    S.busy = false;
  };
}

const ticketView = token => guard(3, async () => {
  const t = await api.ticket(token), url = `${location.origin}/#/ticket/${t.token}`;
  shell(3, `<div class="ticket"><span class="st">${t.status === 'paid' ? 'Покупка подтверждена' : 'Билет возвращён'}</span><h2>${esc(t.title)}</h2><div>${esc(t.cinema)}, ${esc(t.address)}<br>${esc(t.hall)} · ${dt(t.starts_at)}, ${tm(t.starts_at)} · ${esc(t.format)}</div>
    <h2>${esc(t.label)}</h2><div class="price">${rub(t.price)}</div><div>Покупатель: ${esc(t.buyer_name)}<br>Заказ №${t.booking}</div><code>Проверка: ${esc(url)}</code></div>
    <button class="cta" id="home">К матчам</button>`);
  $('#home').onclick = () => { S.cinema = null; S.from = null; location.hash = '#/'; };
});

// ---- Матчи (главная), страница матча, обзоры ----
const GENRES_ALL = 'Все турниры', short = (t, n = 150) => t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
const dm = d => new Date(d).toLocaleDateString('ru', { day: 'numeric', month: 'long' });
const price = m => m.min_price ? `от <b>${rub(m.min_price)}</b>` : m.premiere ? `с ${dm(m.premiere)}` : '';
const ratingBadge = m => m.rating ? `<span class="rt ${m.rating >= 8 ? 'hi' : ''}" title="Рейтинг">★ ${m.rating.toFixed(1)}</span>` : '';
const filmCard = m => `<a class="mc" href="#/match/${m.id}"><div class="pst" style="--h:${m.hue}">${ratingBadge(m)}<span class="ag">${esc(m.age)}</span><b>${esc(m.title)}</b></div>
  <div class="g">${esc(m.genre)} · ${m.year}</div><div class="pr">${m.soon ? price(m) : `${price(m)} · ${m.formats.map(esc).join('/')}`}</div></a>`;
const loadMovies = async () => S.movies || (S.movies = await api.movies());

// Обзор: если в БД есть trailer_url — встроенный плеер, иначе демо-поле
function openTrailer(m) {
  const box = $('#trailer'), u = m.trailer_url || '', scr = $('#t-screen');
  scr.innerHTML = /^https:\/\//.test(u) ? (/\.(mp4|webm)(\?|$)/.test(u) ? `<video src="${esc(u)}" controls autoplay></video>` : `<iframe src="${esc(u)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen title="${esc(m.title)}"></iframe>`)
    : `<div class="demo" style="--h:${m.hue}"><div><h2>${esc(m.title)}</h2><p>Демо-поле обзора. Чтобы показать настоящее видео, впишите ссылку в поле <code>movies.trailer_url</code> (YouTube /embed/… или .mp4).</p></div></div>`;
  $('#t-info').innerHTML = `<h2>${esc(m.title)} — обзор</h2><p class="note">${esc(m.genre)} · ${m.year} · ${esc(m.country)} · ${esc(m.age)}</p><p>${esc(m.description)}</p><button class="cta" id="t-buy">${m.soon ? 'О матче' : 'Купить билет'}</button>`;
  box.hidden = false; document.body.style.overflow = 'hidden'; $('#t-close').focus();
  $('#t-buy').onclick = () => { closeTrailer(); location.hash = '#/match/' + m.id; };
}
function closeTrailer() { $('#t-screen').innerHTML = ''; $('#trailer').hidden = true; document.body.style.overflow = ''; }
$('#t-close').onclick = closeTrailer; $('#trailer').onclick = e => { if (e.target.id === 'trailer') closeTrailer(); };
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#trailer').hidden) closeTrailer(); });
const bindTrailers = list => app.querySelectorAll('[data-tr]').forEach(b => b.onclick = () => openTrailer(list.find(m => m.id == b.dataset.tr)));

const homeView = (tab = 'now') => guard(-1, async () => {
  const all = await loadMovies(), now = all.filter(m => !m.soon), soon = all.filter(m => m.soon).sort((a, b) => new Date(a.premiere) - new Date(b.premiere));
  if (!all.length) return shell(-1, '<h1>Матчей пока нет</h1><p class="note">Выполните <code>npm run seed</code>, чтобы заполнить базу.</p>');
  const cinemas = await api.cinemas(), tops = [...now].sort((a, b) => b.rating - a.rating).slice(0, 4), genres = [GENRES_ALL, ...new Set(now.map(m => m.genre))];
  let hi = 0, genre = GENRES_ALL, side = 'now';
  shell(-1, `${tops.length ? '<section class="hero" id="hero"></section>' : ''}
    <div class="layout"><section><div class="sec"><div class="tabs" style="margin:0"><button data-tab="now" class="${tab === 'now' ? 'on' : ''}">Ближайшие матчи (${now.length})</button><button data-tab="soon" class="${tab === 'soon' ? 'on' : ''}">Скоро (${soon.length})</button></div></div>
      ${tab === 'now' ? `<div class="tabs" id="genres">${genres.map(g => `<button data-g="${esc(g)}" class="${g === genre ? 'on' : ''}">${esc(g)}</button>`).join('')}</div>` : ''}
      <div class="films" id="films"></div></section>
    <aside class="side"><div class="tabs"><button data-s="now" class="on">Сейчас</button><button data-s="soon">Скоро</button></div><div class="sl" id="sl"></div></aside></div>
    <div class="sec" style="margin-top:36px"><h2>Стадионы</h2></div><div class="cin-row">${cinemas.map(c => `<button class="card cin" data-id="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.address)}</span><small>${esc(c.description)}</small></button>`).join('')}</div>`);
  const films = () => { const list = tab === 'soon' ? soon : now.filter(m => genre === GENRES_ALL || m.genre === genre); $('#films').innerHTML = list.length ? list.map(filmCard).join('') : '<p class="note">Матчей в этой категории пока нет.</p>'; };
  const sideList = () => { const l = side === 'now' ? [...now].sort((a, b) => new Date(a.next_start) - new Date(b.next_start)).slice(0, 6) : soon.slice(0, 6);
    $('#sl').innerHTML = l.map(m => `<a href="#/match/${m.id}"><b>${esc(m.title)}</b><small>${m.year}, ${esc(m.country)}, ${esc(m.genre)}</small><small>${m.soon ? 'Старт продаж ' + dm(m.premiere) : 'Ближайший матч: ' + tm(m.next_start)}</small></a>`).join(''); };
  const hero = () => { const m = tops[hi]; if (!m || !$('#hero')) return;
    $('#hero').style.setProperty('--h', m.hue);
    $('#hero').innerHTML = `<div><div class="meta"><span class="chip f">Ближайшие матчи</span><span class="chip">${esc(m.genre)}</span><span class="chip">${m.year}, ${esc(m.country)}</span><span class="chip">${esc(m.age)}</span>${m.rating ? `<span class="chip">★ ${m.rating.toFixed(1)}</span>` : ''}</div>
      <h1>${esc(m.title)}</h1><p>${esc(short(m.description, 200))}</p><div class="acts"><a class="cta" href="#/match/${m.id}">Купить билет${m.min_price ? ' от ' + rub(m.min_price) : ''}</a><button class="ghost" data-tr="${m.id}">▶ Обзор</button></div></div>
      <button class="play" data-tr="${m.id}" aria-label="Смотреть обзор «${esc(m.title)}»">▶</button><div class="dots">${tops.map((_, i) => `<button class="${i === hi ? 'on' : ''}" data-i="${i}" aria-label="Матч ${i + 1}"></button>`).join('')}</div>`;
    $('#hero').querySelectorAll('[data-tr]').forEach(b => b.onclick = () => openTrailer(m)); $('#hero').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { hi = +b.dataset.i; hero(); }); };
  films(); sideList(); hero(); if (tops.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) S.timer = setInterval(() => { hi = (hi + 1) % tops.length; hero(); }, 7000);
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { location.hash = b.dataset.tab === 'soon' ? '#/soon' : '#/'; });
  app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { genre = b.dataset.g; app.querySelectorAll('[data-g]').forEach(x => x.classList.toggle('on', x === b)); films(); });
  app.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { side = b.dataset.s; app.querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', x === b)); sideList(); });
  app.querySelectorAll('.cin').forEach(b => b.onclick = () => { S.cinema = cinemas.find(c => c.id == b.dataset.id); S.session = S.seat = S.day = null; S.from = null; sessionsView(); });
});

const REACTS = ['🧡', '👏', '🥺', '🤔', '🥱'];
const getReact = id => { try { return localStorage.getItem('react:' + id); } catch { return null; } };
const setReact = (id, v) => { try { v === null ? localStorage.removeItem('react:' + id) : localStorage.setItem('react:' + id, v); } catch {} };

const movieView = (id, mday) => guard(-1, async () => {
  const m = await api.movie(id), all = await loadMovies(); m.soon = !m.sessions.length;
  const days = [...new Set(m.sessions.map(s => new Date(s.starts_at).toDateString()))]; S.mday = days.includes(mday) ? mday : days[0];
  const list = m.sessions.filter(s => new Date(s.starts_at).toDateString() === S.mday), byCin = [...new Map(list.map(s => [s.cinema_id, s])).values()];
  const similar = all.filter(x => x.id !== m.id && !x.soon).sort((a, b) => (b.genre === m.genre) - (a.genre === m.genre) || b.rating - a.rating).slice(0, 5);
  const cur = getReact(m.id);
  shell(-1, `<div class="crumbs"><a href="#/">Матчи</a> / ${esc(m.title)}</div>
    <div class="mhead"><div class="pst" style="--h:${m.hue}"></div><div><h1>${esc(m.title)}</h1>
      <dl class="facts"><dt>Год</dt><dd>${m.year}</dd><dt>Город</dt><dd>${esc(m.country)}</dd><dt>Турнир</dt><dd>${esc(m.genre)}</dd><dt>Длительность</dt><dd>${m.duration} мин</dd><dt>Возраст</dt><dd>${esc(m.age)}</dd>${m.rating ? `<dt>Рейтинг</dt><dd>★ ${m.rating.toFixed(1)}</dd>` : ''}${m.soon ? `<dt>Старт продаж</dt><dd>${dm(m.premiere)}</dd>` : ''}</dl>
      <p>${esc(m.description)}</p><div class="acts" style="display:flex;gap:10px;flex-wrap:wrap"><button class="cta" data-tr>▶ Смотреть обзор</button>${m.soon ? '' : '<button class="ghost" data-go="ses">Купить билет</button>'}</div>
      <div class="react" role="group" aria-label="Ваша реакция">${REACTS.map(r => `<button data-r="${r}" class="${cur === r ? 'on' : ''}" aria-pressed="${cur === r}">${r}</button>`).join('')}</div><small>Реакции сохраняются только в вашем браузере.</small></div></div>
    <div class="mtabs"><button class="on" data-go="top">О матче</button><button data-go="ses">Матчи и билеты</button><button data-go="trl">Обзоры</button><button data-go="sim">Похожие</button></div>
    <section id="ses"><h2>Матчи и билеты</h2>${m.soon ? `<p class="note">Продажа билетов на «${esc(m.title)}» откроется ближе к матчу (${dm(m.premiere)}).</p>` : `<div class="tabs">${days.map(d => `<button data-d="${d}" class="${d === S.mday ? 'on' : ''}">${dt(d)}</button>`).join('')}</div>
      ${byCin.map(c => `<div class="card cn"><h2>${esc(c.cinema)}</h2><small>${esc(c.address)}</small><div class="times">${list.filter(s => s.cinema_id === c.cinema_id).map(s => `<button class="time" data-id="${s.id}" data-c="${s.cinema_id}" ${s.free ? '' : 'disabled'}><b>${tm(s.starts_at)}</b> ${esc(s.format)}<br><small>${esc(s.hall)} · ${s.free ? 'от ' + rub(s.min_price) : 'мест нет'}</small></button>`).join('')}</div></div>`).join('')}`}</section>
    <section id="trl" style="margin-top:28px"><h2>Обзоры</h2><div class="trg"><button class="tc" data-tr><div class="th" style="--h:${m.hue}"><i>▶</i></div><div><b>${esc(m.title)}. Обзор</b><small>Видеообзор</small></div></button></div></section>
    ${similar.length ? `<section id="sim" style="margin-top:28px"><h2>Другие матчи</h2><div class="films">${similar.map(filmCard).join('')}</div></section>` : ''}`);
  app.querySelectorAll('[data-tr]').forEach(b => b.onclick = () => openTrailer(m));
  app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const t = b.dataset.go === 'top' ? app : $('#' + b.dataset.go); t?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelectorAll('.mtabs button').forEach(a => a.classList.toggle('on', a === b)); });
  app.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const v = getReact(m.id) === b.dataset.r ? null : b.dataset.r; setReact(m.id, v); app.querySelectorAll('[data-r]').forEach(x => { x.classList.toggle('on', x.dataset.r === v); x.setAttribute('aria-pressed', x.dataset.r === v); }); });
  app.querySelectorAll('.tabs [data-d]').forEach(b => b.onclick = () => movieView(id, b.dataset.d));
  app.querySelectorAll('.time').forEach(b => b.onclick = () => { const s = m.sessions.find(x => x.id == b.dataset.id); S.cinema = { id: s.cinema_id, name: s.cinema, address: s.address }; S.seat = null; S.from = 'movie'; S.mid = m.id; seatsView(+b.dataset.id); });
});

const trailersView = () => guard(-1, async () => {
  const all = await loadMovies();
  shell(-1, `<h1>Обзоры</h1><div class="trg">${all.map(m => `<button class="tc" data-tr="${m.id}"><div class="th" style="--h:${m.hue}"><i>▶</i></div><div><b>${esc(m.title)}. Обзор</b><small>${esc(m.genre)} · ${m.year}${m.soon ? ' · скоро' : ''}</small></div></button>`).join('')}</div>`);
  bindTrailers(all);
});

// Поиск по названию (подсказки под строкой поиска)
{ const q = $('#q'), box = $('#sugg'); let found = [];
  const hide = () => { box.hidden = true; };
  q.oninput = async () => { const v = q.value.trim().toLowerCase(); if (!v) return hide(); try { found = (await loadMovies()).filter(m => m.title.toLowerCase().includes(v)).slice(0, 6); } catch { return hide(); }
    box.innerHTML = found.length ? found.map(m => `<a href="#/match/${m.id}"><b>${esc(m.title)}</b><small>${esc(m.genre)} · ${m.year}</small></a>`).join('') : '<small class="note" style="padding:10px 14px">Ничего не найдено</small>'; box.hidden = false; };
  $('#search').onsubmit = e => { e.preventDefault(); if (found[0]) { location.hash = '#/match/' + found[0].id; q.value = ''; hide(); } };
  box.onclick = () => { q.value = ''; hide(); }; document.addEventListener('click', e => { if (!e.target.closest('#search')) hide(); }); }

// Cookie-плашка
try { if (!localStorage.getItem('cookie')) { $('#cookie').hidden = false; $('#cookie-ok').onclick = () => { localStorage.setItem('cookie', '1'); $('#cookie').hidden = true; }; } } catch {}

function route() {
  const h = location.hash, t = h.match(/^#\/ticket\/([\w-]+)$/), mv = h.match(/^#\/match\/(\d+)$/);
  document.querySelectorAll('#menu a').forEach(a => a.classList.toggle('on', a.dataset.m === (mv ? 'home' : h === '#/soon' ? 'soon' : h === '#/reviews' ? 'trailers' : h === '#/stadiums' ? 'cinemas' : !h || h === '#/' ? 'home' : '')));
  if (t) return ticketView(t[1]);
  if (mv) return movieView(+mv[1]);
  ({ '#/login': () => authView('login'), '#/register': () => authView('register'), '#/account': accountView, '#/topup': topupView, '#/history': () => historyView(), '#/tickets': () => ticketsView(),
    '#/stadiums': cinemasView, '#/reviews': trailersView, '#/soon': () => homeView('soon') }[h] || (() => homeView('now')))();
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route); loadMe().then(() => { nav(); route(); });
