"""Payment provider protocol, exact Decimal currency helpers, and Platega duration parser."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, DecimalException
import re
from typing import Any, Literal, Protocol

from app.db.connection import to_iso_utc
from app.domain.enums import ProviderPaymentStatus


class ProviderError(Exception):
    """Base payment provider error."""


class ProviderUnavailableError(ProviderError):
    """Create failed before dispatch / was explicitly rejected, or a read-only GET is unavailable."""

    def __init__(self, message: str, *, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


class ProviderAmbiguousError(ProviderError):
    """Raised on network timeout / broken stream after request dispatch where payment might exist."""


class ProviderNotFoundError(ProviderError):
    """Raised when GET /transaction/{id} returns 404."""


@dataclass(frozen=True, slots=True)
class ProviderCreateResult:
    transaction_id: str
    payment_url: str
    status: ProviderPaymentStatus
    expires_at: str | None
    raw_response: dict[str, Any]
    amount_minor: int | None = None
    currency: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderTransactionSnapshot:
    transaction_id: str
    status: ProviderPaymentStatus
    amount_minor: int
    currency: str
    payload: str | None = None
    refund_id: str | None = None
    refund_status: str | None = None
    refunded_amount_minor: int | None = None
    qr_url: str | None = None


class PaymentProvider(Protocol):
    @property
    def name(self) -> Literal["mock", "platega"]: ...

    async def create_payment(
        self,
        *,
        order_id: str,
        amount_minor: int,
        currency: str,
        customer_email: str,
        customer_id: str,
        access_token: str,
    ) -> ProviderCreateResult: ...

    async def get_transaction(self, transaction_id: str) -> ProviderTransactionSnapshot: ...


def minor_to_rub_decimal(amount_minor: int) -> Decimal:
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor < 0:
        raise ValueError("amount_minor must be a non-negative integer.")
    return (Decimal(amount_minor) / Decimal(100)).quantize(Decimal("0.01"))


def minor_to_json_rub(amount_minor: int) -> int | Decimal:
    """Converts integer kopeks to exact rubles without float drift (e.g., 55000 -> 550)."""
    dec = minor_to_rub_decimal(amount_minor)
    if dec == dec.to_integral_value():
        return int(dec)
    return dec


def rub_to_minor_exact(raw_amount: Any) -> int:
    """Converts provider ruble amount (int, str, float, Decimal) into exact integer kopeks."""
    if isinstance(raw_amount, bool) or raw_amount is None:
        raise ValueError("Amount is missing or invalid.")
    try:
        dec = Decimal(str(raw_amount).strip())
        if not dec.is_finite() or dec < 0:
            raise ValueError("Amount must be finite and non-negative.")
        minor = dec * Decimal(100)
        if minor != minor.to_integral_value():
            raise ValueError("Amount has sub-kopek precision.")
        return int(minor)
    except (DecimalException, OverflowError) as exc:
        raise ValueError("Invalid monetary amount.") from exc


_HMS_RE = re.compile(r"^(?:(?P<days>\d+)[.:])?(?P<hours>\d{1,2}):(?P<minutes>\d{2}):(?P<seconds>\d{2})$")


def parse_expires_in_to_iso(raw_expires: Any, now: datetime) -> str | None:
    """Parses Platega `expiresIn` ('00:15:00', integer seconds, or ISO-8601) into UTC ISO-8601."""
    if raw_expires is None:
        return None
    if isinstance(raw_expires, (int, float)) and not isinstance(raw_expires, bool):
        if raw_expires <= 0:
            return None
        return to_iso_utc(now + timedelta(seconds=float(raw_expires)))
    if isinstance(raw_expires, str):
        text = raw_expires.strip()
        if not text:
            return None
        if text.isdigit():
            return to_iso_utc(now + timedelta(seconds=int(text)))
        match = _HMS_RE.fullmatch(text)
        if match:
            days = int(match.group("days") or 0)
            hours = int(match.group("hours"))
            minutes = int(match.group("minutes"))
            seconds = int(match.group("seconds"))
            delta = timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)
            return to_iso_utc(now + delta) if delta.total_seconds() > 0 else None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return to_iso_utc(parsed)
        except ValueError:
            return None
    return None
