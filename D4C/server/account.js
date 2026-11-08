// Аккаунты, баланс, покупка, возвраты. Все финансовые операции — только здесь, внутри транзакций БД.
import { Router } from 'express'; import crypto from 'crypto'; import { pool } from './db.js';
export const r = Router();
const MIN = +(process.env.REFUND_BEFORE_MIN || 60), PCT = +(process.env.REFUND_PERCENT || 100); // правила возврата (конфигурируются в .env)
class Fail extends Error { constructor(s, m) { super(m); this.s = s; } }
const W = f => (a, b, n) => f(a, b, n).catch(e => e instanceof Fail ? b.status(e.s).json({ error: e.message }) : (console.error(e), b.status(500).json({ error: 'Сервер временно недоступен. Попробуйте ещё раз.' })));
const q = async (s, p = []) => (await pool.query(s, p))[0];
const need = req => { if (!req.user) throw new Fail(401, 'Войдите в аккаунт'); };
async function tx(fn) { const c = await pool.getConnection(); try { await c.beginTransaction(); const v = await fn(c); await c.commit(); return v; } catch (e) { await c.rollback().catch(() => {}); throw e; } finally { c.release(); } }
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const okPw = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 32)); };
const issue = async id => { const t = crypto.randomBytes(32).toString('hex'); await q('INSERT INTO auth_tokens (token,user_id) VALUES (?,?)', [t, id]); return t; };

r.use(W(async (req, _, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', ''); req.user = null;
  if (t) [req.user = null] = await q('SELECT u.id,u.name,u.email,u.balance FROM auth_tokens a JOIN users u ON u.id=a.user_id WHERE a.token=?', [t]);
  next();
}));
r.post('/auth/register', W(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80), email = String(req.body?.email || '').trim().toLowerCase(), pw = String(req.body?.password || '');
  if (!name) throw new Fail(400, 'Введите имя'); if (!/^\S+@\S+\.\S+$/.test(email)) throw new Fail(400, 'Введите корректный email'); if (pw.length < 6) throw new Fail(400, 'Пароль — не короче 6 символов');
  try { const [u] = await pool.query('INSERT INTO users (name,email,pass_hash) VALUES (?,?,?)', [name, email, hashPw(pw)]); res.json({ token: await issue(u.insertId) }); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new Fail(409, 'Этот email уже зарегистрирован'); throw e; }
}));
r.post('/auth/login', W(async (req, res) => {
  const [u] = await q('SELECT id,pass_hash FROM users WHERE email=?', [String(req.body?.email || '').trim().toLowerCase()]);
  if (!u || !okPw(String(req.body?.password || ''), u.pass_hash)) throw new Fail(401, 'Неверный email или пароль');
  res.json({ token: await issue(u.id) });
}));
r.post('/auth/logout', W(async (req, res) => { await q('DELETE FROM auth_tokens WHERE token=?', [(req.headers.authorization || '').replace('Bearer ', '')]); res.json({}); }));
r.get('/me', W(async (req, res) => {
  need(req); const [n] = await q("SELECT COUNT(*) n FROM tickets WHERE user_id=? AND status='paid'", [req.user.id]);
  const [next = null] = await q(`SELECT s.starts_at,m.title FROM tickets t JOIN sessions s ON s.id=t.session_id JOIN movies m ON m.id=s.movie_id WHERE t.user_id=? AND t.status='paid' AND s.starts_at>NOW() ORDER BY s.starts_at LIMIT 1`, [req.user.id]);
  res.json({ user: req.user, tickets: n.n, next, rules: { minutes: MIN, percent: PCT } });
}));
// Пополнение — ДЕМО: реальный платёжный провайдер не подключён, деньги не списываются
r.post('/balance/topup', W(async (req, res) => {
  need(req); const a = Number(req.body?.amount), m = req.body?.method;
  if (!Number.isInteger(a) || a < 100 || a > 50000) throw new Fail(400, 'Сумма пополнения — от 100 до 50 000 ₽'); if (!['card', 'sbp'].includes(m)) throw new Fail(400, 'Выберите способ оплаты');
  res.json({ balance: await tx(async c => { await c.query('UPDATE users SET balance=balance+? WHERE id=?', [a, req.user.id]); await c.query("INSERT INTO transactions (user_id,type,amount,method) VALUES (?, 'topup', ?, ?)", [req.user.id, a, 'demo-' + m]); return (await c.query('SELECT balance FROM users WHERE id=?', [req.user.id]))[0][0].balance; }) });
}));
r.get('/transactions', W(async (req, res) => {
  need(req); const t = req.query.type, ok = ['topup', 'purchase', 'refund'].includes(t);
  res.json(await q(`SELECT x.id,x.type,x.amount,x.method,x.status,x.created_at,m.title FROM transactions x LEFT JOIN tickets t ON t.id=x.ticket_id LEFT JOIN sessions s ON s.id=t.session_id LEFT JOIN movies m ON m.id=s.movie_id
    WHERE x.user_id=? ${ok ? 'AND x.type=?' : ''} ORDER BY x.id DESC LIMIT 200`, ok ? [req.user.id, t] : [req.user.id]));
}));
r.get('/my/tickets', W(async (req, res) => {
  need(req);
  res.json(await q(`SELECT t.id,t.token,t.price,t.status,s.starts_at,s.format,m.title,m.hue,c.name cinema,c.address,h.name hall,st.label,
    (t.status='paid' AND s.starts_at>NOW()+INTERVAL ? MINUTE) can_refund, FLOOR(t.price*?/100) refund_amount
    FROM tickets t JOIN sessions s ON s.id=t.session_id JOIN movies m ON m.id=s.movie_id JOIN cinemas c ON c.id=s.cinema_id JOIN halls h ON h.id=s.hall_id JOIN seats st ON st.id=t.seat_id
    WHERE t.user_id=? ORDER BY s.starts_at`, [MIN, PCT, req.user.id]));
}));
// Покупка: цена берётся из БД; при оплате балансом строка пользователя блокируется FOR UPDATE — отрицательный баланс и двойное списание невозможны;
// UNIQUE(session_id, seat_id, live) не даёт продать одно место дважды
r.post('/purchase', W(async (req, res) => {
  const { sessionId, seatId, email, method } = req.body || {}, bal = method === 'balance'; let name = String(req.body?.name || '').trim().slice(0, 80);
  if (bal) need(req); if (req.user) name = req.user.name; if (!name) throw new Fail(400, 'Введите имя покупателя');
  res.json(await tx(async c => {
    const [[row]] = await c.query('SELECT st.price FROM sessions s JOIN seats st ON st.hall_id=s.hall_id WHERE s.id=? AND st.id=? AND st.active=1 AND s.starts_at>NOW()', [sessionId, seatId]);
    if (!row) throw new Fail(404, 'Матч или место недоступны');
    if (bal && (await c.query('SELECT balance FROM users WHERE id=? FOR UPDATE', [req.user.id]))[0][0].balance < row.price) throw new Fail(402, 'Недостаточно средств на балансе');
    const [b] = await c.query('INSERT INTO bookings (session_id,buyer_name,buyer_email,total_price) VALUES (?,?,?,?)', [sessionId, name, String(email || '').slice(0, 120) || null, row.price]), token = crypto.randomUUID();
    let t; try { [t] = await c.query('INSERT INTO tickets (booking_id,session_id,seat_id,price,token,user_id) VALUES (?,?,?,?,?,?)', [b.insertId, sessionId, seatId, row.price, token, req.user?.id ?? null]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new Fail(409, 'Это место уже купили. Выберите другое.'); throw e; }
    if (req.user) { if (bal) await c.query('UPDATE users SET balance=balance-? WHERE id=?', [row.price, req.user.id]); await c.query("INSERT INTO transactions (user_id,type,amount,method,ticket_id) VALUES (?, 'purchase', ?, ?, ?)", [req.user.id, -row.price, bal ? 'balance' : 'demo-card', t.insertId]); }
    return { token, price: row.price };
  }));
}));
// Возврат: правила из .env (REFUND_BEFORE_MIN, REFUND_PERCENT). Деньги идут на внутренний баланс, место освобождается (live=NULL) в той же транзакции
r.post('/tickets/:id/refund', W(async (req, res) => {
  need(req);
  res.json({ amount: await tx(async c => {
    const [[t]] = await c.query('SELECT t.id,t.price,t.status,s.starts_at>NOW()+INTERVAL ? MINUTE ok FROM tickets t JOIN sessions s ON s.id=t.session_id WHERE t.id=? AND t.user_id=? FOR UPDATE', [MIN, req.params.id, req.user.id]);
    if (!t) throw new Fail(404, 'Билет не найден'); if (t.status !== 'paid') throw new Fail(409, 'Билет уже возвращён'); if (!t.ok) throw new Fail(409, `Возврат возможен не позже чем за ${MIN} мин до начала матча`);
    const a = Math.floor(t.price * PCT / 100);
    await c.query("UPDATE tickets SET status='refunded', live=NULL WHERE id=?", [t.id]); await c.query('UPDATE users SET balance=balance+? WHERE id=?', [a, req.user.id]);
    await c.query("INSERT INTO transactions (user_id,type,amount,method,ticket_id) VALUES (?, 'refund', ?, 'balance', ?)", [req.user.id, a, t.id]); return a;
  }) });
}));
