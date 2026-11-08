import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { Availability, Hall, Seat } from '../lib/types';
import { comfortColor } from '../lib/seatExperience';
import { money } from '../lib/format';

interface Props { comfortScores?: ReadonlyMap<string, number>; hall: Hall; availability: Availability; selectedId: string | null; compareIds: string[]; onSelect: (seat: Seat) => void }
export default function SeatMap({ comfortScores, hall, availability, selectedId, compareIds, onSelect }: Props) {
  const [zoom, setZoom] = useState(1);
  const states = useMemo(() => new Map(availability.seats.map(s => [s.seat_id, s])), [availability]);
  const rows = useMemo(() => Array.from(new Set(hall.seats.map(s => s.row))), [hall]);
  const first = hall.seats.find(s => states.get(s.id)?.status === 'available')?.id;
  const width = 1280;
  // Row and seat numbers place the map; 3D reads world coordinates of the same seats.
  const rowCounts = useMemo(() => new Map(rows.map(row => [row, hall.seats.filter(s => s.row === row).length])), [hall, rows]);
  const spacing = useMemo(() => {
    const regular = Math.max(...hall.seats.filter(s => s.type === 'standard').map(s => s.number));
    return (width - 160) / regular;
  }, [hall]);
  const seatWidth = (seat: Seat) => (seat.type === 'sofa' ? spacing * 2.05 : spacing * .84);
  const projectX = (seat: Seat) => width / 2 + (seat.number - ((rowCounts.get(seat.row) ?? 1) + 1) / 2) * (seat.type === 'sofa' ? spacing * 2.28 : spacing);
  const projectRow = (row: number) => 108 + (row - rows[0]) * Math.max(58, spacing * .78);
  const height = projectRow(rows[rows.length - 1]) + 60;
  function keyboard(event: KeyboardEvent<SVGGElement>, seat: Seat) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(seat); return; }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const candidates = hall.seats.filter(s => horizontal ? s.row === seat.row && (s.number - seat.number) * direction > 0 : s.row === seat.row + direction);
    candidates.sort((a, b) => Math.abs(a.number / (rowCounts.get(a.row) ?? 1) - seat.number / (rowCounts.get(seat.row) ?? 1)) - Math.abs(b.number / (rowCounts.get(b.row) ?? 1) - seat.number / (rowCounts.get(seat.row) ?? 1)));
    const next = candidates[0];
    if (next) { onSelect(next); document.getElementById('seat-' + next.id)?.focus(); }
  }
  return <div className="seat-map-shell">
    <div className="screen-label"><span/>ПОЛЕ<span/></div>
    <div className="seat-map-scroll" tabIndex={0} role="region" aria-label="Схема сектора. Используйте стрелки для перемещения между местами">
      <svg className="seat-map-svg" viewBox={'0 0 ' + width + ' ' + height} style={{ width: (zoom * 100) + '%' }} role="group" aria-label={hall.name + ', выбор места'}>
        <rect x="150" y="14" width="980" height="52" rx="6" fill="#1f6b39" stroke="#eef3ee" strokeWidth="3"/>
        <path d="M640 14V66" stroke="#eef3ee" strokeWidth="3"/><circle cx="640" cy="40" r="17" fill="none" stroke="#eef3ee" strokeWidth="3"/>
        {rows.map(row => { const y = projectRow(row); return <g key={row} className="row-labels" aria-hidden="true"><text x="28" y={y + 7}>{row}</text><text x={width - 28} y={y + 7}>{row}</text></g>; })}
        {hall.seats.map(seat => {
          const state = states.get(seat.id);
          const selected = seat.id === selectedId;
          const comparison = compareIds.indexOf(seat.id);
          const status = state?.status ?? 'held';
          const label = (seat.type === 'sofa' ? 'Ложа, ' : seat.zone === 'front' ? 'У кромки, ' : 'Центр трибуны, ') + 'Ряд ' + seat.row + ', ' + (seat.type === 'sofa' ? 'ложа ' : 'место ') + seat.number + ', ' + (status === 'available' ? 'свободно' : status === 'held' ? 'забронировано' : 'занято') + (state ? ', ' + money(state.price_minor) : '') + (comfortScores?.has(seat.id) ? ', расчётный комфорт ' + comfortScores.get(seat.id) + ' из 100' : '');
          const w = seatWidth(seat);
          return <g key={seat.id} id={'seat-' + seat.id} role="button" aria-label={label} aria-pressed={selected} tabIndex={selected || (!selectedId && seat.id === first) ? 0 : -1} onClick={() => onSelect(seat)} onKeyDown={e => keyboard(e, seat)} className={'seat seat-zone-' + seat.zone + ' seat--' + status + (selected ? ' is-selected' : '') + (comparison >= 0 ? ' is-compared' : '')} transform={'translate(' + projectX(seat) + ' ' + projectRow(seat.row) + ')'}>
            <title>{label}</title><rect className="seat-hit" x={-w / 2 - 2} y="-22" width={w + 4} height="44" rx="9"/>
            <rect style={status === 'available' && !selected && comparison < 0 && comfortScores?.has(seat.id) ? { fill: comfortColor(comfortScores.get(seat.id)!) } : undefined} className="seat-back" x={-w / 2} y="-16" width={w} height="25" rx="5"/>
            <path className="seat-bottom" d={'M' + (-w / 2 + 4) + ' 7H' + (w / 2 - 4)} strokeLinecap="round"/>
            {selected ? <path d="m-5-4 4 4 7-8" className="seat-check" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/> : comparison >= 0 ? <text className="seat-letter" y="1">{comparison === 0 ? 'A' : 'B'}</text> : status === 'held' ? <circle className="seat-held-dot" r="2" cy="-3"/> : null}
          </g>;
        })}
      </svg>
    </div>
    <div className="map-bottom"><div className="seat-legend"><span><i className="legend-free"/>Свободно</span><span><i className="legend-sold"/>Занято</span><span><i className="legend-held"/>Бронь</span><span><i className="legend-selected"/>Ваше место</span></div><div className="map-zoom"><button className="icon-button" aria-label="Уменьшить схему" onClick={() => setZoom(z => Math.max(1, z - .25))} disabled={zoom <= 1}><Minus size={16}/></button><button className="icon-button" aria-label="Сбросить масштаб" onClick={() => setZoom(1)}><RotateCcw size={14}/></button><button className="icon-button" aria-label="Увеличить схему" onClick={() => setZoom(z => Math.min(2, z + .25))} disabled={zoom >= 2}><Plus size={16}/></button></div></div>
    <p className="map-hint">Выберите место, чтобы увидеть цену и посмотреть на поле с этой точки трибуны.</p>
  </div>;
}
