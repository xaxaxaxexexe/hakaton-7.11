import { StadiumView, crowdProfile } from './stadium3d.js';

/* Booking UI state. Seat coordinates come from the API and are shared with the WebGL scene. */
const $ = (id) => document.getElementById(id);
const state = { catalog: null, stadium: null, match: null, sector: null, seats: [], selected: null, ticket: null, audio: null, busy: false, view3d: null, viewMode: 'seat', heatMap: false, user: null, ticketCount: 0, authMode: 'register', pendingCheckout: false };
const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;
const plural = (n, forms) => forms[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 1 : 2];
const longDate = (stamp) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(stamp));
const shortDate = (stamp) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(stamp));
const seatLabel = (seat) => `Сектор ${seat.sector}, ряд ${seat.row_number}, ${seat.kind === 'box' ? 'ложа' : 'место'} ${seat.seat_number}`;
const matchById = (id) => state.catalog.matches.find((m) => m.id === id);
const stadiumById = (id) => state.catalog.stadiums.find((s) => s.id === id);
const matchTitle = (match) => `${match.home_name} — ${match.away_name}`;
const METERS_PER_UNIT = 1.5;
let toastTimer;
let installPrompt = null;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4200);
}
async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error('Сервер вернул неверный ответ.'); }
  if (!response.ok) throw Object.assign(new Error(body.error || 'Ошибка запроса.'), { status: response.status });
  return body;
}

function crest(short, color) {
  const el = document.createElement('span'); el.className = 'crest'; el.style.setProperty('--crest', color); el.textContent = short;
  return el;
}
function crests(match) {
  const el = document.createElement('span'); el.className = 'crests';
  const versus = document.createElement('i'); versus.textContent = 'vs';
  el.append(crest(match.home_short, match.home_color), versus, crest(match.away_short, match.away_color));
  return el;
}

async function start() {
  bindEvents();
  updateWalletCount();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
  try {
    const [catalog, auth] = await Promise.all([api('/api/catalog'), api('/api/auth/me')]);
    state.catalog = catalog;
    state.user = auth.user;
    updateAccountUI();
    if (state.user) refreshTicketCount();
    const route = location.pathname.match(/^\/match\/([a-z0-9-]+)\/?$/);
    if (route && matchById(route[1])) {
      await openMatch(route[1]);
    } else {
      if (route) toast('Матч не найден. Показываем расписание.');
      renderCatalog();
    }
    const token = new URLSearchParams(location.search).get('ticket');
    if (token) {
      try { showTicket(await api(`/api/tickets/${encodeURIComponent(token)}`)); }
      catch { toast('Не удалось открыть билет по этой ссылке.'); }
    }
  } catch (error) { toast(`Не удалось загрузить расписание: ${error.message}`); }
  setInterval(() => { if (state.match && document.visibilityState === 'visible' && $('checkout-modal').hidden) refreshSeats(true); }, 12000);
  document.addEventListener('visibilitychange', () => {
    state.view3d?.setVisible(document.visibilityState === 'visible' && !$('preview-section').hidden);
    if (document.visibilityState === 'visible' && state.match) refreshSeats(true);
  });
}

function renderCatalog() {
  $('home-intro').hidden = false; $('matches').hidden = false; $('how').hidden = false;
  $('match-hero').hidden = true; $('booking').hidden = true; $('preview-section').hidden = true;
  document.title = 'Матчи · Трибуна — билет с видом на поле';
  const count = state.catalog.matches.length;
  $('catalog-count').textContent = `${count} ${plural(count, ['матч', 'матча', 'матчей'])} · ${state.catalog.stadiums.length} ${plural(state.catalog.stadiums.length, ['стадион', 'стадиона', 'стадионов'])}`;
  renderSpotlight();
  let filter = 'all';
  const filters = $('stadium-filters');
  filters.replaceChildren();
  const list = $('match-grid');
  const render = () => {
    const search = $('match-search').value.trim().toLocaleLowerCase('ru');
    const matches = state.catalog.matches.filter((match) =>
      (filter === 'all' || filter === match.stadium_id) &&
      `${match.home_name} ${match.away_name} ${match.tournament} ${stadiumById(match.stadium_id).name}`.toLocaleLowerCase('ru').includes(search));
    list.replaceChildren(); $('catalog-empty').hidden = matches.length > 0;
    for (const match of matches) {
      const stadium = stadiumById(match.stadium_id);
      const card = document.createElement('a'); card.className = 'match-card'; card.href = `/match/${match.id}`;
      const art = document.createElement('span'); art.className = 'match-card-art'; art.append(crests(match));
      const details = document.createElement('span'); details.className = 'match-card-details';
      const tournament = document.createElement('small'); tournament.textContent = match.tournament.toUpperCase();
      const title = document.createElement('strong'); title.textContent = matchTitle(match);
      const meta = document.createElement('span'); meta.textContent = `${shortDate(match.starts_at)} · ${stadium.name}`;
      const action = document.createElement('b'); action.textContent = `от ${money(stadium.price_from)} · Выбрать место ↗`;
      details.append(tournament, title, meta, action); card.append(art, details); list.append(card);
    }
  };
  const addFilter = (id, label) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.className = id === filter ? 'active' : '';
    button.addEventListener('click', () => {
      filter = id;
      for (const item of filters.children) item.classList.toggle('active', item === button);
      render();
    });
    filters.append(button);
  };
  addFilter('all', 'Все стадионы');
  for (const stadium of state.catalog.stadiums) addFilter(stadium.id, stadium.name);
  $('match-search').addEventListener('input', render);
  render();
}

function renderSpotlight() {
  const match = state.catalog.matches[0];
  if (!match) return;
  const stadium = stadiumById(match.stadium_id);
  $('spotlight').hidden = false;
  $('spotlight-title').textContent = matchTitle(match);
  $('spotlight-description').textContent = `${stadium.name}, ${stadium.city}. Сядьте на любое место и посмотрите, как будет видно поле, ещё до покупки.`;
  $('spotlight-genre').textContent = match.tournament;
  $('spotlight-time').textContent = longDate(match.starts_at);
  $('spotlight-link').href = `/match/${match.id}`;
  $('spotlight-crests').replaceChildren(crests(match));
}

async function openMatch(id) {
  const match = matchById(id);
  state.match = id; state.stadium = match.stadium_id; state.sector = null; state.selected = null;
  hidePreview();
  renderMatchPage(); renderStadiumSelect(); renderSchedule();
  loadWeather(id);
  await refreshSeats();
}

function renderMatchPage() {
  const match = matchById(state.match), stadium = stadiumById(state.stadium);
  $('home-intro').hidden = true; $('matches').hidden = true; $('how').hidden = true;
  $('match-hero').hidden = false; $('booking').hidden = false;
  $('match-title').textContent = matchTitle(match);
  $('match-crests').replaceChildren(crests(match));
  $('match-eyebrow').textContent = match.tournament.toUpperCase();
  $('match-meta').textContent = `${longDate(match.starts_at)}  ·  ${stadium.name}  ·  ${stadium.city}`;
  $('match-description').textContent = `Выберите сектор и место, сядьте на него в 3D и посмотрите на поле с этой точки трибуны. Цена зависит от места: от ${money(stadium.price_from)} до ${money(stadium.price_to)}.`;
  document.title = `${matchTitle(match)} · Выбрать место · Трибуна`;
}

function renderStadiumSelect() {
  const select = $('stadium-select'); select.replaceChildren();
  for (const stadium of state.catalog.stadiums) {
    const option = document.createElement('option'); option.value = stadium.id; option.textContent = `${stadium.name} · ${stadium.city}`; select.append(option);
  }
  select.value = state.stadium || '';
  $('stadium-address').textContent = stadiumById(state.stadium)?.address || '';
}

function renderSchedule() {
  const list = $('fixture-list'); list.replaceChildren();
  for (const match of state.catalog.matches.filter((m) => m.stadium_id === state.stadium)) {
    const active = match.id === state.match;
    const button = document.createElement('button'); button.type = 'button';
    button.className = `fixture-card${active ? ' active' : ''}`; button.setAttribute('aria-pressed', String(active));
    const words = document.createElement('span'); words.className = 'fixture-text';
    const title = document.createElement('strong'); title.textContent = matchTitle(match);
    const meta = document.createElement('small'); meta.textContent = `${shortDate(match.starts_at)} · ${match.tournament}`;
    words.append(title, meta);
    button.append(crests(match), words);
    button.addEventListener('click', () => selectMatch(match.id));
    list.append(button);
  }
  if (!list.children.length) list.textContent = 'На этом стадионе пока нет матчей.';
}

async function selectMatch(id) {
  if (id !== state.match) history.pushState(null, '', `/match/${id}`);
  await openMatch(id);
}

async function loadWeather(id) {
  const el = $('match-weather');
  el.textContent = '';
  try {
    const weather = await api(`/api/matches/${id}/weather`);
    if (id !== state.match) return;
    el.textContent = weather.available
      ? `Погода к началу: ${weather.temperature_c > 0 ? '+' : ''}${weather.temperature_c} °C, осадки ${weather.precipitation_pct}%, ветер ${weather.wind_kmh} км/ч · ${weather.source}`
      : weather.message;
  } catch { if (id === state.match) el.textContent = 'Прогноз погоды сейчас недоступен.'; }
}

async function refreshSeats(silent = false) {
  if (!state.match) { state.seats = []; renderSeats(); return; }
  const requested = state.match;
  try {
    const result = await api(`/api/matches/${requested}`);
    if (requested !== state.match) return;
    state.seats = result.seats;
    if (state.selected) {
      const updated = state.seats.find((s) => s.id === state.selected.id);
      if (!updated || updated.occupied) {
        state.selected = null; hidePreview();
        if (updated?.occupied) toast('Выбранное место уже купили. Выберите другое.');
      } else state.selected = updated;
    }
    const sectors = stadiumById(state.stadium).sectors;
    if (!sectors.some((s) => s.code === state.sector)) state.sector = (sectors.find((s) => s.side === 'south' && s.offset_along === 0) || sectors[0]).code;
    renderSectors(); renderSeats(); updateSummary();
    if (!$('preview-section').hidden) drawView();
  } catch (error) { if (!silent) toast(`Не удалось загрузить места: ${error.message}`); }
}

function sectorSeats(code = state.sector) { return state.seats.filter((seat) => seat.sector === code); }

function selectSector(code) {
  state.sector = code;
  renderSectors(); renderSeats();
}

function renderSectors() {
  const stadium = stadiumById(state.stadium);
  const chips = $('sector-chips'); chips.replaceChildren();
  const map = $('stadium-map'); map.replaceChildren();
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  const extent = Math.max(...state.seats.map((s) => Math.max(Math.abs(s.x), Math.abs(s.z) * 1.1))) + 3;
  map.setAttribute('viewBox', `${-extent} ${-extent * .78} ${extent * 2} ${extent * 1.56}`);
  map.append(svg('rect', { x: -35, y: -22.5, width: 70, height: 45, class: 'map-pitch' }),
    svg('line', { x1: 0, y1: -22.5, x2: 0, y2: 22.5, class: 'map-line' }),
    svg('circle', { cx: 0, cy: 0, r: 6, class: 'map-line' }));
  for (const sector of stadium.sectors) {
    const seats = sectorSeats(sector.code);
    const free = seats.filter((s) => !s.occupied).length;
    const low = Math.min(...seats.map((s) => s.price_rub));
    const selected = sector.code === state.sector;
    const label = `Сектор ${sector.code}${sector.is_fan ? ', фан-сектор' : ''}: ${free} ${plural(free, ['место', 'места', 'мест'])} свободно, от ${money(low)}`;

    const xs = seats.map((s) => s.x), zs = seats.map((s) => s.z);
    const x = Math.min(...xs) - .8, y = Math.min(...zs) - .8, width = Math.max(...xs) - Math.min(...xs) + 1.6, height = Math.max(...zs) - Math.min(...zs) + 1.6;
    const group = svg('g', { class: `map-sector${selected ? ' selected' : ''}${sector.is_fan ? ' fan' : ''}`, role: 'button', tabindex: '0', 'aria-label': label });
    const title = svg('title', {}); title.textContent = label;
    const text = svg('text', { x: x + width / 2, y: y + height / 2 + 2 }); text.textContent = sector.code;
    group.append(title, svg('rect', { x, y, width, height, rx: 1 }), text);
    group.addEventListener('click', () => selectSector(sector.code));
    group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSector(sector.code); } });
    map.append(group);

    const chip = document.createElement('button'); chip.type = 'button'; chip.className = `sector-chip${selected ? ' active' : ''}`;
    chip.setAttribute('aria-pressed', String(selected)); chip.setAttribute('aria-label', label);
    const code = document.createElement('b'); code.textContent = sector.code;
    const info = document.createElement('small'); info.textContent = `${sector.is_fan ? 'фан · ' : ''}от ${money(low)}`;
    chip.append(code, info);
    chip.addEventListener('click', () => selectSector(sector.code));
    chips.append(chip);
  }
}

function renderSeats() {
  const map = $('seat-map'); map.replaceChildren();
  map.classList.toggle('view-map', state.heatMap);
  $('view-map-toggle').setAttribute('aria-pressed', String(state.heatMap));
  $('view-map-legend').hidden = !state.heatMap;
  const seats = sectorSeats();
  const groups = new Map();
  for (const seat of seats) { if (!groups.has(seat.row_number)) groups.set(seat.row_number, []); groups.get(seat.row_number).push(seat); }
  for (const [rowNumber, rowSeats] of groups) {
    const row = document.createElement('div'); row.className = 'seat-row';
    const label = document.createElement('span'); label.className = 'row-label'; label.textContent = rowNumber; row.append(label);
    for (const seat of rowSeats) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = `seat${seat.kind === 'box' ? ' box' : ''}${seat.occupied ? ' occupied' : ''}${seat.id === state.selected?.id ? ' selected' : ''}`;
      const score = viewScore(seat);
      button.style.setProperty('--heat-color', score >= 80 ? '#8ed9bf' : score >= 60 ? '#eeb987' : '#d58182');
      button.disabled = Boolean(seat.occupied);
      button.setAttribute('aria-label', `${seatLabel(seat)}, ${seat.occupied ? 'занято' : money(seat.price_rub)}${state.heatMap && !seat.occupied ? `, ориентир обзора ${score} из 100` : ''}`);
      button.setAttribute('aria-pressed', String(seat.id === state.selected?.id));
      button.title = `${seatLabel(seat)} · ${seat.occupied ? 'Занято' : money(seat.price_rub)}`;
      button.addEventListener('click', () => selectSeat(seat));
      row.append(button);
    }
    map.append(row);
  }
  const free = seats.filter((s) => !s.occupied).length;
  $('seat-count').textContent = seats.length ? `Сектор ${state.sector}: ${free} ${plural(free, ['место', 'места', 'мест'])} свободно` : 'Нет мест';
  const prices = new Map();
  for (const seat of seats) {
    const tier = seat.kind === 'box' ? 'Ложи' : null;
    const key = tier || seat.price_rub;
    const entry = prices.get(key) || { price: seat.price_rub, rows: new Set(), tier };
    entry.rows.add(seat.row_number); prices.set(key, entry);
  }
  const legend = $('price-legend'); legend.replaceChildren();
  for (const entry of prices.values()) {
    const rows = [...entry.rows];
    const item = document.createElement('span');
    const price = document.createElement('b'); price.textContent = money(entry.price);
    item.append(price, ` ${entry.tier || `ряды ${rows[0]}–${rows[rows.length - 1]}`}`);
    legend.append(item);
  }
}

function distanceMeters(seat) { return Math.round(Math.hypot(seat.x, seat.z) * METERS_PER_UNIT); }
function behindGoal(seat) { return Math.abs(seat.x) > 35; }
function viewScore(seat) {
  const rows = stadiumById(state.stadium).rows_count;
  const along = behindGoal(seat) ? Math.abs(seat.z) : Math.abs(seat.x);
  const score = Math.round(98 - (behindGoal(seat) ? 24 : 0) - along * .55 - Math.abs(seat.row_number - rows * .65) * 3.4);
  return Math.max(25, Math.min(98, score));
}
function selectSeat(seat) {
  if (!seat || seat.occupied) { toast('Это место уже занято.'); return; }
  state.selected = seat;
  if (seat.sector !== state.sector) { state.sector = seat.sector; renderSectors(); }
  renderSeats(); updateSummary();
  if (!$('preview-section').hidden) { updatePreview(); drawView(); }
}
function recommendSeat(kind) {
  const free = state.seats.filter((seat) => !seat.occupied);
  if (!free.length) { toast('На этом матче нет свободных мест.'); return; }
  const scores = {
    best: (s) => -viewScore(s),
    near: (s) => s.row_number * 4 + Math.hypot(s.x, s.z),
    budget: (s) => s.price_rub - viewScore(s) * .01,
  };
  free.sort((a, b) => scores[kind](a) - scores[kind](b));
  selectSeat(free[0]);
  $('selection-summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`${kind === 'best' ? 'Лучший обзор' : kind === 'near' ? 'Ближе к полю' : 'Доступная цена'}: ${seatLabel(free[0])}`);
}
/* Move to the nearest free seat in the same sector, by row or along the row. */
function moveSeat(rowStep, seatStep) {
  const current = state.selected; if (!current) return;
  const candidates = sectorSeats(current.sector).filter((seat) => !seat.occupied && seat.id !== current.id && (
    rowStep ? Math.sign(seat.row_number - current.row_number) === rowStep : seat.row_number === current.row_number && Math.sign(seat.seat_number - current.seat_number) === seatStep));
  if (!candidates.length) return toast('В этом направлении свободных мест нет.');
  const relative = (seat) => seat.seat_number / sectorSeats(seat.sector).filter((s) => s.row_number === seat.row_number).length;
  candidates.sort((a, b) => rowStep
    ? (Math.abs(a.row_number - current.row_number) - Math.abs(b.row_number - current.row_number)) || (Math.abs(relative(a) - relative(current)) - Math.abs(relative(b) - relative(current)))
    : Math.abs(a.seat_number - current.seat_number) - Math.abs(b.seat_number - current.seat_number));
  selectSeat(candidates[0]);
  state.viewMode = 'seat'; updateModeButtons(); drawView();
}
function updateSummary() {
  const seat = state.selected;
  $('summary-seat').textContent = seat ? seatLabel(seat) : 'Выберите место на схеме';
  $('summary-context').textContent = seat ? (seat.kind === 'box' ? 'Ложа на верхней отметке: поле как схема тактики' : seat.row_number <= 3 ? 'У кромки поля, игроки совсем рядом' : 'Центр трибуны, поле видно почти целиком') : 'Чтобы увидеть вид с места';
  $('summary-price').textContent = seat ? money(seat.price_rub) : '—';
  $('view-button').disabled = !seat;
  $('view-insight').hidden = !seat;
  if (seat) {
    const score = viewScore(seat);
    const quality = score >= 80 ? 'Обзор всего поля' : score >= 60 ? 'Хороший обзор с углом' : behindGoal(seat) ? 'Вид из-за ворот' : 'Выразительный боковой ракурс';
    $('view-score').textContent = String(score);
    $('view-score-ring').style.setProperty('--score', `${score}%`);
    $('view-insight-title').textContent = quality;
    $('view-insight-description').textContent = `Оценка рассчитана по положению места на этой трибуне.`;
    $('view-distance').textContent = `${distanceMeters(seat)} м`;
    $('view-height').textContent = `${Math.round(seat.y * METERS_PER_UNIT)} м`;
  }
}
function seatDescription(seat) {
  if (seat.kind === 'box') return 'Ложа наверху: поле видно как схема тактики, зато игроки и мяч заметно мельче.';
  if (seat.row_number <= 3) return behindGoal(seat) ? 'У кромки за воротами: вратарь совсем рядом, а дальняя половина поля сливается в узкую полосу.' : 'У кромки поля: игроки совсем рядом, но дальняя половина поля сливается в узкую полосу.';
  if (behindGoal(seat)) return 'За воротами: хорошо видно атаки на эти ворота, а дальние ворота заметно меньше.';
  return Math.abs(seat.x) > 12 ? 'Сбоку от центра: поле видно под углом, ближняя половина крупнее дальней.' : 'Центр трибуны: поле видно почти целиком, но головы впереди закрывают ближнюю бровку.';
}
function updatePreview() {
  const seat = state.selected; if (!seat) return;
  const stadium = stadiumById(state.stadium);
  $('preview-title').textContent = `Вид с места: сектор ${seat.sector}, ряд ${seat.row_number}, ${seat.kind === 'box' ? 'ложа' : 'место'} ${seat.seat_number}`;
  $('preview-description').textContent = `${stadium.name} · ${matchTitle(matchById(state.match))}`;
  $('aside-seat').textContent = seatLabel(seat);
  $('aside-description').textContent = seatDescription(seat);
  $('aside-price').textContent = money(seat.price_rub);
  $('sound-level').textContent = soundDescription(seat);
}
function soundDescription(seat) {
  const stadium = stadiumById(state.stadium);
  const profile = crowdProfile(seat, state.seats, stadium.sectors, stadium.rows_count);
  const where = profile.fanLevel > .55 ? 'рядом с фан-сектором' : seat.row_number >= stadium.rows_count - 2 ? 'на верхней отметке' : 'вдали от фан-сектора';
  return `Громкость трибуны ${profile.loudness}%: ${where}`;
}
function showPreview() {
  if (!state.selected) return;
  state.viewMode = 'seat'; updateModeButtons();
  updatePreview(); $('preview-section').hidden = false;
  requestAnimationFrame(() => { drawView(); $('preview-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
function hidePreview() { leavePreviewFullscreen(); $('preview-section').hidden = true; state.view3d?.setVisible(false); stopSound(); }

function previewViewport() { return $('stadium-view').parentElement; }
function updateFullscreenButton() {
  const active = document.fullscreenElement === previewViewport() || previewViewport().classList.contains('pseudo-fullscreen');
  const label = active ? 'Выйти из полного экрана' : 'На весь экран';
  $('fullscreen-button').setAttribute('aria-label', label);
  $('fullscreen-button').title = label;
  $('fullscreen-button').textContent = active ? '✕' : '⛶';
  requestAnimationFrame(() => state.view3d?.resize());
}
function leavePreviewFullscreen() {
  const viewport = previewViewport();
  if (document.fullscreenElement === viewport) document.exitFullscreen().catch(() => {});
  viewport.classList.remove('pseudo-fullscreen');
  document.body.classList.remove('preview-fullscreen-open');
  updateFullscreenButton();
}
async function togglePreviewFullscreen() {
  const viewport = previewViewport();
  if (document.fullscreenElement === viewport || viewport.classList.contains('pseudo-fullscreen')) return leavePreviewFullscreen();
  try {
    if (!viewport.requestFullscreen) throw new Error('Fullscreen API unavailable');
    await viewport.requestFullscreen();
  } catch {
    viewport.classList.add('pseudo-fullscreen');
    document.body.classList.add('preview-fullscreen-open');
  }
  updateFullscreenButton();
}

function updateModeButtons() {
  $('mode-seat').classList.toggle('active', state.viewMode === 'seat');
  $('mode-overview').classList.toggle('active', state.viewMode === 'overview');
  $('mode-seat').setAttribute('aria-pressed', String(state.viewMode === 'seat'));
  $('mode-overview').setAttribute('aria-pressed', String(state.viewMode === 'overview'));
  const compact = window.matchMedia('(max-width: 520px)').matches;
  $('viewport-hint').textContent = state.viewMode === 'seat'
    ? compact ? 'Проведите пальцем, чтобы осмотреться' : 'Потяните мышью или пальцем, чтобы осмотреться · колесо — масштаб'
    : compact ? 'Поверните стадион · нажмите на место' : 'Потяните для поворота · нажмите на свободное место';
}

function drawView() {
  const seat = state.selected;
  if (!seat || $('preview-section').hidden) return;
  try {
    if (!state.view3d) {
      state.view3d = new StadiumView($('stadium-view'), (seatId) => {
        const target = state.seats.find((s) => s.id === seatId);
        if (!target || target.occupied) return toast('Это место уже занято.');
        selectSeat(target); state.viewMode = 'seat'; updateModeButtons(); drawView();
      });
    }
    state.view3d.setStadium(stadiumById(state.stadium), state.seats, matchById(state.match));
    if (state.view3d.selectedId !== seat.id) state.view3d.setSeat(seat);
    if (state.view3d.mode !== state.viewMode) state.view3d.setMode(state.viewMode);
    state.view3d.resize();
    state.view3d.setVisible(document.visibilityState === 'visible');
    $('stadium-view').dataset.engine = 'webgl';
    $('viewport-error').hidden = true;
  } catch (error) {
    console.error('WebGL scene:', error);
    $('viewport-error').hidden = false;
    $('viewport-error').textContent = '3D-сцена недоступна в этом браузере. Включите аппаратное ускорение и обновите страницу.';
  }
}

function updateSoundControls(enabled) {
  $('sound-button').setAttribute('aria-pressed', String(enabled));
  $('sound-caption').textContent = enabled ? 'Звук трибуны · нажмите, чтобы выключить' : 'Нажмите, чтобы услышать';
  $('sound-icon').textContent = enabled ? '◉' : '◌';
  $('viewport-sound').setAttribute('aria-pressed', String(enabled));
  $('viewport-sound').setAttribute('aria-label', enabled ? 'Выключить звук трибуны' : 'Включить звук трибуны');
  $('viewport-sound').title = enabled ? 'Выключить звук трибуны' : 'Включить звук трибуны';
  $('viewport-sound').textContent = enabled ? '◉' : '◖';
}
function stopSound() {
  state.view3d?.disableAudio();
  state.audio = null;
  updateSoundControls(false);
}
async function toggleSound() {
  if (state.audio) { stopSound(); return; }
  if (!state.selected || !state.view3d) return toast('Сначала откройте вид с места.');
  try {
    await state.view3d.enableAudio();
    if ($('preview-section').hidden) return state.view3d.disableAudio();
    state.audio = true;
    updateSoundControls(true);
  } catch (error) {
    console.error('Stadium audio:', error);
    toast('Не удалось включить звук трибуны в этом браузере.');
  }
}

function openCheckout() {
  if (!state.selected) return;
  if (!state.user) { state.pendingCheckout = true; openAccount('register'); return; }
  const match = matchById(state.match);
  $('modal-details').textContent = `${matchTitle(match)} · ${longDate(match.starts_at)} · ${seatLabel(state.selected)}`;
  $('modal-price').textContent = money(state.selected.price_rub); $('form-error').hidden = true;
  $('checkout-modal').hidden = false; setTimeout(()=>$('test-card').focus(), 20);
}
function closeCheckout() { $('checkout-modal').hidden = true; }
async function submitCheckout(event) {
  event.preventDefault(); if (state.busy || !state.selected) return;
  state.busy = true; $('confirm-button').disabled = true; $('form-error').hidden = true;
  let paymentId = null;
  try {
    $('confirm-button').textContent = 'Проверяем оплату…';
    const payment = await api('/api/payments/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ match_id: state.match, seat_id: state.selected.id }) });
    paymentId = payment.payment_id;
    const result = await api(`/api/payments/${paymentId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test_card: $('test-card').value.trim() }) });
    const ticket = await api(`/api/tickets/${result.token}`);
    closeCheckout(); showTicket(ticket); state.selected = null; hidePreview(); await refreshSeats(true); refreshTicketCount();
  } catch (error) {
    if (paymentId) api(`/api/payments/${paymentId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    $('form-error').textContent = error.message; $('form-error').hidden = false;
    if (error.status === 409) { closeCheckout(); await refreshSeats(true); toast(error.message); }
  } finally { state.busy = false; $('confirm-button').disabled = false; $('confirm-button').innerHTML = 'Оплатить тестово <span>↗</span>'; }
}
function showTicket(ticket) {
  state.ticket = ticket;
  saveTicketToken(ticket.token);
  $('ticket-match').textContent = `${ticket.home_name} — ${ticket.away_name}`;
  $('ticket-when').textContent = `${longDate(ticket.starts_at)} · ${ticket.tournament}`;
  $('ticket-stadium').textContent = ticket.stadium_name;
  $('ticket-seat').textContent = seatLabel(ticket);
  $('ticket-name').textContent = ticket.customer_name;
  $('ticket-price').textContent = money(ticket.price_rub);
  $('ticket-code').textContent = ticket.token.slice(0, 12).toUpperCase();
  $('ticket-modal').hidden = false;
}
function closeTicket() { $('ticket-modal').hidden = true; history.replaceState(null, '', location.pathname); }
function walletTokens() {
  try {
    const value = JSON.parse(localStorage.getItem('tribunaTickets') || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(item)) : [];
  } catch { return []; }
}
function saveTicketToken(token) {
  try {
    const tokens = [token, ...walletTokens().filter((item) => item !== token)].slice(0, 30);
    localStorage.setItem('tribunaTickets', JSON.stringify(tokens));
    updateWalletCount();
  } catch { /* private browsing can disable local storage */ }
}
function updateWalletCount() {
  const count = state.user ? state.ticketCount : walletTokens().length;
  $('wallet-count').textContent = count ? `(${count})` : '';
}
async function refreshTicketCount() {
  if (!state.user) return;
  try { state.ticketCount = (await api('/api/me/tickets')).tickets.length; updateWalletCount(); }
  catch { /* The wallet can still be opened later. */ }
}
async function openWallet() {
  $('wallet-modal').hidden = false;
  const list = $('wallet-list'); list.replaceChildren();
  const loading = document.createElement('p'); loading.textContent = 'Загружаем билеты…'; list.append(loading);
  let tickets = [];
  try {
    if (state.user) {
      tickets = (await api('/api/me/tickets')).tickets;
      state.ticketCount = tickets.length; updateWalletCount();
    } else {
      const results = await Promise.allSettled(walletTokens().map((token) => api(`/api/tickets/${token}`)));
      tickets = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    }
  } catch (error) { if (!$('wallet-modal').hidden) list.textContent = error.message; return; }
  if ($('wallet-modal').hidden) return;
  list.replaceChildren();
  for (const ticket of tickets) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'wallet-item';
    const title = document.createElement('strong'); title.textContent = `${ticket.home_name} — ${ticket.away_name}`;
    const meta = document.createElement('small'); meta.textContent = `${longDate(ticket.starts_at)} · ${ticket.stadium_name}`;
    const seat = document.createElement('span'); seat.textContent = seatLabel(ticket);
    button.append(title, meta, seat);
    button.addEventListener('click', () => { $('wallet-modal').hidden = true; showTicket(ticket); });
    list.append(button);
  }
  if (!list.children.length) list.textContent = 'Билетов пока нет. Выберите стадион, матч и место.';
}

function updateAccountUI() {
  $('account-button').textContent = state.user ? state.user.name : 'Войти';
  $('dock-account').querySelector('small').textContent = state.user ? 'Профиль' : 'Войти';
  $('account-form').hidden = Boolean(state.user);
  $('account-signed-in').hidden = !state.user;
  $('account-identity').textContent = state.user ? `${state.user.name}\n${state.user.email}` : '';
  updateWalletCount();
}
function setAuthMode(mode) {
  state.authMode = mode;
  $('auth-register-tab').classList.toggle('active', mode === 'register');
  $('auth-login-tab').classList.toggle('active', mode === 'login');
  $('account-name-wrap').hidden = mode !== 'register';
  $('account-name').required = mode === 'register';
  $('account-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('account-submit').textContent = mode === 'register' ? 'Создать аккаунт ↗' : 'Войти ↗';
  $('account-title').textContent = mode === 'register' ? 'Создайте аккаунт' : 'С возвращением';
  $('account-hint').textContent = mode === 'register' ? 'Тестовая регистрация без подтверждения почты.' : 'Войдите, чтобы открыть ваши билеты на любом устройстве.';
  $('account-error').hidden = true;
}
function openAccount(mode = 'register') {
  setAuthMode(mode);
  updateAccountUI();
  $('account-modal').hidden = false;
  if (!state.user) setTimeout(() => $('account-email').focus(), 20);
}
function closeAccount() {
  $('account-modal').hidden = true;
  if (!state.user) state.pendingCheckout = false;
}
async function submitAccount(event) {
  event.preventDefault();
  const endpoint = state.authMode === 'register' ? 'register' : 'login';
  const data = { email: $('account-email').value.trim(), password: $('account-password').value };
  if (endpoint === 'register') data.name = $('account-name').value.trim();
  $('account-submit').disabled = true; $('account-error').hidden = true;
  try {
    state.user = (await api(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).user;
    $('account-password').value = '';
    updateAccountUI(); refreshTicketCount();
    $('account-modal').hidden = true;
    toast(`Здравствуйте, ${state.user.name}!`);
    if (state.pendingCheckout) { state.pendingCheckout = false; openCheckout(); }
  } catch (error) { $('account-error').textContent = error.message; $('account-error').hidden = false; }
  finally { $('account-submit').disabled = false; }
}
async function logoutAccount() {
  try {
    await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.user = null; state.ticketCount = 0; updateAccountUI(); closeAccount(); toast('Вы вышли из аккаунта.');
  } catch (error) { toast(error.message); }
}
function calendarStamp(stamp, minutes = 0) {
  const date = new Date(`${stamp}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '');
}
function downloadCalendar() {
  const ticket = state.ticket; if (!ticket) return;
  const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tribuna//Stadium Ticket//RU', 'BEGIN:VEVENT',
    `UID:${ticket.token}@tribuna.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Moscow:${calendarStamp(ticket.starts_at)}`,
    `DTEND;TZID=Europe/Moscow:${calendarStamp(ticket.starts_at, 120)}`,
    `SUMMARY:${escape(`Матч: ${ticket.home_name} — ${ticket.away_name}`)}`,
    `LOCATION:${escape(`${ticket.stadium_name}, ${ticket.address}`)}`,
    `DESCRIPTION:${escape(seatLabel(ticket))}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `tribuna-${ticket.token.slice(0, 8)}.ics`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function bindEvents() {
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('install-app').hidden = true; toast('Приложение установлено.'); });
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('install-app').hidden = true;
  $('install-app').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    } else if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      toast('В Safari нажмите «Поделиться» → «На экран Домой».');
    } else {
      toast('Откройте меню браузера и выберите «Установить приложение». Для телефона нужен HTTPS.');
    }
  });
  $('my-tickets').addEventListener('click', openWallet);
  $('wallet-mobile').addEventListener('click', openWallet);
  $('dock-tickets').addEventListener('click', openWallet);
  $('dock-account').addEventListener('click', () => openAccount(state.user ? 'login' : 'register'));
  $('account-button').addEventListener('click', () => openAccount(state.user ? 'login' : 'register'));
  $('account-close').addEventListener('click', closeAccount);
  $('account-modal').addEventListener('click', (event) => { if (event.target === $('account-modal')) closeAccount(); });
  $('auth-register-tab').addEventListener('click', () => setAuthMode('register'));
  $('auth-login-tab').addEventListener('click', () => setAuthMode('login'));
  $('account-form').addEventListener('submit', submitAccount);
  $('logout-button').addEventListener('click', logoutAccount);
  document.querySelectorAll('[data-demo-card]').forEach((button) => button.addEventListener('click', () => { $('test-card').value = button.dataset.demoCard; $('test-card').focus(); }));
  $('test-card').addEventListener('input', () => { $('demo-card-number').textContent = $('test-card').value || '•••• •••• •••• 4242'; });
  $('wallet-close').addEventListener('click', () => { $('wallet-modal').hidden = true; });
  $('wallet-modal').addEventListener('click', (event) => { if (event.target === $('wallet-modal')) $('wallet-modal').hidden = true; });
  $('best-seat').addEventListener('click', () => recommendSeat('best'));
  $('near-seat').addEventListener('click', () => recommendSeat('near'));
  $('budget-seat').addEventListener('click', () => recommendSeat('budget'));
  $('view-map-toggle').addEventListener('click', () => { state.heatMap = !state.heatMap; renderSeats(); });
  $('stadium-select').addEventListener('change', async (event) => {
    const first = state.catalog.matches.find((m) => m.stadium_id === event.target.value);
    if (first) await selectMatch(first.id);
    else toast('На этом стадионе пока нет матчей.');
  });
  window.addEventListener('popstate', () => {
    const route = location.pathname.match(/^\/match\/([a-z0-9-]+)\/?$/);
    if (route && matchById(route[1])) openMatch(route[1]);
    else location.reload();
  });
  $('view-button').addEventListener('click', showPreview);
  $('seat-up').addEventListener('click', () => moveSeat(1, 0));
  $('seat-down').addEventListener('click', () => moveSeat(-1, 0));
  $('seat-left').addEventListener('click', () => moveSeat(0, -1));
  $('seat-right').addEventListener('click', () => moveSeat(0, 1));
  $('back-button').addEventListener('click', () => { hidePreview(); $('seat-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('mode-seat').addEventListener('click', () => { state.viewMode = 'seat'; updateModeButtons(); drawView(); });
  $('mode-overview').addEventListener('click', () => { state.viewMode = 'overview'; updateModeButtons(); drawView(); });
  $('look-left').addEventListener('click', () => state.view3d?.nudge(-.18, 0));
  $('look-right').addEventListener('click', () => state.view3d?.nudge(.18, 0));
  $('look-reset').addEventListener('click', () => state.view3d?.resetLook());
  $('stadium-view').addEventListener('keydown', (event) => {
    const directions = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .1], ArrowDown: [0, -.1] };
    if (directions[event.key]) { event.preventDefault(); state.view3d?.nudge(...directions[event.key]); }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); state.view3d?.resetLook(); }
  });
  $('sound-button').addEventListener('click', toggleSound);
  $('viewport-sound').addEventListener('click', toggleSound);
  $('fullscreen-button').addEventListener('click', togglePreviewFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  $('checkout-button').addEventListener('click', openCheckout);
  $('modal-close').addEventListener('click', closeCheckout);
  $('checkout-modal').addEventListener('click', (event) => { if (event.target === $('checkout-modal')) closeCheckout(); });
  $('checkout-form').addEventListener('submit', submitCheckout);
  $('ticket-close').addEventListener('click', closeTicket);
  $('done-ticket').addEventListener('click', () => { closeTicket(); $('booking').scrollIntoView({ behavior: 'smooth' }); });
  $('ticket-modal').addEventListener('click', (event) => { if (event.target === $('ticket-modal')) closeTicket(); });
  $('copy-ticket').addEventListener('click', async () => {
    if (!state.ticket) return;
    const url = new URL(location.pathname, location.origin); url.searchParams.set('ticket', state.ticket.token);
    try { await navigator.clipboard.writeText(url.toString()); toast('Ссылка на билет скопирована.'); }
    catch { toast('Не удалось скопировать. Откройте билет по адресу: ' + url.toString()); }
  });
  $('calendar-ticket').addEventListener('click', downloadCalendar);
  $('print-ticket').addEventListener('click', () => window.print());
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (previewViewport().classList.contains('pseudo-fullscreen')) leavePreviewFullscreen(); closeCheckout(); closeTicket(); closeAccount(); $('wallet-modal').hidden = true; } });
  window.addEventListener('resize', () => { if (!$('preview-section').hidden) { updateModeButtons(); drawView(); } });
}
start();
