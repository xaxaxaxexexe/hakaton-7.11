// Сквозной тест API (сервер должен быть запущен): npm run smoke
const B = process.env.BASE || 'http://localhost:3000/api'; let tok;
const call = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: b && JSON.stringify(b) }); return { s: r.status, d: await r.json() }; };
const ok = (c, n) => { console.log((c ? 'OK   ' : 'FAIL ') + n); if (!c) process.exitCode = 1; };
let r = await call('POST', '/auth/register', { name: 'Тест', email: `t${Date.now()}@x.ru`, password: 'secret1' }); ok(r.s === 200, 'регистрация'); tok = r.d.token;
r = await call('POST', '/balance/topup', { amount: 1000, method: 'card' }); ok(r.d.balance === 1000, 'пополнение');
r = await call('POST', '/balance/topup', { amount: -5, method: 'card' }); ok(r.s === 400, 'валидация суммы');
const cin = (await call('GET', '/cinemas')).d[0], ses = (await call('GET', `/cinemas/${cin.id}/sessions`)).d.find(s => s.free > 0 && new Date(s.starts_at) > Date.now() + 3 * 36e5);
let seats = (await call('GET', `/sessions/${ses.id}/seats`)).d; const seat = seats.find(s => !s.taken && s.price <= 1000);
r = await call('POST', '/purchase', { sessionId: ses.id, seatId: seat.id, method: 'balance' }); ok(r.s === 200, 'покупка с баланса');
r = await call('POST', '/purchase', { sessionId: ses.id, seatId: seat.id, method: 'balance' }); ok(r.s === 409, 'двойная покупка отклонена');
r = await call('GET', '/me'); ok(r.d.user.balance === 1000 - seat.price, 'баланс списан');
seats = (await call('GET', `/sessions/${ses.id}/seats`)).d; ok(seats.find(s => s.id === seat.id).taken, 'место занято');
const tk = (await call('GET', '/my/tickets')).d[0]; r = await call('POST', `/tickets/${tk.id}/refund`); ok(r.s === 200, 'возврат');
r = await call('POST', `/tickets/${tk.id}/refund`); ok(r.s === 409, 'повторный возврат отклонён');
seats = (await call('GET', `/sessions/${ses.id}/seats`)).d; ok(!seats.find(s => s.id === seat.id).taken, 'место освобождено');
r = await call('GET', '/me'); ok(r.d.user.balance === 1000, 'баланс восстановлен');
tok = null; r = await call('POST', '/purchase', { sessionId: ses.id, seatId: seat.id, method: 'balance' }); ok(r.s === 401, 'без входа оплата балансом запрещена');
