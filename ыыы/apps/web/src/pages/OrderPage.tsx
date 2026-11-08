import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock3, ExternalLink, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Order, OrderPricing, Session, Seat, Ticket } from '../lib/types';
import { money, sessionDate, sessionTime } from '../lib/format';
import TicketCard from '../components/TicketCard';
import PaymentQr from '../components/PaymentQr';
import { paymentQrTarget } from '../lib/paymentQr';
import '../styles/checkout.css';

function readToken(id: string) {
  try { return sessionStorage.getItem('zal:order:' + id); } catch { return null; }
}

function safePaymentUrl(order: Order) {
  if (!order.payment.payment_url) return null;
  try {
    const url = new URL(order.payment.payment_url);
    if (url.username || url.password) return null;
    if (order.payment.provider === 'mock') {
      return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    }
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function remaining(expiresAt: string | null, clock: number) {
  if (!expiresAt) return null;
  const seconds = Math.ceil((new Date(expiresAt).getTime() - clock) / 1000);
  if (!Number.isFinite(seconds)) return null;
  if (seconds <= 0) return 'Проверяем срок оплаты';
  return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
}

const COPY = {
  creating_payment: { eyebrow: 'СОХРАНЯЕМ ВАШЕ МЕСТО', title: 'Готовим оплату.', description: 'Место уже забронировано. Ещё немного — и можно переходить в приложение банка.' },
  pending_payment: { eyebrow: 'ВАШЕ МЕСТО ЖДЁТ', title: 'Матч уже близко.', description: 'Оплатите билет через СБП. Мы автоматически проверим платёж и покажем ваш билет.' },
  paid: { eyebrow: 'ВАШЕ МЕСТО ЗАБРОНИРОВАНО', title: 'До встречи на трибуне.', description: 'Оплата подтверждена. Осталось прийти на стадион и занять своё место.' },
  canceled: { eyebrow: 'ОПЛАТА ОТМЕНЕНА', title: 'Можно попробовать снова.', description: 'Этот платёж отменён. Вернитесь к схеме и выберите место для новой покупки.' },
  expired: { eyebrow: 'ВРЕМЯ ОПЛАТЫ ИСТЕКЛО', title: 'История ещё впереди.', description: 'Срок этой оплаты закончился. Выберите свободное место и оформите новый билет.' },
  payment_review: { eyebrow: 'ПРОВЕРЯЕМ ОПЛАТУ', title: 'Нам нужно немного времени.', description: 'Сверяем платёж с банком. Повторно оплачивать заказ не нужно — эта страница обновится сама.' },
  refunded: { eyebrow: 'ОПЛАТА ВОЗВРАЩЕНА', title: 'Этот билет больше не действует.', description: 'Возврат подтверждён платёжной системой. Если захотите вернуться, выберите новый матч.' },
};

export default function OrderPage() {
  const { orderId: paramId } = useParams<{ orderId: string }>();
  const [search] = useSearchParams();
  const orderId = paramId || search.get('order') || '';
  const [order, setOrder] = useState<Order | null>(null);
  const [pricing, setPricing] = useState<OrderPricing | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [timezone, setTimezone] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const retryRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setOrder(null); setPricing(null); setTicket(null); setSession(null); setSeat(null); setTimezone(undefined); setError(''); setLoading(true);
  }, [orderId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const token = readToken(orderId);
    if (!orderId || !token) {
      setError(!orderId ? 'Ссылка на заказ неполная. Откройте свой заказ после выбора места.' :
        'Этот заказ открыт в другом браузере или вкладке. Вернитесь в окно, где вы оформляли покупку. Готовый билет можно открыть по его QR-коду.');
      setLoading(false);
      return () => controller.abort();
    }
    async function poll() {
      setChecking(true);
      let shouldContinue = true;
      let delay = 3000;
      try {
        const result = await api.order(orderId, token!, controller.signal);
        if (!alive) return;
        setOrder(result);
        setError('');
        retryRef.current = 0;
        if (result.status !== 'paid') setTicket(null);
        if (result.status === 'paid') {
          const resultTicket = await api.orderTicket(orderId, token!, controller.signal);
          if (!alive) return;
          setTicket(resultTicket);
          shouldContinue = false;
          try {
            const pending = JSON.parse(sessionStorage.getItem('zal:pending-order') || 'null') as { orderId?: string } | null;
            if (pending?.orderId === orderId) sessionStorage.removeItem('zal:pending-order');
          } catch { /* The order token itself remains available. */ }
        } else if (['canceled', 'expired', 'refunded'].includes(result.status)) {
          shouldContinue = false;
          try {
            const pending = JSON.parse(sessionStorage.getItem('zal:pending-order') || 'null') as { orderId?: string } | null;
            if (pending?.orderId === orderId) sessionStorage.removeItem('zal:pending-order');
          } catch { /* No storage access is needed to show the result. */ }
        } else if (result.status === 'payment_review') delay = 10000;
      } catch (cause) {
        if (!alive || (cause instanceof Error && cause.name === 'AbortError')) return;
        if (cause instanceof ApiError && [401, 404].includes(cause.status)) {
          shouldContinue = false;
          setOrder(null); setTicket(null);
          setError(cause.status === 401 ? 'Нет доступа к этому заказу. Откройте его в браузере, где проходила покупка.' : 'Не удалось найти этот заказ. Проверьте ссылку.');
        } else {
          retryRef.current += 1;
          delay = Math.min(3000 * 2 ** retryRef.current, 10000);
          setError('Пока нет ответа от сервера. Мы повторим проверку автоматически — оплачивать заново не нужно.');
        }
      } finally {
        if (alive) {
          setLoading(false);
          setChecking(false);
          if (shouldContinue) timer = setTimeout(poll, delay);
        }
      }
    }
    void poll();
    return () => { alive = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [orderId, refresh]);

  useEffect(() => {
    const token = readToken(orderId);
    if (!token || !order?.payment.payment_url || !order.payment.transaction_id) { setPricing(null); return; }
    const controller = new AbortController();
    let alive = true;
    api.orderPricing(orderId, token, controller.signal).then(value => {
      if (!alive) return;
      const amounts = [value.seat_price_minor, value.service_fee_minor, value.insurance_upsell_minor, value.total_minor];
      const valid = value.order_id === orderId && value.currency === order.currency &&
        amounts.every(amount => Number.isSafeInteger(amount) && amount >= 0) &&
        value.total_minor === order.total_minor &&
        value.seat_price_minor + value.service_fee_minor + value.insurance_upsell_minor === value.total_minor;
      setPricing(valid ? value : null);
    }).catch(() => { if (alive) setPricing(null); });
    return () => { alive = false; controller.abort(); };
  }, [orderId, order?.total_minor, order?.payment.payment_url, order?.payment.transaction_id, refresh]);

  useEffect(() => {
    const sessionId = order?.session_id;
    if (!sessionId) return;
    const controller = new AbortController();
    let alive = true;
    Promise.all([
      api.session(sessionId, controller.signal),
      api.cinemas(controller.signal).catch(() => null),
    ]).then(async ([value, cinemas]) => {
      if (!alive) return;
      setSession(value);
      setTimezone(cinemas?.items.find((cinema) => cinema.id === value.cinema_id)?.timezone);
      const hall = await api.hall(value.hall_id, controller.signal);
      if (alive) setSeat(hall.seats.find((item) => item.id === order.seat_id) || null);
    }).catch(() => {});
    return () => { alive = false; controller.abort(); };
  }, [order?.session_id, order?.seat_id]);

  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);

  const copy = order ? COPY[order.status] : null;
  const paymentUrl = order ? safePaymentUrl(order) : null;
  const hasPaymentQuote = Boolean(order?.payment.payment_url && order.payment.transaction_id);
  const priceBreakdown = pricing?.order_id === order?.id && pricing?.total_minor === order?.total_minor ? pricing : null;
  const terminal = order && ['canceled', 'expired', 'refunded'].includes(order.status);
  const countdown = order ? remaining(order.expires_at, clock) : null;
  const paymentExpired = Boolean(order?.expires_at && new Date(order.expires_at).getTime() <= clock);
  const qrTarget = paymentQrTarget(order?.payment.qr_url, paymentUrl);
  const showQr = order?.status === 'pending_payment' && order.payment.provider === 'platega' && hasPaymentQuote && !paymentExpired;

  return (
    <div className={'page-shell order-page' + (showQr ? ' order-page--payment' : '')}>
      <Link className="order-back-link" to={order ? '/sessions/' + encodeURIComponent(order.session_id) : '/'}><ArrowLeft size={17} aria-hidden="true" /> {order ? 'К выбору мест' : 'К матчам'}</Link>
      {loading && !order ? <div className="order-loading" role="status"><LoaderCircle className="checkout-spin" size={32} aria-hidden="true" /><p>Находим ваш заказ…</p></div> : (
        <>
          <header className="order-heading">
            <span className="eyebrow">{copy?.eyebrow || 'ВАШ ЗАКАЗ'}</span>
            <h1>{copy?.title || 'Вернёмся к покупке.'}</h1>
            <p>{copy?.description || 'Для открытия заказа понадобится доступ из окна оформления.'}</p>
          </header>
          {error && <div className="order-alert" role="alert"><CircleAlert size={20} aria-hidden="true" /><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={checking} aria-label="Повторить проверку заказа"><RefreshCw size={18} className={checking ? 'checkout-spin' : ''} aria-hidden="true" /></button></div>}
          {order?.payment.provider === 'mock' && <div className="order-mock-banner"><span /> Демонстрационный режим · настоящие деньги не списываются</div>}

          {ticket && order?.status === 'paid' ? <TicketCard ticket={ticket} mock={order.payment.provider === 'mock'} /> : order && (
            <section className="order-checkout-layout" aria-label="Состояние заказа">
              <div className="order-payment-panel">
                <div className={'order-status-orbit' + (showQr ? ' order-status-orbit--compact' : '') + (terminal ? ' order-status-orbit--terminal' : '')}>
                  <span /><span />
                  {terminal ? <CircleAlert size={38} strokeWidth={1.3} aria-hidden="true" /> :
                    order.status === 'paid' ? <Check size={38} strokeWidth={1.5} aria-hidden="true" /> :
                    <img className="order-sbp-logo" src="/media/sbp-logo.svg" alt="СБП" width="96" height="48" />}
                </div>
                <h2>{terminal ? 'Платёж завершён' : order.status === 'paid' ? 'Готовим ваш билет' : order.status === 'payment_review' ? 'Проверяем подтверждение' : order.status === 'creating_payment' ? 'Создаём платёж' : showQr ? `${money(order.total_minor)} по СБП` : 'Оплата через СБП'}</h2>
                <p>{terminal ? 'Вы можете вернуться к расписанию и выбрать другой матч.' :
                  order.status === 'paid' ? 'Оплата получена. Загружаем электронный билет.' :
                  order.status === 'payment_review' ? 'Место остаётся за вами на время проверки. Повторная оплата не требуется.' :
                  order.status === 'creating_payment' ? 'Платёжная ссылка появится после ответа банка.' :
                  paymentExpired ? 'Срок QR истёк. Уточняем итоговый статус у банка — повторно платить не нужно.' :
                  showQr ? 'Оплатите по QR, сохранив эту страницу открытой.' : 'Откройте платёжную форму. Эта страница автоматически проверит результат.'}</p>

                {showQr && <PaymentQr target={qrTarget} />}

                {order.status === 'pending_payment' && priceBreakdown && <p className="order-payment-quote">Место {money(priceBreakdown.seat_price_minor)} · комиссия {money(priceBreakdown.service_fee_minor)}{priceBreakdown.insurance_upsell_minor > 0 ? ` · страхование ${money(priceBreakdown.insurance_upsell_minor)}` : ''}</p>}
                {order.status === 'pending_payment' && !paymentExpired && paymentUrl && hasPaymentQuote && <a className="button button--primary order-payment-link" href={paymentUrl} target="_blank" rel="noopener noreferrer">
                  {order.payment.provider === 'mock' ? 'Открыть демо-оплату' : `Открыть форму оплаты · ${money(order.total_minor)}`} <ExternalLink size={17} aria-hidden="true" />
                </a>}
                {order.status === 'pending_payment' && order.payment.payment_url && !paymentUrl && <p className="checkout-field-error">Не удалось безопасно открыть ссылку оплаты. Повторите проверку заказа.</p>}
                {terminal ? <Link className="button button--primary" to="/#sessions">Выбрать матч <ArrowRight size={18} aria-hidden="true" /></Link> : (
                  <button type="button" className="order-refresh" onClick={() => setRefresh((value) => value + 1)} disabled={checking}>
                    <RefreshCw size={15} className={checking ? 'checkout-spin' : ''} aria-hidden="true" /> {checking ? 'Проверяем…' : 'Я оплатил — проверить статус'}
                  </button>
                )}
                {!terminal && <span className="order-auto-check"><i /> Статус обновляется автоматически</span>}
              </div>
              <aside className="order-summary-panel">
                <span className="eyebrow">ВАШ БИЛЕТ</span>
                <h2>{session?.movie.title || 'Ваш матч'}</h2>
                {session && <p className="order-summary-date">{sessionDate(session.starts_at, timezone)} · {sessionTime(session.starts_at, timezone)}</p>}
                <div className="order-place">
                  <div><span>Ряд</span><strong>{seat ? seat.row.toString().padStart(2, '0') : '—'}</strong></div>
                  <div><span>{seat?.type === 'sofa' ? 'Ложа' : 'Место'}</span><strong>{seat ? seat.number.toString().padStart(2, '0') : '—'}</strong></div>
                </div>
                {priceBreakdown && <dl className="order-price-breakdown" aria-label="Состав суммы к оплате">
                  {(priceBreakdown.demo_discount_minor ?? 0) > 0 && <><div><dt>Цена по расписанию</dt><dd>{money(priceBreakdown.catalog_price_minor!)}</dd></div><div><dt>Скидка для демопокупки</dt><dd>−{money(priceBreakdown.demo_discount_minor!)}</dd></div></>}
                  <div><dt>{(priceBreakdown.demo_discount_minor ?? 0) > 0 ? 'Демопокупка' : 'Стоимость места'}</dt><dd>{money(priceBreakdown.seat_price_minor)}</dd></div>
                  <div><dt>Комиссия платёжной системы</dt><dd>{money(priceBreakdown.service_fee_minor)}</dd></div>
                  {priceBreakdown.insurance_upsell_minor > 0 && <div><dt>Страхование</dt><dd>{money(priceBreakdown.insurance_upsell_minor)}</dd></div>}
                </dl>}
                <div className="order-total"><span>{hasPaymentQuote ? 'К оплате' : 'Стоимость места'}</span><strong>{money(order.total_minor)}</strong></div>
                {!hasPaymentQuote && !terminal && <p className="order-quote-note">Итог с комиссией уточняется у платёжной системы.</p>}
                {!terminal && order.status !== 'paid' && countdown && <div className="order-countdown"><Clock3 size={15} aria-hidden="true" /><span>Срок оплаты</span><strong>{countdown}</strong></div>}
                <div className="order-reassurance"><ShieldCheck size={21} strokeWidth={1.5} aria-hidden="true" /><p>Билет появится только после подтверждения платежа.</p></div>
                <span className="order-reference">Заказ № {order.id.slice(0, 8).toUpperCase()}</span>
              </aside>
            </section>
          )}
          <div className="order-bottom-note"><LockKeyhole size={14} aria-hidden="true" /><span>Сохраните эту вкладку, чтобы вернуться к заказу.</span></div>
        </>
      )}
    </div>
  );
}
