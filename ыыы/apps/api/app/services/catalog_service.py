"""Catalog, Hall geometry, Availability, and 3D/Acoustic Seat Intelligence service."""
from __future__ import annotations

from app.domain.models import (
    Availability,
    Cinema,
    Hall,
    HallSummary,
    SeatComparisonResponse,
    SeatRecommendationsResponse,
    Session,
    SessionInsightsResponse,
)
from app.domain.seat_intelligence import (
    build_seat_recommendations,
    compare_two_seats,
    compute_session_insights,
)
from app.errors import not_found_error, validation_error
from app.repositories.catalog_repo import CatalogRepository


class CatalogService:
    def __init__(self, catalog_repo: CatalogRepository) -> None:
        self._repo = catalog_repo

    def list_cinemas(self) -> list[Cinema]:
        return self._repo.list_cinemas()

    def list_sessions(self, cinema_id: str | None) -> list[Session]:
        if cinema_id is None or not cinema_id.strip():
            raise validation_error("Параметр cinema_id обязателен.")
        return self._repo.list_sessions(cinema_id.strip(), future_only=True)

    def get_session(self, session_id: str) -> Session:
        session = self._repo.get_session(session_id)
        if session is None:
            raise not_found_error("Матч не найден.")
        return session

    def get_hall(self, hall_id: str) -> Hall:
        hall = self._repo.get_hall(hall_id)
        if hall is None:
            raise not_found_error("Зал не найден.")
        return hall

    def list_halls(self) -> list[HallSummary]:
        return self._repo.list_halls()

    def get_availability(self, session_id: str) -> Availability:
        availability = self._repo.get_availability(session_id)
        if availability is None:
            raise not_found_error("Матч не найден.")
        return availability

    def get_session_insights(self, session_id: str) -> SessionInsightsResponse:
        session = self.get_session(session_id)
        hall = self.get_hall(session.hall_id)
        availability = self.get_availability(session_id)
        return compute_session_insights(
            hall=hall,
            session_id=session.id,
            updated_at=availability.updated_at,
            availability_items=availability.seats,
        )

    def compare_seats(
        self,
        session_id: str,
        seat_a_id: str | None,
        seat_b_id: str | None,
    ) -> SeatComparisonResponse:
        if not seat_a_id or not seat_b_id:
            raise validation_error("Укажите оба места для сравнения: seat_a и seat_b.")
        if seat_a_id == seat_b_id:
            raise validation_error("Для сравнения выберите два разных места.")
        insights = self.get_session_insights(session_id)
        comparison = compare_two_seats(insights, seat_a_id, seat_b_id)
        if comparison is None:
            raise validation_error("Одно из выбранных мест не принадлежит этому сектору.")
        return comparison

    def get_recommendations(self, session_id: str) -> SeatRecommendationsResponse:
        insights = self.get_session_insights(session_id)
        return build_seat_recommendations(insights)
