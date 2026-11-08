"""Strict API & domain models aligned 1:1 with contracts/openapi.json plus additive extensions."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.domain.enums import (
    OrderStatus,
    ProviderPaymentStatus,
    SeatStatus,
    SeatType,
    SeatZone,
    TicketStatus,
)

EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Vector3(StrictModel):
    x: float
    y: float
    z: float


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    mode: Literal["mock", "live"]
    api_version: Literal["1.0.0"] = "1.0.0"
    demo_checkout_minor: int = Field(default=0, ge=0)


class Cinema(StrictModel):
    id: str = Field(min_length=1)
    name: str
    address: str
    timezone: str


class CinemaListResponse(StrictModel):
    items: list[Cinema]


class Movie(StrictModel):
    id: str = Field(min_length=1)
    title: str
    duration_minutes: int = Field(ge=0)
    age_rating: str
    poster_url: str | None = None


class Session(StrictModel):
    id: str = Field(min_length=1)
    cinema_id: str = Field(min_length=1)
    hall_id: str = Field(min_length=1)
    movie: Movie
    starts_at: str
    format: str
    currency: Literal["RUB"] = "RUB"
    price_from_minor: int = Field(ge=0)


class SessionListResponse(StrictModel):
    items: list[Session]


class Seat(StrictModel):
    id: str = Field(min_length=1)
    row: int = Field(ge=1)
    number: int = Field(ge=1)
    type: SeatType
    zone: SeatZone
    position: Vector3
    rotation_y: float
    width: float = Field(gt=0)
    depth: float = Field(gt=0)


class HallDimensions(StrictModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    depth: float = Field(gt=0)


class HallScreen(StrictModel):
    center: Vector3
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class HallCamera(StrictModel):
    eye_height: float = Field(gt=0)
    fov_degrees: float = Field(gt=0, lt=180)
    near: float = Field(gt=0)
    far: float = Field(gt=0)


class HallSpeaker(StrictModel):
    id: str = Field(min_length=1)
    position: Vector3


class Hall(StrictModel):
    id: str = Field(min_length=1)
    cinema_id: str = Field(min_length=1)
    name: str
    dimensions: HallDimensions
    screen: HallScreen
    camera: HallCamera
    speakers: list[HallSpeaker]
    seats: list[Seat]


class SeatAvailability(StrictModel):
    seat_id: str = Field(min_length=1)
    status: SeatStatus
    price_minor: int = Field(ge=0)
    currency: Literal["RUB"] = "RUB"


class Availability(StrictModel):
    session_id: str = Field(min_length=1)
    updated_at: str
    seats: list[SeatAvailability]


class Payment(StrictModel):
    provider: Literal["mock", "platega"]
    status: ProviderPaymentStatus
    payment_url: str | None = None
    qr_url: str | None = None
    transaction_id: str | None = None


class Order(StrictModel):
    id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    seat_id: str = Field(min_length=1)
    status: OrderStatus
    total_minor: int = Field(ge=0)
    currency: Literal["RUB"] = "RUB"
    created_at: str
    expires_at: str | None = None
    payment: Payment
    ticket_id: str | None = None


class CreateOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    session_id: str = Field(min_length=1)
    seat_id: str = Field(min_length=1)
    customer_email: str = Field(min_length=3, max_length=254)

    @field_validator("customer_email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 254 or not EMAIL_REGEX.fullmatch(cleaned):
            raise ValueError("Укажите корректный email покупателя.")
        return cleaned


class CreateOrderResponse(StrictModel):
    order: Order
    access_token: str = Field(min_length=32)


class Ticket(StrictModel):
    id: str = Field(min_length=1)
    order_id: str = Field(min_length=1)
    film_title: str
    cinema_name: str
    hall_name: str
    starts_at: str
    timezone: str
    row: int = Field(ge=1)
    number: int = Field(ge=1)
    seat_type: SeatType
    paid_minor: int = Field(ge=0)
    currency: Literal["RUB"] = "RUB"
    status: TicketStatus
    verification_url: str
    issued_at: str


class AckResponse(StrictModel):
    ok: bool = True


# ---------------------------------------------------------------------------
# Additive Extension Models (3D View & Acoustic Intelligence, Transparency, Scalability)
# ---------------------------------------------------------------------------


class SeatAcousticMetrics(StrictModel):
    left_distance_m: float
    right_distance_m: float
    spl_offset_db: float
    stereo_pan: float
    itd_ms: float
    acoustic_balance_score: int = Field(ge=0, le=100)


class SeatViewMetrics(StrictModel):
    eye_position: Vector3
    distance_to_screen_m: float
    horizontal_fov_occupancy_deg: float
    lateral_off_axis_deg: float
    vertical_tilt_center_deg: float
    vertical_tilt_top_deg: float
    distortion_index: float = Field(ge=0.0, le=1.0)
    head_occlusion_ratio: float = Field(ge=0.0, le=1.0)
    occluding_sold_seat_ids: list[str]


class SeatInsight(StrictModel):
    seat_id: str
    row: int
    number: int
    type: SeatType
    zone: SeatZone
    status: SeatStatus
    price_minor: int
    currency: Literal["RUB"] = "RUB"
    comfort_score: int = Field(ge=0, le=100)
    badges: list[str]
    summary_ru: str
    view: SeatViewMetrics
    acoustics: SeatAcousticMetrics


class ZonePriceSummary(StrictModel):
    zone: SeatZone
    label_ru: str
    rows: list[int]
    price_minor: int
    available_count: int
    total_count: int


class SessionInsightsResponse(StrictModel):
    session_id: str
    hall_id: str
    updated_at: str
    sold_count: int
    held_count: int
    available_count: int
    zones: list[ZonePriceSummary]
    reference_seat_id: str | None
    seats: list[SeatInsight]


class SeatComparisonResponse(StrictModel):
    session_id: str
    seat_a: SeatInsight
    seat_b: SeatInsight
    price_delta_minor: int
    comfort_delta: int
    recommended_seat_id: str
    verdict_ru: str


class RecommendedSeatBucket(StrictModel):
    category: str
    title_ru: str
    reason_ru: str
    seat: SeatInsight


class SeatRecommendationsResponse(StrictModel):
    session_id: str
    items: list[RecommendedSeatBucket]


class OrderPriceBreakdownResponse(StrictModel):
    order_id: str
    seat_price_minor: int
    catalog_price_minor: int
    demo_discount_minor: int = 0
    service_fee_minor: int = 0
    insurance_upsell_minor: int = 0
    total_minor: int
    currency: Literal["RUB"] = "RUB"
    zero_hidden_fees: bool = True
    refund_policy_ru: str
    can_cancel_unpaid_hold: bool
    session_starts_at: str


class HallSummary(StrictModel):
    id: str
    cinema_id: str
    name: str
    seat_count: int
    rows_count: int
    screen_width_m: float
    screen_height_m: float


class HallListResponse(StrictModel):
    items: list[HallSummary]


class NormalizedCallbackEvent(BaseModel):
    """Validated Platega callback after normalizing camelCase / PascalCase aliases."""

    transaction_id: str
    amount_minor: int
    currency: str
    status: str
    payment_method: str
    payload: str
    refund_id: str | None = None
    refund_status: str | None = None
    refunded_amount_minor: int | None = None
    raw: dict[str, Any]
