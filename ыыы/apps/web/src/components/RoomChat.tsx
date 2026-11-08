import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PanelRightClose, PanelRightOpen, MessageCircle, SendHorizontal, Smile, Users, WifiOff, X } from 'lucide-react';
import { chatApi, chatIdentity, safeEmoteUrl, type ChatEmote, type ChatMessage, type ChatSnapshot } from '../lib/chatApi';
import '../styles/room-chat.css';

const EMOJI = ['⚽', '🎬', '❤️', '😂', '🔥', '👏', '😍', '😮', '🥹', '👍', '👀', '✨'];
const REACTIONS = ['👍', '❤️', '😂'];
const appendMessage = (list: ChatMessage[], next: ChatMessage) => list.some(item => item.id === next.id) ? list : [...list, next].slice(-50);

export default function RoomChat({ sessionId }: { sessionId: string }) {
  const [visitor] = useState(chatIdentity);
  const [open, setOpen] = useState(() => {
    try { const saved = localStorage.getItem('zal:chat:open'); return saved === null ? window.innerWidth >= 1200 : saved === 'true'; }
    catch { return window.innerWidth >= 1200; }
  });
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nickname, setNickname] = useState(() => { try { return localStorage.getItem('zal:chat:nickname') || 'Болельщик ' + visitor.slice(0, 4); } catch { return 'Болельщик ' + visitor.slice(0, 4); } });
  const [text, setText] = useState('');
  const [emotes, setEmotes] = useState<ChatEmote[]>([]);
  const [selectedEmote, setSelectedEmote] = useState<ChatEmote | null>(null);
  const [picker, setPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const history = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    setMessages([]); setParticipants(null); setText(''); setSelectedEmote(null); setError(''); pending.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setConnected(false);
    const stream = chatApi.stream(sessionId, visitor);
    let connectionId = '';
    const leave = () => { if (connectionId) { void chatApi.leave(sessionId, visitor, connectionId); connectionId = ''; } };
    window.addEventListener('pagehide', leave);
    const parse = <T,>(event: Event): T => JSON.parse((event as MessageEvent).data) as T;
    stream.addEventListener('history', event => {
      const snapshot = parse<ChatSnapshot>(event);
      if (snapshot.room_id !== sessionId) return;
      connectionId = snapshot.connection_id;
      setMessages(snapshot.messages); setParticipants(snapshot.participants); setConnected(true); setError('');
    });
    stream.addEventListener('message', event => setMessages(previous => appendMessage(previous, parse<ChatMessage>(event))));
    stream.addEventListener('presence', event => setParticipants(parse<{ participants: number }>(event).participants));
    stream.addEventListener('reaction', event => {
      const update = parse<{ message_id: string; reactions: ChatMessage['reactions'] }>(event);
      setMessages(previous => previous.map(message => message.id === update.message_id ? { ...message, reactions: update.reactions } : message));
    });
    stream.onerror = () => { setConnected(false); setParticipants(null); };
    return () => { leave(); window.removeEventListener('pagehide', leave); stream.close(); setConnected(false); };
  }, [open, sessionId, visitor]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    chatApi.emotes(controller.signal).then(setEmotes).catch(() => {});
    return () => controller.abort();
  }, [open]);

  useEffect(() => { if (history.current) history.current.scrollTop = history.current.scrollHeight; }, [messages.length, open]);
  useEffect(() => { try { localStorage.setItem('zal:chat:nickname', nickname); } catch { /* Optional preference only. */ } }, [nickname]);
  useEffect(() => { try { localStorage.setItem('zal:chat:open', String(open)); } catch { /* Optional preference. */ } }, [open]);
  const close = () => { setOpen(false); setPicker(false); requestAnimationFrame(() => launcher.current?.focus()); };
  const expand = () => { setOpen(true); requestAnimationFrame(() => composer.current?.focus({ preventScroll: true })); };

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current || !connected || !nickname.trim() || (!text.trim() && !selectedEmote)) return;
    const body = { visitor_id: visitor, nickname: nickname.trim(), text: text.trim(), emote_id: selectedEmote?.id || null };
    const fingerprint = JSON.stringify(body);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    sendingRef.current = true; setSending(true); setError('');
    try {
      const message = await chatApi.send(sessionId, { ...body, client_message_id: pending.current.key });
      setMessages(previous => appendMessage(previous, message));
      setText(''); setSelectedEmote(null); setPicker(false); pending.current = null;
      composer.current?.focus();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Соединение прервалось. Текст сохранён — попробуйте ещё раз.'); }
    finally { sendingRef.current = false; setSending(false); }
  }

  async function react(messageId: string, emoji: string) {
    try { await chatApi.react(sessionId, visitor, messageId, emoji); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не получилось добавить реакцию.'); }
  }

  return <aside className={'room-chat' + (open ? ' room-chat--open' : '')} aria-label="Чат матча">
    {open && <section className="room-chat-panel" id="room-chat-panel" aria-label="Сообщения болельщиков" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); picker ? setPicker(false) : close(); } }}>
      <header className="room-chat-header"><div className="room-chat-heading"><span className="room-chat-mark"><MessageCircle size={19}/></span><div><h2>Чат матча</h2><span className="room-chat-presence" role="status">{connected ? <><Users size={12}/>{participants ?? 0} в чате</> : <><WifiOff size={12}/>Подключаемся…</>}</span></div></div><button type="button" className="icon-button" onClick={close} aria-label="Свернуть чат"><PanelRightClose size={20}/></button></header>
      <label className="room-chat-name"><span>Ваше имя</span><input aria-label="Имя в чате" maxLength={24} value={nickname} onChange={event => setNickname(event.target.value)} autoComplete="nickname"/></label>
      <div className="room-chat-history" ref={history} role="log" aria-label="История сообщений" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && <div className="room-chat-empty"><span aria-hidden="true">⚽</span><strong>Кто за кого болеет?</strong><p>Обсудите матч и места на трибуне.<br/>Первое сообщение может быть вашим.</p></div>}
        {messages.map(message => <article key={message.id} className={'room-chat-message' + (message.visitor_id === visitor ? ' room-chat-message--own' : '')}>
          <span className="room-chat-avatar" style={{ '--avatar-color': /^#[a-f0-9]{6}$/i.test(message.color) ? message.color : '#77b8f5' } as React.CSSProperties}>{Array.from(message.nickname)[0]?.toUpperCase()}</span>
          <div className="room-chat-message-body"><div className="room-chat-byline"><strong>{message.nickname}</strong><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time></div>{message.text && <p>{message.text}</p>}{message.emote && safeEmoteUrl(message.emote.image_url) && <span className="room-chat-emote"><img src={message.emote.image_url} alt={message.emote.code} loading="lazy" referrerPolicy="no-referrer"/><small>{message.emote.code}</small></span>}<div className="room-chat-reactions" role="group" aria-label={'Реакции на сообщение ' + message.nickname}>{REACTIONS.map(emoji => { const count = message.reactions.find(reaction => reaction.emoji === emoji)?.count; return <button key={emoji} type="button" disabled={!connected} onClick={() => react(message.id, emoji)} aria-label={'Реакция ' + emoji + (count ? ', ' + count : '')}>{emoji}{count ? <span>{count}</span> : null}</button>; })}</div></div>
        </article>)}
      </div>
      {picker && <div className="room-chat-picker" role="group" aria-label="Выберите эмодзи или эмоцию"><div className="room-chat-picker-heading"><span>Эмодзи</span><button className="icon-button" onClick={() => setPicker(false)} aria-label="Закрыть эмоции" type="button"><X size={15}/></button></div><div className="room-chat-unicode">{EMOJI.map(emoji => <button key={emoji} type="button" aria-label={'Добавить ' + emoji} onClick={() => { setText(value => value.length + emoji.length <= 300 ? value + emoji : value); composer.current?.focus(); }}>{emoji}</button>)}</div><div className="room-chat-picker-heading"><a href="https://betterttv.com/emotes/global" target="_blank" rel="noreferrer">BetterTTV</a><small>{emotes.length ? 'Глобальные эмоции' : 'Пока недоступны'}</small></div><div className="room-chat-bttv">{emotes.map(emote => <button key={emote.id} type="button" title={emote.code} aria-label={'Эмоция ' + emote.code} onClick={() => { setSelectedEmote(emote); setPicker(false); }}><img src={emote.image_url} alt={emote.code} loading="lazy" referrerPolicy="no-referrer"/></button>)}</div></div>}
      <form className="room-chat-compose" onSubmit={send}>
        {selectedEmote && <div className="room-chat-selected"><img src={selectedEmote.image_url} alt=""/><span>{selectedEmote.code}</span><button type="button" className="icon-button" aria-label="Убрать эмоцию" onClick={() => setSelectedEmote(null)}><X size={13}/></button></div>}
        <label className="room-chat-input"><span className="sr-only">Сообщение в чат</span><textarea ref={composer} rows={2} maxLength={300} placeholder="Какой прогноз на матч?" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/></label>
        <div className="room-chat-compose-actions"><button type="button" className="icon-button" aria-label="Открыть эмоции" aria-expanded={picker} onClick={() => setPicker(value => !value)}><Smile size={20}/></button><small>{text.length}/300</small><button type="submit" className="room-chat-send" disabled={sending || !connected || !nickname.trim() || (!text.trim() && !selectedEmote)} aria-label="Отправить сообщение"><SendHorizontal size={18}/><span>{sending ? 'Отправка' : 'Отправить'}</span></button></div>
        {error && <p className="room-chat-error" role="alert">{error}</p>}
      </form>
      <footer className="room-chat-footnote">Последние 50 сообщений · история до перезапуска</footer>
    </section>}
    <button ref={launcher} type="button" className="room-chat-launcher" aria-label={open ? 'Свернуть чат матча' : 'Открыть чат матча'} aria-expanded={open} aria-controls="room-chat-panel" onClick={() => open ? close() : expand()}><PanelRightOpen size={20}/><span>Чат матча</span></button>
  </aside>;
}
