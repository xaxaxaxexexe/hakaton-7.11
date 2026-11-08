export interface ChatEmote { id: string; code: string; image_url: string }
export interface ChatReaction { emoji: string; count: number }
export interface ChatMessage { id: string; visitor_id: string; nickname: string; color: string; text: string; emote: ChatEmote | null; created_at: string; reactions: ChatReaction[] }
export interface ChatSnapshot { room_id: string; connection_id: string; participants: number; messages: ChatMessage[] }
const base = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '');
const room = (sessionId: string) => base + '/sessions/' + encodeURIComponent(sessionId) + '/chat';

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || 'Сообщение не отправлено. Попробуйте ещё раз.');
  return data as T;
}

export const safeEmoteUrl = (url: string) => /^https:\/\/cdn\.betterttv\.net\/emote\/[a-f0-9]{24}\/2x$/.test(url);
export const chatApi = {
  emotes: async (signal?: AbortSignal): Promise<ChatEmote[]> => {
    const response = await fetch(base + '/chat/emotes', { signal });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.items) ? data.items.filter((item: ChatEmote) => typeof item.image_url === 'string' && safeEmoteUrl(item.image_url)) : [];
  },
  stream: (sessionId: string, visitor: string) => new EventSource(room(sessionId) + '/stream?visitor_id=' + encodeURIComponent(visitor)),
  leave: (sessionId: string, visitor: string, connectionId: string) => fetch(room(sessionId) + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitor_id: visitor, connection_id: connectionId }), keepalive: true }).catch(() => {}),
  send: (sessionId: string, body: { visitor_id: string; nickname: string; text: string; emote_id: string | null; client_message_id: string }) => post<ChatMessage>(room(sessionId) + '/messages', body),
  react: (sessionId: string, visitor: string, messageId: string, emoji: string) => post<{ message_id: string; reactions: ChatReaction[] }>(room(sessionId) + '/reactions', { visitor_id: visitor, message_id: messageId, emoji }),
};

export function chatIdentity() {
  let visitor = '';
  try { visitor = sessionStorage.getItem('zal:chat:visitor') || ''; } catch { /* Ephemeral identity still works. */ }
  if (!/^[a-f0-9-]{36}$/.test(visitor)) visitor = crypto.randomUUID();
  try { sessionStorage.setItem('zal:chat:visitor', visitor); } catch { /* Storage may be disabled. */ }
  return visitor;
}
