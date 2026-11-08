import { api } from './api';
import type { Availability, Hall, Seat, Session } from './types';
import type { EngineMatch, EngineSeat, EngineSector, EngineStadium } from './stadiumEngine';

/** A stadium is a Cinema, a sector is a Hall, a match is a Movie with one Session per sector. */
export interface StadiumSector { session: Session; hall: Hall; availability: Availability }
export interface Club { name: string; short: string; color: string }

// Scene units are 1.5 m, so a stand reads at the scale of the pitch.
const UNIT = 1.5;
const CLUB_COLORS = ['#2e7dd7', '#d23c3c', '#12a5a5', '#d9a404', '#7b8494', '#8b5cf6', '#ea6a12', '#1f9d55'];

function hashText(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash;
}
export function clubOf(name: string): Club {
  const words = name.split(/\s+/);
  const short = words.length > 1 ? words.map(word => word[0]).join('') : name.slice(0, 3);
  return { name, short: short.toUpperCase(), color: CLUB_COLORS[hashText(name) % CLUB_COLORS.length] };
}
export function clubsOf(title: string): [Club, Club] {
  const [home = title, away = ''] = title.split(' — ');
  return [clubOf(home), clubOf(away)];
}
export const sectorCode = (hall: Hall) => hall.name.replace('Сектор ', '').split(' ')[0];
export const isFanSector = (hall: Hall) => hall.name.includes('фан-сектор');

function sideOf(yaw: number): EngineSector['side'] {
  if (Math.abs(yaw) < .1) return 'south';
  if (Math.abs(Math.abs(yaw) - Math.PI) < .1) return 'north';
  return yaw < 0 ? 'east' : 'west';
}
function alongOf(seat: Seat, side: EngineSector['side']) {
  return { south: seat.position.x, north: -seat.position.x, east: -seat.position.z, west: seat.position.z }[side];
}

function localStart(iso: string, timezone: string) {
  const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: timezone }).format(new Date(iso));
  return iso.slice(0, 11) + hour.padStart(2, '0') + iso.slice(13);
}

/** All sectors of the same match: the scene needs the whole bowl, the page needs the sector switcher. */
export async function loadStadium(session: Session, signal?: AbortSignal): Promise<StadiumSector[]> {
  const all = await api.sessions(session.cinema_id, signal);
  const siblings = all.items.filter(item => item.movie.id === session.movie.id && item.starts_at === session.starts_at);
  return Promise.all(siblings.map(async item => {
    const [hall, availability] = await Promise.all([api.hall(item.hall_id, signal), api.seats(item.id, signal)]);
    return { session: item, hall, availability };
  }));
}

export function engineData(sectors: StadiumSector[], timezone = 'Europe/Moscow'): { stadium: EngineStadium; seats: EngineSeat[]; match: EngineMatch } {
  const first = sectors[0];
  const seats: EngineSeat[] = [];
  const engineSectors: EngineSector[] = [];
  let setback = Infinity;
  for (const { hall, availability } of sectors) {
    const states = new Map(availability.seats.map(state => [state.seat_id, state.status]));
    const code = sectorCode(hall);
    const side = sideOf(hall.seats[0].rotation_y);
    const center = hall.seats.reduce((sum, seat) => sum + alongOf(seat, side), 0) / hall.seats.length;
    engineSectors.push({ code, side, offset_along: center / UNIT, is_fan: isFanSector(hall) });
    for (const seat of hall.seats) {
      const front = side === 'south' || side === 'north' ? Math.abs(seat.position.z) - hall.screen.height / 2 : Math.abs(seat.position.x) - hall.screen.width / 2;
      if (seat.row === 1) setback = Math.min(setback, front / UNIT);
      seats.push({
        id: seat.id, sector: code, row_number: seat.row, seat_number: seat.number, kind: seat.type === 'sofa' ? 'box' : 'regular',
        x: seat.position.x / UNIT, y: seat.position.y / UNIT, z: seat.position.z / UNIT, yaw: seat.rotation_y, occupied: states.get(seat.id) !== 'available',
      });
    }
  }
  const [home, away] = clubsOf(first.session.movie.title);
  const regular = first.hall.seats.filter(seat => seat.type === 'standard' && seat.row === 1).length;
  return {
    stadium: { id: first.session.cinema_id, rows_count: Math.max(...first.hall.seats.map(seat => seat.row)), seats_per_row: regular, setback, roof: first.hall.dimensions.height >= 40, sectors: engineSectors },
    seats,
    match: { id: first.session.movie.id, starts_at: localStart(first.session.starts_at, timezone), home_color: home.color, away_color: away.color },
  };
}
