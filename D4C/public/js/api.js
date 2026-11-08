const tok = () => localStorage.getItem('tok');
const j = async (u, o = {}) => {
  let r; try { r = await fetch(u, { ...o, headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(tok() ? { Authorization: 'Bearer ' + tok() } : {}) } }); } catch { throw new Error('Нет связи с сервером. Проверьте, что он запущен.'); }
  const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error || 'Ошибка сервера'); e.status = r.status; throw e; } return d;
};
const post = (u, b) => j(u, { method: 'POST', body: JSON.stringify(b || {}) });
export const cinemas = () => j('/api/cinemas');
export const sessions = id => j(`/api/cinemas/${id}/sessions`);
export const session = id => j(`/api/sessions/${id}`);
export const seats = id => j(`/api/sessions/${id}/seats`);
export const ticket = t => j(`/api/tickets/${t}`);
export const purchase = b => post('/api/purchase', b);
export const auth = (mode, b) => post('/api/auth/' + mode, b);
export const logout = () => post('/api/auth/logout');
export const me = () => j('/api/me');
export const topup = b => post('/api/balance/topup', b);
export const transactions = t => j('/api/transactions' + (t ? '?type=' + t : ''));
export const myTickets = () => j('/api/my/tickets');
export const refund = id => post(`/api/tickets/${id}/refund`);
export const movies = () => j('/api/movies');
export const movie = id => j(`/api/movies/${id}`);
