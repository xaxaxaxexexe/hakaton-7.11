import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, ChevronLeft, LoaderCircle, LockKeyhole, Mail, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Cinema, Seat, Session } from '../lib/types';
import { money, sessionDate, sessionTime } from '../lib/format';
import '../styles/checkout.css';

const PENDING_KEY = 'zal:pending-order';
type OrderBody = { session_id: string; seat_id: string; customer_email: string };
type PendingIntent = { key: string; body: OrderBody; createdAt: string; orderId?: string };

function readIntent(): PendingIntent | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null') as PendingIntent | null;
    if (!data || typeof data.key !== 'string' || !data.body ||
      typeof data.body.session_id !== 'string' || typeof data.body.seat_id !== 'string' ||
      typeof data.body.customer_email !== 'string') return null;
    return data;
  } catch { return null; }
}

function hasOrderAccess(id: string | undefined) {
  try { return Boolean(id && sessionStorage.getItem('zal:order:' + id)); } catch { return false; }
}

export interface CheckoutDialogProps {
  session: Session;
  seat: Seat;
  priceMinor: number;
  cinema?: Cinema;
  onClose: () => void;
  onConflict: () => void;
}

export default function CheckoutDialog({ session, seat, priceMinor, cinema, onClose, onConflict }: CheckoutDialogProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  const sendingRef = useRef(false);
  const intentRef = useRef<PendingIntent | null>(readIntent());
  const [email, setEmail] = useState(intentRef.current?.body.customer_email || '');
  const [emailTouched, setEmailTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [lockedIntent, setLockedIntent] = useState(Boolean(intentRef.current));
  const [isMock, setIsMock] = useState(false);
  const [demoPrice, setDemoPrice] = useState(0);
  const previousIntent = intentRef.current;
  const differentIntent = lockedIntent && Boolean(previousIntent && (
    previousIntent.body.session_id !== session.id || previousIntent.body.seat_id !== seat.id
  ));
  const canChooseCurrentSeat = differentIntent && hasOrderAccess(previousIntent?.orderId);
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && email.trim().length <= 254;

  useEffect(() => {
    aliveRef.current = true;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    dialog?.showModal();
    emailRef.current?.focus();
    return () => {
      aliveRef.current = false;
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      activeElement?.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    api.health().then((health) => { if (active) { setIsMock(health.mode === 'mock'); setDemoPrice(health.demo_checkout_minor || 0); } }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  function chooseCurrentSeat() {
    // Only a known, recoverable OTHER order may be detached. Unknown requests retain their idempotency key.
    if (pending || sendingRef.current || !differentIntent || !hasOrderAccess(intentRef.current?.orderId)) return;
    try { sessionStorage.removeItem(PENDING_KEY); }
    catch { setError('Не получилось обновить сохранённый запрос. Попробуйте ещё раз.'); return; }
    intentRef.current = null;
    setLockedIntent(false);
    setEmailTouched(false);
    setError('');
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current) return;
    setEmailTouched(true);
    let intent = intentRef.current;
    if (intent?.orderId) {
      try {
        if (sessionStorage.getItem('zal:order:' + intent.orderId)) {
          navigate('/orders/' + encodeURIComponent(intent.orderId));
          return;
        }
      } catch { /* Retry the same request to recover its access token. */ }
    }
    if (!intent && !emailValid) {
      setError('Проверьте email — нужен адрес в формате name@example.ru.');
      emailRef.current?.focus();
      return;
    }
    if (!intent) {
      intent = {
        key: crypto.randomUUID(),
        body: { session_id: session.id, seat_id: seat.id, customer_email: email.trim() },
        createdAt: new Date().toISOString(),
      };
    }
    // Preserve the exact intent before network I/O. An uncertain response must not create a new payment.
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
    } catch {
      setError('Браузер не разрешает сохранить заказ. Разрешите хранение данных сайта и повторите.');
      return;
    }
    intentRef.current = intent;
    sendingRef.current = true;
    setLockedIntent(true);
    setPending(true);
    setError('');
    try {
      const result = await api.createOrder(intent.body, intent.key);
      sessionStorage.setItem('zal:order:' + result.order.id, result.access_token);
      sessionStorage.setItem('zal:last-order', result.order.id);
      intent = { ...intent, orderId: result.order.id };
      intentRef.current = intent;
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
      if (aliveRef.current) navigate('/orders/' + encodeURIComponent(result.order.id));
    } catch (cause) {
      if (!aliveRef.current) return;
      if (cause instanceof ApiError) {
        if (cause.code === 'SEAT_UNAVAILABLE' || cause.code === 'SESSION_STARTED') {
          sessionStorage.removeItem(PENDING_KEY);
          intentRef.current = null;
          onConflict();
          setLockedIntent(false);
          setError(cause.code === 'SESSION_STARTED'
            ? 'Этот матч уже начался. Вернитесь к расписанию и выберите другой.'
            : 'Пока вы выбирали, место заняли. Вернитесь к схеме и выберите другое.');
          return;
        }
        if (cause.status === 422) {
          sessionStorage.removeItem(PENDING_KEY);
          intentRef.current = null;
          setLockedIntent(false);
          setError(cause.message || 'Проверьте введённые данные.');
          return;
        }
        setError(cause.code === 'IDEMPOTENCY_CONFLICT'
          ? 'Данные этой покупки уже сохранены. Вернитесь к предыдущему заказу или обновите страницу.'
          : 'Не удалось получить ответ об оплате. Нажмите «Проверить запрос» — мы восстановим эту же покупку.');
      } else {
        setError('Связь прервалась. Ваш запрос сохранён — повторная проверка не создаст новую покупку.');
      }
    } finally {
      sendingRef.current = false;
      if (aliveRef.current) setPending(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="checkout-dialog"
      aria-modal="true"
      aria-labelledby="checkout-title"
      aria-describedby="checkout-description"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
    >
      <div className="checkout-sheet">
        <div className="checkout-sheet__top">
          <span className="eyebrow">ВАШ МАТЧ</span>
          <button type="button" className="icon-button checkout-close" onClick={onClose} aria-label="Закрыть оформление">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="checkout-heading">
          <div className="checkout-heading__mark"><img src="/media/sbp-logo.svg" width="80" height="40" alt="СБП" /></div>
          <h2 id="checkout-title">Остался один шаг.</h2>
          <p id="checkout-description">Ваше место на этом матче.</p>
        </div>

        <div className="checkout-mode"><span />{isMock ? 'Демо-оплата. Деньги не списываются.' : 'Подключена настоящая оплата. Стадионы и матчи в этом проекте демонстрационные.'}</div>
        <div className="checkout-summary">
          <div className="checkout-summary__film">
            <span className="checkout-summary__eyebrow">{cinema?.name || 'Ваш стадион'}</span>
            <h3>{session.movie.title}</h3>
            <span>{sessionDate(session.starts_at, cinema?.timezone)} · {sessionTime(session.starts_at, cinema?.timezone)}</span>
          </div>
          <div className="checkout-summary__seats">
            <div><span>Ряд</span><strong>{seat.row.toString().padStart(2, '0')}</strong></div>
            <div><span>{seat.type === 'sofa' ? 'Ложа' : 'Место'}</span><strong>{seat.number.toString().padStart(2, '0')}</strong></div>
            <div className="checkout-summary__total"><span>Стоимость места</span><strong>{money(priceMinor)}</strong></div>
          </div>
        </div>
        {demoPrice > 0 && demoPrice < priceMinor && <div className="checkout-demo-price"><div><span>Демопокупка</span><strong>{money(demoPrice)}</strong></div><p>Для демонстрации любое место — за {money(demoPrice)}. Комиссию и точный итог покажем перед переходом в банк.</p></div>}
        <p className="checkout-fee-note">Итог с комиссией платёжной системы покажем перед оплатой.</p>

        <form className="checkout-form" onSubmit={submit} noValidate>
          {differentIntent && (
            <div className="checkout-notice">
              {canChooseCurrentSeat ? <>
                <strong>У вас есть другой заказ</strong>
                <p>Он сохранён в «Моих билетах». Можно вернуться к нему или оформить выбранное место.</p>
                <div className="checkout-intent-actions">
                  <Link to={'/orders/' + encodeURIComponent(previousIntent!.orderId!)}>Открыть предыдущий заказ</Link>
                  <button type="button" onClick={chooseCurrentSeat} disabled={pending}>Оформить это место<ArrowRight size={16} aria-hidden="true" /></button>
                </div>
              </> : 'Ответ по предыдущему запросу ещё не получен. Сначала проверим эту покупку, чтобы не создать повторный платёж.'}
            </div>
          )}
          {error && <div ref={errorRef} className="checkout-error" role="alert" tabIndex={-1}>{error}</div>}
          <div className="checkout-field">
            <label htmlFor="checkout-email">Ваш email</label>
            <div className={'checkout-input-wrap' + (emailTouched && !emailValid ? ' checkout-input-wrap--invalid' : '')}>
              <Mail size={19} aria-hidden="true" />
              <input
                ref={emailRef}
                id="checkout-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.ru"
                required
                maxLength={254}
                value={email}
                readOnly={pending || lockedIntent}
                aria-invalid={emailTouched && !emailValid}
                aria-describedby="checkout-email-hint"
                onChange={(event) => { setEmail(event.target.value); setError(''); }}
                onBlur={() => { if (aliveRef.current && dialogRef.current?.open) setEmailTouched(true); }}
              />
            </div>
            <p id="checkout-email-hint" className={emailTouched && !emailValid ? 'checkout-field-error' : ''}>
              {emailTouched && !emailValid ? 'Введите корректный email.' : 'Для оформления платежа. Билет появится здесь, на сайте.'}
            </p>
          </div>

          <div className="checkout-payment-method">
            <img className="checkout-sbp" src="/media/sbp-logo.svg" width="76" height="44" alt="СБП" />
            <div><strong>Система быстрых платежей</strong><span>Оплата в приложении вашего банка</span></div>
            <span className="checkout-method-check"><Check size={14} aria-hidden="true" /></span>
          </div>
          {!canChooseCurrentSeat && <button type="submit" className="button button--primary checkout-pay" disabled={pending}>
            {pending ? <><LoaderCircle className="checkout-spin" size={20} aria-hidden="true" /> Сохраняем ваше место</>
              : <>{lockedIntent ? hasOrderAccess(previousIntent?.orderId) ? 'Открыть заказ' : 'Проверить запрос' : 'Перейти к оплате'} <ArrowRight size={19} aria-hidden="true" /></>}
          </button>}
          <p className="checkout-secure"><LockKeyhole size={13} aria-hidden="true" /> Билет появится после подтверждения оплаты</p>
          <button type="button" className="checkout-back" onClick={onClose}><ChevronLeft size={16} aria-hidden="true" /> Вернуться к выбору места</button>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
