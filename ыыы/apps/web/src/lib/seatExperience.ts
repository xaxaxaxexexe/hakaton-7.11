import type { Availability, Hall, Seat } from './types';

export interface SeatInsight {
  seat_id: string; comfort_score: number;
  view: { distance_to_screen_m: number; lateral_off_axis_deg: number; horizontal_fov_occupancy_deg: number };
  acoustics: { acoustic_balance_score: number; stereo_pan: number };
}
export interface SessionInsights { session_id: string; hall_id: string; seats: SeatInsight[] }
export interface SeatPair { seats: [Seat, Seat]; totalMinor: number; rank: number }

/** Fixed scale, shared by the 2D map, 3D upholstery and legend. */
export function comfortColor(score: number): string {
  const t = Math.max(0, Math.min(1, score / 100));
  const a = [220, 139, 77], b = [83, 192, 164];
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function findSeatPairs(hall: Hall, availability: Availability): SeatPair[] {
  const free = new Map(availability.seats.filter(s => s.status === 'available' && Number.isSafeInteger(s.price_minor) && s.price_minor >= 0).map(s => [s.seat_id, s.price_minor]));
  const pairs: SeatPair[] = [];
  const rows = new Map<number, Seat[]>();
  // Sort all seats before filtering: occupied seats must never be skipped over.
  for (const seat of hall.seats) rows.set(seat.row, [...(rows.get(seat.row) ?? []), seat]);
  for (const row of rows.values()) {
    row.sort((a, b) => a.position.x - b.position.x || a.position.z - b.position.z);
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1], b = row[i];
      if (a.type === 'sofa' || b.type === 'sofa' || a.zone !== b.zone || !free.has(a.id) || !free.has(b.id)) continue;
      const gap = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) - (a.width + b.width) / 2;
      if (gap > 0.35 || gap < -0.15 || Math.abs(a.position.y - b.position.y) > 0.1 || Math.abs(a.rotation_y - b.rotation_y) > 0.15) continue;
      const x = (a.position.x + b.position.x) / 2 - hall.screen.center.x;
      const z = Math.abs((a.position.z + b.position.z) / 2 - hall.screen.center.z);
      const rank = Math.abs(x) / hall.dimensions.width + Math.abs(z - hall.dimensions.depth * 0.65) / hall.dimensions.depth;
      pairs.push({ seats: [a, b], totalMinor: free.get(a.id)! + free.get(b.id)!, rank });
    }
  }
  return pairs.sort((a, b) => a.rank - b.rank || a.totalMinor - b.totalMinor || a.seats[0].id.localeCompare(b.seats[0].id));
}
