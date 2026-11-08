import { api, esc, rub, time, dateLong, plural, poster, phaseOf, orders, rememberEmail, toast } from '../lib.js';
import * as sound from '../audio/engine.js';

let stagePromise = null;
const getStage = () => (stagePromise ||= import('../scene/stage.js').then((m) => m.createStage(document.getElementById('scene'))));
const MAX = 8;
const TYPE_NAME = { standard: 'Трибуна', premium: 'Комфорт', sofa: 'Места для двоих', accessible: 'Место для коляски' };

const verdictOf = ({ tilt }) => {
  if (tilt > -2.5) return 'У кромки поля: игроки совсем рядом, но дальняя половина поля сливается в узкую полосу.';
  if (tilt > -12) return 'Центр трибуны: поле видно почти целиком, но головы впереди закрывают ближнюю бровку.';
  return 'Ложа наверху: поле как на ладони, но игроки и мяч заметно мельче.';
};

function hudHTML(mode) {
  return `
  <section class="hud" id="hud" aria-live="polite">
    <div class="hud-head"><p class="hud-seat" id="hudSeat"></p><p class="hud-zone" id="hudZone"></p></div>
    <div class="hud-metrics">
      <div class="metric"><strong id="mDist"></strong><span>до центра поля</span></div>
      <div class="metric"><strong id="mAngle"></strong><span>угол обзора поля</span></div>
      <div class="metric"><strong id="mTilt"></strong><span>взгляд на поле</span></div>
    </div>
    <div class="verdict"><div class="verdict-scale"><i id="verdictDot"></i></div><p id="verdictText"></p></div>
    <div class="acoustic">
      <div class="ac-head"><strong>Звук трибун с этого места</strong><span class="ac-score" id="acScore"></span></div>
      <p class="ac-verdict" id="acVerdict"></p>
      <details class="ac-details"><summary>По источникам</summary><ul class="ac-bars" id="acBars"></ul></details>
      <div class="ac-actions">
        <button class="btn btn-ghost" id="soundCheck"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg><span>Послушать стадион с этого места</span></button>
        <p class="ac-now" id="acNow"></p>
      </div>
    </div>
    <label class="switch"><input type="checkbox" id="peopleToggle" checked /> <span>Показывать болельщиков на занятых местах</span></label>
    <div class="hud-nav" role="group" aria-label="Соседние места">
      <button class="btn btn-ghost" data-move="left"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Левее</button>
      <button class="btn btn-ghost" data-move="front"><svg viewBox="0 0 24 24"><path d="M5 15l7-7 7 7"/></svg>Ниже</button>
      <button class="btn btn-ghost" data-move="back"><svg viewBox="0 0 24 24"><path d="M5 9l7 7 7-7"/></svg>Выше</button>
      <button class="btn btn-ghost" data-move="right">Правее<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>
    <div class="hud-actions">
      ${mode === 'session' ? '<button class="btn btn-primary" id="hudSelect">Выбрать это место</button>' : '<a class="btn btn-primary" href="#sessions" id="hudSessions">Выбрать матч</a>'}
      <button class="btn btn-quiet" id="hudBack">Вернуться к выбору места</button>
    </div>
  </section>
  <p class="look-hint" id="lookHint">${matchMedia('(pointer: coarse)').matches ? 'Проведите пальцем по экрану, чтобы осмотреться.' : 'Потяните, чтобы осмотреться. Стрелки на клавиатуре пересаживают на соседнее место.'}</p>
  <div class="tooltip" id="tooltip" role="status"></div>`;
}

function mapSVG(seats, statusOf, selected, viewing) {
  const xs = seats.map((s) => s.x);
  const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1;
  const sx = 380 / (maxX - minX);
  const rows = [...new Set(seats.map((s) => s.row))].sort((a, b) => a - b);
  const rowH = rows.length > 9 ? 17 : 22; const top = 40;
  const ry = (r) => top + rows.indexOf(r) * rowH;
  const minGap = Math.min(...rows.map((r) => { const a = seats.filter((s) => s.row === r).map((s) => s.x).sort((p, q) => p - q); let m = 9; for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]); return m; }));
  const sw = Math.max(5, Math.min(26, minGap * sx - 2.4));
  const h = ry(rows[rows.length - 1]) + 14;
  const rects = seats.map((s) => {
    const st = statusOf(s);
    const cls = selected.includes(s.id) ? 'sel' : st !== 'available' ? 'taken' : s.type;
    return `<rect class="m-seat ${cls}${viewing === s.id ? ' viewing' : ''}" data-id="${s.id}" x="${((s.x - minX) * sx - sw / 2).toFixed(1)}" y="${(ry(s.row) - 5.5).toFixed(1)}" width="${sw.toFixed(1)}" height="11" rx="3"><title>Ряд ${s.row}, место ${s.num}</title></rect>`;
  }).join('');
  const labels = rows.map((r) => `<text x="6" y="${ry(r) + 3.5}" class="m-row">${r}</text><text x="374" y="${ry(r) + 3.5}" class="m-row" text-anchor="end">${r}</text>`).join('');
  return `<svg viewBox="0 0 380 ${h}" role="img" aria-label="Схема сектора: ${seats.length} мест"><rect x="30" y="2" width="320" height="22" rx="3" fill="#1fa35a" opacity=".85"/><path d="M190 2v22M30 13h320" stroke="#fff" stroke-opacity=".5" stroke-width=".8" fill="none"/><circle cx="190" cy="13" r="6" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".8"/><text x="190" y="33" class="m-screen-label" text-anchor="middle">поле</text>${labels}${rects}</svg>`;
}

// Общая часть страниц сектора и матча
async function mountScene({ view, mode, hall, seats, phase, statuses, query, onPick, extraInfo, cartHTML, onSelectionChange }) {
  document.body.classList.add('is-3d');
  const stage = await getStage();
  stage.start();
  stage.load({ hall, seats, phase, statuses });
  const st = stage.state;
  const $ = (s) => view.querySelector(s);
  let selected = [];
  const statusOf = (s) => st.status.get(s.id) || 'available';
  const seatById = new Map(st.seats.map((s) => [s.id, s]));
  const refSeat = [...st.seats].sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || Math.abs(a.row - Math.round(st.hall.rows.length * 0.65)) - Math.abs(b.row - Math.round(st.hall.rows.length * 0.65)))[0];

  const drawMap = () => { $('#seatMap').innerHTML = mapSVG(st.seats, statusOf, selected, st.mode === 'seat' ? st.view?.id : null); };
  const legendTypes = [...new Set(st.seats.map((s) => s.type))];
  $('#legend').innerHTML = legendTypes.map((t) => `<li><i class="lg ${t}"></i>${TYPE_NAME[t]}</li>`).join('') +
    (mode === 'session' ? '<li><i class="lg taken"></i>Занято</li><li><i class="lg sel"></i>Ваш выбор</li>' : '');
  drawMap();

  // ----- звук -----
  const setupAudio = () => { if (sound.isOn()) { sound.hall.setup(hall, st.view || refSeat); sound.hall.startSoundtrack(); } };
  setupAudio();
  const offSound = sound.onChange((on) => { if (on) setupAudio(); });
  const refEye = stage.eyeOf(refSeat);
  const offFrame = stage.on('frame', ({ pos, forward, mode: m }) => {
    if (!sound.hall.speakers) return;
    if (m === 'seat') sound.hall.setListener(pos, forward);
    else sound.hall.setListener(refEye, { x: 0, y: 0, z: -1 });
  });

  // ----- HUD -----
  const fmtTilt = (t) => (Math.abs(t) < 1 ? 'прямо' : (t > 0 ? 'вверх ' : 'вниз ') + Math.round(Math.abs(t)) + '°');
  function updateHud() {
    const s = st.view; if (!s) return;
    const m = stage.metrics(s);
    $('#hudSeat').textContent = `Ряд ${s.row}, место ${s.num}`;
    const taken = statusOf(s) !== 'available';
    $('#hudZone').textContent = mode === 'session'
      ? (taken ? 'Место занято, но посмотреть с него можно' : `${TYPE_NAME[s.type]}, ${rub(s.price)}`)
      : `${TYPE_NAME[s.type]}${s.price ? ', от ' + rub(s.price) : ''}`;
    $('#mDist').textContent = m.dist.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' м';
    $('#mAngle').textContent = Math.round(m.angle) + '°';
    $('#mTilt').textContent = fmtTilt(m.tilt);
    $('#verdictText').textContent = verdictOf(m);
    $('#verdictDot').style.left = `${Math.max(0, Math.min(1, -m.tilt / 25)) * 100}%`;
    const ac = sound.analyze(hall, s, m.eye, refEye);
    $('#acScore').textContent = ac.score + ' из 100';
    $('#acScore').dataset.level = ac.score >= 80 ? 'good' : ac.score >= 60 ? 'ok' : 'low';
    $('#acVerdict').textContent = ac.verdict;
    const maxL = Math.max(...ac.rows.map((r) => r.level));
    $('#acBars').innerHTML = ac.rows.map((r) => `<li data-ch="${r.id}"><span class="acb-name">${esc(r.name)}</span>
      <span class="acb-bar"><i style="width:${Math.max(6, 100 + (r.level - maxL) * 6)}%"></i></span>
      <span class="acb-val">${r.level.toFixed(1)} дБ, ${Math.round(r.delay)} мс</span></li>`).join('');
    const sel = $('#hudSelect');
    if (sel) {
      sel.disabled = taken;
      sel.textContent = taken ? 'Место занято' : selected.includes(s.id) ? 'Убрать из выбора' : `Выбрать за ${rub(s.price)}`;
      sel.classList.toggle('is-picked', selected.includes(s.id));
    }
    view.querySelectorAll('[data-move]').forEach((b) => { b.disabled = !stage.neighbour(s, b.dataset.move); });
    if (sound.hall.speakers) sound.hall.applySeat(s);
  }
  function enter(s) {
    sound.hall.cancel();
    stage.enterSeat(s);
    document.body.classList.add('in-seat');
    sound.ui('fly');
    drawMap(); updateHud();
    if (sound.isOn()) { if (!sound.hall.speakers) setupAudio(); sound.hall.applySeat(s); }
  }
  function exit() {
    if (st.mode !== 'seat') return;
    sound.hall.cancel(); stage.highlightSpeaker('*', false);
    document.body.classList.remove('in-seat');
    stage.toOverview();
    sound.hall.applySeat(refSeat);
    setTimeout(drawMap, 1900);
  }
  $('#hudBack').addEventListener('click', exit);
  view.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => { const n = stage.neighbour(st.view, b.dataset.move); if (n) enter(n); }));
  $('#peopleToggle').addEventListener('change', (e) => stage.setShowPeople(e.target.checked));
  $('#hudSessions')?.addEventListener('click', (e) => { e.preventDefault(); exit(); });
  $('#soundCheck').addEventListener('click', async () => {
    const btn = $('#soundCheck');
    if (sound.hall.checking) { sound.hall.cancel(); return; }
    if (!sound.isOn()) await sound.enable();
    if (!sound.hall.speakers) setupAudio();
    sound.hall.applySeat(st.view);
    btn.querySelector('span').textContent = 'Остановить проверку';
    view.querySelector('.acoustic details').open = true;
    await sound.hall.soundCheck((ev) => {
      if (ev.type === 'speaker') {
        stage.highlightSpeaker(ev.id, true);
        $('#acNow').textContent = 'Играет: ' + ev.name;
        view.querySelectorAll('#acBars li').forEach((li) => li.classList.toggle('is-on', li.dataset.ch === ev.id));
      } else if (ev.type === 'speaker-off') stage.highlightSpeaker(ev.id, false);
      else if (ev.type === 'flyover') $('#acNow').textContent = 'Облёт стадиона: звук идёт по кругу через все трибуны';
      else if (ev.type === 'done') {
        $('#acNow').textContent = ev.stopped ? '' : 'Проверка закончена. Пересядьте и сравните.';
        view.querySelectorAll('#acBars li').forEach((li) => li.classList.remove('is-on'));
      }
    });
    btn.querySelector('span').textContent = 'Проверить звук с этого места';
  });

  // ----- выбор мест -----
  const tooltip = $('#tooltip');
  let ptr = { x: 0, y: 0 };
  const onMove = (e) => { ptr = { x: e.clientX, y: e.clientY }; };
  window.addEventListener('pointermove', onMove);
  stage.on('hover', (s) => {
    view.querySelectorAll('.m-seat.hover').forEach((n) => n.classList.remove('hover'));
    if (!s || st.mode !== 'overview') { tooltip.classList.remove('is-on'); return; }
    view.querySelector(`.m-seat[data-id="${s.id}"]`)?.classList.add('hover');
    const stt = statusOf(s);
    const line = mode === 'session'
      ? (stt !== 'available' ? 'Занято' : selected.includes(s.id) ? 'В вашем выборе' : `${TYPE_NAME[s.type]}, ${rub(s.price)}`)
      : `${TYPE_NAME[s.type]}. Нажмите, чтобы сесть`;
    tooltip.innerHTML = `<strong>Ряд ${s.row}, место ${s.num}</strong><span>${line}</span>`;
    tooltip.classList.add('is-on');
    tooltip.style.transform = `translate(${ptr.x + 16}px, ${ptr.y + 16}px)`;
  });
  stage.on('pick', (s, info) => onPick(s, info));
  let mapClick = { id: null, t: 0 };
  $('#seatMap').addEventListener('click', (e) => {
    const r = e.target.closest('[data-id]'); if (!r) return;
    const s = seatById.get(r.dataset.id); const now = performance.now();
    const double = mapClick.id === s.id && now - mapClick.t < 380;
    mapClick = double ? { id: null, t: 0 } : { id: s.id, t: now };
    if (st.mode === 'seat') { enter(s); return; }
    onPick(s, { double });
  });
  $('#mapToggle').addEventListener('click', () => {
    const open = !$('#mapDock').classList.toggle('is-collapsed');
    $('#mapToggle').setAttribute('aria-expanded', String(open));
  });
  if (innerWidth < 860) { $('#mapDock').classList.add('is-collapsed'); $('#mapToggle').setAttribute('aria-expanded', 'false'); }
  // на телефоне схема встаёт сразу под инфопанелью
  const placeDock = () => { $('#mapDock').style.top = innerWidth < 860 ? Math.round($('#filmsPanel').getBoundingClientRect().bottom + 8) + 'px' : ''; };
  placeDock(); window.addEventListener('resize', placeDock);
  const onKey = (e) => {
    if (st.mode !== 'seat' || e.target.closest('input,textarea')) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'front', ArrowDown: 'back' };
    if (map[e.key]) { e.preventDefault(); const n = stage.neighbour(st.view, map[e.key]); if (n) enter(n); }
    if (e.key === 'Escape') exit();
  };
  window.addEventListener('keydown', onKey);

  const api_ = {
    stage, st, seatById, statusOf, enter, exit, updateHud, drawMap,
    get selected() { return selected; },
    setSelected(ids) { selected = ids; stage.setSelected(ids); drawMap(); if (st.mode === 'seat') updateHud(); onSelectionChange?.(ids); },
    cleanup() {
      offSound(); offFrame(); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', placeDock); window.removeEventListener('pointermove', onMove);
      sound.hall.teardown(); stage.stop(); document.body.classList.remove('is-3d', 'in-seat');
    },
  };
  const want = query.get('seat');
  if (want && seatById.get(want)) setTimeout(() => enter(seatById.get(want)), 400);
  return api_;
}

const shell = (left, right, mode) => `
  <aside class="panel films scene-info" id="filmsPanel">${left}</aside>
  <section class="mapdock" id="mapDock">
    <button class="map-toggle" id="mapToggle" aria-expanded="true">Схема сектора</button>
    <div class="map-body"><div id="seatMap"></div><ul class="legend" id="legend"></ul></div>
  </section>
  <aside class="panel cart" id="cartPanel">${right}</aside>
  ${hudHTML(mode)}`;

// ---------- Страница сектора: прогулка по трибуне и звук ----------
export async function hallPage({ view, params, query }) {
  const data = await api('/halls/' + params[0]);
  const h = data.hall;
  const left = `
    <a class="back-link" href="/sectors">Все сектора</a>
    <h1 class="panel-title big">${esc(h.name)}</h1>
    <p class="hall-sub">${esc(h.subtitle || '')}</p>
    <dl class="hall-facts compact">
      <div><dt>Мест</dt><dd>${data.seats.length}</dd></div>
      <div><dt>Рядов</dt><dd>${new Set(data.seats.map((s) => s.row)).size}</dd></div>
    </dl>
    <p class="hall-tech">Поле 105 × 68 м, натуральный газон, освещение 2000 люкс.</p>
    <p class="hint-text">Нажмите на любое место: камера пересадит вас туда, и вы увидите поле с этой точки трибуны.</p>`;
  const right = `
    <h2 class="panel-title" id="sessions">Матчи в этом секторе</h2>
    <ul class="session-lines">${data.sessions.map((s) => `<li><a href="/seats/${s.id}"><strong>${time(s.starts_at)}</strong><span>${esc(s.title)}<small>${dateLong(s.starts_at)}, ${s.free ? 'от ' + rub(s.min_price) : 'мест нет'}</small></span></a></li>`).join('') || '<li class="muted">Матчей на неделю нет</li>'}</ul>`;
  view.innerHTML = shell(left, right, 'hall');
  const ctl = await mountScene({
    view, mode: 'hall', hall: h, seats: data.seats, phase: phaseOf(h.id), statuses: [], query,
    onPick: (s) => { sound.ui('tap'); ctl.enter(s); },
  });
  return () => ctl.cleanup();
}

// ---------- Страница матча: выбор мест и бронь ----------
export async function sessionPage({ view, params, query, navigate }) {
  const data = await api('/screenings/' + params[0]);
  const { screening: sc, movie: m, hall: h } = data;
  const hallName = h.name;
  const prices = {};
  data.seats.forEach((s) => { prices[s.type] = Math.min(prices[s.type] ?? Infinity, s.price); });
  const left = `
    <a class="back-link" href="/match/${m.id}">${esc(m.title)}</a>
    <div class="session-head">
      <div class="mini-poster">${poster(m)}</div>
      <div>
        <h1 class="panel-title big">${time(sc.starts_at)}</h1>
        <p class="hall-sub">${dateLong(sc.starts_at)}</p>
        <p class="session-hall${h.category === 'vip' ? ' is-vip' : ''}">${esc(hallName)}</p>
      </div>
    </div>
    <ul class="price-list">${Object.entries(prices).map(([t, p]) => `<li><i class="lg ${t}"></i><span>${TYPE_NAME[t]}</span><strong>от ${rub(p)}</strong></li>`).join('')}</ul>
    <p class="hint-text">Нажмите на место, чтобы выбрать его. Двойное нажатие пересадит вас туда: увидите поле с этой точки трибуны.</p>
    ${sc.on_sale ? '' : '<p class="notice">Продажа на этот матч закрыта.</p>'}`;
  const right = `
    <h2 class="panel-title">Ваши места</h2>
    <p class="cart-film">${esc(m.title)}, ${time(sc.starts_at)}, ${esc(hallName)}</p>
    <ul class="cart-list" id="cartList"></ul>
    <div class="cart-empty" id="cartEmpty"><p>Выберите до ${MAX} мест на трибуне или на схеме.</p></div>
    <form class="checkout-form" id="checkoutForm" hidden novalidate>
      <label for="email">E-mail для билетов</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="name@example.ru" />
      <p class="form-note">Бронь держится 10 минут. Это демо: письма не отправляются, билеты будут в разделе «Мои билеты».</p>
      <p class="form-error" id="formError" role="alert"></p>
    </form>
    <div class="cart-foot">
      <div class="total"><span>Итого</span><strong id="cartTotal">0 ₽</strong></div>
      <button class="btn btn-primary" id="bookBtn" disabled>Перейти к оплате</button>
    </div>`;
  view.innerHTML = shell(left, right, 'session');
  const statuses = data.seats.filter((s) => s.status !== 'available').map((s) => [s.id, s.status]);
  const $ = (s) => view.querySelector(s);
  let step = 'seats';
  const renderCart = (ids) => {
    const list = ids.map((id) => ctl.seatById.get(id));
    $('#cartList').innerHTML = list.map((s) => `<li class="cart-item"><span class="ci-seat"><strong>Ряд ${s.row}, место ${s.num}</strong><span>${TYPE_NAME[s.type]}</span></span>
      <span class="ci-price">${rub(s.price)}</span>
      <button class="icon-btn" data-view="${s.id}" aria-label="Вид с места: ряд ${s.row}, место ${s.num}" title="Вид и звук с места"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button class="icon-btn" data-remove="${s.id}" aria-label="Убрать ряд ${s.row}, место ${s.num}" title="Убрать"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`).join('');
    $('#cartEmpty').hidden = list.length > 0;
    $('#cartTotal').textContent = rub(list.reduce((a, s) => a + s.price, 0));
    $('#bookBtn').disabled = !list.length || !sc.on_sale;
    if (!list.length) { step = 'seats'; $('#checkoutForm').hidden = true; }
    $('#bookBtn').textContent = step === 'email' ? `Забронировать и оплатить` : list.length ? `Перейти к оплате, ${list.length} ${plural(list.length, 'место', 'места', 'мест')}` : 'Перейти к оплате';
  };
  const ctl = await mountScene({
    view, mode: 'session', hall: h, seats: data.seats, phase: phaseOf(m.id), statuses, query,
    onSelectionChange: renderCart,
    onPick: (s, { double }) => {
      if (double) { if (ctl.statusOf(s) === 'available' && !ctl.selected.includes(s.id) && ctl.selected.length < MAX) ctl.setSelected([...ctl.selected, s.id]); ctl.enter(s); return; }
      toggle(s);
    },
  });
  function toggle(s) {
    if (!sc.on_sale) { toast('Продажа на этот матч закрыта.'); return; }
    if (ctl.statusOf(s) !== 'available') { sound.ui('error'); toast('Это место уже занято. Выберите свободное.'); return; }
    if (ctl.selected.includes(s.id)) { sound.ui('deselect'); ctl.setSelected(ctl.selected.filter((x) => x !== s.id)); return; }
    if (ctl.selected.length >= MAX) { toast(`За один раз можно забронировать до ${MAX} мест.`); return; }
    sound.ui('select'); ctl.setSelected([...ctl.selected, s.id]);
  }
  $('#hudSelect').addEventListener('click', () => toggle(ctl.st.view));
  $('#cartList').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]'); const r = e.target.closest('[data-remove]');
    if (v) ctl.enter(ctl.seatById.get(v.dataset.view));
    if (r) toggle(ctl.seatById.get(r.dataset.remove));
  });
  renderCart([]);

  // актуальная занятость: опрос раз в 12 секунд
  let polling = true;
  const poll = async () => {
    if (!polling || document.hidden) return;
    try {
      const a = await api(`/screenings/${sc.id}/availability`);
      ctl.stage.setStatuses(a.unavailable);
      const lost = ctl.selected.filter((id) => ctl.statusOf(ctl.seatById.get(id)) !== 'available');
      if (lost.length) { ctl.setSelected(ctl.selected.filter((id) => !lost.includes(id))); toast('Пока вы выбирали, часть мест заняли. Мы убрали их из корзины.'); }
      ctl.drawMap();
    } catch {}
  };
  const timer = setInterval(poll, 12000);

  // бронь
  const email = $('#email');
  email.value = rememberEmail();
  let idem = crypto.randomUUID();
  $('#bookBtn').addEventListener('click', async () => {
    if (step === 'seats') { step = 'email'; $('#checkoutForm').hidden = false; renderCart(ctl.selected); email.focus(); return; }
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v)) { $('#formError').textContent = 'Проверьте e-mail: в нём должны быть @ и домен, например name@mail.ru.'; email.focus(); return; }
    $('#formError').textContent = '';
    const btn = $('#bookBtn'); btn.disabled = true; btn.textContent = 'Бронируем места…';
    try {
      const r = await api('/orders', { method: 'POST', body: { screening_id: sc.id, seat_ids: ctl.selected, email: v, idempotency_key: idem } });
      rememberEmail(v);
      orders.save({ id: r.order_id, token: r.token, created: Date.now(), title: m.title, starts_at: sc.starts_at });
      sound.ui('success');
      navigate('/checkout/' + r.order_id);
    } catch (e) {
      sound.ui('error');
      $('#formError').textContent = e.message;
      idem = crypto.randomUUID();
      btn.disabled = false; renderCart(ctl.selected);
      if (e.status === 409) poll();
    }
  });
  $('#checkoutForm').addEventListener('submit', (e) => { e.preventDefault(); $('#bookBtn').click(); });
  return () => { polling = false; clearInterval(timer); ctl.cleanup(); };
}
