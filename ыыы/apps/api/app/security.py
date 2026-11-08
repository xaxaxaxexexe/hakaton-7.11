"""Cryptographic token derivation, constant-time secret verification, and rate limiting."""
from __future__ import annotations

import base64
from collections import deque
import hashlib
import hmac
import secrets
import threading
import time


class TokenManager:
    """Derives and verifies order access tokens and ticket QR tokens.

    Order access tokens are deterministically derived via HMAC-SHA256(server_secret,
    f"zal:order:v1:{order_id}:{token_nonce}") where `token_nonce` is persisted per order.
    This guarantees:
    1. Raw bearer tokens are not stored in plaintext in SQLite.
    2. Idempotent POST /orders retries return the exact same bearer token even after server restart.
    3. Verification uses constant-time `hmac.compare_digest`.
    """

    def __init__(self, secret: str) -> None:
        if not secret:
            raise ValueError("Server token secret must not be empty.")
        self._secret_bytes = secret.encode("utf-8")

    @staticmethod
    def generate_nonce() -> str:
        return secrets.token_hex(16)

    def derive_order_access_token(self, order_id: str, token_nonce: str) -> str:
        msg = f"zal:order:v1:{order_id}:{token_nonce}".encode("utf-8")
        digest = hmac.new(self._secret_bytes, msg, hashlib.sha256).digest()
        # 32 bytes -> 43 URL-safe base64 chars (>= 32 minLength in OpenAPI)
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    def verify_order_access_token(
        self,
        order_id: str,
        token_nonce: str,
        supplied_token: str | None,
    ) -> bool:
        if not supplied_token or not token_nonce:
            return False
        expected = self.derive_order_access_token(order_id, token_nonce)
        return hmac.compare_digest(expected, supplied_token)

    def derive_customer_id(self, normalized_email: str) -> str:
        msg = f"zal:customer:v1:{normalized_email}".encode("utf-8")
        return hmac.new(self._secret_bytes, msg, hashlib.sha256).hexdigest()[:24]

    @staticmethod
    def generate_ticket_token() -> tuple[str, str]:
        """Returns (public_qr_token, sha256_hex_hash). Minimum 256 bits of entropy."""
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        return raw_token, token_hash

    @staticmethod
    def hash_ticket_token(raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def verify_platega_headers(
    *,
    expected_merchant_id: str,
    expected_api_key: str,
    supplied_merchant_id: str | None,
    supplied_secret: str | None,
) -> bool:
    """Constant-time verification of Platega X-MerchantId and X-Secret headers."""
    if not expected_merchant_id or not expected_api_key:
        return False
    if not supplied_merchant_id or not supplied_secret:
        return False
    merchant_ok = hmac.compare_digest(
        expected_merchant_id.encode("utf-8"),
        supplied_merchant_id.strip().encode("utf-8"),
    )
    secret_ok = hmac.compare_digest(
        expected_api_key.encode("utf-8"),
        supplied_secret.strip().encode("utf-8"),
    )
    return merchant_ok and secret_ok


class SlidingWindowRateLimiter:
    """Thread-safe in-process sliding window rate limiter per client key."""

    def __init__(self, max_requests: int, window_seconds: float = 60.0) -> None:
        self._max_requests = max_requests
        self._window = window_seconds
        self._buckets: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self._max_requests:
                return False
            bucket.append(now)
            return True
