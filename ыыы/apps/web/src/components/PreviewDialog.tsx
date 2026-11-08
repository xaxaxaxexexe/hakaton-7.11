import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, ChevronRight, Eye, Headphones, MoveHorizontal, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import type { Availability, Hall, Seat } from '../lib/types';
import type { StadiumSector } from '../lib/stadiumData';
import { engineData } from '../lib/stadiumData';
import { crowdProfile } from '../lib/stadiumEngine';
import { money, seatLabel } from '../lib/format';
import LightSwitch from './LightSwitch';
import FullscreenButton from './FullscreenButton';
import { useFullscreen } from '../hooks/useFullscreen';
import { Loading } from './Feedback';
import '../styles/cinema-media.css';

const StadiumScene = lazy(() => import('./StadiumScene'));
interface Props {
  hall: Hall;
  sectors: StadiumSector[];
  availability: Availability;
  seats: Seat[];
  onClose: () => void;
  onSelect: (seat: Seat) => void;
  onBuy?: (seat: Seat) => void;
  lightsOn?: boolean;
  onToggleLights?: () => void;
}

export default function PreviewDialog({ hall, sectors, availability, seats, onClose, onSelect, onBuy, lightsOn = true, onToggleLights }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(fullscreenRef);
  const compare = seats.length > 1;
  const [activeSeatId, setActiveSeatId] = useState(seats[0]?.id);
  const [listeningIndex, setListeningIndex] = useState(0);
  const [soundOn, setSoundOn] = useState(false);
  const [soundError, setSoundError] = useState(false);
  const [resetViews, setResetViews] = useState([0, 0]);
  const orderedSeats = useMemo(() => [...hall.seats].sort((a, b) => a.row - b.row || a.number - b.number), [hall.seats]);
  const activeSeat = hall.seats.find((seat) => seat.id === activeSeatId) || seats[0] || null;
  const visibleSeats = compare ? seats.slice(0, 2) : activeSeat ? [activeSeat] : [];
  const listeningSeat = compare ? visibleSeats[listeningIndex] || visibleSeats[0] : activeSeat;
  const free = (seat: Seat) => availability.seats.find((state) => state.seat_id === seat.id)?.status === 'available';
  const activeIndex = orderedSeats.findIndex((seat) => seat.id === activeSeat?.id);
  const rows = [...new Set(orderedSeats.map((seat) => seat.row))];
  const rowIndex = rows.indexOf(activeSeat?.row || 0);
  const scene = useMemo(() => sectors.length ? engineData(sectors) : null, [sectors]);
  const loudness = useMemo(() => {
    const engineSeat = scene?.seats.find((seat) => seat.id === listeningSeat?.id);
    return scene && engineSeat ? crowdProfile(engineSeat, scene.seats, scene.stadium.sectors, scene.stadium.rows_count).loudness : null;
  }, [scene, listeningSeat?.id]);

  useEffect(() => { setActiveSeatId(seats[0]?.id); setListeningIndex(0); }, [seats[0]?.id, seats.length]);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    closeButton.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  function changeSeat(seat: Seat | undefined) {
    if (!seat) return;
    setActiveSeatId(seat.id);
    onSelect(seat);
    setResetViews((values) => [values[0] + 1, values[1]]);
  }
  function changeRow(direction: number) {
    if (!activeSeat) return;
    const row = rows[rowIndex + direction];
    const relative = (seat: Seat) => seat.number / orderedSeats.filter((item) => item.row === seat.row).length;
    const nearest = orderedSeats.filter((seat) => seat.row === row).sort((a, b) => Math.abs(relative(a) - relative(activeSeat)) - Math.abs(relative(b) - relative(activeSeat)))[0];
    changeSeat(nearest);
  }
  function resetView(index: number) { setResetViews((values) => values.map((value, key) => key === index ? value + 1 : value)); }
  function closePreview() { setSoundOn(false); void fullscreen.exit().then(onClose); }

  return <dialog ref={dialog} className={'preview-dialog media-preview' + (compare ? ' preview-dialog--compare' : '') + (fullscreen.active ? ' is-fullscreen' : '')} aria-modal="true" aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); if (fullscreen.active) void fullscreen.exit(); else closePreview(); }} onClick={(event) => { if (event.target === dialog.current) closePreview(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((element) => element.getClientRects().length > 0);
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div ref={fullscreenRef} className={'preview-fullscreen-shell' + (fullscreen.active ? ' is-fullscreen' : '')} data-fullscreen-mode={fullscreen.mode}>
    <div className="preview-header"><div><p className="eyebrow">{compare ? 'ОДИН МАТЧ. ДВА ВПЕЧАТЛЕНИЯ.' : 'ПРИСЯДЬТЕ. ВИРТУАЛЬНО.'}</p><h2 id="preview-title">{compare ? 'Сравните вид. Услышьте разницу.' : activeSeat ? hall.name + ' · ' + seatLabel(activeSeat.row, activeSeat.number, activeSeat.type) : 'Вид с трибуны'}</h2></div><div className="preview-header-actions">{onToggleLights && <LightSwitch on={lightsOn} onToggle={onToggleLights}/>}<FullscreenButton active={fullscreen.active} busy={fullscreen.busy} onToggle={fullscreen.toggle} label={compare ? 'Развернуть сравнение на весь экран' : 'Развернуть просмотр на весь экран'} /><button ref={closeButton} className="icon-button" onClick={closePreview} aria-label="Вернуться к схеме"><X size={23} aria-hidden="true"/></button></div></div>

    {!compare && activeSeat && <div className="preview-seat-navigator"><div className="preview-seat-step"><button className="icon-button" aria-label="Предыдущее место" disabled={activeIndex <= 0} onClick={() => changeSeat(orderedSeats[activeIndex - 1])}><ChevronLeft size={18} aria-hidden="true"/></button><label className="sr-only" htmlFor="preview-seat-select">Место для просмотра</label><select className="preview-seat-select" id="preview-seat-select" value={activeSeat.id} onChange={(event) => changeSeat(hall.seats.find((seat) => seat.id === event.target.value))}>{orderedSeats.map((seat) => <option key={seat.id} value={seat.id}>{seatLabel(seat.row, seat.number, seat.type)}{free(seat) ? '' : ' · занято'}</option>)}</select><button className="icon-button" aria-label="Следующее место" disabled={activeIndex >= orderedSeats.length - 1} onClick={() => changeSeat(orderedSeats[activeIndex + 1])}><ChevronRight size={18} aria-hidden="true"/></button></div><div className="preview-row-step"><button onClick={() => changeRow(-1)} disabled={rowIndex <= 0}><ArrowDown size={14} aria-hidden="true"/>Ниже, к полю</button><button onClick={() => changeRow(1)} disabled={rowIndex >= rows.length - 1}><ArrowUp size={14} aria-hidden="true"/>Выше по трибуне</button></div></div>}

    {compare && <div className="preview-listening-switch"><span><Headphones size={13} aria-hidden="true"/> Точка прослушивания</span><div role="group" aria-label="Выбрать место для прослушивания">{visibleSeats.map((seat, index) => <button key={seat.id} aria-pressed={listeningIndex === index} onClick={() => setListeningIndex(index)}>{index ? 'B' : 'A'} · ряд {seat.row}, место {seat.number}</button>)}</div><small>Один стадион. Меняется только ваше место.</small></div>}

    <div className="preview-scenes">{visibleSeats.map((seat, index) => {
      const price = availability.seats.find((state) => state.seat_id === seat.id)?.price_minor;
      const distance = Math.hypot(seat.position.x - hall.screen.center.x, seat.position.z - hall.screen.center.z);
      return <div className={'preview-panel' + (listeningSeat?.id === seat.id ? ' is-listening' : '')} key={index}><div className="preview-canvas-wrap"><Suspense fallback={<Loading label="Занимаем ваше место…"/>}>{sectors.length > 0 && <StadiumScene lightsOn={lightsOn} sectors={sectors} seat={seat} className="seat-preview-canvas" resetViewKey={resetViews[index]} soundOn={soundOn && listeningSeat?.id === seat.id} onSoundError={() => { setSoundOn(false); setSoundError(true); }}/>}</Suspense><span className="preview-eye"><Eye size={13} aria-hidden="true"/>{compare ? `${index ? 'РАКУРС B' : 'РАКУРС A'} · РЯД ${seat.row}, МЕСТО ${seat.number}` : 'НА УРОВНЕ ВАШИХ ГЛАЗ'}</span><button className="preview-reset-view" aria-label={`Смотреть на поле${compare ? index ? ' — ракурс B' : ' — ракурс A' : ''}`} onClick={() => resetView(index)}><RotateCcw size={14} aria-hidden="true"/><span>Смотреть на поле</span></button><span className="preview-look-hint"><MoveHorizontal size={13} aria-hidden="true"/>Потяните изображение, чтобы оглядеться</span></div><div className="preview-panel-info"><div><h3>{seatLabel(seat.row, seat.number, seat.type)}</h3><p>{distance.toFixed(0)} м до центра поля<span>·</span>{seat.position.y.toFixed(0)} м над полем<span>·</span>{price === undefined ? 'Цена уточняется' : money(price)}</p></div>{compare && <div className="preview-panel-actions"><button className="preview-listen-button" aria-pressed={listeningIndex === index} onClick={() => setListeningIndex(index)}><Headphones size={14} aria-hidden="true"/>{listeningIndex === index ? 'Слушаете здесь' : 'Слушать здесь'}</button><button className="button button--secondary" onClick={() => { onSelect(seat); closePreview(); }}><Check size={14} aria-hidden="true"/>Выбрать {index ? 'B' : 'A'}</button></div>}</div></div>;
    })}</div>
    <section className="stadium-sound" aria-label="Звук с места"><button className="button button--secondary" aria-pressed={soundOn} onClick={() => { setSoundError(false); setSoundOn((value) => !value); }}>{soundOn ? <VolumeX size={17} aria-hidden="true"/> : <Volume2 size={17} aria-hidden="true"/>}{soundOn ? 'Выключить звук трибуны' : 'Включить звук трибуны'}</button>{loudness !== null && <span>Громкость на этом месте: <strong>{loudness}%</strong>. У фан-сектора громче, наверху тише.</span>}{soundError && <span role="alert">Не удалось включить звук в этом браузере.</span>}</section>
    <div className="preview-footer"><button className="button button--ghost" onClick={closePreview}><ArrowLeft size={16} aria-hidden="true"/>К схеме трибуны</button>{compare ? <p className="preview-intro-note">В каждом окне можно оглядеться независимо.</p> : activeSeat && <button className="button button--primary" disabled={!free(activeSeat) || !onBuy} onClick={() => { setSoundOn(false); void fullscreen.exit().then(() => { onClose(); onBuy?.(activeSeat); }); }}>{free(activeSeat) ? 'Купить билет' : 'Место недоступно'}<ArrowRight size={16} aria-hidden="true"/></button>}</div>
    </div>
  </dialog>;
}
