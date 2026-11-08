// Создаёт БД и таблицы, затем генерирует стадионы, сектора, места, матчи и расписание.
// Новый стадион/сектор: добавьте запись в CINEMAS / HALLS и снова запустите `npm run seed`.
import 'dotenv/config'; import fs from 'fs'; import mysql from 'mysql2/promise';
const DB = process.env.DB_NAME || 'arena3d';
const CINEMAS = [
  ['Арена «Горцы»', 'Грозный, пр. Спортивный, 1', 'Главный стадион: 7 лож в верхнем ряду сектора'],
  ['Стадион «Северный»', 'Аргун, ул. Стадионная, 4', 'Компактный стадион, трибуны близко к полю'],
  ['Арена «Каспий»', 'Гудермес, ул. Набережная, 10', 'Крытые трибуны и фан-сектор за воротами']];
// rows — число рядов на трибуне, n — мест в ряду, tiers — [до какого ряда включительно, цена], sofas/sofa — ложи в верхнем ряду
const HALLS = [
  { cinema: 0, name: 'Сектор C', screen: [16, 6], rows: 9, n: 16, tiers: [[3, 700], [9, 1200]], sofas: 7, sofa: 3500 },
  { cinema: 1, name: 'Сектор A', screen: [14, 5.5], rows: 7, n: 18, tiers: [[2, 600], [7, 1000]], sofas: 6, sofa: 3000 },
  { cinema: 2, name: 'Сектор B · фан-сектор', screen: [15, 6], rows: 8, n: 20, tiers: [[3, 500], [8, 800]], sofas: 6, sofa: 2800 }];
// title, описание, минут, турнир (в поле genre), hue карточки, год, город, рейтинг, возраст, через сколько дней старт продаж (0 — уже в продаже; >0 — «Скоро», матчей нет)
// trailer_url можно проставить в БД вручную (ссылка вида https://www.youtube.com/embed/ID или .mp4) — тогда видеообзор откроется во встроенном плеере.
const MOVIES = [
  ['Горцы — Северный Ветер', 'Дерби под прожекторами: лидер принимает главного соперника.', 105, 'Премьер-лига', 140, 2026, 'Грозный', 8.4, '0+', 0],
  ['Звезда Каспия — Беркут', 'Битва за верх таблицы перед зимней паузой.', 105, 'Премьер-лига', 210, 2026, 'Гудермес', 7.8, '0+', 0],
  ['Динамо-Сунжа — Метеор', 'Кубковый матч: проигравший выбывает.', 105, 'Кубок страны', 190, 2026, 'Грозный', 7.5, '0+', 0],
  ['Аргун — Сокол', 'Молодая команда хозяев против опытных гостей.', 105, 'Первая лига', 270, 2026, 'Аргун', 6.9, '0+', 0],
  ['Горцы U-19 — Беркут U-19', 'Семейный матч молодёжных составов.', 105, 'Молодёжная лига', 120, 2026, 'Грозный', 7.1, '0+', 0],
  ['Вайнах — Звезда Каспия', 'Кавказское противостояние двух лучших атак лиги.', 105, 'Премьер-лига', 0, 2026, 'Грозный', 8.0, '0+', 0],
  ['Сборная звёзд — Ветераны', 'Новогодний товарищеский матч.', 105, 'Товарищеский', 60, 2026, 'Грозный', 7.0, '0+', 21],
  ['Горцы — Нефтяник', 'Первый матч весенней части сезона.', 105, 'Премьер-лига', 150, 2026, 'Грозный', 0, '0+', 35]];
const SP = 0.85, RZ = 1.2, Z0 = 3.6, CURVE = 0.006, RISE = 0.55, BOX_LIFT = 2.4; // крутая трибуна, ложи подняты над рядами
function genSeats(h) {
  const out = [];
  for (let r = 1; r <= h.rows; r++) {
    const price = h.tiers.find(t => r <= t[0])[1];
    for (let s = 1; s <= h.n; s++) { const x = (s - (h.n + 1) / 2) * SP; out.push([r, s, 'standard', `Ряд ${r}, место ${s}`, x, r * RISE, Z0 + (r - 1) * RZ + x * x * CURVE, price]); }
  }
  const r = h.rows + 1, step = (h.n * SP) / h.sofas;
  for (let s = 1; s <= h.sofas; s++) { const x = (s - (h.sofas + 1) / 2) * step; out.push([r, s, 'sofa', `Ряд ${r}, ложа ${s}`, x, r * RISE + BOX_LIFT, Z0 + (r - 1) * RZ + 0.3 + x * x * CURVE, h.sofa]); }
  return out;
}
const c = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true });
await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4`); await c.query(`USE \`${DB}\``);
await c.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const cid = [], mid = [], hid = [], playing = [];
for (const x of CINEMAS) cid.push((await c.query('INSERT INTO cinemas (name,address,description) VALUES (?)', [x]))[0].insertId);
for (const m of MOVIES) { const id = (await c.query('INSERT INTO movies (title,description,duration,genre,hue,year,country,rating,age,premiere) VALUES (?)', [[...m.slice(0, 9), m[9] ? new Date(Date.now() + m[9] * 864e5) : null]]))[0].insertId; mid.push(id); if (!m[9]) playing.push(id); }
const seatsByHall = [];
for (const h of HALLS) {
  const id = (await c.query('INSERT INTO halls (cinema_id,name,screen_w,screen_h) VALUES (?,?,?,?)', [cid[h.cinema], h.name, ...h.screen]))[0].insertId;
  hid.push(id); const seats = genSeats(h);
  await c.query('INSERT INTO seats (hall_id,row_num,seat_num,seat_type,label,x,y,z,price) VALUES ?', [seats.map(s => [id, ...s])]);
  seatsByHall.push((await c.query('SELECT id,row_num,seat_num FROM seats WHERE hall_id=?', [id]))[0]);
}
// Будущие матчи: сегодня (если ещё не поздно) и ближайшие 3 дня
const now = Date.now(), times = [[14, 0], [17, 0], [19, 30], [21, 0]]; let k = 0;
for (let hi = 0; hi < HALLS.length; hi++) for (let d = 0; d < 4; d++) for (const [H, M] of times) {
  const t = new Date(); t.setDate(t.getDate() + d); t.setHours(H, M, 0, 0); if (t.getTime() < now + 30 * 60000) continue;
  const sid = (await c.query('INSERT INTO sessions (cinema_id,hall_id,movie_id,starts_at,format) VALUES (?,?,?,?,?)', [cid[HALLS[hi].cinema], hid[hi], playing[k % playing.length], t, k % 3 === 0 ? '3D' : '2D']))[0].insertId; k++;
  // Часть мест занята для наглядности; три контрольных места (р1/м3, р6/м12, последний ряд/последний диван) всегда свободны
  const [bk] = await c.query("INSERT INTO bookings (session_id,buyer_name,total_price) VALUES (?, 'Демо-болельщик', 0)", [sid]); const last = HALLS[hi].rows + 1;
  const taken = seatsByHall[hi].filter(s => !((s.row_num === 1 && s.seat_num === 3) || (s.row_num === 6 && s.seat_num === 12) || (s.row_num === last && s.seat_num === HALLS[hi].sofas)) && (s.row_num * 31 + s.seat_num * 17 + sid * 7) % 100 < 25);
  if (taken.length) await c.query('INSERT INTO tickets (booking_id,session_id,seat_id,price,token) VALUES ?', [taken.map(s => [bk.insertId, sid, s.id, 0, crypto.randomUUID()])]);
}
console.log(`Готово: БД «${DB}», матчей: ${k}`); await c.end();
