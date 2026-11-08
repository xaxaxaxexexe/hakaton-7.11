"""Atomic order reservation, idempotency, payment state transitions, and ticket repository."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import sqlite3
from typing import Any, Literal
import uuid

from app.db.connection import Database, utc_now, utc_now_iso
from app.domain.enums import (
    OrderStatus,
    ProviderPaymentStatus,
    SeatStatus,
    SeatType,
    TicketStatus,
)
from app.domain.models import Order, Payment, Ticket
from app.errors import (
    idempotency_conflict_error,
    not_found_error,
    seat_unavailable_error,
    session_started_error,
    validation_error,
)
from app.security import TokenManager


@dataclass(slots=True)
class StoredOrderRecord:
    order: Order
    token_nonce: str
    customer_id: str
    customer_email: str
    last_reconciled_at: str | None
    provider_request_sent: bool
    requested_amount_minor: int
    catalog_price_minor: int
    provider_response: dict[str, Any] | None


@dataclass(slots=True)
class ReservationOutcome:
    record: StoredOrderRecord
    replayed: bool
    needs_provider_call: bool


@dataclass(slots=True)
class PaymentEventRow:
    id: str
    provider: str
    provider_transaction_id: str
    payload_order_id: str | None
    event_status: str
    amount_minor: int | None
    currency: str | None
    refund_id: str | None
    refund_status: str | None
    refunded_amount_minor: int | None
    processing_status: str


class BookingRepository:
    def __init__(self, db: Database, token_manager: TokenManager, public_app_url: str, *, demo_checkout_minor: int = 0) -> None:
        if demo_checkout_minor not in (0, 100):
            raise ValueError("Invalid demo checkout amount")
        self._demo_checkout_minor = demo_checkout_minor
        self._db = db
        self._tokens = token_manager
        self._public_app_url = public_app_url.rstrip("/")
        self._ensure_attempt_columns()

    def _ensure_attempt_columns(self) -> None:
        with self._db.immediate_transaction() as conn:
            order_cols = {str(r["name"]) for r in conn.execute("PRAGMA table_info(orders);")}
            if "catalog_price_minor" not in order_cols:
                conn.execute("ALTER TABLE orders ADD COLUMN catalog_price_minor INTEGER;")
            cols = {
                str(r["name"])
                for r in conn.execute("PRAGMA table_info(payment_attempts);").fetchall()
            }
            if "request_sent" not in cols:
                conn.execute(
                    "ALTER TABLE payment_attempts ADD COLUMN request_sent INTEGER NOT NULL DEFAULT 0;"
                )
            if "qr_url" not in cols:
                conn.execute("ALTER TABLE payment_attempts ADD COLUMN qr_url TEXT;")

    def create_or_replay_reservation(
        self,
        *,
        idem_key: str,
        request_hash: str,
        session_id: str,
        seat_id: str,
        customer_email: str,
        provider_name: Literal["mock", "platega"],
    ) -> ReservationOutcome:
        """Atomically reserves the seat and stores the order + Idempotency-Key in BEGIN IMMEDIATE."""
        normalized_email = customer_email.strip().lower()
        customer_id = self._tokens.derive_customer_id(normalized_email)
        now = utc_now()
        now_iso = now.isoformat().replace("+00:00", "Z")

        with self._db.immediate_transaction() as conn:
            existing_idem = conn.execute(
                "SELECT request_hash, order_id FROM idempotency_keys WHERE idem_key = ?;",
                (idem_key,),
            ).fetchone()
            if existing_idem is not None:
                if str(existing_idem["request_hash"]) != request_hash:
                    raise idempotency_conflict_error()
                existing_record = self._fetch_order_record_in_tx(conn, str(existing_idem["order_id"]))
                if existing_record is None:
                    raise not_found_error("Связанный заказ не найден.")
                # Retry provider creation ONLY if order is still creating_payment AND request was never sent
                should_retry_provider = (
                    existing_record.order.status == OrderStatus.CREATING_PAYMENT
                    and not existing_record.provider_request_sent
                )
                return ReservationOutcome(
                    record=existing_record,
                    replayed=True,
                    needs_provider_call=should_retry_provider,
                )

            sess_row = conn.execute(
                "SELECT id, hall_id, starts_at FROM sessions WHERE id = ?;",
                (session_id,),
            ).fetchone()
            if sess_row is None:
                raise not_found_error("Матч не найден.")

            starts_dt = datetime.fromisoformat(str(sess_row["starts_at"]).replace("Z", "+00:00"))
            if starts_dt <= now:
                raise session_started_error()

            seat_row = conn.execute(
                """
                SELECT status, price_minor, currency
                FROM session_seats
                WHERE session_id = ? AND seat_id = ?;
                """,
                (session_id, seat_id),
            ).fetchone()
            if seat_row is None:
                raise validation_error("Указанное место не принадлежит этому сектору.")

            if str(seat_row["status"]) != SeatStatus.AVAILABLE.value:
                raise seat_unavailable_error()

            catalog_price_minor = int(seat_row["price_minor"])
            price_minor = min(catalog_price_minor, self._demo_checkout_minor) if self._demo_checkout_minor else catalog_price_minor
            order_id = str(uuid.uuid4())
            attempt_id = str(uuid.uuid4())
            token_nonce = self._tokens.generate_nonce()

            conn.execute(
                """
                INSERT INTO customers (id, email_normalized, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(email_normalized) DO NOTHING;
                """,
                (customer_id, normalized_email, now_iso),
            )
            cust_row = conn.execute(
                "SELECT id FROM customers WHERE email_normalized = ?;",
                (normalized_email,),
            ).fetchone()
            effective_customer_id = str(cust_row["id"]) if cust_row else customer_id

            conn.execute(
                """
                INSERT INTO orders (
                    id, session_id, seat_id, customer_id, customer_email,
                    status, total_minor, currency, token_nonce, provider,
                    created_at, updated_at, expires_at, last_reconciled_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'RUB', ?, ?, ?, ?, NULL, NULL);
                """,
                (
                    order_id,
                    session_id,
                    seat_id,
                    effective_customer_id,
                    customer_email.strip(),
                    OrderStatus.CREATING_PAYMENT.value,
                    price_minor,
                    token_nonce,
                    provider_name,
                    now_iso,
                    now_iso,
                ),
            )

            conn.execute("UPDATE orders SET catalog_price_minor=? WHERE id=?", (catalog_price_minor, order_id))

            cur = conn.execute(
                """
                UPDATE session_seats
                SET status = ?, active_order_id = ?, updated_at = ?
                WHERE session_id = ? AND seat_id = ? AND status = ?;
                """,
                (
                    SeatStatus.HELD.value,
                    order_id,
                    now_iso,
                    session_id,
                    seat_id,
                    SeatStatus.AVAILABLE.value,
                ),
            )
            if cur.rowcount != 1:
                raise seat_unavailable_error()

            conn.execute(
                """
                INSERT INTO payment_attempts (
                    id, order_id, provider, provider_transaction_id, status,
                    payment_url, amount_minor, currency, expires_at,
                    raw_response_json, created_at, updated_at, request_sent
                )
                VALUES (?, ?, ?, NULL, ?, NULL, ?, 'RUB', NULL, NULL, ?, ?, 0);
                """,
                (
                    attempt_id,
                    order_id,
                    provider_name,
                    ProviderPaymentStatus.CREATING.value,
                    price_minor,
                    now_iso,
                    now_iso,
                ),
            )

            conn.execute(
                """
                INSERT INTO idempotency_keys (idem_key, request_hash, order_id, created_at)
                VALUES (?, ?, ?, ?);
                """,
                (idem_key, request_hash, order_id, now_iso),
            )

            record = self._fetch_order_record_in_tx(conn, order_id)
            assert record is not None
            return ReservationOutcome(
                record=record,
                replayed=False,
                needs_provider_call=True,
            )

    def claim_provider_request(self, order_id: str) -> bool:
        """Durably claim dispatch BEFORE network I/O; concurrent retries may never both POST."""
        with self._db.immediate_transaction() as conn:
            cur = conn.execute(
                """UPDATE payment_attempts SET request_sent = 1, updated_at = ?
                   WHERE order_id = ? AND request_sent = 0 AND provider_transaction_id IS NULL
                   AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'creating_payment');""",
                (utc_now_iso(), order_id, order_id),
            )
            return cur.rowcount == 1

    def reset_definitely_unsent_request(self, order_id: str) -> None:
        """Only use after a proven pre-dispatch failure or an explicit provider rejection."""
        with self._db.immediate_transaction() as conn:
            conn.execute(
                """UPDATE payment_attempts SET request_sent = 0, updated_at = ?
                   WHERE order_id = ? AND provider_transaction_id IS NULL
                   AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'creating_payment');""",
                (utc_now_iso(), order_id, order_id),
            )

    def _apply_provider_quote_in_tx(self, conn: sqlite3.Connection, record: StoredOrderRecord, transaction_id: str, amount_minor: int, currency: str | None) -> bool:
        """Persist the authenticated creation quote, keeping the original seat tariff in the attempt."""
        order = record.order
        if (
            order.status not in (OrderStatus.CREATING_PAYMENT, OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW)
            or order.ticket_id is not None
            or order.payment.status in (ProviderPaymentStatus.DISPUTED, ProviderPaymentStatus.PARTIALLY_REFUNDED, ProviderPaymentStatus.CHARGEBACKED)
            or (order.payment.transaction_id and order.payment.transaction_id != transaction_id)
            or not record.provider_request_sent
            or isinstance(amount_minor, bool) or not isinstance(amount_minor, int)
            or amount_minor < record.requested_amount_minor or currency != order.currency
        ):
            return False
        if order.total_minor != amount_minor:
            conn.execute("UPDATE orders SET total_minor = ?, updated_at = ? WHERE id = ?;", (amount_minor, utc_now_iso(), order.id))
        return True

    def restore_provider_quote(self, order_id: str, transaction_id: str, amount_minor: int, currency: str) -> StoredOrderRecord:
        with self._db.immediate_transaction() as conn:
            record = self._fetch_order_record_in_tx(conn, order_id)
            if record is None:
                raise not_found_error("Заказ не найден.")
            if record.order.payment.transaction_id == transaction_id:
                self._apply_provider_quote_in_tx(conn, record, transaction_id, amount_minor, currency)
            return self._fetch_order_record_in_tx(conn, order_id) or record

    def mark_provider_payment_created(
        self,
        *,
        order_id: str,
        transaction_id: str,
        payment_url: str,
        provider_status: ProviderPaymentStatus,
        expires_at: str | None,
        raw_response: dict[str, Any] | None = None,
        quoted_amount_minor: int | None = None,
        quoted_currency: str | None = None,
    ) -> StoredOrderRecord:
        now_iso = utc_now_iso()
        raw_json = json.dumps(raw_response, ensure_ascii=False) if raw_response is not None else None

        with self._db.immediate_transaction() as conn:
            current = self._fetch_order_record_in_tx(conn, order_id)
            if current is None:
                raise not_found_error("Заказ не найден.")
            if current.order.payment.transaction_id and current.order.payment.transaction_id != transaction_id:
                # A callback may have won the race. Never overwrite an already verified binding.
                if current.order.status not in (OrderStatus.PAID, OrderStatus.REFUNDED):
                    conn.execute("UPDATE orders SET status = 'payment_review', updated_at = ? WHERE id = ?;", (now_iso, order_id))
                return self._fetch_order_record_in_tx(conn, order_id) or current

            if quoted_amount_minor is not None:
                self._apply_provider_quote_in_tx(conn, current, transaction_id, quoted_amount_minor, quoted_currency)

            # A verified callback may bind any status before the POST response arrives.
            # A late creation response is metadata only, never a newer payment state.
            if current.order.payment.transaction_id or current.order.status in (OrderStatus.PAID, OrderStatus.REFUNDED):
                conn.execute(
                    """
                    UPDATE payment_attempts
                    SET payment_url = COALESCE(payment_url, ?),
                        provider_transaction_id = COALESCE(provider_transaction_id, ?),
                        expires_at = COALESCE(expires_at, ?),
                        request_sent = 1,
                        updated_at = ?
                    WHERE order_id = ?;
                    """,
                    (payment_url, transaction_id, expires_at, now_iso, order_id),
                )
                conn.execute(
                    """
                    UPDATE orders
                    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
                    WHERE id = ?;
                    """,
                    (expires_at, now_iso, order_id),
                )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated

            next_order_status = (
                OrderStatus.PENDING_PAYMENT
                if provider_status in (ProviderPaymentStatus.PENDING, ProviderPaymentStatus.CREATING)
                else OrderStatus.PAYMENT_REVIEW
            )
            conn.execute(
                """
                UPDATE payment_attempts
                SET provider_transaction_id = ?,
                    status = ?,
                    payment_url = ?,
                    expires_at = ?,
                    raw_response_json = COALESCE(?, raw_response_json),
                    request_sent = 1,
                    updated_at = ?
                WHERE order_id = ?;
                """,
                (
                    transaction_id,
                    provider_status.value,
                    payment_url,
                    expires_at,
                    raw_json,
                    now_iso,
                    order_id,
                ),
            )
            conn.execute(
                """
                UPDATE orders
                SET status = ?, expires_at = ?, updated_at = ?
                WHERE id = ?;
                """,
                (next_order_status.value, expires_at, now_iso, order_id),
            )
            updated = self._fetch_order_record_in_tx(conn, order_id)
            assert updated is not None
            return updated

    def mark_provider_timeout_ambiguous(
        self,
        *,
        order_id: str,
        error_note: str,
    ) -> StoredOrderRecord:
        """POST /transaction/process timed out or dropped after send: keep hold, set payment_review, forbid blind retry."""
        now_iso = utc_now_iso()
        with self._db.immediate_transaction() as conn:
            current = self._fetch_order_record_in_tx(conn, order_id)
            if current is None:
                raise not_found_error("Заказ не найден.")
            if current.order.payment.transaction_id or current.order.status in (OrderStatus.PAID, OrderStatus.REFUNDED):
                return current

            conn.execute(
                """
                UPDATE payment_attempts
                SET status = ?,
                    raw_response_json = ?,
                    request_sent = 1,
                    updated_at = ?
                WHERE order_id = ?;
                """,
                (
                    ProviderPaymentStatus.UNKNOWN.value,
                    json.dumps({"ambiguous_error": error_note}, ensure_ascii=False),
                    now_iso,
                    order_id,
                ),
            )
            conn.execute(
                """
                UPDATE orders
                SET status = ?, updated_at = ?
                WHERE id = ?;
                """,
                (OrderStatus.PAYMENT_REVIEW.value, now_iso, order_id),
            )
            updated = self._fetch_order_record_in_tx(conn, order_id)
            assert updated is not None
            return updated

    def get_order_record(self, order_id: str) -> StoredOrderRecord | None:
        with self._db.read_connection() as conn:
            return self._fetch_order_record_in_tx(conn, order_id)

    def find_order_by_transaction_or_payload(
        self,
        *,
        transaction_id: str,
        payload_order_id: str | None,
    ) -> StoredOrderRecord | None:
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT order_id FROM payment_attempts WHERE provider_transaction_id = ?;",
                (transaction_id,),
            ).fetchone()
            if row is not None:
                return self._fetch_order_record_in_tx(conn, str(row["order_id"]))
            if payload_order_id:
                return self._fetch_order_record_in_tx(conn, payload_order_id)
            return None

    def save_payment_event(
        self,
        *,
        provider: str,
        transaction_id: str,
        payload_order_id: str | None,
        event_status: str,
        amount_minor: int | None,
        currency: str | None,
        refund_id: str | None,
        refund_status: str | None,
        refunded_amount_minor: int | None,
        raw_payload: dict[str, Any],
    ) -> tuple[str, bool]:
        """Persists incoming authenticated callback event before verification. Returns (event_id, already_processed)."""
        dedup_parts = [
            provider,
            transaction_id,
            event_status.strip().upper(),
            str(refund_id or ""),
            str(refund_status or ""),
            str(refunded_amount_minor if refunded_amount_minor is not None else ""),
        ]
        dedup_key = "|".join(dedup_parts)
        now_iso = utc_now_iso()
        event_id = str(uuid.uuid4())
        raw_json = json.dumps(raw_payload, ensure_ascii=False, sort_keys=True)

        with self._db.immediate_transaction() as conn:
            existing = conn.execute(
                "SELECT id, processing_status FROM payment_events WHERE event_dedup_key = ?;",
                (dedup_key,),
            ).fetchone()
            if existing is not None:
                already_done = str(existing["processing_status"]) in (
                    "processed",
                    "ignored_unknown_order",
                )
                return str(existing["id"]), already_done

            conn.execute(
                """
                INSERT INTO payment_events (
                    id, event_dedup_key, provider, provider_transaction_id, payload_order_id,
                    event_status, amount_minor, currency, refund_id, refund_status,
                    refunded_amount_minor, raw_json, processing_status, error_note,
                    received_at, processed_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL);
                """,
                (
                    event_id,
                    dedup_key,
                    provider,
                    transaction_id,
                    payload_order_id,
                    event_status,
                    amount_minor,
                    currency,
                    refund_id,
                    refund_status,
                    refunded_amount_minor,
                    raw_json,
                    now_iso,
                ),
            )
            return event_id, False

    def update_payment_event_status(
        self,
        event_id: str,
        processing_status: str,
        *,
        error_note: str | None = None,
    ) -> None:
        now_iso = utc_now_iso()
        processed_at = now_iso if processing_status != "retry_pending" else None
        with self._db.immediate_transaction() as conn:
            conn.execute(
                """
                UPDATE payment_events
                SET processing_status = ?, error_note = ?, processed_at = ?
                WHERE id = ?;
                """,
                (processing_status, error_note, processed_at, event_id),
            )

    def list_pending_events(self, limit: int = 50) -> list[PaymentEventRow]:
        with self._db.read_connection() as conn:
            rows = conn.execute(
                """
                SELECT id, provider, provider_transaction_id, payload_order_id,
                       event_status, amount_minor, currency, refund_id,
                       refund_status, refunded_amount_minor, processing_status
                FROM payment_events
                WHERE processing_status IN ('pending', 'retry_pending')
                ORDER BY received_at ASC
                LIMIT ?;
                """,
                (limit,),
            ).fetchall()
        return [
            PaymentEventRow(
                id=str(r["id"]),
                provider=str(r["provider"]),
                provider_transaction_id=str(r["provider_transaction_id"]),
                payload_order_id=r["payload_order_id"],
                event_status=str(r["event_status"]),
                amount_minor=int(r["amount_minor"]) if r["amount_minor"] is not None else None,
                currency=r["currency"],
                refund_id=r["refund_id"],
                refund_status=r["refund_status"],
                refunded_amount_minor=(
                    int(r["refunded_amount_minor"]) if r["refunded_amount_minor"] is not None else None
                ),
                processing_status=str(r["processing_status"]),
            )
            for r in rows
        ]

    def list_orders_needing_reconciliation(self, limit: int = 50) -> list[StoredOrderRecord]:
        with self._db.read_connection() as conn:
            rows = conn.execute(
                """
                SELECT id
                FROM orders
                WHERE status IN ('creating_payment', 'pending_payment', 'payment_review', 'paid')
                ORDER BY COALESCE(last_reconciled_at, created_at) ASC, id ASC
                LIMIT ?;
                """,
                (limit,),
            ).fetchall()
            records: list[StoredOrderRecord] = []
            for r in rows:
                rec = self._fetch_order_record_in_tx(conn, str(r["id"]))
                if rec is not None:
                    records.append(rec)
            return records

    def touch_order_reconciled(self, order_id: str) -> None:
        now_iso = utc_now_iso()
        with self._db.immediate_transaction() as conn:
            conn.execute(
                "UPDATE orders SET last_reconciled_at = ? WHERE id = ?;",
                (now_iso, order_id),
            )

    def release_abandoned_unsent_order(self, order_id: str) -> tuple[bool, str | None, str | None]:
        """Releases a hold ONLY if provider request was NEVER sent (request_sent=0) and order is stale."""
        now_iso = utc_now_iso()
        with self._db.immediate_transaction() as conn:
            rec = self._fetch_order_record_in_tx(conn, order_id)
            if rec is None:
                return False, None, None
            if rec.provider_request_sent or rec.order.status != OrderStatus.CREATING_PAYMENT:
                return False, None, None
            conn.execute(
                "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?;",
                (OrderStatus.EXPIRED.value, now_iso, order_id),
            )
            conn.execute(
                "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                (ProviderPaymentStatus.EXPIRED.value, now_iso, order_id),
            )
            conn.execute(
                """
                UPDATE session_seats
                SET status = 'available', active_order_id = NULL, updated_at = ?
                WHERE session_id = ? AND seat_id = ? AND active_order_id = ? AND status = 'held';
                """,
                (now_iso, rec.order.session_id, rec.order.seat_id, order_id),
            )
            return True, rec.order.session_id, rec.order.seat_id

    def mark_order_payment_review(
        self,
        order_id: str,
        *,
        provider_status: ProviderPaymentStatus | None = None,
        note: str | None = None,
    ) -> StoredOrderRecord:
        now_iso = utc_now_iso()
        with self._db.immediate_transaction() as conn:
            rec = self._fetch_order_record_in_tx(conn, order_id)
            if rec is None:
                raise not_found_error("Заказ не найден.")
            # Never downgrade an already paid/refunded order due to a bogus/mismatched callback
            if rec.order.status in (OrderStatus.PAID, OrderStatus.REFUNDED):
                return rec
            conn.execute(
                "UPDATE orders SET status = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?;",
                (OrderStatus.PAYMENT_REVIEW.value, now_iso, now_iso, order_id),
            )
            if provider_status is not None:
                conn.execute(
                    "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                    (provider_status.value, now_iso, order_id),
                )
            updated = self._fetch_order_record_in_tx(conn, order_id)
            assert updated is not None
            return updated

    def apply_verified_provider_state(
        self,
        *,
        order_id: str,
        transaction_id: str,
        provider_status: ProviderPaymentStatus,
        verified_amount_minor: int,
        verified_currency: str,
        refunded_amount_minor: int | None = None,
        refund_confirmed: bool = False,
        qr_url: str | None = None,
    ) -> tuple[StoredOrderRecord, str | None]:
        """Single atomic handler called by BOTH webhook callbacks and status polling/reconciliation.

        Returns `(updated_record, seat_changed_status_or_none)`.
        """
        now_iso = utc_now_iso()

        with self._db.immediate_transaction() as conn:
            rec = self._fetch_order_record_in_tx(conn, order_id)
            if rec is None:
                raise not_found_error("Заказ не найден.")

            order = rec.order
            existing_tx = order.payment.transaction_id
            if existing_tx and existing_tx != transaction_id:
                # Conflicting transaction ID for an already bound order -> flag review unless already paid
                if order.status not in (OrderStatus.PAID, OrderStatus.REFUNDED):
                    conn.execute(
                        "UPDATE orders SET status = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?;",
                        (OrderStatus.PAYMENT_REVIEW.value, now_iso, now_iso, order_id),
                    )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, None

            # Verify currency & exact amount in kopeks
            if verified_currency.upper() != order.currency or verified_amount_minor != order.total_minor:
                if order.status not in (OrderStatus.PAID, OrderStatus.REFUNDED):
                    conn.execute(
                        "UPDATE orders SET status = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?;",
                        (OrderStatus.PAYMENT_REVIEW.value, now_iso, now_iso, order_id),
                    )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, None

            # Bind transaction_id if order was recovering from a lost create response
            conn.execute(
                """
                UPDATE payment_attempts
                SET provider_transaction_id = COALESCE(provider_transaction_id, ?),
                    qr_url = ?,
                    request_sent = 1,
                    updated_at = ?
                WHERE order_id = ?;
                """,
                (transaction_id, qr_url, now_iso, order_id),
            )

            existing_ticket_row = conn.execute(
                "SELECT id, status FROM tickets WHERE order_id = ?;",
                (order_id,),
            ).fetchone()

            # Check full refund via refund metadata even if top-level status was CONFIRMED/PARTIALLY_REFUNDED
            effective_status = provider_status
            if refund_confirmed and refunded_amount_minor is not None:
                if refunded_amount_minor >= order.total_minor:
                    effective_status = ProviderPaymentStatus.CHARGEBACKED
                elif refunded_amount_minor > 0 and effective_status == ProviderPaymentStatus.CONFIRMED:
                    effective_status = ProviderPaymentStatus.PARTIALLY_REFUNDED

            # A successful partial refund cannot be undone by a stale CONFIRMED poll.
            # Disputes may resolve to CONFIRMED; partial refunds require manual resolution.
            if order.payment.status == ProviderPaymentStatus.PARTIALLY_REFUNDED and effective_status != ProviderPaymentStatus.CHARGEBACKED:
                effective_status = ProviderPaymentStatus.PARTIALLY_REFUNDED

            # 1. CONFIRMED -> issue at most ONE ticket, transition seat to SOLD
            if effective_status == ProviderPaymentStatus.CONFIRMED:
                if order.status == OrderStatus.REFUNDED:
                    # Do not resurrect a fully refunded order
                    return rec, None

                seat_row = conn.execute(
                    """
                    SELECT status, active_order_id
                    FROM session_seats
                    WHERE session_id = ? AND seat_id = ?;
                    """,
                    (order.session_id, order.seat_id),
                ).fetchone()
                if seat_row is None:
                    raise not_found_error("Место на этом матче не найдено.")

                seat_owner = seat_row["active_order_id"]
                seat_curr_status = str(seat_row["status"])

                # Conflict guard: if seat was somehow sold/held to a DIFFERENT order, never issue 2nd ticket!
                if seat_owner is not None and str(seat_owner) != order_id:
                    conn.execute(
                        """
                        UPDATE orders
                        SET status = ?, last_reconciled_at = ?, updated_at = ?
                        WHERE id = ?;
                        """,
                        (OrderStatus.PAYMENT_REVIEW.value, now_iso, now_iso, order_id),
                    )
                    conn.execute(
                        "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                        (ProviderPaymentStatus.CONFIRMED.value, now_iso, order_id),
                    )
                    updated = self._fetch_order_record_in_tx(conn, order_id)
                    assert updated is not None
                    return updated, None

                if seat_curr_status == SeatStatus.SOLD.value and seat_owner != order_id:
                    conn.execute(
                        """
                        UPDATE orders
                        SET status = ?, last_reconciled_at = ?, updated_at = ?
                        WHERE id = ?;
                        """,
                        (OrderStatus.PAYMENT_REVIEW.value, now_iso, now_iso, order_id),
                    )
                    updated = self._fetch_order_record_in_tx(conn, order_id)
                    assert updated is not None
                    return updated, None

                seat_changed: str | None = None
                if seat_curr_status != SeatStatus.SOLD.value:
                    conn.execute(
                        """
                        UPDATE session_seats
                        SET status = 'sold', active_order_id = ?, updated_at = ?
                        WHERE session_id = ? AND seat_id = ?;
                        """,
                        (order_id, now_iso, order.session_id, order.seat_id),
                    )
                    seat_changed = SeatStatus.SOLD.value

                if existing_ticket_row is None:
                    self._issue_ticket_in_tx(conn, order_id=order_id, paid_minor=order.total_minor, now_iso=now_iso)
                elif str(existing_ticket_row["status"]) == TicketStatus.SUSPENDED.value:
                    # Dispute resolved back to CONFIRMED -> restore valid ticket
                    conn.execute(
                        "UPDATE tickets SET status = 'valid', updated_at = ? WHERE order_id = ?;",
                        (now_iso, order_id),
                    )

                conn.execute(
                    "UPDATE payment_attempts SET status = 'CONFIRMED', updated_at = ? WHERE order_id = ?;",
                    (now_iso, order_id),
                )
                conn.execute(
                    """
                    UPDATE orders
                    SET status = 'paid', last_reconciled_at = ?, updated_at = ?
                    WHERE id = ?;
                    """,
                    (now_iso, now_iso, order_id),
                )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, seat_changed

            # 2. CANCELED / EXPIRED / FAILED -> NEVER rollback paid/refunded or existing ticket!
            if effective_status in (
                ProviderPaymentStatus.CANCELED,
                ProviderPaymentStatus.EXPIRED,
                ProviderPaymentStatus.FAILED,
            ):
                if order.status in (OrderStatus.PAID, OrderStatus.REFUNDED) or existing_ticket_row is not None:
                    conn.execute(
                        "UPDATE orders SET last_reconciled_at = ? WHERE id = ?;",
                        (now_iso, order_id),
                    )
                    updated = self._fetch_order_record_in_tx(conn, order_id)
                    assert updated is not None
                    return updated, None

                target_order_status = (
                    OrderStatus.EXPIRED
                    if effective_status == ProviderPaymentStatus.EXPIRED
                    else OrderStatus.CANCELED
                )
                conn.execute(
                    "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                    (effective_status.value, now_iso, order_id),
                )
                conn.execute(
                    "UPDATE orders SET status = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?;",
                    (target_order_status.value, now_iso, now_iso, order_id),
                )
                cur = conn.execute(
                    """
                    UPDATE session_seats
                    SET status = 'available', active_order_id = NULL, updated_at = ?
                    WHERE session_id = ? AND seat_id = ? AND active_order_id = ? AND status = 'held';
                    """,
                    (now_iso, order.session_id, order.seat_id, order_id),
                )
                seat_changed = SeatStatus.AVAILABLE.value if cur.rowcount > 0 else None
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, seat_changed

            # 3. DISPUTED / PARTIALLY_REFUNDED -> order=payment_review, ticket=suspended, seat stays sold
            if effective_status in (
                ProviderPaymentStatus.DISPUTED,
                ProviderPaymentStatus.PARTIALLY_REFUNDED,
            ):
                if order.status != OrderStatus.REFUNDED:
                    conn.execute(
                        "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                        (effective_status.value, now_iso, order_id),
                    )
                    conn.execute(
                        """
                        UPDATE orders
                        SET status = 'payment_review', last_reconciled_at = ?, updated_at = ?
                        WHERE id = ?;
                        """,
                        (now_iso, now_iso, order_id),
                    )
                    if existing_ticket_row is not None and str(existing_ticket_row["status"]) != TicketStatus.REVOKED.value:
                        conn.execute(
                            "UPDATE tickets SET status = 'suspended', updated_at = ? WHERE order_id = ?;",
                            (now_iso, order_id),
                        )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, None

            # 4. CHARGEBACKED (Full confirmed refund) -> order=refunded, ticket=revoked, seat remains sold
            if effective_status == ProviderPaymentStatus.CHARGEBACKED:
                conn.execute(
                    "UPDATE payment_attempts SET status = 'CHARGEBACKED', updated_at = ? WHERE order_id = ?;",
                    (now_iso, order_id),
                )
                conn.execute(
                    """
                    UPDATE orders
                    SET status = 'refunded', last_reconciled_at = ?, updated_at = ?
                    WHERE id = ?;
                    """,
                    (now_iso, now_iso, order_id),
                )
                if existing_ticket_row is not None:
                    conn.execute(
                        "UPDATE tickets SET status = 'revoked', updated_at = ? WHERE order_id = ?;",
                        (now_iso, order_id),
                    )
                updated = self._fetch_order_record_in_tx(conn, order_id)
                assert updated is not None
                return updated, None

            # 5. PENDING / CREATING / UNKNOWN
            if order.status not in (OrderStatus.PAID, OrderStatus.REFUNDED):
                if effective_status == ProviderPaymentStatus.UNKNOWN:
                    conn.execute(
                        """
                        UPDATE orders
                        SET status = 'payment_review', last_reconciled_at = ?, updated_at = ?
                        WHERE id = ?;
                        """,
                        (now_iso, now_iso, order_id),
                    )
                else:
                    conn.execute(
                        "UPDATE orders SET last_reconciled_at = ?, status = CASE WHEN ? THEN 'pending_payment' ELSE status END WHERE id = ?;",
                        (now_iso, effective_status == ProviderPaymentStatus.PENDING and existing_ticket_row is None and order.status in (OrderStatus.CREATING_PAYMENT, OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW), order_id),
                    )
                conn.execute(
                    "UPDATE payment_attempts SET status = ?, updated_at = ? WHERE order_id = ?;",
                    (effective_status.value, now_iso, order_id),
                )

            updated = self._fetch_order_record_in_tx(conn, order_id)
            assert updated is not None
            return updated, None

    def get_ticket_by_order_id(self, order_id: str) -> Ticket | None:
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM tickets WHERE order_id = ?;",
                (order_id,),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_ticket(row)

    def get_ticket_by_qr_token(self, raw_qr_token: str) -> Ticket | None:
        token_hash = self._tokens.hash_ticket_token(raw_qr_token)
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM tickets WHERE token_hash = ?;",
                (token_hash,),
            ).fetchone()
        if row is None:
            return None
        return self._row_to_ticket(row)

    def _issue_ticket_in_tx(
        self,
        conn: sqlite3.Connection,
        *,
        order_id: str,
        paid_minor: int,
        now_iso: str,
    ) -> None:
        details = conn.execute(
            """
            SELECT
                o.session_id, o.seat_id,
                s.starts_at, s.hall_id,
                m.title AS film_title,
                c.name AS cinema_name, c.timezone AS cinema_timezone,
                h.name AS hall_name,
                hs.row_num, hs.seat_number, hs.seat_type
            FROM orders o
            JOIN sessions s ON s.id = o.session_id
            JOIN movies m ON m.id = s.movie_id
            JOIN cinemas c ON c.id = s.cinema_id
            JOIN halls h ON h.id = s.hall_id
            JOIN hall_seats hs ON hs.hall_id = s.hall_id AND hs.seat_id = o.seat_id
            WHERE o.id = ?;
            """,
            (order_id,),
        ).fetchone()
        if details is None:
            raise not_found_error("Данные матча или места для выпуска билета не найдены.")

        ticket_id = str(uuid.uuid4())
        qr_token, token_hash = self._tokens.generate_ticket_token()
        conn.execute(
            """
            INSERT INTO tickets (
                id, order_id, token_hash, qr_token,
                film_title, cinema_name, hall_name, starts_at, timezone,
                row_num, seat_number, seat_type,
                paid_minor, currency, status, issued_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUB', 'valid', ?, ?)
            ON CONFLICT(order_id) DO NOTHING;
            """,
            (
                ticket_id,
                order_id,
                token_hash,
                qr_token,
                str(details["film_title"]),
                str(details["cinema_name"]),
                str(details["hall_name"]),
                str(details["starts_at"]),
                str(details["cinema_timezone"]),
                int(details["row_num"]),
                int(details["seat_number"]),
                str(details["seat_type"]),
                paid_minor,
                now_iso,
                now_iso,
            ),
        )

    def _fetch_order_record_in_tx(
        self,
        conn: sqlite3.Connection,
        order_id: str,
    ) -> StoredOrderRecord | None:
        row = conn.execute(
            """
            SELECT
                o.id, o.session_id, o.seat_id, o.customer_id, o.customer_email,
                o.status, o.total_minor, o.currency, o.token_nonce, o.provider,
                o.created_at, o.expires_at, o.last_reconciled_at, o.catalog_price_minor,
                pa.status AS payment_status,
                pa.payment_url AS payment_url,
                pa.qr_url AS qr_url,
                pa.provider_transaction_id AS transaction_id,
                pa.request_sent AS request_sent,
                pa.amount_minor AS requested_amount_minor,
                pa.raw_response_json AS provider_response,
                t.id AS ticket_id
            FROM orders o
            LEFT JOIN payment_attempts pa ON pa.order_id = o.id
            LEFT JOIN tickets t ON t.order_id = o.id
            WHERE o.id = ?;
            """,
            (order_id,),
        ).fetchone()
        if row is None:
            return None

        order = Order(
            id=str(row["id"]),
            session_id=str(row["session_id"]),
            seat_id=str(row["seat_id"]),
            status=OrderStatus(str(row["status"])),
            total_minor=int(row["total_minor"]),
            currency="RUB",
            created_at=str(row["created_at"]),
            expires_at=row["expires_at"],
            payment=Payment(
                provider=row["provider"],
                status=ProviderPaymentStatus(str(row["payment_status"] or "CREATING")),
                payment_url=row["payment_url"],
                qr_url=row["qr_url"] if str(row["status"]) == "pending_payment" else None,
                transaction_id=row["transaction_id"],
            ),
            ticket_id=row["ticket_id"],
        )
        return StoredOrderRecord(
            order=order,
            token_nonce=str(row["token_nonce"]),
            customer_id=str(row["customer_id"]),
            customer_email=str(row["customer_email"]),
            last_reconciled_at=row["last_reconciled_at"],
            provider_request_sent=bool(row["request_sent"]),
            requested_amount_minor=int(row["requested_amount_minor"]),
            catalog_price_minor=int(row["catalog_price_minor"] if row["catalog_price_minor"] is not None else row["requested_amount_minor"]),
            provider_response=json.loads(row["provider_response"]) if row["provider_response"] else None,
        )

    def _row_to_ticket(self, row: sqlite3.Row) -> Ticket:
        qr_token = str(row["qr_token"])
        return Ticket(
            id=str(row["id"]),
            order_id=str(row["order_id"]),
            film_title=str(row["film_title"]),
            cinema_name=str(row["cinema_name"]),
            hall_name=str(row["hall_name"]),
            starts_at=str(row["starts_at"]),
            timezone=str(row["timezone"]),
            row=int(row["row_num"]),
            number=int(row["seat_number"]),
            seat_type=SeatType(str(row["seat_type"])),
            paid_minor=int(row["paid_minor"]),
            currency="RUB",
            status=TicketStatus(str(row["status"])),
            verification_url=f"{self._public_app_url}/tickets/{qr_token}",
            issued_at=str(row["issued_at"]),
        )
