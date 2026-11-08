"""Background payment & seat hold reconciliation worker."""
from __future__ import annotations

import asyncio
import logging

from app.services.payment_service import PaymentService

logger = logging.getLogger("zal.reconciler")


class PaymentReconciliationWorker:
    """Periodically retries queued webhook events and verifies open/expired orders against the provider."""

    def __init__(self, payment_service: PaymentService, interval_seconds: float = 15.0) -> None:
        self._payment_service = payment_service
        self._interval = max(1.0, interval_seconds)
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._run_loop(), name="zal-payment-reconciler")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self._payment_service.run_reconciliation_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Never log customer emails or secret keys
                logger.error("Payment reconciliation cycle failed (%s)", type(exc).__name__)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval)
            except TimeoutError:
                continue
