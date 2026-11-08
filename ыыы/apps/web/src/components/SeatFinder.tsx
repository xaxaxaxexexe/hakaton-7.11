import { useId, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Eye, GitCompareArrows } from 'lucide-react';
import type { Availability, Hall, Seat } from '../lib/types';
import { money, seatLabel } from '../lib/format';
import '../styles/seat-finder.css';

export type SeatPreference = 'overview' | 'immersion' | 'price';
export interface SeatRecommendation { seat: Seat; priceMinor: number; distance: number; offCenter: number; score: number }

/** Lower scores match the chosen preference more closely. No model service or invented ratings. */
export function rankSeats(hall: Hall, availability: Availability, preference: SeatPreference): SeatRecommendation[] {
  const available = new Map(availability.seats.filter((state) => state.status === 'available' && Number.isFinite(state.price_minor) && state.price_minor >= 0).map((state) => [state.seat_id, state.price_minor]));
  const prices = [...available.values()];
  if (!prices.length) return [];
  const minimum = Math.min(...prices);
  const priceRange = Math.max(...prices) - minimum || 1;
  const rows = Math.max(...hall.seats.map((seat) => seat.row));
  const rowLength = new Map<number, number>();
  for (const seat of hall.seats) rowLength.set(seat.row, Math.max(rowLength.get(seat.row) ?? 0, seat.number));
  return hall.seats.flatMap((seat) => {
    const priceMinor = available.get(seat.id);
    if (priceMinor === undefined) return [];
    const length = rowLength.get(seat.row) ?? 1;
    const offCenter = Math.abs(seat.number - (length + 1) / 2) / Math.max(1, length / 2);
    const distance = Math.hypot(seat.position.x - hall.screen.center.x, seat.position.z - hall.screen.center.z);
    const price = (priceMinor - minimum) / priceRange;
    const height = seat.row / rows;
    let score = 0;
    if (preference === 'overview') score = Math.abs(height - .65) * .7 + offCenter * .25 + price * .05;
    if (preference === 'immersion') score = height * .8 + offCenter * .2;
    if (preference === 'price') score = offCenter + Math.abs(height - .5);
    return [{ seat, priceMinor, distance, offCenter, score }];
  }).sort((a, b) => (preference === 'price' ? a.priceMinor - b.priceMinor : 0) || a.score - b.score || a.priceMinor - b.priceMinor || a.seat.row - b.seat.row || a.seat.number - b.seat.number || a.seat.id.localeCompare(b.seat.id));
}

const preferences = [
  { id: 'overview', label: 'Хороший обзор', description: 'Выше по трибуне, ближе к центру сектора.' },
  { id: 'immersion', label: 'Ближе к полю', description: 'Нижние ряды: игроки совсем рядом.' },
  { id: 'price', label: 'Ниже цена', description: 'Сначала недорогие места ближе к центру.' },
] as const;

function reason(item: SeatRecommendation) {
  return `${item.distance.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} м до центра поля · ${item.offCenter <= .15 ? 'по центру сектора' : 'сбоку в секторе'}`;
}

interface Props {
  hall: Hall;
  availability: Availability;
  selectedId?: string | null;
  onSelect: (seat: Seat) => void;
  onPreview: (seat: Seat) => void;
  onCompare: (seats: Seat[]) => void;
}

export default function SeatFinder({ hall, availability, selectedId: controlledSelectedId, onSelect, onPreview, onCompare }: Props) {
  const [preference, setPreference] = useState<SeatPreference>('overview');
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = controlledSelectedId === undefined ? localSelectedId : controlledSelectedId;
  const id = useId();
  const ranked = useMemo(() => rankSeats(hall, availability, preference), [hall, availability, preference]);
  const candidates = useMemo(() => {
    if (!ranked.length) return [];
    const result = [ranked[0]];
    // Different rows make the alternatives useful; preserve the cheapest tier for the price preference.
    for (const item of ranked) {
      if (result.length === 3) break;
      if (result.some(previous => previous.seat.row === item.seat.row)) continue;
      if (preference === 'price' && item.priceMinor !== ranked[0].priceMinor) continue;
      result.push(item);
    }
    for (const item of ranked) {
      if (result.length === 3) break;
      if (!result.some(previous => previous.seat.id === item.seat.id)) result.push(item);
    }
    return result;
  }, [ranked, preference]);
  const activePreference = preferences.find((item) => item.id === preference)!;
  function selectSeat(seat: Seat) {
    setLocalSelectedId(seat.id);
    onSelect(seat);
    if (window.matchMedia('(min-width: 821px)').matches) requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.querySelector('.booking-layout')?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
    });
  }
  return <section className="seat-finder" aria-labelledby={id + '-title'}>
    <header className="seat-finder-header">
      <div><h2 id={id + '-title'}>Помочь с выбором?</h2><p>Свободные места этого сектора под ваш запрос.</p></div>
      <label className="seat-finder-preference" htmlFor={id + '-preference'}><span>Мне важнее</span><div><select id={id + '-preference'} value={preference} onChange={event => setPreference(event.target.value as SeatPreference)}>{preferences.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select><ChevronDown size={18} aria-hidden="true"/></div></label>
    </header>
    {candidates.length ? <>
      <div className="seat-finder-results">
        {candidates.map((item, index) => <article className={'seat-finder-option' + (index === 0 ? ' seat-finder-option--primary' : '')} key={item.seat.id}>
          {index === 0 && <p className="seat-finder-match"><span aria-hidden="true"/>Подходит под ваш запрос</p>}
          <div className="seat-finder-option-title"><h3>{seatLabel(item.seat.row, item.seat.number, item.seat.type)}</h3><strong>{money(item.priceMinor)}</strong></div>
          <p className="seat-finder-reason">{reason(item)}</p>
          {index === 0 && <p className="seat-finder-explanation">{activePreference.description}</p>}
          <div className="seat-finder-actions">
            <button className="seat-finder-preview" aria-label={'Посмотреть ' + seatLabel(item.seat.row, item.seat.number, item.seat.type).toLowerCase()} onClick={() => { setLocalSelectedId(item.seat.id); onPreview(item.seat); }}><Eye size={18} aria-hidden="true"/>Посмотреть</button>
            <button className="seat-finder-select" aria-pressed={selectedId === item.seat.id} aria-label={'Выбрать ' + seatLabel(item.seat.row, item.seat.number, item.seat.type).toLowerCase()} onClick={() => selectSeat(item.seat)}>{selectedId === item.seat.id ? <><Check size={17} aria-hidden="true"/>Выбрано</> : <>Выбрать<ArrowRight size={17} aria-hidden="true"/></>}</button>
          </div>
        </article>)}
      </div>
      <footer className="seat-finder-footer"><p>По геометрии трибуны и текущей цене.</p>{candidates.length > 1 && <button onClick={() => onCompare(candidates.slice(0, 2).map(item => item.seat))}><GitCompareArrows size={18} aria-hidden="true"/>Сравнить два места<ArrowRight size={16} aria-hidden="true"/></button>}</footer>
    </> : <div className="seat-finder-empty" role="status"><h3>Свободных мест пока нет</h3><p>Выберите другой сектор или матч.</p></div>}
  </section>;
}
