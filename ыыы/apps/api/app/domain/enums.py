"""Domain statuses and payment-to-order state machine rules."""
from __future__ import annotations

from enum import StrEnum


class SeatStatus(StrEnum):
    AVAILABLE = "available"
    HELD = "held"
    SOLD = "sold"


class SeatType(StrEnum):
    STANDARD = "standard"
    SOFA = "sofa"


class SeatZone(StrEnum):
    FRONT = "front"
    MIDDLE = "middle"
    SOFA = "sofa"


class OrderStatus(StrEnum):
    CREATING_PAYMENT = "creating_payment"
    PENDING_PAYMENT = "pending_payment"
    PAID = "paid"
    CANCELED = "canceled"
    EXPIRED = "expired"
    PAYMENT_REVIEW = "payment_review"
    REFUNDED = "refunded"


class TicketStatus(StrEnum):
    VALID = "valid"
    SUSPENDED = "suspended"
    REVOKED = "revoked"


class ProviderPaymentStatus(StrEnum):
    CREATING = "CREATING"
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    CANCELED = "CANCELED"
    EXPIRED = "EXPIRED"
    FAILED = "FAILED"
    DISPUTED = "DISPUTED"
    CHARGEBACKED = "CHARGEBACKED"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
    UNKNOWN = "UNKNOWN"


KNOWN_PROVIDER_STATUSES: frozenset[str] = frozenset(item.value for item in ProviderPaymentStatus)

TERMINAL_UNPAID_PROVIDER_STATUSES: frozenset[ProviderPaymentStatus] = frozenset(
    {
        ProviderPaymentStatus.CANCELED,
        ProviderPaymentStatus.EXPIRED,
        ProviderPaymentStatus.FAILED,
    }
)


def normalize_provider_status(raw_status: str | None) -> ProviderPaymentStatus:
    """Map external provider status safely; unknown strings never map to CONFIRMED."""
    if not raw_status:
        return ProviderPaymentStatus.UNKNOWN
    upper = raw_status.strip().upper()
    aliases = {
        "CANCELLED": ProviderPaymentStatus.CANCELED,
        "REFUNDED": ProviderPaymentStatus.CHARGEBACKED,
        "FULL_REFUND": ProviderPaymentStatus.CHARGEBACKED,
        "PARTIAL_REFUND": ProviderPaymentStatus.PARTIALLY_REFUNDED,
    }
    if upper in aliases:
        return aliases[upper]
    if upper in KNOWN_PROVIDER_STATUSES:
        return ProviderPaymentStatus(upper)
    return ProviderPaymentStatus.UNKNOWN
