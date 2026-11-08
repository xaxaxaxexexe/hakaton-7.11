import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, ChevronDown, Eye, Headphones, MapPin, Search, X } from 'lucide-react';
import { useApp } from '../lib/AppContext';
import { api } from '../lib/api';
import { money, sessionDate, sessionTime } from '../lib/format';
import { clubsOf, loadStadium, type StadiumSector } from '../lib/stadiumData';
import type { Session } from '../lib/types';
import { EmptyState, ErrorState, Loading } from '../components/Feedback';
import '../styles/home-v2.css';

const StadiumScene = lazy(() => import('../components/StadiumScene'));
const STADIUM_HERO = '/media/stadium-hero.jpg';

function Crests({ title }: { title: string }) {
  const [home, away] = clubsOf(title);
  return <span className="match-crests" aria-hidden="true"><i style={{ background: home.color }}>{home.short}</i><b>vs</b><i style={{ background: away.color }}>{away.short}</i></span>;
}

function MatchCard({ sessions, timezone }: { sessions: Session[]; timezone?: string }) {
  const entry = sessions.find(session => session.id.endsWith('_C')) ?? sessions[0];
  const { movie } = entry;
  return <article className="reel-card match-card">
    <Link className="match-card-pitch" to={'/sessions/' + entry.id} aria-label={'Выбрать место на матч ' + movie.title}><Crests title={movie.title}/></Link>
    <div className="reel-caption"><h3><Link to={'/sessions/' + entry.id}>{movie.title}</Link></h3><p>{entry.format}</p></div>
    <div className="match-card-when"><strong>{sessionTime(entry.starts_at, timezone)}</strong><span>{sessionDate(entry.starts_at, timezone)}</span><span>{sessions.length} секторов</span></div>
    <div className="reel-bottom"><span>от {money(Math.min(...sessions.map(session => session.price_from_minor)))}</span><Link to={'/sessions/' + entry.id}><Eye size={14}/>Выбрать место</Link></div>
  </article>;
}

export default function HomePage() {
  const { cinemas, loading: catalogLoading, error: catalogError, reload } = useApp();
  const [cinemaId, setCinemaId] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [stadium, setStadium] = useState<StadiumSector[] | null>(null);
  const [previewPosition, setPreviewPosition] = useState<'front' | 'middle' | 'back'>('middle');
  const [query, setQuery] = useState('');
  const selectedCinema = cinemas.find(cinema => cinema.id === cinemaId);

  useEffect(() => { if (cinemas.length && !cinemas.some(cinema => cinema.id === cinemaId)) setCinemaId(cinemas[0].id); }, [cinemas, cinemaId]);
  useEffect(() => {
    if (!cinemaId) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setSessions([]); setStadium(null);
    api.sessions(cinemaId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const future = data.items.filter(item => new Date(item.starts_at).getTime() > Date.now()).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
      setSessions(future);
      if (future[0]) void loadStadium(future[0], controller.signal).then(sectors => { if (!controller.signal.aborted) setStadium(sectors); }).catch(() => {});
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cinemaId, version]);

  const matches = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const session of sessions) groups.set(session.movie.id, [...(groups.get(session.movie.id) ?? []), session]);
    return [...groups.values()];
  }, [sessions]);
  const visible = matches.filter(group => (group[0].movie.title + ' ' + group[0].format).toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU')));
  const featured = stadium?.find(item => item.session.id.endsWith('_C')) ?? stadium?.[0];
  const positions = [{ id: 'front', label: 'У кромки', row: 1, number: 3 }, { id: 'middle', label: 'Центр трибуны', row: 6, number: 12 }, { id: 'back', label: 'Ложа наверху', row: 10, number: 5 }] as const;
  const position = positions.find(item => item.id === previewPosition)!;
  const previewSeat = featured?.hall.seats.find(seat => seat.row === position.row && seat.number === position.number) ?? featured?.hall.seats[0];
  const seatHref = featured ? '/sessions/' + featured.session.id + (previewSeat ? '?seat=' + encodeURIComponent(previewSeat.id) + '&preview=1' : '') : '#sessions';

  return <div className="home-v2">
    <section className="stadium-hero" aria-labelledby="stadium-hero-title">
      <img src={STADIUM_HERO} alt=""/>
      <div className="wrap stadium-hero-copy">
        <p className="cinema-hero-kicker"><span/>СНАЧАЛА — ВАШЕ МЕСТО</p>
        <h1 id="stadium-hero-title">Билет с видом<br/>на <em>поле.</em></h1>
        <p>Сядьте на место до покупки.<br/>Посмотрите на поле, послушайте трибуну<br className="cinema-desktop-break"/> и выберите свой лучший ракурс.</p>
        <div className="cinema-hero-actions"><a className="button button--primary" href="#sessions">Выбрать матч<ArrowUpRight size={21}/></a></div>
        <div className="hero-benefits"><span><Eye size={15}/>Вид с любого места</span><span><Headphones size={15}/>Звук с вашей трибуны</span></div>
      </div>
    </section>

    <section className="reel-section" id="sessions" aria-labelledby="reel-title">
      <div className="wrap">
        <div className="reel-heading"><div><p className="reel-eyebrow">РАСПИСАНИЕ СТАДИОНА</p><h2 id="reel-title">Какой матч смотрим?</h2></div><div className="reel-cinema-control"><MapPin size={20}/><div><label htmlFor="cinema">Стадион</label><select id="cinema" value={cinemaId} onChange={event => setCinemaId(event.target.value)} disabled={!cinemas.length}>{!cinemas.length && <option value="">Загружаем стадионы</option>}{cinemas.map(cinema => <option key={cinema.id} value={cinema.id}>{cinema.name}</option>)}</select></div><ChevronDown size={17}/></div></div>
        <div className="reel-toolbar"><p className="match-address">{selectedCinema?.address}</p><label className="reel-search"><Search size={18}/><span className="sr-only">Найти матч</span><input type="search" placeholder="Команда или турнир" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button onClick={() => setQuery('')} aria-label="Очистить поиск"><X size={16}/></button>}</label></div>
        <div className="reel-meta"><p><span/>Все места можно посмотреть в 3D</p><span>{visible.length} {visible.length === 1 ? 'матч' : visible.length > 1 && visible.length < 5 ? 'матча' : 'матчей'}</span></div>
        {catalogError ? <ErrorState message={catalogError} onRetry={reload}/> : error ? <ErrorState message={error} onRetry={() => setVersion(value => value + 1)}/> : catalogLoading || loading ? <div className="reel-grid" aria-label="Загрузка матчей" aria-busy="true">{[0, 1, 2].map(index => <div className="reel-skeleton" key={index}/>)}</div> : visible.length ? <div className="reel-grid">{visible.map(group => <MatchCard key={group[0].movie.id} sessions={group} timezone={selectedCinema?.timezone}/>)}</div> : matches.length ? <EmptyState title="Не нашли такой матч"><span>Попробуйте другую команду или турнир.</span><button className="button button--secondary" onClick={() => setQuery('')}>Показать все матчи</button></EmptyState> : <EmptyState title="Новые матчи уже скоро">Выберите другой стадион, чтобы посмотреть его расписание.</EmptyState>}
      </div>
    </section>

    <section className="seat-discovery" id="how-it-works" aria-labelledby="discovery-title">
      <div className="wrap seat-discovery-inner"><div className="seat-discovery-copy"><p className="reel-eyebrow">ПЕРЕД ПОКУПКОЙ — ПРИСЯДЬТЕ</p><h2 id="discovery-title">С каждого места<br/>своё поле.</h2><p>Расстояние до игроков. Высота трибуны.<br/>Головы впереди. Проверьте всё,<br/>что меняет впечатление от матча.</p><div className="discovery-features"><span><Eye size={19}/>Настоящий вид с места</span><span><Headphones size={19}/>Звук рядом с фан-сектором</span><span><Check size={19}/>Сравнение двух ракурсов</span></div><Link className="button button--primary" to={seatHref}>Открыть этот ракурс<ArrowUpRight size={20}/></Link></div>
        <div className="seat-discovery-product"><div className="discovery-tabs" role="group" aria-label="Попробуйте разные места">{positions.map(item => <button key={item.id} aria-pressed={previewPosition === item.id} onClick={() => setPreviewPosition(item.id)}>{item.label}</button>)}</div><div className="discovery-scene">{stadium && previewSeat ? <Suspense fallback={<Loading label="Открываем вид с места…"/>}><StadiumScene sectors={stadium} seat={previewSeat}/></Suspense> : <div className="discovery-scene-fallback"><img src={STADIUM_HERO} alt="" loading="lazy"/><Eye size={32}/></div>}<div className="discovery-seat-label"><Eye size={15}/>{previewSeat ? 'Ряд ' + previewSeat.row + ' · ' + (previewSeat.type === 'sofa' ? 'ложа ' : 'место ') + previewSeat.number : 'Вид с места'}</div></div><div className="discovery-scene-footer"><span>Как будто вы уже на трибуне</span><Link to={seatHref}>Попробовать<ArrowUpRight size={17}/></Link></div></div>
      </div>
    </section>
    <div className="home-final-line wrap"><span>Хороший матч начинается с хорошего места.</span><a href="#sessions">Выбрать своё<ArrowUpRight size={20}/></a></div>
  </div>;
}
