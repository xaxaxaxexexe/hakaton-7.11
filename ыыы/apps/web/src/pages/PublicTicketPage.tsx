import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Ticket } from '../lib/types';
import TicketCard from '../components/TicketCard';
import '../styles/checkout.css';

export default function PublicTicketPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mock, setMock] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    setTicket(null);
    if (!token) { setError('В ссылке отсутствует номер билета.'); setLoading(false); return; }
    Promise.all([
      api.ticket(token, controller.signal),
      api.health().catch(() => null),
    ]).then(([result, health]) => {
      if (!active) return;
      setTicket(result);
      setMock(health?.mode === 'mock');
    }).catch((cause) => {
      if (!active || (cause instanceof Error && cause.name === 'AbortError')) return;
      setError(cause instanceof ApiError && cause.status === 404 ? 'Такой билет не найден. Проверьте QR-код или ссылку.' : 'Не удалось проверить билет. Проверьте соединение и попробуйте ещё раз.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [token, refresh]);
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, []);
  return (
    <div className="page-shell order-page">
      <Link className="order-back-link" to="/"><ArrowLeft size={17} aria-hidden="true" /> К матчам</Link>
      <header className="order-heading">
        <span className="eyebrow">ПРОВЕРКА БИЛЕТА</span>
        <h1>{ticket?.status === 'valid' ? 'Ваше место на трибуне.' : ticket ? 'Проверим ваш билет.' : 'Билет на ваш матч.'}</h1>
        <p>{ticket?.status === 'valid' ? 'Матч, место и актуальный статус — всё здесь.' : 'Проверяем данные напрямую в системе бронирования.'}</p>
      </header>
      {loading ? <div className="order-loading" role="status"><LoaderCircle className="checkout-spin" size={30} aria-hidden="true" /><p>Проверяем билет…</p></div> : error ? (
        <div className="order-empty-state"><CircleAlert size={32} strokeWidth={1.5} aria-hidden="true" /><h2>Не удалось открыть билет</h2><p role="alert">{error}</p><button type="button" className="button button--primary" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={17} aria-hidden="true" /> Проверить снова</button></div>
      ) : ticket && <TicketCard ticket={ticket} publicView mock={mock} />}
      {ticket && <div className="order-public-refresh"><button type="button" className="order-refresh" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" /> Обновить статус билета</button></div>}
    </div>
  );
}
