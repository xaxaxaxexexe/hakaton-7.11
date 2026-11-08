export interface EngineSeat { id: string; sector: string; row_number: number; seat_number: number; kind: 'regular' | 'box'; x: number; y: number; z: number; yaw: number; occupied: boolean }
export interface EngineSector { code: string; side: 'south' | 'north' | 'east' | 'west'; offset_along: number; is_fan: boolean }
export interface EngineStadium { id: string; rows_count: number; seats_per_row: number; setback: number; roof: boolean; sectors: EngineSector[] }
export interface EngineMatch { id: string; starts_at: string; home_color: string; away_color: string }
export function crowdProfile(seat: EngineSeat, seats: EngineSeat[], sectors: EngineSector[], rows: number): { distance: number; fanLevel: number; tier: number; loudness: number };
export class StadiumView {
  constructor(canvas: HTMLCanvasElement, onSeatClick: (seatId: string) => void, options?: { seatTint?: string; boardText?: string });
  mode: 'seat' | 'overview';
  selectedId: string | null;
  resize(): void;
  render(): void;
  setStadium(stadium: EngineStadium, seats: EngineSeat[], match: EngineMatch): void;
  setSeat(seat: EngineSeat): void;
  setMode(mode: 'seat' | 'overview'): void;
  setOverviewView(view: string): void;
  setFloodlights(on: boolean): void;
  setCrowdVisible(visible: boolean): void;
  setVisible(visible: boolean): void;
  resetLook(instant?: boolean): void;
  enableAudio(): Promise<void>;
  disableAudio(): void;
  dispose(): void;
}
