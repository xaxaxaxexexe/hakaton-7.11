"""OpenAPI v1 contract routes plus additive 3D/Acoustic Seat Intelligence & SSE routes."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.dependencies import (
    AppContainer,
    extract_bearer_token,
    extract_client_ip,
    get_container,
)
from app.domain.models import (
    AckResponse,
    Availability,
    CinemaListResponse,
    CreateOrderRequest,
    Hall,
    HallListResponse,
    HealthResponse,
    Order,
    OrderPriceBreakdownResponse,
    SeatComparisonResponse,
    SeatRecommendationsResponse,
    Session,
    SessionInsightsResponse,
    SessionListResponse,
    Ticket,
)
from app.errors import rate_limited_error, validation_error

router = APIRouter(prefix="/api/v1")


def _apply_no_store_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


@router.get("/health", response_model=HealthResponse, tags=["System"])
async def get_health(container: AppContainer = Depends(get_container)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        mode=container.settings.mode,
        api_version="1.0.0",
        demo_checkout_minor=container.settings.demo_checkout_minor,
    )


@router.get("/cinemas", response_model=CinemaListResponse, tags=["Catalog"])
async def list_cinemas(container: AppContainer = Depends(get_container)) -> CinemaListResponse:
    return CinemaListResponse(items=container.catalog_service.list_cinemas())


@router.get("/sessions", response_model=SessionListResponse, tags=["Catalog"])
async def list_sessions(
    cinema_id: str | None = Query(default=None),
    container: AppContainer = Depends(get_container),
) -> SessionListResponse:
    return SessionListResponse(items=container.catalog_service.list_sessions(cinema_id))


@router.get("/sessions/{session_id}", response_model=Session, tags=["Catalog"])
async def get_session(
    session_id: str,
    container: AppContainer = Depends(get_container),
) -> Session:
    return container.catalog_service.get_session(session_id)


@router.get("/halls", response_model=HallListResponse, tags=["Catalog"])
async def list_halls(container: AppContainer = Depends(get_container)) -> HallListResponse:
    return HallListResponse(items=container.catalog_service.list_halls())


@router.get("/halls/{hall_id}", response_model=Hall, tags=["Catalog"])
async def get_hall(
    hall_id: str,
    container: AppContainer = Depends(get_container),
) -> Hall:
    return container.catalog_service.get_hall(hall_id)


@router.get("/sessions/{session_id}/seats", response_model=Availability, tags=["Availability"])
async def get_session_seats(
    session_id: str,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> Availability:
    response.headers["Cache-Control"] = "no-store"
    return container.catalog_service.get_availability(session_id)


@router.get(
    "/sessions/{session_id}/insights",
    response_model=SessionInsightsResponse,
    tags=["Seat Intelligence"],
)
async def get_session_insights(
    session_id: str,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> SessionInsightsResponse:
    response.headers["Cache-Control"] = "no-store"
    return container.catalog_service.get_session_insights(session_id)


@router.get(
    "/sessions/{session_id}/compare",
    response_model=SeatComparisonResponse,
    tags=["Seat Intelligence"],
)
async def compare_session_seats(
    session_id: str,
    seat_a: str | None = Query(default=None),
    seat_b: str | None = Query(default=None),
    container: AppContainer = Depends(get_container),
) -> SeatComparisonResponse:
    return container.catalog_service.compare_seats(session_id, seat_a, seat_b)


@router.get(
    "/sessions/{session_id}/recommendations",
    response_model=SeatRecommendationsResponse,
    tags=["Seat Intelligence"],
)
async def get_session_recommendations(
    session_id: str,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> SeatRecommendationsResponse:
    response.headers["Cache-Control"] = "no-store"
    return container.catalog_service.get_recommendations(session_id)


@router.get("/sessions/{session_id}/stream", tags=["Availability"])
async def stream_session_seats(
    session_id: str,
    container: AppContainer = Depends(get_container),
) -> StreamingResponse:
    # Ensure session exists before opening SSE stream
    container.catalog_service.get_session(session_id)
    return StreamingResponse(
        container.realtime.subscribe(session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/orders", tags=["Orders"])
async def create_order(
    payload: CreateOrderRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    container: AppContainer = Depends(get_container),
) -> JSONResponse:
    client_ip = extract_client_ip(request)
    if not container.orders_limiter.allow(client_ip):
        raise rate_limited_error("Слишком много запросов на создание заказа. Подождите минуту.")

    result, status_code = await container.booking_service.create_order(
        idempotency_key=idempotency_key,
        payload=payload,
    )
    return JSONResponse(
        status_code=status_code,
        content=result.model_dump(mode="json"),
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    )


@router.get("/orders/{order_id}", response_model=Order, tags=["Orders"])
async def get_order(
    order_id: str,
    request: Request,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> Order:
    _apply_no_store_headers(response)
    token = extract_bearer_token(request)
    return await container.booking_service.get_order(order_id, token)


@router.get(
    "/orders/{order_id}/pricing",
    response_model=OrderPriceBreakdownResponse,
    tags=["Orders"],
)
async def get_order_pricing(
    order_id: str,
    request: Request,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> OrderPriceBreakdownResponse:
    _apply_no_store_headers(response)
    token = extract_bearer_token(request)
    return container.booking_service.get_price_breakdown(order_id, token)


@router.post("/orders/{order_id}/cancel", response_model=Order, tags=["Orders"])
async def cancel_unpaid_order(
    order_id: str,
    request: Request,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> Order:
    _apply_no_store_headers(response)
    token = extract_bearer_token(request)
    return await container.booking_service.cancel_unpaid_hold(order_id, token)


@router.get("/orders/{order_id}/ticket", response_model=Ticket, tags=["Tickets"])
async def get_order_ticket(
    order_id: str,
    request: Request,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> Ticket:
    _apply_no_store_headers(response)
    token = extract_bearer_token(request)
    return await container.booking_service.get_order_ticket(order_id, token)


@router.get("/tickets/{token}", response_model=Ticket, tags=["Tickets"])
async def get_public_ticket(
    token: str,
    request: Request,
    response: Response,
    container: AppContainer = Depends(get_container),
) -> Ticket:
    _apply_no_store_headers(response)
    client_ip = extract_client_ip(request)
    if not container.tickets_limiter.allow(client_ip):
        raise rate_limited_error("Слишком частая проверка билетов. Повторите через минуту.")
    return container.booking_service.verify_ticket_by_token(token)


@router.post("/payments/platega/callback", response_model=AckResponse, tags=["Payments"])
async def platega_callback(
    request: Request,
    response: Response,
    x_merchant_id: str | None = Header(default=None, alias="X-MerchantId"),
    x_secret: str | None = Header(default=None, alias="X-Secret"),
    container: AppContainer = Depends(get_container),
) -> AckResponse:
    _apply_no_store_headers(response)
    raw_bytes = await request.body()
    try:
        body = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise validation_error("Некорректный JSON в теле callback.") from exc

    return await container.payment_service.handle_platega_callback(
        merchant_id_header=x_merchant_id,
        secret_header=x_secret,
        body=body,
        raw_bytes=raw_bytes,
    )
