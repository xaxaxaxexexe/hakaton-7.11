import { useMemo, useState } from 'react';
import { ArrowRight, Eye, RotateCcw, Users } from 'lucide-react';
import type { Availability, Hall, Seat } from '../lib/types';
import { findSeatPairs, type SeatInsight } from '../lib/seatExperience';
import { money } from '../lib/format';
import '../styles/seat-lab.css';

interface Props {
  hall: Hall; availability: Availability; selected: Seat | null;
  insight?: SeatInsight; insightError: boolean;
  onCompare: (seats: Seat[]) => void; onPreview: (seat: Seat) => void;
}
export default function SeatLab({ hall, availability, selected, insight, insightError, onCompare, onPreview }: Props) {
  const pairs = useMemo(() => findSeatPairs(hall, availability), [hall, availability]);
  const [index, setIndex] = useState(0);
  const pair = pairs.length ? pairs[index % pairs.length] : undefined;
  return <section className="seat-lab" aria-label="Инструменты выбора места">
    <article className="seat-lab-card">
      <div className="seat-lab-kicker"><Users size={18} aria-hidden="true"/><span>ВДВОЁМ НА МАТЧ</span></div>
      <h2>Два места рядом.</h2>
      {pair ? <>
        <p>Свободная пара рядом, без прохода между местами.</p>
        <div className="seat-pair" aria-live="polite"><span>Ряд {pair.seats[0].row}</span><div>{pair.seats.map(seat => <b key={seat.id}>{seat.number}</b>)}</div><strong>{money(pair.totalMinor)}<small>за два места</small></strong></div>
        <div className="seat-lab-actions"><button className="button button--light" onClick={() => onCompare(pair.seats)}><Eye size={16} aria-hidden="true"/>Примерить пару</button><button className="seat-lab-next" disabled={pairs.length < 2} onClick={() => setIndex(value => (value + 1) % pairs.length)}><RotateCcw size={15} aria-hidden="true"/>Другая пара</button></div>
        <small className="seat-lab-note">Подбор не бронирует места. Каждый билет оформляется отдельно.</small>
      </> : <div role="status"><p>Двух свободных мест рядом сейчас нет.</p><small className="seat-lab-note">Посмотрите другой сектор или матч.</small></div>}
    </article>
    <article className="seat-lab-card">
      <div className="seat-lab-kicker"><Eye size={18} aria-hidden="true"/><span>ПАСПОРТ МЕСТА</span></div>
      <h2>{selected ? `Ряд ${selected.row} · ${selected.type === 'sofa' ? 'ложа' : 'место'} ${selected.number}` : 'Узнайте, как здесь смотреть.'}</h2>
      {selected && insight ? <>
        <div className="seat-lab-score"><strong>{insight.comfort_score}<span>/100</span></strong><div><b>Расчётный комфорт</b><meter min="0" max="100" value={insight.comfort_score} aria-label="Расчётный комфорт места"/></div></div>
        <dl className="seat-lab-metrics"><div><dt>До центра поля</dt><dd>{insight.view.distance_to_screen_m.toFixed(1)} м</dd></div><div><dt>Высота над полем</dt><dd>{selected.position.y.toFixed(0)} м</dd></div><div><dt>Цена</dt><dd>{money(availability.seats.find(s => s.seat_id === selected.id)?.price_minor ?? 0)}</dd></div></dl>
        <button className="seat-lab-preview" onClick={() => onPreview(selected)}>Проверить своими глазами<ArrowRight size={17} aria-hidden="true"/></button>
        <small className="seat-lab-note">Оценка по геометрии трибуны и обзору поля.</small>
      </> : <p role="status">{selected ? insightError ? 'Оценка временно недоступна. Вид с места и звук можно проверить в 3D.' : 'Рассчитываем обзор…' : 'Выберите место на схеме: покажем расстояние до поля, высоту и обзор.'}</p>}
    </article>
  </section>;
}
