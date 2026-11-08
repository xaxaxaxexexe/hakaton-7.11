"""Official Platega SBP payment adapter (`https://docs.platega.io/`).

Uses:
- POST /transaction/process (paymentMethod=2 for SBP, X-MerchantId / X-Secret headers)
- GET  /transaction/{transactionId} (server-to-server authoritative verification)
Never logs or serializes API keys or merchant secrets.
"""
from __future__ import annotations

from decimal import Decimal
import hmac
import json
import re
from typing import Any, Literal
from urllib.parse import quote, urlparse

import httpx

from app.db.connection import utc_now
from app.domain.enums import ProviderPaymentStatus, normalize_provider_status
from app.providers.base import (
    ProviderAmbiguousError,
    ProviderCreateResult,
    ProviderNotFoundError,
    ProviderTransactionSnapshot,
    ProviderUnavailableError,
    minor_to_json_rub,
    parse_expires_in_to_iso,
    rub_to_minor_exact,
)

_PAYMENT_DETAILS_STR_RE = re.compile(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*([A-Za-z]{3})\s*$")


def safe_sbp_qr(value: Any) -> str | None:
    """Accept only the bank payment URI, never HTML, images or arbitrary redirects."""
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() or ord(c) < 32 for c in value):
        return None
    try:
        url = urlparse(value)
        if (url.scheme == "https" and url.hostname == "qr.nspk.ru" and
                not url.username and not url.password and url.port in (None, 443) and
                url.path.strip("/") and not url.fragment):
            return value
    except ValueError:
        pass
    return None


def _encode_decimal_json(value: Any) -> str:
    """Emit Decimal as a JSON number without passing through binary float."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Non-finite JSON amount.")
        return format(value, "f")
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key) + ":" + _encode_decimal_json(item) for key, item in value.items()) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_encode_decimal_json(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _extract_payment_details(raw_details: Any, fallback_data: dict[str, Any]) -> tuple[int, str]:
    if isinstance(raw_details, dict):
        amt = raw_details.get("amount")
        curr = str(raw_details.get("currency") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", curr):
            raise ValueError("Missing or invalid currency.")
        return rub_to_minor_exact(amt), curr
    if isinstance(raw_details, str):
        match = _PAYMENT_DETAILS_STR_RE.match(raw_details)
        if match:
            amt_str = match.group(1).replace(",", ".")
            curr = match.group(2).upper()
            return rub_to_minor_exact(amt_str), curr
    if "amount" in fallback_data:
        curr = str(fallback_data.get("currency") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", curr):
            raise ValueError("Missing or invalid currency.")
        return rub_to_minor_exact(fallback_data["amount"]), curr
    raise ProviderUnavailableError("Platega response missing valid paymentDetails.", status_code=502)


class PlategaPaymentProvider:
    def __init__(
        self,
        *,
        base_url: str,
        merchant_id: str,
        api_key: str,
        public_app_url: str,
        timeout_seconds: float = 10.0,
        fallback_callback_url: str = "",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._merchant_id = merchant_id.strip()
        self._api_key = api_key.strip()
        self._public_app_url = public_app_url.rstrip("/")
        self._timeout = timeout_seconds
        self._fallback_callback_url = fallback_callback_url.strip()
        self._external_client = http_client

    @property
    def name(self) -> Literal["mock", "platega"]:
        return "platega"

    def _auth_headers(self) -> dict[str, str]:
        if not self._merchant_id or not self._api_key:
            raise ProviderUnavailableError(
                "Платёжный провайдер Platega ещё не настроен (отсутствуют ключи мерчанта).",
                status_code=503,
            )
        return {
            "X-MerchantId": self._merchant_id,
            "X-Secret": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

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
        headers = self._auth_headers()
        return_url = f"{self._public_app_url}/payment/return?order={order_id}"
        amount_rub = minor_to_json_rub(amount_minor)

        payload_body = {
            "paymentMethod": 2,
            "paymentDetails": {
                "amount": amount_rub,
                "currency": currency,
            },
            "description": f"Билет ZAL, заказ {order_id}",
            "return": return_url,
            "failedUrl": return_url,
            "payload": order_id,
            "metadata": {
                "user_email": customer_email,
                "userId": customer_id,
            },
        }
        encoded_body = _encode_decimal_json(payload_body).encode("utf-8")

        try:
            if self._external_client is not None:
                resp = await self._external_client.post(
                    f"{self._base_url}/transaction/process",
                    content=encoded_body,
                    headers=headers,
                    timeout=self._timeout,
                    follow_redirects=False,
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.post(
                        f"{self._base_url}/transaction/process",
                        content=encoded_body,
                        headers=headers,
                        follow_redirects=False,
                    )
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            raise ProviderUnavailableError(
                "Не удалось подключиться к платёжному шлюзу Platega.",
                status_code=503,
            ) from exc
        except (httpx.TimeoutException, httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError) as exc:
            raise ProviderAmbiguousError("Timeout or network drop while awaiting Platega /transaction/process.") from exc
        except httpx.HTTPError as exc:
            raise ProviderAmbiguousError("Unknown transport outcome while creating Platega payment.") from exc

        if resp.status_code >= 500 or resp.status_code in (408, 409, 429) or 300 <= resp.status_code < 400:
            # Gateway timeout / internal error after receiving POST: payment may have been created
            raise ProviderAmbiguousError(f"Platega returned ambiguous HTTP {resp.status_code} on create.")
        if resp.status_code >= 400:
            raise ProviderUnavailableError(
                "Платёжный шлюз отклонил создание платежа. Попробуйте позже.",
                status_code=502 if resp.status_code != 503 else 503,
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderAmbiguousError("Platega returned non-JSON on 200 OK.") from exc

        if not isinstance(data, dict):
            raise ProviderAmbiguousError("Platega returned unexpected JSON root.")

        tx_id = str(data.get("transactionId") or data.get("id") or "").strip()
        raw_redirect = data.get("redirect")
        if isinstance(raw_redirect, dict):
            redirect_url = str(raw_redirect.get("url") or "").strip()
        else:
            redirect_url = str(raw_redirect or "").strip()

        if not tx_id or not redirect_url:
            raise ProviderAmbiguousError("Platega create response missing transactionId or redirect URL.")

        parsed_redirect = urlparse(redirect_url)
        if parsed_redirect.scheme != "https" or not parsed_redirect.hostname or parsed_redirect.username or parsed_redirect.password:
            # A successful POST may have created a transaction even if its URL is malformed.
            raise ProviderAmbiguousError("Platega created a payment but returned an unsafe redirect.")

        now = utc_now()
        try:
            expires_at = parse_expires_in_to_iso(data.get("expiresIn"), now)
        except (ValueError, OverflowError):
            expires_at = None
        status = normalize_provider_status(str(data.get("status") or "PENDING"))

        try:
            quoted_minor, quoted_currency = _extract_payment_details(data.get("paymentDetails"), data)
        except (ValueError, ProviderUnavailableError) as exc:
            raise ProviderAmbiguousError("Platega create response missing an exact payment quote.") from exc
        if quoted_currency != currency or quoted_minor < amount_minor:
            raise ProviderAmbiguousError("Platega create quote currency or amount does not match the request.")

        return ProviderCreateResult(
            transaction_id=tx_id,
            payment_url=redirect_url,
            status=status,
            expires_at=expires_at,
            raw_response=data,
            amount_minor=quoted_minor,
            currency=quoted_currency,
        )

    async def get_transaction(self, transaction_id: str) -> ProviderTransactionSnapshot:
        headers = self._auth_headers()
        try:
            if self._external_client is not None:
                resp = await self._external_client.get(
                    f"{self._base_url}/transaction/{quote(transaction_id, safe='')}",
                    headers=headers,
                    timeout=self._timeout,
                    follow_redirects=False,
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    resp = await client.get(
                        f"{self._base_url}/transaction/{quote(transaction_id, safe='')}",
                        headers=headers,
                        follow_redirects=False,
                    )
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError(
                "Не удалось проверить статус платежа в Platega.",
                status_code=503,
            ) from exc

        if resp.status_code == 404:
            raise ProviderNotFoundError(f"Transaction {transaction_id} not found at Platega.")
        if not 200 <= resp.status_code < 300:
            raise ProviderUnavailableError(
                f"Platega status check failed with HTTP {resp.status_code}.",
                status_code=502,
            )

        try:
            data = json.loads(resp.content, parse_float=Decimal)
        except ValueError as exc:
            raise ProviderUnavailableError("Invalid JSON from Platega status endpoint.", status_code=502) from exc

        if not isinstance(data, dict):
            raise ProviderUnavailableError("Unexpected response shape from Platega status endpoint.", status_code=502)

        tx_id = str(data.get("id") or data.get("transactionId") or "").strip()
        if tx_id != transaction_id or (data.get("id") and data.get("transactionId") and data["id"] != data["transactionId"]):
            raise ProviderUnavailableError("Platega returned a different or missing transaction ID.", status_code=502)
        merchant = data.get("merchantId", data.get("mechantId"))
        if merchant is not None and not hmac.compare_digest(str(merchant), self._merchant_id):
            raise ProviderUnavailableError("Platega transaction merchant mismatch.", status_code=502)
        method = data.get("paymentMethod")
        if method is not None and str(method).upper() not in {"2", "SBPQR"}:
            raise ProviderUnavailableError("Platega transaction payment method mismatch.", status_code=502)
        status = normalize_provider_status(str(data.get("status") or ""))
        try:
            amount_minor, currency = _extract_payment_details(data.get("paymentDetails"), data)
        except ValueError as exc:
            raise ProviderUnavailableError("Invalid monetary details from Platega.", status_code=502) from exc
        payload = str(data["payload"]) if data.get("payload") is not None else None

        refund_id = str(data["refundId"]) if data.get("refundId") else None
        refund_status = str(data["refundStatus"]) if data.get("refundStatus") else None
        try:
            # refundedAmount is cumulative; refundAmount in callbacks is one operation, not a total.
            refunded_minor = rub_to_minor_exact(data["refundedAmount"]) if data.get("refundedAmount") is not None else None
        except ValueError as exc:
            raise ProviderUnavailableError("Invalid refund details from Platega.", status_code=502) from exc

        return ProviderTransactionSnapshot(
            transaction_id=tx_id,
            status=status,
            amount_minor=amount_minor,
            currency=currency,
            payload=payload,
            refund_id=refund_id,
            refund_status=refund_status,
            refunded_amount_minor=refunded_minor,
            qr_url=safe_sbp_qr(data.get("qr")),
        )

    async def forward_foreign_callback(self, raw_body: bytes) -> bool:
        """Optional safe routing if merchant shares callback across projects."""
        if not self._fallback_callback_url:
            return False
        target = urlparse(self._fallback_callback_url)
        if target.scheme != "https" or not target.hostname or target.username or target.password:
            return False
        headers = self._auth_headers()
        try:
            if self._external_client is not None:
                resp = await self._external_client.post(
                    self._fallback_callback_url,
                    content=raw_body,
                    headers=headers,
                    timeout=5.0,
                    follow_redirects=False,
                )
            else:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.post(
                        self._fallback_callback_url,
                        content=raw_body,
                        headers=headers,
                        follow_redirects=False,
                    )
            return 200 <= resp.status_code < 300
        except httpx.HTTPError:
            return False
