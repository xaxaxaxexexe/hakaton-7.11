import { money } from '../lib/format';
import { isFanSector, sectorCode, type StadiumSector } from '../lib/stadiumData';
import '../styles/stadium-map.css';

interface Props { sectors: StadiumSector[]; currentHallId: string; onSelect: (sector: StadiumSector) => void }

/** Top-down stadium scheme drawn from the seat coordinates of every sector. */
export default function StadiumMap({ sectors, currentHallId, onSelect }: Props) {
  const seats = sectors.flatMap(item => item.hall.seats);
  const extentX = Math.max(...seats.map(seat => Math.abs(seat.position.x))) + 6;
  const extentZ = Math.max(...seats.map(seat => Math.abs(seat.position.z))) + 6;
  const pitch = sectors[0]?.hall.screen;
  return <div className="stadium-map-panel">
    <svg className="stadium-map" viewBox={`${-extentX} ${-extentZ} ${extentX * 2} ${extentZ * 2}`} role="group" aria-label="Схема стадиона с секторами">
      {pitch && <><rect className="stadium-map-pitch" x={-pitch.width / 2} y={-pitch.height / 2} width={pitch.width} height={pitch.height}/><path className="stadium-map-line" d={`M0 ${-pitch.height / 2}V${pitch.height / 2}`}/><circle className="stadium-map-line" r="9.15"/></>}
      {sectors.map(item => {
        const xs = item.hall.seats.map(seat => seat.position.x), zs = item.hall.seats.map(seat => seat.position.z);
        const x = Math.min(...xs) - 1.2, y = Math.min(...zs) - 1.2, width = Math.max(...xs) - Math.min(...xs) + 2.4, height = Math.max(...zs) - Math.min(...zs) + 2.4;
        const code = sectorCode(item.hall);
        const free = item.availability.seats.filter(state => state.status === 'available').length;
        const label = `Сектор ${code}${isFanSector(item.hall) ? ', фан-сектор' : ''}: ${free} свободно, от ${money(item.session.price_from_minor)}`;
        const current = item.hall.id === currentHallId;
        return <g key={item.hall.id} className={'stadium-map-sector' + (current ? ' is-current' : '') + (isFanSector(item.hall) ? ' is-fan' : '')} role="button" tabIndex={0} aria-label={label} aria-current={current || undefined} onClick={() => onSelect(item)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item); } }}>
          <title>{label}</title><rect x={x} y={y} width={width} height={height} rx="1.5"/><text x={x + width / 2} y={y + height / 2 + 3}>{code}</text>
        </g>;
      })}
    </svg>
    <div className="stadium-map-chips" role="group" aria-label="Сектор">{sectors.map(item => <button key={item.hall.id} aria-pressed={item.hall.id === currentHallId} onClick={() => onSelect(item)}><b>{sectorCode(item.hall)}</b><small>{isFanSector(item.hall) ? 'фан · ' : ''}от {money(item.session.price_from_minor)}</small></button>)}</div>
  </div>;
}
