"""Booking, order lifecycle, ticket access, and transparent RF pricing/cancellation service."""
from __future__ import annotations

import hashlib
import json

from app.domain.enums import OrderStatus, ProviderPaymentStatus
from app.domain.models import (
    CreateOrderRequest,
    CreateOrderResponse,
    Order,
    OrderPriceBreakdownResponse,
    Ticket,
)
from app.errors import (
    not_found_error,
    order_state_conflict_error,
    payment_unavailable_error,
    ticket_not_ready_error,
    unauthorized_error,
    validation_error,
)
from app.providers.base import (
    PaymentProvider,
    ProviderAmbiguousError,
    ProviderUnavailableError,
)
from app.providers.sandbox import SandboxPaymentProvider
from app.repositories.booking_repo import BookingRepository, StoredOrderRecord
from app.repositories.catalog_repo import CatalogRepository
from app.security import TokenManager
from app.services.payment_service import PaymentService
from app.services.realtime_service import RealtimeSeatBroker


def _canonical_request_hash(payload: CreateOrderRequest) -> str:
    canonical = json.dumps(
        {
            "session_id": payload.session_id,
            "seat_id": payload.seat_id,
            "customer_email": payload.customer_email,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class BookingService:
    def __init__(
        self,
        *,
        booking_repo: BookingRepository,
        catalog_repo: CatalogRepository,
        token_manager: TokenManager,
        provider: PaymentProvider,
        payment_service: PaymentService,
        realtime: RealtimeSeatBroker,
    ) -> None:
        self._repo = booking_repo
        self._catalog_repo = catalog_repo
        self._tokens = token_manager
        self._provider = provider
        self._payment_service = payment_service
        self._realtime = realtime

    async def create_order(
        self,
        *,
        idempotency_key: str | None,
        payload: CreateOrderRequest,
    ) -> tuple[CreateOrderResponse, int]:
        if idempotency_key is None or not (16 <= len(idempotency_key) <= 128):
            raise validation_error("Заголовок Idempotency-Key должен содержать от 16 до 128 символов.")

        req_hash = _canonical_request_hash(payload)
        reservation = self._repo.create_or_replay_reservation(
            idem_key=idempotency_key,
            request_hash=req_hash,
            session_id=payload.session_id,
            seat_id=payload.seat_id,
            customer_email=payload.customer_email,
            provider_name=self._provider.name,
        )

        record = reservation.record
        access_token = self._tokens.derive_order_access_token(record.order.id, record.token_nonce)

        if not reservation.replayed:
            self._realtime.publish_seat_change(
                session_id=record.order.session_id,
                seat_id=record.order.seat_id,
                status="held",
            )

        if not reservation.needs_provider_call:
            # Safe idempotency replay: never issue a duplicate POST to payment provider
            return CreateOrderResponse(order=record.order, access_token=access_token), 200

        if not self._repo.claim_provider_request(record.order.id):
            current = self._repo.get_order_record(record.order.id) or record
            return CreateOrderResponse(order=current.order, access_token=access_token), 200

        try:
            created = await self._provider.create_payment(
                order_id=record.order.id,
                amount_minor=record.order.total_minor,
                currency=record.order.currency,
                customer_email=record.customer_email,
                customer_id=record.customer_id,
                access_token=access_token,
            )
        except ProviderAmbiguousError as exc:
            ambiguous_record = self._repo.mark_provider_timeout_ambiguous(
                order_id=record.order.id,
                error_note=str(exc),
            )
            status_code = 200 if reservation.replayed else 202
            return CreateOrderResponse(order=ambiguous_record.order, access_token=access_token), status_code
        except ProviderUnavailableError as exc:
            self._repo.reset_definitely_unsent_request(record.order.id)
            raise payment_unavailable_error(str(exc), status_code=exc.status_code) from exc

        updated = self._repo.mark_provider_payment_created(
            order_id=record.order.id,
            transaction_id=created.transaction_id,
            payment_url=created.payment_url,
            provider_status=created.status,
            expires_at=created.expires_at,
            raw_response=created.raw_response,
            quoted_amount_minor=created.amount_minor,
            quoted_currency=created.currency,
        )
        # A callback may arrive before the POST quote is persisted. Verify again now;
        # neither the creation response nor the browser return can issue a ticket.
        updated = await self._payment_service.reconcile_order(updated, force=True)
        status_code = 200 if reservation.replayed else 201
        return CreateOrderResponse(order=updated.order, access_token=access_token), status_code

    def _authenticate_order(self, order_id: str, bearer_token: str | None) -> StoredOrderRecord:
        if not bearer_token:
            raise unauthorized_error("Нет доступа к заказу.")
        record = self._repo.get_order_record(order_id)
        if record is None:
            raise not_found_error("Заказ не найден.")
        if not self._tokens.verify_order_access_token(order_id, record.token_nonce, bearer_token):
            raise unauthorized_error("Нет доступа к заказу.")
        return record

    async def get_order(self, order_id: str, bearer_token: str | None) -> Order:
        record = self._authenticate_order(order_id, bearer_token)
        if record.order.status in (
            OrderStatus.PENDING_PAYMENT,
            OrderStatus.PAYMENT_REVIEW,
            OrderStatus.CREATING_PAYMENT,
        ):
            record = await self._payment_service.reconcile_order(
                record, force=False, min_interval_seconds=2.5
            )
        return record.order

    async def get_order_ticket(self, order_id: str, bearer_token: str | None) -> Ticket:
        record = self._authenticate_order(order_id, bearer_token)
        if not record.order.ticket_id:
            # Quick check if payment was just confirmed
            if record.order.status in (OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW):
                record = await self._payment_service.reconcile_order(
                    record, force=False, min_interval_seconds=2.5
                )
        if not record.order.ticket_id:
            raise ticket_not_ready_error()
        ticket = self._repo.get_ticket_by_order_id(order_id)
        if ticket is None:
            raise ticket_not_ready_error()
        return ticket

    def verify_ticket_by_token(self, qr_token: str) -> Ticket:
        if not qr_token or not qr_token.strip():
            raise not_found_error("Билет не найден.")
        ticket = self._repo.get_ticket_by_qr_token(qr_token.strip())
        if ticket is None:
            raise not_found_error("Билет не найден.")
        return ticket

    async def cancel_unpaid_hold(self, order_id: str, bearer_token: str | None) -> Order:
        """Allows buyer to cleanly release an unpaid seat hold so they can pick another seat immediately,
        only after verifying with the payment provider that payment was NOT completed.
        """
        record = self._authenticate_order(order_id, bearer_token)
        if record.order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED):
            return record.order
        if record.order.status in (OrderStatus.PAID, OrderStatus.REFUNDED):
            raise order_state_conflict_error("Заказ уже оплачен; отмена неоплаченной брони недоступна.")

        if isinstance(self._provider, SandboxPaymentProvider):
            self._provider.set_order_transaction_status(order_id, ProviderPaymentStatus.CANCELED)
            reconciled = await self._payment_service.reconcile_order(record, force=True)
            return reconciled.order

        tx_id = record.order.payment.transaction_id
        if tx_id:
            reconciled = await self._payment_service.reconcile_order(record, force=True)
            if reconciled.order.status == OrderStatus.PAID:
                raise order_state_conflict_error("Платёж уже подтверждён банком; билет выпущен.")
            if reconciled.order.status in (OrderStatus.CANCELED, OrderStatus.EXPIRED):
                return reconciled.order
            raise order_state_conflict_error(
                "Платёж уже ожидает ответа в СБП. Дождитесь завершения или отмены в приложении банка."
            )

        if not record.provider_request_sent:
            released, sess_id, seat_id = self._repo.release_abandoned_unsent_order(order_id)
            if released and sess_id and seat_id:
                self._realtime.publish_seat_change(
                    session_id=sess_id, seat_id=seat_id, status="available"
                )
            updated = self._repo.get_order_record(order_id)
            assert updated is not None
            return updated.order

        raise order_state_conflict_error("Статус платежа уточняется у провайдера; отмена сейчас недоступна.")

    def get_price_breakdown(
        self, order_id: str, bearer_token: str | None
    ) -> OrderPriceBreakdownResponse:
        record = self._authenticate_order(order_id, bearer_token)
        session = self._catalog_repo.get_session(record.order.session_id)
        starts_at = session.starts_at if session else record.order.created_at

        can_cancel_hold = (
            record.order.status in (OrderStatus.CREATING_PAYMENT, OrderStatus.PENDING_PAYMENT)
            and (isinstance(self._provider, SandboxPaymentProvider) or not record.provider_request_sent)
        )
        policy = (
            "Цена места и комиссия платёжного провайдера показаны отдельно. "
            "Автоматический возврат в проекте не предусмотрен. "
            "Для проверки платежа обратитесь к организатору демонстрации."
        )
        return OrderPriceBreakdownResponse(
            order_id=record.order.id,
            seat_price_minor=record.requested_amount_minor,
            catalog_price_minor=record.catalog_price_minor,
            demo_discount_minor=max(0, record.catalog_price_minor - record.requested_amount_minor),
            service_fee_minor=max(0, record.order.total_minor - record.requested_amount_minor),
            insurance_upsell_minor=0,
            total_minor=record.order.total_minor,
            currency="RUB",
            zero_hidden_fees=record.order.total_minor == record.requested_amount_minor,
            refund_policy_ru=policy,
            can_cancel_unpaid_hold=can_cancel_hold,
            session_starts_at=starts_at,
        )
