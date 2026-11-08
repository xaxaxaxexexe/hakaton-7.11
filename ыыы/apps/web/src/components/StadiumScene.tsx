import { useEffect, useMemo, useRef, useState } from 'react';
import { StadiumView } from '../lib/stadiumEngine';
import { engineData, type StadiumSector } from '../lib/stadiumData';
import type { Seat } from '../lib/types';
import './stadium-scene.css';

interface Props {
  sectors: StadiumSector[];
  seat?: Seat | null;
  overview?: boolean;
  className?: string;
  onError?: () => void;
  paused?: boolean;
  onSeatPick?: (seatId: string) => void;
  view?: 'overview' | 'front' | 'back' | 'top' | 'sofas';
  audience?: boolean;
  lightsOn?: boolean;
  soundOn?: boolean;
  onSoundError?: () => void;
  resetViewKey?: number;
}

/** The scene and the seat map consume the same seat positions from the API. */
export default function StadiumScene({ sectors, seat = null, overview = false, className = '', onError, paused = false, onSeatPick, view = 'overview', audience = true, lightsOn = true, soundOn = false, onSoundError, resetViewKey = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<StadiumView | null>(null);
  const pickRef = useRef(onSeatPick);
  pickRef.current = onSeatPick;
  const [unavailable, setUnavailable] = useState(false);
  const data = useMemo(() => engineData(sectors), [sectors]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let engine: StadiumView;
    try {
      engine = new StadiumView(canvasRef.current, id => pickRef.current?.(id), { seatTint: '#2c5f8f', boardText: 'СЕКТОР  ·  БИЛЕТ С ВИДОМ НА ПОЛЕ' });
    } catch {
      setUnavailable(true); onError?.();
      return;
    }
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setStadium(data.stadium, data.seats, data.match); }, [data]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const engineSeat = seat ? data.seats.find(item => item.id === seat.id) : data.seats.find(item => item.row_number === 6);
    if (engineSeat && engine.selectedId !== engineSeat.id) engine.setSeat(engineSeat);
  }, [seat?.id, data]);
  useEffect(() => { engineRef.current?.setMode(overview ? 'overview' : 'seat'); }, [overview, data.stadium.id]);
  useEffect(() => { if (overview) engineRef.current?.setOverviewView(view); }, [view, overview]);
  useEffect(() => { engineRef.current?.setVisible(!paused); return () => engineRef.current?.setVisible(false); }, [paused]);
  useEffect(() => { engineRef.current?.setCrowdVisible(audience); }, [audience]);
  useEffect(() => { engineRef.current?.setFloodlights(lightsOn); }, [lightsOn]);
  useEffect(() => { if (resetViewKey) engineRef.current?.resetLook(); }, [resetViewKey]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (soundOn) engine.enableAudio().catch(() => onSoundError?.());
    else engine.disableAudio();
  }, [soundOn]);

  return (
    <div className={'stadium-scene ' + className} data-engine="webgl">
      <div className="stadium-scene__canvas"><canvas ref={canvasRef} tabIndex={0} aria-label="Трёхмерный вид стадиона. Перетаскивайте, чтобы осмотреться." /></div>
      {unavailable && <div className="stadium-scene__fallback" role="status"><p>На этом устройстве 3D недоступен.</p><span>Выберите место на схеме: покупка по-прежнему доступна.</span></div>}
    </div>
  );
}
