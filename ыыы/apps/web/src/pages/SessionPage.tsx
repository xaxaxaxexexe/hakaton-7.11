import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Box, Clock3, Eye, GitCompareArrows, Grid2X2, MapPin, MousePointer2, RotateCcw, ShieldCheck, Ticket, Users, Volume2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/AppContext';
import type { Availability, Hall, Seat, Session } from '../lib/types';
import { money, sessionDate, sessionTime } from '../lib/format';
import { clubsOf, loadStadium, type StadiumSector } from '../lib/stadiumData';
import StadiumMap from '../components/StadiumMap';
import '../styles/session-v2.css';
import LightSwitch from '../components/LightSwitch';
import SeatLab from '../components/SeatLab';
import type { SessionInsights } from '../lib/seatExperience';
import SeatMap from '../components/SeatMap';
import SeatFinder from '../components/SeatFinder';
import RoomChat from '../components/RoomChat';
import PreviewDialog from '../components/PreviewDialog';
import CheckoutDialog from '../components/CheckoutDialog';
import FullscreenButton from '../components/FullscreenButton';
import { useFullscreen } from '../hooks/useFullscreen';
import { ErrorState, Loading } from '../components/Feedback';

const StadiumScene = lazy(() => import('../components/StadiumScene'));

export default function SessionPage() {
  const { sessionId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const requestedSeat = searchParams.get('seat');
  const requestedPreview = searchParams.get('preview') === '1';
  const { cinemas, mode } = useApp();
  const navigate = useNavigate();
  const [stadium, setStadium] = useState<StadiumSector[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [hall, setHall] = useState<Hall | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const [checkout, setCheckout] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState(false);
  const [version, setVersion] = useState(0);
  const [hallMode, setHallMode] = useState<'3d' | '2d'>('2d');
  const [cameraView, setCameraView] = useState<'overview' | 'front' | 'back' | 'top' | 'sofas'>('overview');
  const [cameraRevision, setCameraRevision] = useState(0);
  const [sceneError, setSceneError] = useState(false);
  const [lightsOn, setLightsOn] = useState(() => { try { return localStorage.getItem('zal:lights') !== 'off'; } catch { return true; } });
  const [insights, setInsights] = useState<SessionInsights | null>(null);
  const [insightError, setInsightError] = useState(false);
  useEffect(() => { try { localStorage.setItem('zal:lights', lightsOn ? 'on' : 'off'); } catch { /* optional preference */ } }, [lightsOn]);
  useEffect(() => {
    if (!hall || !availability) return;
    const controller = new AbortController();
    api.insights(sessionId, controller.signal).then(data => {
      if (!controller.signal.aborted && data.session_id === sessionId && data.hall_id === hall.id) { setInsights(data); setInsightError(false); }
    }).catch(() => { if (!controller.signal.aborted) { setInsightError(true); setInsights(null); } });
    return () => controller.abort();
  }, [hall, sessionId, availability?.updated_at]);
  const [audience, setAudience] = useState(true);
  const hallFullscreenRef = useRef<HTMLDivElement>(null);
  const hallFullscreen = useFullscreen(hallFullscreenRef);
  const availabilityRequest = useRef(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const controller = new AbortController();
    setHallMode('2d'); setSceneError(false); setStadium([]);
    setLoading(true); setError(''); setSession(null); setHall(null); setAvailability(null);
    setInsights(null); setInsightError(false); setSelectedId(null); setCompareIds([]); setPreviewIds([]); setCheckout(false);
    api.session(sessionId, controller.signal).then(async info => {
      const [geometry, states] = await Promise.all([api.hall(info.hall_id, controller.signal), api.seats(info.id, controller.signal)]);
      if (!controller.signal.aborted) {
        setSession(info); setHall(geometry); setAvailability(states);
        const requested = geometry.seats.find(seat => seat.id === requestedSeat);
        if (requested) { setSelectedId(requested.id); if (requestedPreview) setPreviewIds([requested.id]); }
        void loadStadium(info, controller.signal).then(sectors => { if (!controller.signal.aborted) setStadium(sectors); }).catch(() => { if (!controller.signal.aborted) setSceneError(true); });
      }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, version, requestedSeat, requestedPreview]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      const request = ++availabilityRequest.current;
      api.seats(session.id, controller.signal).then(data => {
        if (!controller.signal.aborted && request === availabilityRequest.current) {
          setAvailability(current => current && Date.parse(data.updated_at) < Date.parse(current.updated_at) ? current : data);
          setRefreshError(false);
        }
      }).catch(() => { if (!controller.signal.aborted && request === availabilityRequest.current) setRefreshError(true); })
        .finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refresh, 10000);
    const stopStream = mode === 'live' && typeof EventSource !== 'undefined' ? api.watchSeats(session.id, refresh) : undefined;
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); clearInterval(timer); stopStream?.(); window.removeEventListener('focus', refresh); };
  }, [session, mode]);
  const liveStadium = useMemo(() => availability ? stadium.map(item => item.hall.id === hall?.id ? { ...item, availability } : item) : stadium, [stadium, availability, hall?.id]);
  const pickSeat = useCallback((seatId: string) => {
    const owner = liveStadium.find(item => item.hall.seats.some(seat => seat.id === seatId));
    if (!owner) return;
    if (owner.hall.id === hall?.id) setSelectedId(seatId);
    else navigate('/sessions/' + owner.session.id + '?seat=' + encodeURIComponent(seatId));
  }, [liveStadium, hall?.id, navigate]);
  const selected = hall?.seats.find(s => s.id === selectedId) ?? null;
  const selectedState = availability?.seats.find(s => s.seat_id === selectedId);
  const centerSeat = hall?.seats.filter(seat => seat.row === 6 && availability?.seats.some(s => s.seat_id === seat.id && s.status === 'available')).sort((a, b) => Math.abs(a.position.x) - Math.abs(b.position.x))[0];
  const cinema = cinemas.find(c => c.id === session?.cinema_id);
  const availableCount = availability?.seats.filter(s => s.status === 'available').length ?? 0;
  const tiers = useMemo(() => hall && availability ? Array.from(new Set(hall.seats.map(s => s.zone))).map(zone => {
    const ids = new Set(hall.seats.filter(s => s.zone === zone).map(s => s.id));
    const prices = availability.seats.filter(s => ids.has(s.seat_id)).map(s => s.price_minor);
    return { zone, price: Math.min(...prices) };
  }) : [], [hall, availability]);
  const select = useCallback((seat: Seat) => setSelectedId(seat.id), []);
  function addCompare() {
    if (!selected) return;
    setCompareIds(ids => ids.includes(selected.id) ? ids.filter(id => id !== selected.id) : ids.length < 2 ? [...ids, selected.id] : [ids[0], selected.id]);
  }
  async function conflict() {
    setCheckout(false);
    const request = ++availabilityRequest.current;
    setSelectedId(null);
    try {
      const data = await api.seats(sessionId);
      if (request === availabilityRequest.current) setAvailability(current => current && Date.parse(data.updated_at) < Date.parse(current.updated_at) ? current : data);
    } catch { if (request === availabilityRequest.current) setRefreshError(true); }
  }
  if (loading) return <div className="page-shell"><Loading label="Открываем трибуну…"/></div>;
  if (error || !session || !hall || !availability) return <div className="page-shell"><Link className="back-link" to="/#sessions"><ArrowLeft size={16}/>К матчам</Link><ErrorState message={error || 'Этот матч не найден.'} onRetry={() => setVersion(v => v + 1)}/></div>;
  const [homeClub, awayClub] = clubsOf(session.movie.title);
  const expired = new Date(session.starts_at).getTime() <= Date.now();
  return <div className="page-shell session-page session-v2">
    <div className="session-topline"><Link className="back-link" to="/#sessions"><ArrowLeft size={16}/>К матчам</Link><ol className="booking-steps" aria-label="Этапы покупки"><li className="is-current" aria-current="step">01<span>Место</span></li><li>02<span>Оплата</span></li><li>03<span>Билет</span></li></ol></div>
    <div className="session-title"><span className="session-crests" aria-hidden="true"><i style={{ background: homeClub.color }}>{homeClub.short}</i><i style={{ background: awayClub.color }}>{awayClub.short}</i></span><div><p className="eyebrow">ВЫБЕРИТЕ МЕСТО. ПРИМЕРЬТЕ ВПЕЧАТЛЕНИЕ.</p><h1>{session.movie.title}</h1><div className="session-subtitle"><span><MapPin size={15}/>{cinema?.name ?? hall.name}</span><span><Clock3 size={15}/>{sessionDate(session.starts_at, cinema?.timezone)}, {sessionTime(session.starts_at, cinema?.timezone)}</span><span>{session.format}</span></div></div><span className="availability-chip"><span className="status-dot"/>{availableCount} свободных мест</span></div>
    {expired && <div className="inline-notice" role="alert">Этот матч уже начался. <Link to="/#sessions">Выберите другой.</Link></div>}
    {refreshError && <div className="inline-notice" role="status">Не удалось обновить места. Доступность проверится ещё раз при покупке.</div>}
    <div className="booking-layout">
      <div ref={hallFullscreenRef} className={'hall-panel' + (hallFullscreen.active ? ' is-fullscreen' : '')} data-fullscreen-mode={hallFullscreen.mode} role={hallFullscreen.active ? 'dialog' : undefined} aria-modal={hallFullscreen.active || undefined} aria-label={hallFullscreen.active ? 'Трибуна на весь экран' : undefined}>
        <div className="hall-panel-head"><div><h2>{hall.name}</h2><span className="hall-name">{hall.seats.length} мест · цена зависит от ряда</span></div><div className="hall-panel-actions"><div className="hall-mode-toggle" role="group" aria-label="Отображение трибуны"><button aria-pressed={hallMode === '2d'} onClick={() => setHallMode('2d')}><Grid2X2 size={16}/>Схема</button><button aria-pressed={hallMode === '3d'} onClick={() => setHallMode('3d')}><Box size={16}/>3D-стадион</button></div><FullscreenButton active={hallFullscreen.active} busy={hallFullscreen.busy} onToggle={hallFullscreen.toggle} label="Развернуть на весь экран" /></div></div>
        {stadium.length > 0 && <StadiumMap sectors={liveStadium} currentHallId={hall.id} onSelect={item => { if (item.hall.id !== hall.id) navigate('/sessions/' + item.session.id); }}/>}
        {hallMode === '3d' && liveStadium.length ? <div className="interactive-hall">
          <div className="hall-interaction-hint"><MousePointer2 size={13}/><span>Перетаскивайте для обзора · выберите место</span></div>
          <Suspense fallback={<Loading label="Включаем прожекторы…"/>}><StadiumScene key={cameraRevision} sectors={liveStadium} seat={selected} overview onSeatPick={pickSeat} audience={audience} lightsOn={lightsOn} view={cameraView} paused={previewIds.length > 0 || checkout} onError={() => { setSceneError(true); setHallMode('2d'); }}/></Suspense>
          <div className="hall-experience-controls"><LightSwitch on={lightsOn} onToggle={() => setLightsOn(value => !value)}/><button className="audience-toggle" aria-pressed={audience} onClick={() => setAudience(value => !value)}><Users size={15}/><span>Болельщики</span><i/></button></div>
          <div className="hall-camera-bar" role="group" aria-label="Ракурс камеры">{([{ value: 'overview', label: 'Весь стадион' }, { value: 'front', label: 'От ворот' }, { value: 'back', label: 'С трибуны' }, { value: 'top', label: 'Сверху' }, { value: 'sofas', label: 'С другой стороны' }] as const).map(view => <button key={view.value} aria-pressed={cameraView === view.value} onClick={() => setCameraView(view.value)}>{view.label}</button>)}<button className="camera-reset" aria-label="Сбросить камеру" onClick={() => { setCameraView('overview'); setCameraRevision(v => v + 1); }}><RotateCcw size={16}/></button></div>
        </div> : <><SeatMap hall={hall} availability={availability} selectedId={selectedId} compareIds={compareIds} onSelect={select}/>{sceneError && <p className="map-hint" role="status">3D недоступен в этом браузере. Все места можно выбрать на схеме.</p>}</>}
        <div className="price-tiers">{tiers.map(t => <div key={t.zone}><span className={'tier-symbol tier-' + t.zone}/><div><strong>{money(t.price)}</strong><span>{t.zone === 'front' ? 'Ряды у кромки поля' : t.zone === 'middle' ? 'Центр трибуны' : 'Ложи наверху'}</span></div></div>)}</div>
        {hallFullscreen.active && <div className="fullscreen-seat-bar">{selected && selectedState ? <><div><strong>Ряд {selected.row} · {selected.type === 'sofa' ? 'ложа' : 'место'} {selected.number}</strong><span>{money(selectedState.price_minor)}{selectedState.status !== 'available' ? ' · Занято' : ''}</span></div><button className="button button--primary" onClick={async () => { await hallFullscreen.exit(); setPreviewIds([selected.id]); }}><Eye size={17} aria-hidden="true"/>Сесть и посмотреть</button></> : <p>Выберите место, чтобы посмотреть на поле с этой точки трибуны.</p>}</div>}
      </div>
      <aside className="booking-sidebar" aria-label="Выбранное место">
        <AnimatePresence mode="wait" initial={false}>{selected && selectedState ? <motion.div className="selection-card" key="selected-seat" initial={reduce ? false : { opacity: .3, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: .3 }} transition={{ duration: .12 }}>
          <div className="selection-kicker"><span className="eyebrow">ТО САМОЕ МЕСТО</span><span className="selected-dot"/></div>
          <div className="seat-numbers"><div><span>Ряд</span><strong>{String(selected.row).padStart(2, '0')}</strong></div><i/><div><span>{selected.type === 'sofa' ? 'Ложа' : 'Место'}</span><strong>{String(selected.number).padStart(2, '0')}</strong></div><div className="selection-chair" aria-hidden="true"><Ticket size={36} strokeWidth={1}/></div></div>
          <div className="selection-price"><span>{selected.type === 'sofa' ? 'Место в ложе' : 'Один билет'}</span><strong>{money(selectedState.price_minor)}</strong></div>
          {selectedState.status !== 'available' && <p className="seat-unavailable" role="status">{selectedState.status === 'held' ? 'Это место временно забронировано.' : 'Это место уже купили.'} Посмотреть ракурс всё равно можно.</p>}
          <button className="button button--light preview-cta" onClick={() => setPreviewIds([selected.id])}><Eye size={19}/>Сесть и посмотреть<ArrowUpRight size={18}/></button>
          <button className="button button--primary buy-cta" disabled={selectedState.status !== 'available' || expired} onClick={() => setCheckout(true)}>Купить билет<ArrowRight size={18}/></button>
          <button className={'compare-button' + (compareIds.includes(selected.id) ? ' is-active' : '')} onClick={() => compareIds.length === 2 ? setPreviewIds(compareIds) : addCompare()}><GitCompareArrows size={17}/>{compareIds.length === 2 ? 'Сравнить два места' : compareIds.includes(selected.id) ? 'Убрать из сравнения' : 'Добавить к сравнению'}</button>
          <p className="booking-trust"><ShieldCheck size={14}/>Место бронируется при оформлении</p>
        </motion.div> : <div className="selection-card selection-empty" key="empty"><div className="empty-seat-illustration"><div className="fallback-chair"><span/><i/><b/></div></div><h3>Где сядем?</h3><p>Выберите место на трибуне.<br/>Сядьте, оглядитесь<br/>и послушайте звук со своего места.</p>{centerSeat && <button className="button button--primary center-preview" onClick={() => { select(centerSeat); setPreviewIds([centerSeat.id]); }}><Eye size={17}/>Примерить центр трибуны</button>}<span className="empty-selection-hint"><Volume2 size={15}/>У фан-сектора громче, наверху тише</span></div>}</AnimatePresence>
        <div className="seat-tip"><span>СНАЧАЛА ПОСМОТРЕТЬ</span><p>Включите звук и смените место.<br/>Вид и громкость изменятся вместе с ним.</p></div>
      </aside>
    </div>
    <div className="reference-views"><span className="eyebrow">ПОЧУВСТВУЙТЕ РАЗНИЦУ</span><div>{[{ row: 1, number: 3, label: 'У кромки поля' }, { row: 6, number: 12, label: 'Центр трибуны' }, { row: 10, number: 5, label: 'Ложа наверху' }].map(preset => {
      const seat = hall.seats.find(s => s.row === preset.row && s.number === preset.number);
      return seat ? <button key={seat.id} onClick={() => { select(seat); setPreviewIds([seat.id]); }}><Eye size={17}/><span>{preset.label}<small>Ряд {seat.row}, {seat.type === 'sofa' ? 'ложа' : 'место'} {seat.number}</small></span><ArrowUpRight size={17}/></button> : null;
    })}</div></div>
    <SeatLab hall={hall} availability={availability} selected={selected} insight={insights?.session_id === sessionId ? insights.seats.find(s => s.seat_id === selectedId) : undefined} insightError={insightError} onCompare={seats => { const ids = seats.map(seat => seat.id); setCompareIds(ids); setPreviewIds(ids); }} onPreview={seat => setPreviewIds([seat.id])}/>
    <SeatFinder hall={hall} availability={availability} selectedId={selectedId} onSelect={select} onPreview={seat => { select(seat); setPreviewIds([seat.id]); }} onCompare={seats => { const ids = seats.map(seat => seat.id); setCompareIds(ids); setPreviewIds(ids); }}/>
    {compareIds.length > 0 && <div className="compare-dock" role="region" aria-label="Сравнение мест"><div className="compare-dock-label"><GitCompareArrows size={18}/><span>Сравнение мест</span></div><div className="compare-slots">{[0, 1].map(index => {
      const seat = hall.seats.find(s => s.id === compareIds[index]);
      return <div className={'compare-slot' + (!seat ? ' is-empty' : '')} key={index}><b>{index ? 'B' : 'A'}</b>{seat ? <><span>Ряд {seat.row} · место {seat.number}</span><button aria-label={'Убрать место ' + (index ? 'B' : 'A')} onClick={() => setCompareIds(ids => ids.filter(id => id !== seat.id))}><X size={14}/></button></> : <span>Выберите ещё одно</span>}</div>;
    })}</div><button className="button button--primary" disabled={compareIds.length !== 2} onClick={() => setPreviewIds(compareIds)}>Сравнить ракурсы<ArrowRight size={16}/></button></div>}
    <RoomChat sessionId={session.id}/>
    {previewIds.length > 0 && <PreviewDialog lightsOn={lightsOn} onToggleLights={() => setLightsOn(value => !value)} sectors={liveStadium} hall={hall} availability={availability} seats={previewIds.flatMap(id => { const seat = hall.seats.find(s => s.id === id); return seat ? [seat] : []; })} onClose={() => setPreviewIds([])} onSelect={select} onBuy={expired ? undefined : seat => { select(seat); setCheckout(true); }}/>}
    {checkout && selected && selectedState && <CheckoutDialog session={session} seat={selected} priceMinor={selectedState.price_minor} cinema={cinema} onClose={() => setCheckout(false)} onConflict={conflict}/>}
    {selected && selectedState && <div className="mobile-seat-bar"><button className="mobile-seat-detail" onClick={() => setPreviewIds([selected.id])}><Eye size={18}/><span><strong>Ряд {selected.row} · {selected.type === 'sofa' ? 'ложа' : 'место'} {selected.number}</strong><small>Посмотреть с места</small></span></button><button className="button button--primary" disabled={selectedState.status !== 'available' || expired} onClick={() => setCheckout(true)}>{selectedState.status === 'available' ? money(selectedState.price_minor) : 'Занято'}<ArrowRight size={17}/><span className="sr-only"> — Купить билет</span></button></div>}
  </div>;
}
