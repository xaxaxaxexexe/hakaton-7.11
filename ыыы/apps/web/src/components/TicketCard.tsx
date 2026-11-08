import { useEffect, useState } from 'react';
import { Check, Download, ScanLine, ShieldAlert, Ticket as TicketIcon } from 'lucide-react';
import QRCode from 'qrcode';
import type { Ticket } from '../lib/types';
import { money, sessionDate, sessionTime } from '../lib/format';

export interface TicketCardProps {
  ticket: Ticket;
  publicView?: boolean;
  mock?: boolean;
}

export default function TicketCard({ ticket, publicView = false, mock = false }: TicketCardProps) {
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState(false);
  const valid = ticket.status === 'valid';
  useEffect(() => {
    let active = true;
    setQr('');
    setQrError(false);
    QRCode.toDataURL(ticket.verification_url, {
      width: 256, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#151511', light: '#F6F3E9' },
    }).then((value) => { if (active) setQr(value); }).catch(() => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [ticket.verification_url]);
  return (
    <div className="ticket-wrap">
      <article className={'ticket-card' + (!valid ? ' ticket-card--inactive' : '')} aria-labelledby="ticket-film-title">
        <div className="ticket-card__main">
          <div className="ticket-card__top"><span className="ticket-brand">SEKTOR</span><span className="ticket-card__eyebrow">ЭЛЕКТРОННЫЙ БИЛЕТ</span><TicketIcon size={23} strokeWidth={1.5} aria-hidden="true" /></div>
          <div className={'ticket-status ticket-status--' + ticket.status}>
            {valid ? <Check size={14} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />}
            {valid ? 'Билет действителен' : ticket.status === 'suspended' ? 'Билет приостановлен' : 'Билет отозван'}
          </div>
          {mock && <div className="ticket-demo-note">Демонстрационный билет · без списания денег</div>}
          <p className="ticket-cinema">{ticket.cinema_name}</p>
          <h2 id="ticket-film-title">{ticket.film_title}</h2>
          <p className="ticket-hall">{ticket.hall_name}</p>
          <div className="ticket-details">
            <div className="ticket-details__date"><span>Дата и время</span><strong>{sessionDate(ticket.starts_at, ticket.timezone)}</strong><b>{sessionTime(ticket.starts_at, ticket.timezone)}</b></div>
            <div><span>Ряд</span><strong>{ticket.row.toString().padStart(2, '0')}</strong></div>
            <div><span>{ticket.seat_type === 'sofa' ? 'Ложа' : 'Место'}</span><strong>{ticket.number.toString().padStart(2, '0')}</strong></div>
          </div>
          <div className="ticket-card__bottom"><span>Оплачено</span><strong>{money(ticket.paid_minor)}</strong></div>
        </div>
        <div className="ticket-card__stub">
          <div className="ticket-stub-label"><ScanLine size={17} aria-hidden="true" /><span>ВАШ ПРОПУСК НА ТРИБУНУ</span></div>
          {qr ? <img className="ticket-qr" src={qr} alt="QR-код для проверки билета" width={184} height={184} />
            : <div className="ticket-qr ticket-qr--loading" role="status">{qrError ? 'QR недоступен' : 'Создаём QR…'}</div>}
          <span className="ticket-number">№ {ticket.id.slice(0, 8).toUpperCase()}</span>
          <p>{valid ? 'Покажите билет с экрана или сохраните его перед матчем.' : 'Этот билет сейчас недействителен. Проверьте статус заказа.'}</p>
          {publicView && <span className="ticket-public-check">Статус проверен на сервере</span>}
        </div>
      </article>
      <div className="ticket-actions">
        <button className="button button--primary" type="button" onClick={() => window.print()}>
          <Download size={18} aria-hidden="true" /> Сохранить билет
        </button>
        <span>В окне печати выберите «Сохранить как PDF»</span>
      </div>
    </div>
  );
}
