"""Persistent SQLite-backed Sandbox SBP provider for local development (`PAYMENT_PROVIDER=mock`).

Strictly isolated: never registered or active when `PAYMENT_PROVIDER=platega`.
Simulates provider-side state transitions so local development exercises the exact same
database transactions, reconciliation pipeline, and ticket issuance as production.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Literal
from urllib.parse import urlencode
import uuid

from app.db.connection import Database, to_iso_utc, utc_now, utc_now_iso
from app.domain.enums import ProviderPaymentStatus
from app.providers.base import (
    ProviderCreateResult,
    ProviderNotFoundError,
    ProviderTransactionSnapshot,
)


class SandboxPaymentProvider:
    def __init__(self, db: Database, *, public_api_url: str = "http://127.0.0.1:8000") -> None:
        self._db = db
        self._public_api_url = public_api_url.rstrip("/")
        self._ensure_table()

    @property
    def name(self) -> Literal["mock", "platega"]:
        return "mock"

    def _ensure_table(self) -> None:
        with self._db.immediate_transaction() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sandbox_transactions (
                    transaction_id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    amount_minor INTEGER NOT NULL,
                    currency TEXT NOT NULL DEFAULT 'RUB',
                    expires_at TEXT NOT NULL,
                    refunded_amount_minor INTEGER,
                    refund_status TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

    async def create_payment(
        self,
        *,
        order_id: str,
        amount_minor: int,
        currency: str,
        customer_email: str,
        customer_id: str,
        access_token: str,
    ) -> ProviderCreateResult:
        now = utc_now()
        now_iso = to_iso_utc(now)
        expires_at = to_iso_utc(now + timedelta(minutes=15))
        tx_id = f"mock_{uuid.uuid4()}"
        query = urlencode({"token": access_token})
        payment_url = f"{self._public_api_url}/__mock/pay/{order_id}?{query}"

        with self._db.immediate_transaction() as conn:
            existing = conn.execute(
                "SELECT transaction_id, status, expires_at FROM sandbox_transactions WHERE order_id = ?;",
                (order_id,),
            ).fetchone()
            if existing is not None:
                tx_id = str(existing["transaction_id"])
                status = ProviderPaymentStatus(str(existing["status"]))
                expires_at = str(existing["expires_at"])
            else:
                status = ProviderPaymentStatus.PENDING
                conn.execute(
                    """
                    INSERT INTO sandbox_transactions (
                        transaction_id, order_id, status, amount_minor, currency,
                        expires_at, refunded_amount_minor, refund_status, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?);
                    """,
                    (tx_id, order_id, status.value, amount_minor, currency, expires_at, now_iso, now_iso),
                )

        return ProviderCreateResult(
            transaction_id=tx_id,
            payment_url=payment_url,
            status=status,
            expires_at=expires_at,
            raw_response={"sandbox": True, "transactionId": tx_id, "status": status.value},
        )

    async def get_transaction(self, transaction_id: str) -> ProviderTransactionSnapshot:
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM sandbox_transactions WHERE transaction_id = ?;",
                (transaction_id,),
            ).fetchone()
        if row is None:
            raise ProviderNotFoundError(f"Sandbox transaction {transaction_id} not found.")

        status = ProviderPaymentStatus(str(row["status"]))
        # Auto-expire pending sandbox payment if past its 15-minute window
        if status == ProviderPaymentStatus.PENDING:
            from datetime import datetime

            exp_dt = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
            if exp_dt <= utc_now():
                status = ProviderPaymentStatus.EXPIRED
                self.set_order_transaction_status(str(row["order_id"]), status)

        return ProviderTransactionSnapshot(
            transaction_id=str(row["transaction_id"]),
            status=status,
            amount_minor=int(row["amount_minor"]),
            currency=str(row["currency"]),
            payload=str(row["order_id"]),
            refund_id=f"rf_{row['transaction_id']}" if row["refund_status"] else None,
            refund_status=row["refund_status"],
            refunded_amount_minor=(
                int(row["refunded_amount_minor"]) if row["refunded_amount_minor"] is not None else None
            ),
        )

    def set_order_transaction_status(
        self,
        order_id: str,
        status: ProviderPaymentStatus,
        *,
        refunded_amount_minor: int | None = None,
        refund_status: str | None = None,
    ) -> str | None:
        now_iso = utc_now_iso()
        with self._db.immediate_transaction() as conn:
            row = conn.execute(
                "SELECT transaction_id FROM sandbox_transactions WHERE order_id = ?;",
                (order_id,),
            ).fetchone()
            if row is None:
                return None
            tx_id = str(row["transaction_id"])
            conn.execute(
                """
                UPDATE sandbox_transactions
                SET status = ?,
                    refunded_amount_minor = COALESCE(?, refunded_amount_minor),
                    refund_status = COALESCE(?, refund_status),
                    updated_at = ?
                WHERE order_id = ?;
                """,
                (status.value, refunded_amount_minor, refund_status, now_iso, order_id),
            )
            return tx_id
