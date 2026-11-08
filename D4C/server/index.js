import express from 'express'; import path from 'path'; import { fileURLToPath } from 'url'; import { pool } from './db.js'; import { r as account } from './account.js';
const dir = path.dirname(fileURLToPath(import.meta.url)), app = express(); app.use(express.json());
app.use('/vendor/three', express.static(path.join(dir, '../node_modules/three'))); app.use(express.static(path.join(dir, '../public'))); app.use('/api', account);
const wrap = f => (q, r) => f(q, r).catch(e => { console.error(e); r.status(500).json({ error: 'Сервер временно недоступен. Попробуйте ещё раз.' }); });
const q = async (sql, p = []) => (await pool.query(sql, p))[0];

app.get('/api/cinemas', wrap(async (_, r) => r.json(await q('SELECT id,name,address,description FROM cinemas WHERE active=1'))));
const MOVIE_COLS = 'm.id,m.title,m.description,m.duration,m.genre,m.hue,m.year,m.country,m.rating,m.age,m.premiere,m.trailer_url';
// Афиша: матчи с ближайшими датами («Ближайшие матчи») и без них («Скоро»)
app.get('/api/movies', wrap(async (_, r) => {
  const rows = await q(`SELECT ${MOVIE_COLS}, COUNT(s.id) sessions_count, MIN(s.starts_at) next_start, GROUP_CONCAT(DISTINCT s.format) formats,
    (SELECT MIN(st.price) FROM seats st WHERE st.active=1 AND st.hall_id IN (SELECT hall_id FROM sessions WHERE movie_id=m.id AND starts_at>NOW())) min_price
    FROM movies m LEFT JOIN sessions s ON s.movie_id=m.id AND s.starts_at>NOW() GROUP BY m.id ORDER BY m.id`);
  r.json(rows.map(m => ({ ...m, rating: m.rating == null ? null : Number(m.rating), formats: m.formats ? m.formats.split(',') : [], soon: !m.sessions_count })));
}));
// Страница матча: описание + все будущие даты по стадионам
app.get('/api/movies/:id', wrap(async (req, r) => {
  const [m] = await q(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.id=?`, [req.params.id]);
  if (!m) return r.status(404).json({ error: 'Матч не найден' });
  const sessions = await q(`SELECT s.id,s.starts_at,s.format,s.cinema_id,c.name cinema,c.address,h.name hall,
    (SELECT COUNT(*) FROM seats WHERE hall_id=s.hall_id AND active=1)-(SELECT COUNT(*) FROM tickets t WHERE t.session_id=s.id AND t.live=1) free,
    (SELECT MIN(price) FROM seats WHERE hall_id=s.hall_id AND active=1) min_price
    FROM sessions s JOIN cinemas c ON c.id=s.cinema_id JOIN halls h ON h.id=s.hall_id WHERE s.movie_id=? AND s.starts_at>NOW() AND c.active=1 ORDER BY s.starts_at`, [req.params.id]);
  r.json({ ...m, rating: m.rating == null ? null : Number(m.rating), sessions });
}));
app.get('/api/cinemas/:id/sessions', wrap(async (req, r) => r.json(await q(
  `SELECT s.id,s.starts_at,s.format,m.id movie_id,m.title,m.description,m.duration,m.genre,m.hue,h.name hall,
   (SELECT COUNT(*) FROM seats WHERE hall_id=s.hall_id AND active=1)-(SELECT COUNT(*) FROM tickets t WHERE t.session_id=s.id AND t.live=1) free
   FROM sessions s JOIN movies m ON m.id=s.movie_id JOIN halls h ON h.id=s.hall_id
   WHERE s.cinema_id=? AND s.starts_at>NOW() ORDER BY s.starts_at`, [req.params.id]))));
app.get('/api/sessions/:id', wrap(async (req, r) => {
  const [s] = await q(`SELECT s.id,s.starts_at,s.format,m.title,c.name cinema,h.name hall,h.screen_w,h.screen_h FROM sessions s
    JOIN movies m ON m.id=s.movie_id JOIN cinemas c ON c.id=s.cinema_id JOIN halls h ON h.id=s.hall_id WHERE s.id=?`, [req.params.id]);
  s ? r.json(s) : r.status(404).json({ error: 'Матч не найден' });
}));
app.get('/api/sessions/:id/seats', wrap(async (req, r) => r.json((await q(
  `SELECT st.id,st.row_num,st.seat_num,st.seat_type,st.label,st.x,st.y,st.z,st.price,(t.id IS NOT NULL) taken
   FROM seats st LEFT JOIN tickets t ON t.seat_id=st.id AND t.live=1 AND t.session_id=?
   WHERE st.active=1 AND st.hall_id=(SELECT hall_id FROM sessions WHERE id=?) ORDER BY st.row_num,st.seat_num`, [req.params.id, req.params.id])).map(s => ({ ...s, taken: !!s.taken })))));

app.get('/api/tickets/:token', wrap(async (req, r) => {
  const [t] = await q(`SELECT t.token,t.price,b.buyer_name,t.status,b.id booking,s.starts_at,s.format,m.title,c.name cinema,c.address,h.name hall,st.label
    FROM tickets t JOIN bookings b ON b.id=t.booking_id JOIN sessions s ON s.id=t.session_id JOIN movies m ON m.id=s.movie_id
    JOIN cinemas c ON c.id=s.cinema_id JOIN halls h ON h.id=s.hall_id JOIN seats st ON st.id=t.seat_id WHERE t.token=?`, [req.params.token]);
  t ? r.json(t) : r.status(404).json({ error: 'Билет не найден' });
}));
const port = process.env.PORT || 3000; app.listen(port, () => console.log(`http://localhost:${port}`));
