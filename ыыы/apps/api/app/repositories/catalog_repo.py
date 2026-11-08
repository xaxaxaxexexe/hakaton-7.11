"""Catalog, Hall geometry, Session, and Seat Availability repository."""
from __future__ import annotations

from datetime import datetime, timedelta
import json

from app.db.connection import Database, to_iso_utc, utc_now, utc_now_iso
from app.domain.enums import SeatStatus
from app.domain.models import (
    Availability,
    Cinema,
    Hall,
    HallSummary,
    Movie,
    SeatAvailability,
    Session,
)


class CatalogRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    def list_cinemas(self) -> list[Cinema]:
        with self._db.read_connection() as conn:
            rows = conn.execute(
                "SELECT id, name, address, timezone FROM cinemas ORDER BY id ASC;"
            ).fetchall()
        return [
            Cinema(
                id=row["id"],
                name=row["name"],
                address=row["address"],
                timezone=row["timezone"],
            )
            for row in rows
        ]

    def get_cinema(self, cinema_id: str) -> Cinema | None:
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT id, name, address, timezone FROM cinemas WHERE id = ?;",
                (cinema_id,),
            ).fetchone()
        if not row:
            return None
        return Cinema(
            id=row["id"],
            name=row["name"],
            address=row["address"],
            timezone=row["timezone"],
        )

    def ensure_future_schedule(self) -> None:
        """Roll an exhausted demo schedule forward without moving any purchased session.

        Each cinema is checked separately and one common offset preserves its session spacing.
        """
        now = utc_now()
        now_iso = to_iso_utc(now)
        with self._db.immediate_transaction() as conn:
            rows = conn.execute(
                """
                SELECT s.id, s.cinema_id, s.starts_at
                FROM sessions s
                WHERE NOT EXISTS(SELECT 1 FROM orders o WHERE o.session_id = s.id)
                  AND NOT EXISTS(
                      SELECT 1 FROM sessions future
                      WHERE future.cinema_id = s.cinema_id AND future.starts_at > ?
                  )
                ORDER BY s.starts_at ASC;
                """, (now_iso,),
            ).fetchall()
            offsets: dict[str, timedelta] = {}
            for row in rows:
                old_dt = datetime.fromisoformat(str(row["starts_at"]).replace("Z", "+00:00"))
                if row["cinema_id"] not in offsets:
                    offsets[row["cinema_id"]] = timedelta(days=(now.date() - old_dt.date()).days + 1)
                conn.execute(
                    "UPDATE sessions SET starts_at = ? WHERE id = ?;",
                    (to_iso_utc(old_dt + offsets[row["cinema_id"]]), row["id"]),
                )

    def list_sessions(self, cinema_id: str, *, future_only: bool = True) -> list[Session]:
        now_iso = utc_now_iso()
        with self._db.read_connection() as conn:
            if future_only:
                rows = conn.execute(
                    """
                    SELECT
                        s.id, s.cinema_id, s.hall_id, s.starts_at, s.format, s.currency,
                        COALESCE(
                            (SELECT MIN(ss.price_minor) FROM session_seats ss WHERE ss.session_id = s.id),
                            s.price_from_minor
                        ) AS effective_price_from_minor,
                        m.id AS movie_id, m.title AS movie_title,
                        m.duration_minutes, m.age_rating, m.poster_url
                    FROM sessions s
                    JOIN movies m ON m.id = s.movie_id
                    WHERE s.cinema_id = ? AND s.starts_at > ?
                    ORDER BY s.starts_at ASC, s.id ASC;
                    """,
                    (cinema_id, now_iso),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT
                        s.id, s.cinema_id, s.hall_id, s.starts_at, s.format, s.currency,
                        COALESCE(
                            (SELECT MIN(ss.price_minor) FROM session_seats ss WHERE ss.session_id = s.id),
                            s.price_from_minor
                        ) AS effective_price_from_minor,
                        m.id AS movie_id, m.title AS movie_title,
                        m.duration_minutes, m.age_rating, m.poster_url
                    FROM sessions s
                    JOIN movies m ON m.id = s.movie_id
                    WHERE s.cinema_id = ?
                    ORDER BY s.starts_at ASC, s.id ASC;
                    """,
                    (cinema_id,),
                ).fetchall()
        return [self._row_to_session(row) for row in rows]

    def get_session(self, session_id: str) -> Session | None:
        with self._db.read_connection() as conn:
            row = conn.execute(
                """
                SELECT
                    s.id, s.cinema_id, s.hall_id, s.starts_at, s.format, s.currency,
                    COALESCE(
                        (SELECT MIN(ss.price_minor) FROM session_seats ss WHERE ss.session_id = s.id),
                        s.price_from_minor
                    ) AS effective_price_from_minor,
                    m.id AS movie_id, m.title AS movie_title,
                    m.duration_minutes, m.age_rating, m.poster_url
                FROM sessions s
                JOIN movies m ON m.id = s.movie_id
                WHERE s.id = ?;
                """,
                (session_id,),
            ).fetchone()
        if not row:
            return None
        return self._row_to_session(row)

    def get_hall(self, hall_id: str) -> Hall | None:
        with self._db.read_connection() as conn:
            row = conn.execute(
                "SELECT geometry_json FROM halls WHERE id = ?;",
                (hall_id,),
            ).fetchone()
        if not row:
            return None
        return Hall.model_validate(json.loads(row["geometry_json"]))

    def list_halls(self) -> list[HallSummary]:
        with self._db.read_connection() as conn:
            rows = conn.execute(
                "SELECT geometry_json FROM halls ORDER BY id ASC;"
            ).fetchall()
        summaries: list[HallSummary] = []
        for row in rows:
            hall = Hall.model_validate(json.loads(row["geometry_json"]))
            rows_count = len({s.row for s in hall.seats})
            summaries.append(
                HallSummary(
                    id=hall.id,
                    cinema_id=hall.cinema_id,
                    name=hall.name,
                    seat_count=len(hall.seats),
                    rows_count=rows_count,
                    screen_width_m=hall.screen.width,
                    screen_height_m=hall.screen.height,
                )
            )
        return summaries

    def get_availability(self, session_id: str) -> Availability | None:
        with self._db.read_connection() as conn:
            sess_exists = conn.execute(
                "SELECT 1 FROM sessions WHERE id = ?;",
                (session_id,),
            ).fetchone()
            if not sess_exists:
                return None

            rows = conn.execute(
                """
                SELECT seat_id, status, price_minor, currency, updated_at
                FROM session_seats
                WHERE session_id = ?
                ORDER BY sort_order ASC, seat_id ASC;
                """,
                (session_id,),
            ).fetchall()

        now_iso = utc_now_iso()
        latest_seat_ts = max((str(r["updated_at"]) for r in rows), default=now_iso)
        updated_at = max(now_iso, latest_seat_ts)

        seats = [
            SeatAvailability(
                seat_id=row["seat_id"],
                status=SeatStatus(row["status"]),
                price_minor=int(row["price_minor"]),
                currency="RUB",
            )
            for row in rows
        ]
        return Availability(
            session_id=session_id,
            updated_at=updated_at,
            seats=seats,
        )

    @staticmethod
    def _row_to_session(row: object) -> Session:
        r = row  # sqlite3.Row
        return Session(
            id=r["id"],  # type: ignore[index]
            cinema_id=r["cinema_id"],  # type: ignore[index]
            hall_id=r["hall_id"],  # type: ignore[index]
            movie=Movie(
                id=r["movie_id"],  # type: ignore[index]
                title=r["movie_title"],  # type: ignore[index]
                duration_minutes=int(r["duration_minutes"]),  # type: ignore[index]
                age_rating=r["age_rating"],  # type: ignore[index]
                poster_url=r["poster_url"],  # type: ignore[index]
            ),
            starts_at=r["starts_at"],  # type: ignore[index]
            format=r["format"],  # type: ignore[index]
            currency="RUB",
            price_from_minor=int(r["effective_price_from_minor"]),  # type: ignore[index]
        )
