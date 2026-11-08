"""Isolated payment safety tests: temporary SQLite and fake HTTP only, never merchant keys."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
import uuid

import httpx

from app.config import Settings
from app.db.connection import Database
from app.db.migrations import run_migrations
from app.db.seed import seed_from_fixtures
from app.domain.enums import OrderStatus, ProviderPaymentStatus as Status, TicketStatus
from app.domain.models import CreateOrderRequest
from app.errors import AppError
from app.providers.base import ProviderAmbiguousError, ProviderCreateResult, ProviderTransactionSnapshot, ProviderUnavailableError, rub_to_minor_exact
from app.providers.platega import PlategaPaymentProvider
from app.repositories.booking_repo import BookingRepository
from app.repositories.catalog_repo import CatalogRepository
from app.security import TokenManager
from app.services.booking_service import BookingService
from app.services.payment_service import PaymentService, parse_and_normalize_callback
from app.services.realtime_service import RealtimeSeatBroker

FIXTURES = Path(__file__).resolve().parents[3] / "contracts" / "fixtures"


class FakeProvider:
    name = "platega"

    def __init__(self):
        self.create_calls = 0
        self.get_calls = 0
        self.snapshots = {}
        self.error = None
        self.get_error = None
        self.gate = None
        self.entered = asyncio.Event()
        self.quoted_minor = None

    async def create_payment(self, **order):
        self.create_calls += 1
        self.entered.set()
        if self.error:
            raise self.error
        tx = str(uuid.uuid4())
        amount = self.quoted_minor if self.quoted_minor is not None else order["amount_minor"]
        self.snapshots[tx] = ProviderTransactionSnapshot(tx, Status.PENDING, amount, order["currency"], order["order_id"])
        if self.gate:
            await self.gate.wait()
        raw = {"transactionId": tx, "paymentDetails": {"amount": str(Decimal(amount) / 100), "currency": order["currency"]}}
        return ProviderCreateResult(tx, "https://pay.example.test/one", Status.PENDING, None, raw, amount, order["currency"])

    async def get_transaction(self, tx):
        self.get_calls += 1
        if self.get_error:
            raise self.get_error
        return self.snapshots[tx]


class PaymentFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "payments.sqlite")
        run_migrations(self.db)
        seed_from_fixtures(self.db, FIXTURES)
        self.tokens = TokenManager("isolated-test-token-key-not-a-merchant-secret")
        self.repo = BookingRepository(self.db, self.tokens, "https://tickets.example.test")
        self.provider = FakeProvider()
        self.settings = Settings(platega_merchant_id="test-merchant", platega_api_key="test-secret")
        broker = RealtimeSeatBroker()
        self.payments = PaymentService(settings=self.settings, booking_repo=self.repo, provider=self.provider, realtime=broker)
        self.booking = BookingService(booking_repo=self.repo, catalog_repo=CatalogRepository(self.db), token_manager=self.tokens, provider=self.provider, payment_service=self.payments, realtime=broker)
        with self.db.read_connection() as conn:
            row = conn.execute("SELECT session_id, seat_id FROM session_seats WHERE status='available' ORDER BY session_id, seat_id LIMIT 1").fetchone()
        self.payload = CreateOrderRequest(session_id=row["session_id"], seat_id=row["seat_id"], customer_email="test@example.test")
        self.key = "payment-test-key-00000001"

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def create(self):
        response, _ = await self.booking.create_order(idempotency_key=self.key, payload=self.payload)
        return self.repo.get_order_record(response.order.id)

    def assert_state(self, order_id, status, seat_status, ticket_status=None):
        record = self.repo.get_order_record(order_id)
        self.assertEqual(record.order.status, status)
        with self.db.read_connection() as conn:
            seat = conn.execute("SELECT status FROM session_seats WHERE session_id=? AND seat_id=?", (record.order.session_id, record.order.seat_id)).fetchone()
            tickets = conn.execute("SELECT status FROM tickets WHERE order_id=?", (order_id,)).fetchall()
        self.assertEqual(seat["status"], seat_status)
        self.assertEqual(len(tickets), int(ticket_status is not None))
        if ticket_status is not None:
            self.assertEqual(tickets[0]["status"], ticket_status)

    def callback_body(self, record, **changes):
        body = {"id": record.order.payment.transaction_id, "amount": str(Decimal(record.order.total_minor) / 100), "currency": "RUB", "status": "CONFIRMED", "paymentMethod": 2, "payload": record.order.id}
        return body | changes

    async def callback(self, body, secret="test-secret"):
        return await self.payments.handle_platega_callback(merchant_id_header="test-merchant", secret_header=secret, body=body, raw_bytes=json.dumps(body).encode())

    async def confirm(self, record):
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED)
        return await self.payments.reconcile_order(record, force=True)

    async def test_qr_persists_and_polling_replaces_it_with_one_ticket(self):
        record = await self.create()
        tx = record.order.payment.transaction_id
        qr = 'https://qr.nspk.ru/test-payment?sum=55000&cur=RUB'
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], qr_url=qr)
        record = await self.payments.reconcile_order(record, force=True)
        reopened = BookingRepository(self.db, self.tokens, 'https://tickets.example.test')
        self.assertEqual(reopened.get_order_record(record.order.id).order.payment.qr_url, qr)
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, 'held')
        await self.confirm(record)
        token = self.tokens.derive_order_access_token(record.order.id, record.token_nonce)
        order = await self.booking.get_order(record.order.id, token)
        self.assertIsNone(order.payment.qr_url)
        self.assertEqual(order.status, OrderStatus.PAID)
        ticket = await self.booking.get_order_ticket(record.order.id, token)
        self.assertEqual(ticket.order_id, order.id)
        await self.confirm(record)
        self.assert_state(order.id, OrderStatus.PAID, 'sold', TicketStatus.VALID)
        self.assertEqual(self.provider.create_calls, 1)

    async def test_mismatched_qr_snapshot_is_never_exposed(self):
        record = await self.create()
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], qr_url='https://qr.nspk.ru/wrong', amount_minor=1)
        checked = await self.payments.reconcile_order(record, force=True)
        self.assertIsNone(checked.order.payment.qr_url)
        self.assertEqual(checked.order.status, OrderStatus.PAYMENT_REVIEW)

    async def test_concurrent_idempotency_dispatches_exactly_one_post(self):
        self.provider.gate = asyncio.Event()
        first = asyncio.create_task(self.booking.create_order(idempotency_key=self.key, payload=self.payload))
        await self.provider.entered.wait()
        replay, _ = await self.booking.create_order(idempotency_key=self.key, payload=self.payload)
        self.assertEqual(self.provider.create_calls, 1)
        self.provider.gate.set()
        original, _ = await first
        self.assertEqual(original.order.id, replay.order.id)
        self.assertEqual(original.access_token, replay.access_token)
        self.assertTrue(self.repo.get_order_record(original.order.id).provider_request_sent)

    async def test_ambiguous_post_is_not_retried_and_seat_stays_held(self):
        self.provider.error = ProviderAmbiguousError("unknown POST outcome")
        record = await self.create()
        await self.create()
        self.assertEqual(self.provider.create_calls, 1)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")

    async def test_definite_pre_dispatch_failure_can_retry_same_key(self):
        self.provider.error = ProviderUnavailableError("connection failed before dispatch")
        with self.assertRaises(AppError):
            await self.create()
        self.provider.error = None
        record = await self.create()
        self.assertEqual(self.provider.create_calls, 2)
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, "held")

    async def test_restart_after_dispatch_claim_does_not_repost_or_release(self):
        reservation = self.repo.create_or_replay_reservation(idem_key=self.key, request_hash="exact-body", session_id=self.payload.session_id, seat_id=self.payload.seat_id, customer_email=self.payload.customer_email, provider_name="platega")
        self.assertTrue(self.repo.claim_provider_request(reservation.record.order.id))
        restarted = BookingRepository(self.db, self.tokens, "https://tickets.example.test")
        replay = restarted.create_or_replay_reservation(idem_key=self.key, request_hash="exact-body", session_id=self.payload.session_id, seat_id=self.payload.seat_id, customer_email=self.payload.customer_email, provider_name="platega")
        self.assertFalse(replay.needs_provider_call)
        released, _, _ = restarted.release_abandoned_unsent_order(replay.record.order.id)
        self.assertFalse(released)

    async def test_same_key_changed_body_is_conflict(self):
        await self.create()
        changed = self.payload.model_copy(update={"customer_email": "other@example.test"})
        with self.assertRaises(AppError) as error:
            await self.booking.create_order(idempotency_key=self.key, payload=changed)
        self.assertEqual(error.exception.code, "IDEMPOTENCY_CONFLICT")
        self.assertEqual(self.provider.create_calls, 1)

    async def test_duplicate_callback_and_poll_issue_exactly_one_ticket(self):
        record = await self.create()
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED)
        body = self.callback_body(record)
        await asyncio.gather(self.callback(body), self.callback(body), self.payments.reconcile_order(record, force=True))
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_fast_callback_wins_before_create_response(self):
        self.provider.gate = asyncio.Event()
        create = asyncio.create_task(self.booking.create_order(idempotency_key=self.key, payload=self.payload))
        await self.provider.entered.wait()
        tx, snapshot = next(iter(self.provider.snapshots.items()))
        self.provider.snapshots[tx] = replace(snapshot, status=Status.CONFIRMED)
        record = self.repo.get_order_record(snapshot.payload)
        await self.callback(self.callback_body(record, id=tx))
        self.assert_state(record.order.id, OrderStatus.CREATING_PAYMENT, "held")
        self.provider.gate.set()
        response, _ = await create
        self.assertEqual(response.order.status, OrderStatus.PAID)
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_callback_recovers_lost_creation_response(self):
        self.provider.error = ProviderAmbiguousError("lost")
        record = await self.create()
        tx = str(uuid.uuid4())
        self.provider.snapshots[tx] = ProviderTransactionSnapshot(tx, Status.CONFIRMED, record.order.total_minor, "RUB", record.order.id)
        await self.callback(self.callback_body(record, id=tx))
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_fast_cancel_callback_is_not_overwritten_by_late_create(self):
        self.provider.gate = asyncio.Event()
        create = asyncio.create_task(self.booking.create_order(idempotency_key=self.key, payload=self.payload))
        await self.provider.entered.wait()
        tx, snapshot = next(iter(self.provider.snapshots.items()))
        self.provider.snapshots[tx] = replace(snapshot, status=Status.CANCELED)
        record = self.repo.get_order_record(snapshot.payload)
        await self.callback(self.callback_body(record, id=tx, status="CANCELED"))
        self.provider.gate.set()
        response, _ = await create
        self.assertEqual(response.order.payment.status, Status.CANCELED)
        self.assert_state(record.order.id, OrderStatus.CANCELED, "available")

    async def test_late_unknown_create_cannot_overwrite_verified_partial_refund(self):
        record = await self.confirm(await self.create())
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.PARTIALLY_REFUNDED)
        await self.payments.reconcile_order(record, force=True)
        self.repo.mark_provider_timeout_ambiguous(order_id=record.order.id, error_note="late timeout")
        self.repo.mark_provider_payment_created(order_id=record.order.id, transaction_id=tx, payment_url="https://pay.example.test/one", provider_status=Status.PENDING, expires_at=None)
        self.assertEqual(self.repo.get_order_record(record.order.id).order.payment.status, Status.PARTIALLY_REFUNDED)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "sold", TicketStatus.SUSPENDED)

    async def test_expired_local_timer_during_provider_outage_does_not_release_seat(self):
        record = await self.create()
        with self.db.immediate_transaction() as conn:
            conn.execute("UPDATE orders SET expires_at='2020-01-01T00:00:00Z' WHERE id=?", (record.order.id,))
        self.provider.get_error = ProviderUnavailableError("offline")
        await self.payments.reconcile_order(self.repo.get_order_record(record.order.id), force=True)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")

    async def test_wrong_secret_is_rejected_before_event_storage(self):
        record = await self.create()
        with self.assertRaises(AppError) as error:
            await self.callback(self.callback_body(record), secret="wrong")
        self.assertEqual(error.exception.status_code, 401)
        with self.db.read_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM payment_events").fetchone()[0], 0)

    async def test_wrong_sbp_method_rejected(self):
        record = await self.create()
        with self.assertRaises(AppError):
            await self.callback(self.callback_body(record, paymentMethod=11))
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, "held")

    async def test_wrong_callback_amount_cannot_issue_ticket(self):
        record = await self.create()
        await self.callback(self.callback_body(record, amount="1.00"))
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")

    async def test_get_amount_currency_payload_and_identity_binding(self):
        record = await self.create()
        tx = record.order.payment.transaction_id
        original = self.provider.snapshots[tx]
        for change in ({"amount_minor": original.amount_minor + 1}, {"currency": "USD"}, {"payload": None}, {"payload": "wrong-order"}, {"transaction_id": "wrong-transaction"}):
            with self.subTest(change=change):
                self.provider.snapshots[tx] = replace(original, status=Status.CONFIRMED, **change)
                await self.payments.reconcile_order(record, force=True)
                self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")

    async def test_queued_callback_survives_provider_outage(self):
        record = await self.create()
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED)
        self.provider.get_error = ProviderUnavailableError("offline")
        await self.callback(self.callback_body(record))
        self.assertEqual(len(self.repo.list_pending_events()), 1)
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, "held")
        self.provider.get_error = None
        await self.payments.run_reconciliation_cycle()
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)
        self.assertEqual(self.repo.list_pending_events(), [])

    async def test_callback_refund_metadata_cannot_override_current_get(self):
        record = await self.confirm(await self.create())
        await self.callback(self.callback_body(record, refundId="one-refund", refundAmount=str(Decimal(record.order.total_minor) / 100), refundStatus="Succeeded", status="CHARGEBACKED"))
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_paid_orders_polled_and_full_refund_revokes_without_resale(self):
        record = await self.confirm(await self.create())
        self.assertIn(record.order.id, [item.order.id for item in self.repo.list_orders_needing_reconciliation()])
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CHARGEBACKED, refund_status="Succeeded")
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.REFUNDED, "sold", TicketStatus.REVOKED)
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED, refund_status=None)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.REFUNDED, "sold", TicketStatus.REVOKED)

    async def test_partial_refund_stays_suspended_on_stale_confirmed(self):
        record = await self.confirm(await self.create())
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.PARTIALLY_REFUNDED, refund_status="Succeeded")
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "sold", TicketStatus.SUSPENDED)
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED, refund_status=None)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "sold", TicketStatus.SUSPENDED)

    async def test_dispute_suspends_then_resolved_payment_restores_ticket(self):
        record = await self.confirm(await self.create())
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.DISPUTED)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "sold", TicketStatus.SUSPENDED)
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CONFIRMED)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_late_canceled_cannot_release_paid_seat(self):
        record = await self.confirm(await self.create())
        tx = record.order.payment.transaction_id
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.CANCELED)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_conflicting_create_transaction_cannot_replace_binding(self):
        record = await self.create()
        original = record.order.payment.transaction_id
        self.repo.mark_provider_payment_created(order_id=record.order.id, transaction_id="other", payment_url="https://pay.example.test/other", provider_status=Status.PENDING, expires_at=None)
        self.assertEqual(self.repo.get_order_record(record.order.id).order.payment.transaction_id, original)

    async def test_exact_provider_quote_fee_is_shown_and_ticket_uses_gross_amount(self):
        with self.db.immediate_transaction() as conn:
            conn.execute("UPDATE session_seats SET price_minor=90000 WHERE session_id=? AND seat_id=?", (self.payload.session_id, self.payload.seat_id))
        self.provider.quoted_minor = 92700
        response, _ = await self.booking.create_order(idempotency_key=self.key, payload=self.payload)
        record = self.repo.get_order_record(response.order.id)
        self.assertEqual(record.order.total_minor, 92700)
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, "held")
        pricing = self.booking.get_price_breakdown(record.order.id, response.access_token)
        self.assertEqual((pricing.seat_price_minor, pricing.service_fee_minor, pricing.total_minor), (90000, 2700, 92700))
        self.assertFalse(pricing.zero_hidden_fees)
        paid = await self.confirm(record)
        self.assert_state(paid.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)
        self.assertEqual(self.repo.get_ticket_by_order_id(paid.order.id).paid_minor, 92700)

    def enable_demo_checkout(self):
        self.repo = BookingRepository(self.db, self.tokens, "https://tickets.example.test", demo_checkout_minor=100)
        broker = RealtimeSeatBroker()
        self.payments = PaymentService(settings=self.settings, booking_repo=self.repo, provider=self.provider, realtime=broker)
        self.booking = BookingService(booking_repo=self.repo, catalog_repo=CatalogRepository(self.db), token_manager=self.tokens, provider=self.provider, payment_service=self.payments, realtime=broker)

    async def test_demo_charge_preserves_catalog_and_issues_exact_quoted_ticket(self):
        self.enable_demo_checkout()
        self.provider.quoted_minor = 103
        record = await self.create()
        self.assertEqual(record.requested_amount_minor, 100)
        self.assertGreaterEqual(record.catalog_price_minor, 35000)
        with self.db.read_connection() as conn:
            price = conn.execute("SELECT price_minor FROM session_seats WHERE session_id=? AND seat_id=?", (record.order.session_id, record.order.seat_id)).fetchone()[0]
        self.assertEqual(price, record.catalog_price_minor)
        token = self.tokens.derive_order_access_token(record.order.id, record.token_nonce)
        pricing = self.booking.get_price_breakdown(record.order.id, token)
        self.assertEqual((pricing.seat_price_minor, pricing.service_fee_minor, pricing.total_minor), (100, 3, 103))
        self.assertEqual(pricing.demo_discount_minor, price - 100)
        await self.confirm(record)
        self.assert_state(record.order.id, OrderStatus.PAID, 'sold', TicketStatus.VALID)
        ticket = await self.booking.get_order_ticket(record.order.id, token)
        self.assertEqual(ticket.paid_minor, 103)
        restarted = BookingRepository(self.db, self.tokens, "https://tickets.example.test")
        saved = restarted.get_order_record(record.order.id)
        self.assertEqual((saved.catalog_price_minor, saved.requested_amount_minor, saved.order.total_minor), (price, 100, 103))

    async def test_enabling_demo_does_not_reprice_existing_payment_on_replay(self):
        original = await self.create()
        self.enable_demo_checkout()
        replay = await self.create()
        self.assertEqual(replay.order.id, original.order.id)
        self.assertEqual(replay.order.total_minor, original.order.total_minor)
        self.assertEqual(self.provider.create_calls, 1)

    async def test_one_ruble_quote_is_103_kopeks_and_mismatch_still_fails(self):
        with self.db.immediate_transaction() as conn:
            conn.execute("UPDATE session_seats SET price_minor=100 WHERE session_id=? AND seat_id=?", (self.payload.session_id, self.payload.seat_id))
        self.provider.quoted_minor = 103
        record = await self.create()
        self.assertEqual(record.order.total_minor, 103)
        tx = record.order.payment.transaction_id
        snapshot = self.provider.snapshots[tx]
        self.provider.snapshots[tx] = replace(snapshot, status=Status.CONFIRMED, amount_minor=104)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")
        self.provider.snapshots[tx] = replace(snapshot, status=Status.CONFIRMED)
        await self.payments.reconcile_order(record, force=True)
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_legacy_unpaid_order_recovers_quote_from_saved_post_without_repost(self):
        self.provider.quoted_minor = 92700
        record = await self.create()
        with self.db.immediate_transaction() as conn:
            conn.execute("UPDATE orders SET total_minor=?,status='payment_review' WHERE id=?", (record.requested_amount_minor, record.order.id))
        recovered = await self.payments.reconcile_order(self.repo.get_order_record(record.order.id), force=True)
        self.assertEqual(recovered.order.total_minor, 92700)
        self.assert_state(record.order.id, OrderStatus.PENDING_PAYMENT, "held")
        self.assertEqual(self.provider.create_calls, 1)

    async def test_gross_callback_before_post_quote_waits_then_reverifies(self):
        with self.db.immediate_transaction() as conn:
            conn.execute("UPDATE session_seats SET price_minor=90000 WHERE session_id=? AND seat_id=?", (self.payload.session_id, self.payload.seat_id))
        self.provider.quoted_minor = 92700
        self.provider.gate = asyncio.Event()
        create = asyncio.create_task(self.booking.create_order(idempotency_key=self.key, payload=self.payload))
        await self.provider.entered.wait()
        tx, snapshot = next(iter(self.provider.snapshots.items()))
        self.provider.snapshots[tx] = replace(snapshot, status=Status.CONFIRMED)
        record = self.repo.get_order_record(snapshot.payload)
        await self.callback(self.callback_body(record, id=tx, amount="927.00"))
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "held")
        self.provider.gate.set()
        response, _ = await create
        self.assertEqual(response.order.total_minor, 92700)
        self.assert_state(record.order.id, OrderStatus.PAID, "sold", TicketStatus.VALID)

    async def test_quote_restore_never_changes_paid_or_disputed_orders(self):
        record = await self.confirm(await self.create())
        total = record.order.total_minor
        tx = record.order.payment.transaction_id
        self.repo.restore_provider_quote(record.order.id, tx, total + 1, "RUB")
        self.assertEqual(self.repo.get_order_record(record.order.id).order.total_minor, total)
        self.provider.snapshots[tx] = replace(self.provider.snapshots[tx], status=Status.DISPUTED)
        await self.payments.reconcile_order(record, force=True)
        self.repo.restore_provider_quote(record.order.id, tx, total + 1, "RUB")
        self.assertEqual(self.repo.get_order_record(record.order.id).order.total_minor, total)
        self.assert_state(record.order.id, OrderStatus.PAYMENT_REVIEW, "sold", TicketStatus.SUSPENDED)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_qr_only_accepts_direct_nspk_https_uri(self):
        cases = [('https://qr.nspk.ru/valid?sum=103&cur=RUB', True),
                 (None, False), ('javascript:alert(1)', False),
                 ('https://qr.nspk.ru.evil.test/pay', False),
                 ('https://user@qr.nspk.ru/pay', False),
                 ('https://qr.nspk.ru:444/pay', False),
                 ('https://qr.nspk.ru/pay\n', False),
                 ('<svg onload="alert(1)"/>', False)]
        for qr, valid in cases:
            with self.subTest(qr=qr):
                provider = self.adapter(lambda request: httpx.Response(200, json={
                    'id': 'tx-qr', 'status': 'PENDING', 'payload': 'order-qr',
                    'paymentDetails': {'amount': '1.03', 'currency': 'RUB'}, 'qr': qr}))
                snapshot = await provider.get_transaction('tx-qr')
                self.assertEqual(snapshot.qr_url, qr if valid else None)

    def adapter(self, handler):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        return PlategaPaymentProvider(base_url="https://api.example.test", merchant_id="test-merchant", api_key="test-secret", public_app_url="https://tickets.example.test", http_client=client)

    async def create(self, provider):
        return await provider.create_payment(order_id="order-test", amount_minor=55001, currency="RUB", customer_email="test@example.test", customer_id="stable-customer", access_token="private-order-token")

    async def test_sbp_body_and_decimal_rubles_are_exact(self):
        captured = []
        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"transactionId": "tx-test", "redirect": "https://pay.example.test/one", "status": "PENDING", "expiresIn": "00:15:00", "paymentDetails": "550.01 RUB"})
        result = await self.create(self.adapter(handler))
        body = json.loads(captured[0].content, parse_float=Decimal)
        self.assertEqual(body["paymentMethod"], 2)
        self.assertEqual(body["paymentDetails"], {"amount": Decimal("550.01"), "currency": "RUB"})
        self.assertEqual(body["payload"], "order-test")
        self.assertEqual(body["metadata"]["userId"], "stable-customer")
        self.assertNotIn("private-order-token", captured[0].content.decode())
        self.assertIsNotNone(result.expires_at)

    async def test_every_5xx_create_is_ambiguous_including_503(self):
        for status in (500, 501, 502, 503, 504, 599):
            with self.subTest(status=status), self.assertRaises(ProviderAmbiguousError):
                await self.create(self.adapter(lambda request: httpx.Response(status)))

    async def test_success_quote_must_be_exact_same_currency_and_not_underpriced(self):
        for details in ({"amount": 550, "currency": "RUB"}, {"amount": 550.01, "currency": "USD"}, "550.001 RUB", None):
            body = {"transactionId": "tx-test", "redirect": "https://pay.example.test/one", "status": "PENDING", "paymentDetails": details}
            with self.subTest(details=details), self.assertRaises(ProviderAmbiguousError):
                await self.create(self.adapter(lambda request: httpx.Response(200, json=body)))

    async def test_malformed_success_and_unsafe_redirect_do_not_allow_retry(self):
        for body in ({}, {"transactionId": "tx", "redirect": "http://pay.example.test"}, {"transactionId": "tx", "redirect": "https://user:password@pay.example.test"}):
            with self.subTest(body=body), self.assertRaises(ProviderAmbiguousError):
                await self.create(self.adapter(lambda request: httpx.Response(200, json=body)))

    async def test_get_rejects_missing_identity_currency_and_wrong_merchant(self):
        valid = {"id": "tx", "status": "CONFIRMED", "paymentDetails": {"amount": 550.01, "currency": "RUB"}, "payload": "order-test", "paymentMethod": "SBPQR", "mechantId": "test-merchant"}
        bodies = [valid | {"id": None}, valid | {"id": "other"}, valid | {"paymentDetails": {"amount": 550.01}}, valid | {"mechantId": "other"}, valid | {"paymentMethod": "CARD"}, valid | {"paymentDetails": {"amount": "NaN", "currency": "RUB"}}]
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(ProviderUnavailableError):
                await self.adapter(lambda request: httpx.Response(200, json=body)).get_transaction("tx")
        snapshot = await self.adapter(lambda request: httpx.Response(200, json=valid)).get_transaction("tx")
        self.assertEqual(snapshot.amount_minor, 55001)

    async def test_client_redirects_cannot_forward_merchant_headers(self):
        captured = []
        def handler(request):
            captured.append(request)
            return httpx.Response(302, headers={"Location": "https://foreign.example.test/collect"})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
        self.addAsyncCleanup(client.aclose)
        provider = PlategaPaymentProvider(base_url="https://api.example.test", merchant_id="test-merchant", api_key="test-secret", public_app_url="https://tickets.example.test", http_client=client)
        with self.assertRaises(ProviderAmbiguousError):
            await self.create(provider)
        with self.assertRaises(ProviderUnavailableError):
            await provider.get_transaction("tx")
        self.assertEqual(len(captured), 2)
        self.assertTrue(all(request.url.host == "api.example.test" for request in captured))


class NumericAndCallbackTests(unittest.TestCase):
    def test_nonfinite_and_subkopek_amounts_are_rejected(self):
        for amount in (True, None, "NaN", "sNaN", "Infinity", "-Infinity", "0.001", "10.0000001", "-1"):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                rub_to_minor_exact(amount)
        self.assertEqual(rub_to_minor_exact("1500.25"), 150025)

    def test_official_refund_amount_and_alias_conflicts(self):
        body = {"id": "tx", "amount": 1500.25, "currency": "RUB", "status": "CHARGEBACKED", "paymentMethod": 2, "payload": "order", "refundId": "refund", "refundAmount": 1500.25, "refundStatus": "Succeeded"}
        self.assertEqual(parse_and_normalize_callback(body).refunded_amount_minor, 150025)
        with self.assertRaises(AppError):
            parse_and_normalize_callback(body | {"Status": "CONFIRMED"})


if __name__ == "__main__":
    unittest.main()
