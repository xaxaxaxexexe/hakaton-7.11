// Данные стадиона поверх API: матчи, сектора трибун, цены по рядам.
// API и база не меняются, переименование делается только на клиенте.

export const ARENA = { name: 'Sphera Arena', place: 'Стадион, Грозный' };

const MATCHES = [
  { home: 'Горцы', away: 'Северный Ветер', league: 'Премьер-лига, 15-й тур', tagline: 'Дерби под прожекторами', colors: ['#1fa35a', '#f4f4f0'] },
  { home: 'Звезда Каспия', away: 'Беркут', league: 'Премьер-лига, 15-й тур', tagline: 'Битва за верх таблицы', colors: ['#2563eb', '#f59e0b'] },
  { home: 'Динамо-Сунжа', away: 'Метеор', league: 'Кубок страны, 1/8 финала', tagline: 'Проигравший выбывает', colors: ['#0ea5e9', '#e11d48'] },
  { home: 'Горцы', away: 'Нефтяник', league: 'Премьер-лига, 16-й тур', tagline: 'Домашний матч под куполом', colors: ['#1fa35a', '#111827'] },
  { home: 'Аргун', away: 'Сокол', league: 'Первая лига, 18-й тур', tagline: 'Молодёжь против опыта', colors: ['#7c3aed', '#facc15'] },
  { home: 'Вайнах', away: 'Звезда Каспия', league: 'Премьер-лига, 16-й тур', tagline: 'Кавказское противостояние', colors: ['#dc2626', '#2563eb'] },
  { home: 'Горцы U-19', away: 'Беркут U-19', league: 'Молодёжная лига', tagline: 'Семейный матч, вход для детей со скидкой', colors: ['#22c55e', '#f59e0b'] },
  { home: 'Сборная звёзд', away: 'Ветераны', league: 'Товарищеский матч', tagline: 'Праздник футбола', colors: ['#f4f4f0', '#1fa35a'] },
];
const MOVIE_ORDER = [
  '66666666-6666-4666-8666-666666666601', '33333333-3333-4333-8333-333333333304',
  '33333333-3333-4333-8333-333333333302', '66666666-6666-4666-8666-666666666603',
  '66666666-6666-4666-8666-666666666602', '33333333-3333-4333-8333-333333333301',
  '66666666-6666-4666-8666-666666666604', '33333333-3333-4333-8333-333333333303',
];
const MOVIE_TITLES = ['Башни над Аргуном', 'Вершина', 'Город будущего', 'Ночной Грозный', 'Перевал', 'Путь к звёздам', 'Сокол над Тереком', 'Тайна старого маяка'];

const SECTORS = {
  1: { name: 'Сектор A', subtitle: 'Западная трибуна, центр поля', features: ['Вид по центру поля', 'Козырёк от дождя', 'Рядом фуд-корт'] },
  2: { name: 'Сектор B', subtitle: 'Западная трибуна, у углового', features: ['Вид вдоль бровки', 'Близко к выходу'] },
  3: { name: 'Сектор C', subtitle: 'Северная трибуна, за воротами', features: ['Фан-сектор', 'Самая громкая трибуна'] },
  4: { name: 'Сектор D', subtitle: 'Южная трибуна, семейная зона', features: ['Семейный сектор', 'Детские цены'] },
  5: { name: 'Сектор E', subtitle: 'Восточная трибуна', features: ['Вид на скамейки запасных', 'Места для двоих в последнем ряду'] },
  6: { name: 'VIP Sphera', subtitle: 'Центральная ложа над полем', features: ['Лучший обзор на стадионе', 'Мягкие кресла', 'Кейтеринг в перерыве'] },
  7: { name: 'Скай-бокс', subtitle: 'Закрытая ложа с обслуживанием', features: ['Кресла-реклайнеры', 'Столики у мест', 'Отдельный вход'] },
  8: { name: 'VIP Комфорт', subtitle: 'Премиум-места у центральной линии', features: ['Широкие кресла', 'Подогрев сидений', 'Увеличенный шаг рядов'] },
};

function hash(s = '') { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
export function matchOf(idOrTitle) {
  let i = MOVIE_ORDER.indexOf(idOrTitle);
  if (i < 0) i = MOVIE_TITLES.indexOf(idOrTitle);
  if (i < 0) i = hash(idOrTitle) % MATCHES.length;
  return MATCHES[i];
}
export const matchTitle = (m) => `${m.home} — ${m.away}`;
export const sectorOf = (n) => SECTORS[n] || { name: `Сектор ${n}`, subtitle: 'Трибуна', features: [] };

function asMovie(o) {
  const m = matchOf(o.id || o.title);
  Object.assign(o, {
    title: matchTitle(m), home: m.home, away: m.away, colors: m.colors,
    genre: m.league, tagline: m.tagline, age_rating: '0+', duration_minutes: 105, country: ARENA.name,
    synopsis: `${m.home} принимают команду «${m.away}». ${m.league}. Ворота стадиона открываются за полтора часа до начала, разминка команд за 40 минут.`,
    palette: [m.colors[0], '#0d2a1b', '#06140c'],
  });
}
function asHall(o, numKey) {
  const s = sectorOf(o[numKey]);
  o.name = s.name;
  if ('subtitle' in o) o.subtitle = s.subtitle;
  if ('features' in o) o.features = s.features;
}

// Обходит ответ API и переименовывает сущности.
export function stadiumize(data) {
  const walk = (o, key) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, key)); return; }
    if (!o || typeof o !== 'object') return;
    const isMovie = key === 'movie' || key === 'movies' || ('motif' in o && 'title' in o) || ('synopsis' in o && 'duration_minutes' in o);
    if (isMovie) asMovie(o);
    else {
      if ('movie_id' in o && 'title' in o) o.title = matchTitle(matchOf(o.movie_id));
      if ('hall_number' in o && 'hall_name' in o) o.hall_name = sectorOf(o.hall_number).name;
      if ('hall_number' in o && 'name' in o && 'category' in o) asHall(o, 'hall_number');
      if ('number' in o && 'name' in o && 'category' in o) asHall(o, 'number');
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, k);
  };
  walk(data, '');
  return data;
}
