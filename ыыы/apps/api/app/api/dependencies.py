"""Application service container and FastAPI request helpers."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.config import Settings
from app.db.connection import Database
from app.providers.base import PaymentProvider
from app.repositories.booking_repo import BookingRepository
from app.repositories.catalog_repo import CatalogRepository
from app.security import SlidingWindowRateLimiter, TokenManager
from app.services.booking_service import BookingService
from app.services.catalog_service import CatalogService
from app.services.payment_service import PaymentService
from app.services.realtime_service import RealtimeSeatBroker
from app.workers.reconciler import PaymentReconciliationWorker


@dataclass(slots=True)
class AppContainer:
    settings: Settings
    db: Database
    token_manager: TokenManager
    catalog_repo: CatalogRepository
    booking_repo: BookingRepository
    provider: PaymentProvider
    realtime: RealtimeSeatBroker
    catalog_service: CatalogService
    payment_service: PaymentService
    booking_service: BookingService
    reconciler: PaymentReconciliationWorker
    orders_limiter: SlidingWindowRateLimiter
    tickets_limiter: SlidingWindowRateLimiter


def get_container(request: Request) -> AppContainer:
    return request.app.state.container  # type: ignore[no-any-return]


def extract_bearer_token(request: Request) -> str | None:
    auth_header = request.headers.get("Authorization") or ""
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:].strip()
    return token or None


def extract_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        first_hop = forwarded.split(",")[0].strip()
        if first_hop:
            return first_hop
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
