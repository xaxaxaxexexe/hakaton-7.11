import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, RefreshCw, Ticket } from 'lucide-react';
import { api } from '../lib/api';
import type { Order } from '../lib/types';
import { money, sessionDate } from '../lib/format';
import { EmptyState, Loading } from '../components/Feedback';
import '../styles/checkout.css';

const statusLabels: Record<Order['status'], string> = {
  creating_payment: 'Создаётся оплата',
  pending_payment: 'Ожидает оплаты',
  paid: 'Оплачено',
  canceled: 'Отменён',
  expired: 'Срок оплаты истёк',
  payment_review: 'Проверяем оплату',
  refunded: 'Возврат подтверждён',
};

export default function MyTicketsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setUnavailable(false);
    const requests: Array<Promise<Order>> = [];
    try {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith('zal:order:')) continue;
        const token = sessionStorage.getItem(key);
        const id = key.slice('zal:order:'.length);
        if (token && id) requests.push(api.order(id, token, controller.signal));
      }
    } catch { setUnavailable(true); }
    Promise.allSettled(requests).then((results) => {
      if (!active) return;
      const loaded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      setOrders(loaded.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      if (results.some((result) => result.status === 'rejected')) setUnavailable(true);
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [refresh]);
  return (
    <div className="page-shell my-tickets-page">
      <Link className="order-back-link" to="/"><ArrowLeft size={17} aria-hidden="true" /> К матчам</Link>
      <header className="order-heading">
        <span className="eyebrow">ВАШИ МАТЧИ</span>
        <h1>Мои билеты.</h1>
        <p>Заказы, оформленные в этой вкладке. Готовый билет можно сохранить в PDF и открыть по QR-коду.</p>
      </header>
      {loading ? <Loading label="Находим ваши билеты…" /> : (
        <>
          {unavailable && <div className="order-alert" role="alert"><p>Не все заказы удалось загрузить. Проверьте соединение и повторите проверку.</p><button type="button" onClick={() => setRefresh((value) => value + 1)} aria-label="Обновить список заказов"><RefreshCw size={18} aria-hidden="true" /></button></div>}
          {orders.length > 0 ? <div className="orders-list">
            {orders.map((order) => (
              <Link className="order-list-item" to={'/orders/' + encodeURIComponent(order.id)} key={order.id}>
                <span className="order-list-icon"><Ticket size={25} strokeWidth={1.4} aria-hidden="true" /></span>
                <div><span className="eyebrow">ЗАКАЗ № {order.id.slice(0, 8).toUpperCase()}</span><h2>{statusLabels[order.status]}</h2><p>{sessionDate(order.created_at)}</p></div>
                <strong>{money(order.total_minor)}</strong><ArrowUpRight size={21} aria-hidden="true" />
              </Link>
            ))}
          </div> : <EmptyState title="Ваш следующий матч — впереди." action={<Link className="button button--primary" to="/#sessions">Выбрать матч <ArrowUpRight size={17} aria-hidden="true" /></Link>}>Здесь появятся ваши заказы. Выберите матч и посмотрите на поле со своего будущего места.</EmptyState>}
        </>
      )}
    </div>
  );
}
