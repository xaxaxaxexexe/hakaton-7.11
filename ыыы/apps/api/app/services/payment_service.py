"""Payment callback authentication, verification, and unified reconciliation service."""
from __future__ import annotations

from datetime import datetime, timedelta
import asyncio
import logging
from typing import Any
from weakref import WeakValueDictionary

from app.config import Settings
from app.db.connection import utc_now
from app.domain.enums import (
    OrderStatus,
    ProviderPaymentStatus,
    normalize_provider_status,
)
from app.domain.models import AckResponse, NormalizedCallbackEvent
from app.errors import unauthorized_error, validation_error
from app.providers.base import (
    PaymentProvider,
    ProviderNotFoundError,
    ProviderUnavailableError,
    rub_to_minor_exact,
)
from app.providers.platega import PlategaPaymentProvider, _extract_payment_details
from app.repositories.booking_repo import BookingRepository, StoredOrderRecord
from app.security import verify_platega_headers
from app.services.realtime_service import RealtimeSeatBroker

REFUND_SUCCESS_STATES = frozenset({"SUCCEEDED"})
logger = logging.getLogger("zal.payments")


def _read_aliased_field(
    body: dict[str, Any],
    camel_key: str,
    pascal_key: str,
    *,
    required: bool = False,
) -> Any:
    has_camel = camel_key in body and body[camel_key] is not None
    has_pascal = pascal_key in body and body[pascal_key] is not None
    if has_camel and has_pascal and body[camel_key] != body[pascal_key]:
        raise validation_error(
            f"Конфликтующие значения полей {camel_key} и {pascal_key} в callback."
        )
    if has_camel:
        return body[camel_key]
    if has_pascal:
        return body[pascal_key]
    if required:
        raise validation_error(f"Отсутствует обязательное поле {camel_key} в callback.")
    return None


def parse_and_normalize_callback(body: Any) -> NormalizedCallbackEvent:
    if not isinstance(body, dict):
        raise validation_error("Тело callback должно быть JSON-объектом.")

    tx_id = _read_aliased_field(body, "id", "Id", required=True)
    raw_amount = _read_aliased_field(body, "amount", "Amount", required=True)
    currency = _read_aliased_field(body, "currency", "Currency", required=True)
    status = _read_aliased_field(body, "status", "Status", required=True)
    payment_method = _read_aliased_field(body, "paymentMethod", "PaymentMethod", required=True)
    payload = _read_aliased_field(body, "payload", "Payload", required=True)

    if not isinstance(tx_id, str) or not tx_id.strip():
        raise validation_error("Некорректный идентификатор транзакции в callback.")
    if not isinstance(currency, str) or not currency.strip():
        raise validation_error("Некорректная валюта в callback.")
    if not isinstance(status, str) or not status.strip():
        raise validation_error("Некорректный статус в callback.")
    if not isinstance(payload, str) or not payload.strip():
        raise validation_error("Некорректный payload в callback.")
    if isinstance(payment_method, bool) or not isinstance(payment_method, (int, str)):
        raise validation_error("Некорректный paymentMethod в callback.")

    try:
        amount_minor = rub_to_minor_exact(raw_amount)
    except ValueError as exc:
        raise validation_error("Некорректная сумма платежа в callback.") from exc

    refund_id_raw = _read_aliased_field(body, "refundId", "RefundId", required=False)
    refund_status_raw = _read_aliased_field(body, "refundStatus", "RefundStatus", required=False)
    # The documented callback field is refundAmount (one refund operation).
    refunded_amt_raw = _read_aliased_field(body, "refundAmount", "RefundAmount", required=False)
    legacy_refund_amount = _read_aliased_field(body, "refundedAmount", "RefundedAmount", required=False)
    if refunded_amt_raw is not None and legacy_refund_amount is not None and refunded_amt_raw != legacy_refund_amount:
        raise validation_error("Конфликтующие суммы возврата в callback.")
    if refunded_amt_raw is None:
        refunded_amt_raw = legacy_refund_amount

    refunded_minor: int | None = None
    if refunded_amt_raw is not None:
        try:
            refunded_minor = rub_to_minor_exact(refunded_amt_raw)
        except ValueError as exc:
            raise validation_error("Некорректная сумма возврата в callback.") from exc

    return NormalizedCallbackEvent(
        transaction_id=tx_id.strip(),
        amount_minor=amount_minor,
        currency=currency.strip().upper(),
        status=status.strip(),
        payment_method=str(payment_method),
        payload=payload.strip(),
        refund_id=str(refund_id_raw).strip() if refund_id_raw is not None else None,
        refund_status=str(refund_status_raw).strip() if refund_status_raw is not None else None,
        refunded_amount_minor=refunded_minor,
        raw=body,
    )


class PaymentService:
    def __init__(
        self,
        *,
        settings: Settings,
        booking_repo: BookingRepository,
        provider: PaymentProvider,
        realtime: RealtimeSeatBroker,
    ) -> None:
        self._settings = settings
        self._repo = booking_repo
        self._provider = provider
        self._realtime = realtime
        self._verification_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    def _lock_for(self, order_id: str) -> asyncio.Lock:
        lock = self._verification_locks.get(order_id)
        if lock is None:
            lock = asyncio.Lock()
            self._verification_locks[order_id] = lock
        return lock

    def _restore_creation_quote(self, record: StoredOrderRecord) -> StoredOrderRecord:
        raw = record.provider_response
        tx = record.order.payment.transaction_id
        if record.order.payment.provider != "platega" or not isinstance(raw, dict) or not tx:
            return record
        if str(raw.get("transactionId") or raw.get("id") or "") != tx:
            return record
        try:
            amount, currency = _extract_payment_details(raw.get("paymentDetails"), raw)
        except (ValueError, ProviderUnavailableError):
            return record
        return self._repo.restore_provider_quote(record.order.id, tx, amount, currency)

    async def handle_platega_callback(
        self,
        *,
        merchant_id_header: str | None,
        secret_header: str | None,
        body: Any,
        raw_bytes: bytes,
    ) -> AckResponse:
        if not verify_platega_headers(
            expected_merchant_id=self._settings.platega_merchant_id,
            expected_api_key=self._settings.platega_api_key,
            supplied_merchant_id=merchant_id_header,
            supplied_secret=secret_header,
        ):
            raise unauthorized_error("Неверные заголовки авторизации мерчанта.")

        event = parse_and_normalize_callback(body)
        known_order = self._repo.find_order_by_transaction_or_payload(transaction_id=event.transaction_id, payload_order_id=event.payload)
        if known_order is not None and event.payment_method.strip() != "2":
            raise validation_error("Для этого заказа ожидается платёж СБП (paymentMethod=2).")
        event_id, already_done = self._repo.save_payment_event(
            provider="platega",
            transaction_id=event.transaction_id,
            payload_order_id=event.payload,
            event_status=event.status,
            amount_minor=event.amount_minor,
            currency=event.currency,
            refund_id=event.refund_id,
            refund_status=event.refund_status,
            refunded_amount_minor=event.refunded_amount_minor,
            raw_payload=event.raw,
        )
        if already_done:
            return AckResponse(ok=True)

        await self._verify_and_apply_event(
            event_id=event_id,
            transaction_id=event.transaction_id,
            payload_order_id=event.payload,
            callback_amount_minor=event.amount_minor,
            callback_currency=event.currency,
            callback_refund_status=event.refund_status,
            callback_refunded_minor=event.refunded_amount_minor,
            raw_bytes=raw_bytes,
        )
        return AckResponse(ok=True)

    async def _verify_and_apply_event(self, **event: Any) -> None:
        record = self._repo.find_order_by_transaction_or_payload(transaction_id=event["transaction_id"], payload_order_id=event.get("payload_order_id"))
        key = record.order.id if record is not None else "transaction:" + event["transaction_id"]
        async with self._lock_for(key):
            await self._verify_and_apply_event_unlocked(**event)

    async def _verify_and_apply_event_unlocked(
        self,
        *,
        event_id: str,
        transaction_id: str,
        payload_order_id: str | None,
        callback_amount_minor: int | None,
        callback_currency: str | None,
        callback_refund_status: str | None,
        callback_refunded_minor: int | None,
        raw_bytes: bytes | None = None,
    ) -> None:
        record = self._repo.find_order_by_transaction_or_payload(
            transaction_id=transaction_id,
            payload_order_id=payload_order_id,
        )
        if record is None:
            # Shared merchant callback safety: never create an order from unknown external payload
            if raw_bytes and isinstance(self._provider, PlategaPaymentProvider):
                await self._provider.forward_foreign_callback(raw_bytes)
            self._repo.update_payment_event_status(event_id, "ignored_unknown_order")
            return

        record = self._restore_creation_quote(record)
        order = record.order
        if order.payment.provider != self._provider.name or (not order.payment.transaction_id and not record.provider_request_sent):
            self._repo.update_payment_event_status(event_id, "verification_failed", error_note="Unclaimed or foreign payment attempt")
            return
        # Guard: if callback explicitly claims a different order payload or wrong amount/currency
        if payload_order_id and payload_order_id != order.id:
            self._repo.mark_order_payment_review(order.id, note="payload_mismatch")
            self._repo.update_payment_event_status(
                event_id, "verification_failed", error_note="Callback payload order mismatch"
            )
            return

        if (
            callback_amount_minor is not None and callback_amount_minor not in (order.total_minor, record.requested_amount_minor)
        ) or (
            callback_currency is not None and callback_currency.upper() != order.currency
        ):
            self._repo.mark_order_payment_review(order.id, note="callback_amount_or_currency_mismatch")
            self._repo.update_payment_event_status(
                event_id, "verification_failed", error_note="Callback amount or currency mismatch"
            )
            return

        try:
            snapshot = await self._provider.get_transaction(transaction_id)
        except ProviderUnavailableError as exc:
            # Keep event in local SQLite queue for background worker retry; never issue ticket unverified!
            self._repo.update_payment_event_status(
                event_id, "retry_pending", error_note=str(exc)
            )
            return
        except ProviderNotFoundError:
            self._repo.mark_order_payment_review(order.id, note="provider_tx_not_found")
            self._repo.update_payment_event_status(
                event_id, "verification_failed", error_note="Transaction not found on GET verify"
            )
            return

        if snapshot.transaction_id != transaction_id or snapshot.payload != order.id:
            self._repo.mark_order_payment_review(order.id, note="snapshot_payload_mismatch")
            self._repo.update_payment_event_status(
                event_id, "verification_failed", error_note="Provider GET payload mismatch"
            )
            return

        if snapshot.status == ProviderPaymentStatus.CONFIRMED and order.status == OrderStatus.CREATING_PAYMENT and not record.provider_response:
            self._repo.update_payment_event_status(event_id, "retry_pending", error_note="Awaiting authenticated creation quote")
            return

        # A signed callback is a notification, not a substitute for the authoritative GET.
        # refundAmount is one operation and must never be treated as a cumulative refund total.
        eff_refund_status = snapshot.refund_status
        eff_refunded_minor = snapshot.refunded_amount_minor
        if snapshot.status in (ProviderPaymentStatus.CHARGEBACKED, ProviderPaymentStatus.PARTIALLY_REFUNDED) and eff_refund_status and eff_refund_status.upper() not in REFUND_SUCCESS_STATES:
            self._repo.update_payment_event_status(event_id, "retry_pending", error_note="Conflicting refund result on provider GET")
            return
        refund_confirmed = bool(
            eff_refund_status and eff_refund_status.strip().upper() in REFUND_SUCCESS_STATES
        ) or (
            snapshot.status
            in (ProviderPaymentStatus.CHARGEBACKED, ProviderPaymentStatus.PARTIALLY_REFUNDED)
        )

        updated_record, seat_changed = self._repo.apply_verified_provider_state(
            order_id=order.id,
            transaction_id=snapshot.transaction_id,
            provider_status=snapshot.status,
            verified_amount_minor=snapshot.amount_minor,
            verified_currency=snapshot.currency,
            refunded_amount_minor=eff_refunded_minor,
            qr_url=snapshot.qr_url,
            refund_confirmed=refund_confirmed,
        )
        self._repo.update_payment_event_status(event_id, "processed")

        if seat_changed is not None:
            self._realtime.publish_seat_change(
                session_id=updated_record.order.session_id,
                seat_id=updated_record.order.seat_id,
                status=seat_changed,
            )

    async def reconcile_order(self, record: StoredOrderRecord, *, force: bool = False, min_interval_seconds: float = 2.5) -> StoredOrderRecord:
        async with self._lock_for(record.order.id):
            current = self._repo.get_order_record(record.order.id) or record
            return await self._reconcile_order_unlocked(current, force=force, min_interval_seconds=min_interval_seconds)

    async def _reconcile_order_unlocked(
        self,
        record: StoredOrderRecord,
        *,
        force: bool = False,
        min_interval_seconds: float = 2.5,
    ) -> StoredOrderRecord:
        """Reconciles an order with the payment provider via authoritative GET /transaction/{id}."""
        record = self._restore_creation_quote(record)
        order = record.order
        now = utc_now()
        if order.payment.provider != self._provider.name:
            self._repo.touch_order_reconciled(order.id)
            return record

        if not force and record.last_reconciled_at:
            last_dt = datetime.fromisoformat(record.last_reconciled_at.replace("Z", "+00:00"))
            if (now - last_dt).total_seconds() < min_interval_seconds:
                return record

        # Fair worker pagination even for malformed / missing provider transactions.
        self._repo.touch_order_reconciled(order.id)

        tx_id = order.payment.transaction_id
        is_past_expiry = False
        if order.expires_at:
            exp_dt = datetime.fromisoformat(order.expires_at.replace("Z", "+00:00"))
            is_past_expiry = exp_dt <= now

        if not tx_id:
            # If request was NEVER sent and order was abandoned > 10 minutes ago, release safely
            created_dt = datetime.fromisoformat(order.created_at.replace("Z", "+00:00"))
            if (
                not record.provider_request_sent
                and order.status == OrderStatus.CREATING_PAYMENT
                and (now - created_dt) >= timedelta(minutes=10)
            ):
                released, sess_id, seat_id = self._repo.release_abandoned_unsent_order(order.id)
                if released and sess_id and seat_id:
                    self._realtime.publish_seat_change(
                        session_id=sess_id, seat_id=seat_id, status="available"
                    )
                refreshed = self._repo.get_order_record(order.id)
                return refreshed or record
            self._repo.touch_order_reconciled(order.id)
            if record.provider_request_sent and order.status == OrderStatus.CREATING_PAYMENT and (now - created_dt) >= timedelta(seconds=30):
                return self._repo.mark_order_payment_review(order.id, note="dispatch_result_unknown_after_restart")
            return record

        try:
            snapshot = await self._provider.get_transaction(tx_id)
        except ProviderUnavailableError:
            # CRITICAL INVARIANT: if local timer expired while bank is unreachable,
            # NEVER release the seat blindly! Transition to payment_review and keep seat held.
            if is_past_expiry and order.status == OrderStatus.PENDING_PAYMENT:
                return self._repo.mark_order_payment_review(
                    order.id,
                    provider_status=ProviderPaymentStatus.UNKNOWN,
                    note="expired_timer_provider_unreachable",
                )
            self._repo.touch_order_reconciled(order.id)
            return record
        except ProviderNotFoundError:
            if order.status not in (OrderStatus.PAID, OrderStatus.REFUNDED):
                return self._repo.mark_order_payment_review(
                    order.id,
                    provider_status=ProviderPaymentStatus.UNKNOWN,
                    note="tx_not_found_on_poll",
                )
            return record

        if snapshot.transaction_id != tx_id or snapshot.payload != order.id:
            return self._repo.mark_order_payment_review(order.id, note="poll_payload_mismatch")

        if snapshot.status in (ProviderPaymentStatus.CHARGEBACKED, ProviderPaymentStatus.PARTIALLY_REFUNDED) and snapshot.refund_status and snapshot.refund_status.upper() not in REFUND_SUCCESS_STATES:
            self._repo.touch_order_reconciled(order.id)
            return record

        refund_confirmed = bool(
            snapshot.refund_status
            and snapshot.refund_status.strip().upper() in REFUND_SUCCESS_STATES
        ) or (
            snapshot.status
            in (ProviderPaymentStatus.CHARGEBACKED, ProviderPaymentStatus.PARTIALLY_REFUNDED)
        )

        updated_record, seat_changed = self._repo.apply_verified_provider_state(
            order_id=order.id,
            transaction_id=snapshot.transaction_id,
            provider_status=normalize_provider_status(snapshot.status.value),
            verified_amount_minor=snapshot.amount_minor,
            verified_currency=snapshot.currency,
            refunded_amount_minor=snapshot.refunded_amount_minor,
            qr_url=snapshot.qr_url,
            refund_confirmed=refund_confirmed,
        )
        if seat_changed is not None:
            self._realtime.publish_seat_change(
                session_id=updated_record.order.session_id,
                seat_id=updated_record.order.seat_id,
                status=seat_changed,
            )
        return updated_record

    async def run_reconciliation_cycle(self) -> int:
        """Processes pending callback events and reconciles in-flight orders. Survives restarts via SQLite."""
        processed_count = 0

        pending_events = self._repo.list_pending_events(limit=50)
        for ev in pending_events:
            try:
                await self._verify_and_apply_event(
                    event_id=ev.id,
                    transaction_id=ev.provider_transaction_id,
                    payload_order_id=ev.payload_order_id,
                    callback_amount_minor=ev.amount_minor,
                    callback_currency=ev.currency,
                    callback_refund_status=ev.refund_status,
                    callback_refunded_minor=ev.refunded_amount_minor,
                )
            except Exception as exc:
                logger.error("Payment event verification failed (%s)", type(exc).__name__)
            processed_count += 1

        open_orders = self._repo.list_orders_needing_reconciliation(limit=50)
        for rec in open_orders:
            try:
                await self.reconcile_order(rec, force=False, min_interval_seconds=5.0)
            except Exception as exc:
                logger.error("Payment order reconciliation failed (%s)", type(exc).__name__)
            processed_count += 1

        return processed_count
