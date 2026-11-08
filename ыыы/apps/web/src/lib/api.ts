import type { SessionInsights } from './seatExperience';
import type { Availability, Cinema, CreateOrderRequest, CreateOrderResponse, Hall, Health, Order, OrderPricing, Session, Ticket } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
    this.name = 'ApiError';
  }
}

const base = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '');

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 18000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(base + path, { ...options, signal, headers: { Accept: 'application/json', ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, data?.error?.code || 'REQUEST_FAILED',
        data?.error?.message || 'Не получилось загрузить данные. Попробуйте ещё раз.', data?.error?.retryable ?? response.status >= 500);
    }
    if (data === null) throw new ApiError(502, 'INVALID_RESPONSE', 'Сервис вернул неполный ответ. Попробуйте ещё раз.', true);
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Соединение прервалось. Проверьте интернет и повторите запрос.', true);
  } finally { window.clearTimeout(timer); }
}

const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
export const api = {
  insights: (id: string, signal?: AbortSignal) => request<SessionInsights>('/sessions/' + encodeURIComponent(id) + '/insights', { signal }),
  health: (signal?: AbortSignal) => request<Health>('/health', { signal }),
  cinemas: (signal?: AbortSignal) => request<{ items: Cinema[] }>('/cinemas', { signal }),
  sessions: (cinemaId: string, signal?: AbortSignal) => request<{ items: Session[] }>('/sessions?cinema_id=' + encodeURIComponent(cinemaId), { signal }),
  session: (id: string, signal?: AbortSignal) => request<Session>('/sessions/' + encodeURIComponent(id), { signal }),
  hall: (id: string, signal?: AbortSignal) => request<Hall>('/halls/' + encodeURIComponent(id), { signal }),
  seats: (id: string, signal?: AbortSignal) => request<Availability>('/sessions/' + encodeURIComponent(id) + '/seats', { signal }),
  watchSeats: (id: string, onChange: () => void) => {
    const stream = new EventSource(base + '/sessions/' + encodeURIComponent(id) + '/stream');
    stream.addEventListener('connected', onChange);
    stream.addEventListener('seat_update', onChange);
    // Polling remains active if the connection drops or a proxy cannot stream.
    stream.onerror = () => stream.close();
    return () => stream.close();
  },
  createOrder: (body: CreateOrderRequest, key: string) => request<CreateOrderResponse>('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }),
  order: (id: string, token: string, signal?: AbortSignal) => request<Order>('/orders/' + encodeURIComponent(id), { signal, headers: auth(token) }),
  orderPricing: (id: string, token: string, signal?: AbortSignal) => request<OrderPricing>('/orders/' + encodeURIComponent(id) + '/pricing', { signal, headers: auth(token) }),
  orderTicket: (id: string, token: string, signal?: AbortSignal) => request<Ticket>('/orders/' + encodeURIComponent(id) + '/ticket', { signal, headers: auth(token) }),
  ticket: (token: string, signal?: AbortSignal) => request<Ticket>('/tickets/' + encodeURIComponent(token), { signal }),
};
