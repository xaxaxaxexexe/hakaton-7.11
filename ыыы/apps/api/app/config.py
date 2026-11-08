"""Application configuration loaded safely from environment variables.

Never logs or exposes secret values (PLATEGA_API_KEY, ORDER_TOKEN_SECRET).
"""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = API_ROOT.parent.parent

PaymentProviderMode = Literal["mock", "platega"]


def _parse_origins(raw: str) -> list[str]:
    origins = [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]
    return origins or ["http://localhost:5173", "http://127.0.0.1:5173"]


@dataclass(frozen=True, slots=True)
class Settings:
    app_env: str = "development"
    payment_provider: PaymentProviderMode = "mock"
    database_path: Path = field(default_factory=lambda: API_ROOT / "data" / "zal.db")
    fixtures_dir: Path = field(default_factory=lambda: REPO_ROOT / "contracts" / "fixtures")
    public_app_url: str = "http://localhost:5173"
    public_api_url: str = "http://127.0.0.1:8000"
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")

    platega_base_url: str = "https://app.platega.io"
    platega_merchant_id: str = ""
    platega_api_key: str = ""
    platega_timeout_seconds: float = 10.0
    platega_fallback_callback_url: str = ""

    enable_external_media_network: bool = True

    order_token_secret: str = ""
    payment_reconcile_seconds: float = 15.0
    enable_background_reconciler: bool = True
    demo_checkout_minor: int = 0
    rate_limit_orders_per_minute: int = 30
    rate_limit_tickets_per_minute: int = 90

    @property
    def health_mode(self) -> Literal["mock", "live"]:
        return "mock" if self.payment_provider == "mock" else "live"

    @property
    def mode(self) -> Literal["mock", "live"]:
        return self.health_mode

    @property
    def is_live_payments(self) -> bool:
        return self.payment_provider == "platega"

    def __repr__(self) -> str:
        # Prevent accidental secret printing in tracebacks or logs.
        return (
            f"Settings(app_env={self.app_env!r}, "
            f"payment_provider={self.payment_provider!r}, "
            f"database_path={str(self.database_path)!r}, "
            f"public_app_url={self.public_app_url!r}, "
            f"platega_configured={bool(self.platega_merchant_id and self.platega_api_key)})"
        )


def load_settings(env_file: Path | None = None) -> Settings:
    target_env = env_file or (API_ROOT / ".env")
    if target_env.exists():
        load_dotenv(target_env, override=False)

    provider_raw = os.getenv("PAYMENT_PROVIDER", "mock").strip().lower()
    if provider_raw not in ("mock", "platega"):
        raise ValueError(f"Unsupported PAYMENT_PROVIDER={provider_raw!r}; expected 'mock' or 'platega'.")

    demo_checkout_minor = int(os.getenv("DEMO_CHECKOUT_MINOR", "0"))
    if demo_checkout_minor not in (0, 100):
        raise ValueError("DEMO_CHECKOUT_MINOR must be 0 (catalog price) or 100 (one-ruble demo).")

    db_raw = os.getenv("DATABASE_PATH", "./data/zal.db").strip()
    db_path = Path(db_raw)
    if not db_path.is_absolute():
        db_path = (API_ROOT / db_path).resolve()

    cors_raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    origins = tuple(_parse_origins(cors_raw))

    reconcile_raw = os.getenv("PAYMENT_RECONCILE_SECONDS", "15").strip()
    try:
        reconcile_seconds = max(1.0, float(reconcile_raw))
    except ValueError:
        reconcile_seconds = 15.0

    rate_raw = os.getenv("RATE_LIMIT_ORDERS_PER_MINUTE", "30").strip()
    try:
        rate_limit = max(1, int(rate_raw))
    except ValueError:
        rate_limit = 30

    ticket_rate_raw = os.getenv("RATE_LIMIT_TICKETS_PER_MINUTE", "90").strip()
    try:
        ticket_rate_limit = max(5, int(ticket_rate_raw))
    except ValueError:
        ticket_rate_limit = 90

    return Settings(
        demo_checkout_minor=demo_checkout_minor,
        app_env=os.getenv("APP_ENV", "development").strip() or "development",
        payment_provider=provider_raw,  # type: ignore[arg-type]
        database_path=db_path,
        fixtures_dir=REPO_ROOT / "contracts" / "fixtures",
        public_app_url=(os.getenv("PUBLIC_APP_URL", "http://localhost:5173").strip() or "http://localhost:5173").rstrip("/"),
        public_api_url=(os.getenv("PUBLIC_API_URL", "http://127.0.0.1:8000").strip() or "http://127.0.0.1:8000").rstrip("/"),
        cors_origins=origins,
        platega_base_url=(os.getenv("PLATEGA_BASE_URL", "https://app.platega.io").strip() or "https://app.platega.io").rstrip("/"),
        platega_merchant_id=os.getenv("PLATEGA_MERCHANT_ID", "").strip(),
        platega_api_key=os.getenv("PLATEGA_API_KEY", "").strip(),
        platega_timeout_seconds=float(os.getenv("PLATEGA_TIMEOUT_SECONDS", "10.0")),
        platega_fallback_callback_url=os.getenv("PLATEGA_FALLBACK_CALLBACK_URL", "").strip(),
        enable_external_media_network=os.getenv("ENABLE_EXTERNAL_MEDIA_NETWORK", "1").strip() not in ("0", "false", "False"),
        order_token_secret=os.getenv("ORDER_TOKEN_SECRET", "").strip(),
        payment_reconcile_seconds=reconcile_seconds,
        enable_background_reconciler=os.getenv("ENABLE_BACKGROUND_RECONCILER", "1").strip() not in ("0", "false", "False"),
        rate_limit_orders_per_minute=rate_limit,
        rate_limit_tickets_per_minute=ticket_rate_limit,
    )
