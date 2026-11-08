export interface Vector3 { x: number; y: number; z: number }
export interface Health { status: 'ok'; mode: 'mock' | 'live'; api_version: string; demo_checkout_minor?: number }
export interface Cinema { id: string; name: string; address: string; timezone: string }
export interface Movie { id: string; title: string; duration_minutes: number; age_rating: string; poster_url: string | null }
export interface Session { id: string; cinema_id: string; hall_id: string; movie: Movie; starts_at: string; format: string; currency: 'RUB'; price_from_minor: number }
export interface Seat { id: string; row: number; number: number; type: 'standard' | 'sofa'; zone: 'front' | 'middle' | 'sofa'; position: Vector3; rotation_y: number; width: number; depth: number }
export interface Hall {
  id: string; cinema_id: string; name: string;
  dimensions: { width: number; height: number; depth: number };
  screen: { center: Vector3; width: number; height: number };
  camera: { eye_height: number; fov_degrees: number; near: number; far: number };
  speakers: Array<{ id: string; position: Vector3 }>;
  seats: Seat[];
}
export interface SeatAvailability { seat_id: string; status: 'available' | 'held' | 'sold'; price_minor: number; currency: 'RUB' }
export interface Availability { session_id: string; updated_at: string; seats: SeatAvailability[] }
export interface Payment {
  provider: 'mock' | 'platega';
  status: 'CREATING' | 'PENDING' | 'CONFIRMED' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'DISPUTED' | 'CHARGEBACKED' | 'PARTIALLY_REFUNDED' | 'UNKNOWN';
  payment_url: string | null; transaction_id: string | null;
  qr_url?: string | null;
}
export interface Order {
  id: string; session_id: string; seat_id: string;
  status: 'creating_payment' | 'pending_payment' | 'paid' | 'canceled' | 'expired' | 'payment_review' | 'refunded';
  total_minor: number; currency: 'RUB'; created_at: string; expires_at: string | null; payment: Payment; ticket_id: string | null;
}
export interface OrderPricing {
  order_id: string; seat_price_minor: number; catalog_price_minor?: number; demo_discount_minor?: number; service_fee_minor: number; insurance_upsell_minor: number;
  total_minor: number; currency: 'RUB'; zero_hidden_fees: boolean; refund_policy_ru: string;
  can_cancel_unpaid_hold: boolean; session_starts_at: string;
}
export interface CreateOrderRequest { session_id: string; seat_id: string; customer_email: string }
export type CreateOrder = CreateOrderRequest;
export interface CreateOrderResponse { order: Order; access_token: string }
export interface Ticket {
  id: string; order_id: string; film_title: string; cinema_name: string; hall_name: string;
  starts_at: string; timezone: string; row: number; number: number; seat_type: 'standard' | 'sofa';
  paid_minor: number; currency: 'RUB'; status: 'valid' | 'suspended' | 'revoked';
  verification_url: string; issued_at: string;
}
