"""SEKTOR stadium ticketing API — FastAPI application factory."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.chat_routes import chat_router
from app.api.dependencies import AppContainer
from app.api.routes import router as v1_router
from app.api.sandbox_routes import sandbox_router
from app.config import Settings, load_settings
from app.db.connection import Database
from app.db.migrations import resolve_or_persist_token_secret, run_migrations
from app.db.seed import seed_from_fixtures
from app.errors import AppError
from app.providers.base import PaymentProvider
from app.providers.platega import PlategaPaymentProvider
from app.providers.sandbox import SandboxPaymentProvider
from app.repositories.booking_repo import BookingRepository
from app.repositories.catalog_repo import CatalogRepository
from app.security import SlidingWindowRateLimiter, TokenManager
from app.services.booking_service import BookingService
from app.services.catalog_service import CatalogService
from app.services.payment_service import PaymentService
from app.services.realtime_service import RealtimeSeatBroker
from app.services.room_chat_service import RoomChatService
from app.workers.reconciler import PaymentReconciliationWorker

logger = logging.getLogger("zal.api")


def build_container(
    settings: Settings,
    *,
    provider_override: PaymentProvider | None = None,
) -> AppContainer:
    db = Database(settings.database_path)
    run_migrations(db)
    seed_from_fixtures(db, settings.fixtures_dir)

    effective_secret = resolve_or_persist_token_secret(db, settings.order_token_secret)
    token_manager = TokenManager(effective_secret)

    catalog_repo = CatalogRepository(db)
    catalog_repo.ensure_future_schedule()

    booking_repo = BookingRepository(db, token_manager, settings.public_app_url, demo_checkout_minor=settings.demo_checkout_minor)
    realtime = RealtimeSeatBroker()

    if provider_override is not None:
        provider = provider_override
    elif settings.payment_provider == "platega":
        provider = PlategaPaymentProvider(
            base_url=settings.platega_base_url,
            merchant_id=settings.platega_merchant_id,
            api_key=settings.platega_api_key,
            public_app_url=settings.public_app_url,
            timeout_seconds=settings.platega_timeout_seconds,
            fallback_callback_url=settings.platega_fallback_callback_url,
        )
    else:
        provider = SandboxPaymentProvider(
            db,
            public_api_url=settings.public_api_url,
        )

    catalog_service = CatalogService(catalog_repo)
    payment_service = PaymentService(
        settings=settings,
        booking_repo=booking_repo,
        provider=provider,
        realtime=realtime,
    )
    booking_service = BookingService(
        booking_repo=booking_repo,
        catalog_repo=catalog_repo,
        token_manager=token_manager,
        provider=provider,
        payment_service=payment_service,
        realtime=realtime,
    )
    reconciler = PaymentReconciliationWorker(
        payment_service=payment_service,
        interval_seconds=settings.payment_reconcile_seconds,
    )

    return AppContainer(
        settings=settings,
        db=db,
        token_manager=token_manager,
        catalog_repo=catalog_repo,
        booking_repo=booking_repo,
        provider=provider,
        realtime=realtime,
        catalog_service=catalog_service,
        payment_service=payment_service,
        booking_service=booking_service,
        reconciler=reconciler,
        orders_limiter=SlidingWindowRateLimiter(
            max_requests=settings.rate_limit_orders_per_minute,
            window_seconds=60.0,
        ),
        tickets_limiter=SlidingWindowRateLimiter(
            max_requests=settings.rate_limit_tickets_per_minute,
            window_seconds=60.0,
        ),
    )


def create_app(
    settings: Settings | None = None,
    *,
    provider_override: PaymentProvider | None = None,
    enable_background_worker: bool | None = None,
    static_web_dir: Path | None = None,
) -> FastAPI:
    cfg = settings or load_settings()
    container = build_container(cfg, provider_override=provider_override)
    run_worker = cfg.enable_background_reconciler if enable_background_worker is None else enable_background_worker

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if run_worker:
            container.reconciler.start()
        try:
            yield
        finally:
            if run_worker:
                await container.reconciler.stop()

    application = FastAPI(
        title="SEKTOR API",
        version="1.0.0",
        description="Stadium ticketing API with shared 2D/3D stand geometry and Platega SBP.",
        lifespan=lifespan,
    )
    application.state.container = container
    application.state.room_chat = RoomChatService(network_enabled=cfg.enable_external_media_network)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(cfg.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "Accept", "Range"],
        expose_headers=["Content-Length", "Content-Range", "Accept-Ranges"],
        max_age=600,
    )

    @application.middleware("http")
    async def security_headers_middleware(request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.url.path.startswith(("/api/v1/orders", "/api/v1/tickets", "/api/v1/payments", "/__mock")):
            response.headers.setdefault("Cache-Control", "no-store")
            response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    @application.exception_handler(AppError)
    async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first_msg = "Проверьте корректность переданных полей запроса."
        errors = exc.errors()
        if errors:
            loc = ".".join(str(p) for p in errors[0].get("loc", []) if p != "body")
            if loc:
                first_msg = f"Некорректное значение поля {loc}."
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": first_msg,
                    "retryable": False,
                }
            },
        )

    @application.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code_map = {
            401: "UNAUTHORIZED",
            403: "UNAUTHORIZED",
            404: "NOT_FOUND",
            405: "VALIDATION_ERROR",
            429: "RATE_LIMITED",
        }
        err_code = code_map.get(exc.status_code, "INTERNAL_ERROR")
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": err_code,
                    "message": str(exc.detail) if isinstance(exc.detail, str) else "Запрос отклонён.",
                    "retryable": exc.status_code >= 500,
                }
            },
        )

    @application.exception_handler(Exception)
    async def handle_unexpected_exception(_request: Request, _exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception in SEKTOR API")
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Внутренняя ошибка сервера. Попробуйте повторить запрос.",
                    "retryable": True,
                }
            },
        )

    application.include_router(v1_router)
    application.include_router(chat_router)

    # Strict production guard: local mock checkout routes exist ONLY in non-production mock mode
    if cfg.payment_provider == "mock" and cfg.app_env != "production" and provider_override is None:
        application.include_router(sandbox_router)

    # Optional single-origin SPA static serving if built frontend (`apps/web/dist`) exists
    resolved_web_dist = static_web_dir
    if resolved_web_dist is None:
        default_dist = cfg.fixtures_dir.parent.parent / "apps" / "web" / "dist"
        if (default_dist / "index.html").is_file():
            resolved_web_dist = default_dist

    if resolved_web_dist is not None and (resolved_web_dist / "index.html").is_file():
        dist_root = resolved_web_dist.resolve()
        index_html = dist_root / "index.html"

        @application.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str) -> Response:
            if full_path.startswith(("api/", "__mock/")) or full_path in ("api", "__mock"):
                return JSONResponse(
                    status_code=404,
                    content={
                        "error": {
                            "code": "NOT_FOUND",
                            "message": "Маршрут API не найден.",
                            "retryable": False,
                        }
                    },
                )
            if full_path:
                candidate = (dist_root / full_path).resolve()
                if candidate.is_relative_to(dist_root) and candidate.is_file():
                    return FileResponse(candidate)
            return FileResponse(index_html)

    return application


_default_app: FastAPI | None = None


async def app(scope, receive, send) -> None:  # type: ignore[no-untyped-def]
    """Lazy ASGI entrypoint for `uvicorn app.main:app` without side effects during test imports."""
    global _default_app
    if _default_app is None:
        _default_app = create_app()
    await _default_app(scope, receive, send)

