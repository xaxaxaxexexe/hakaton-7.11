"""Idempotent seeding from shared contracts/fixtures/ and dynamic Hall registration.

Re-running `seed_from_fixtures` NEVER deletes or overwrites existing orders, sold/held seats,
payment events, or issued tickets.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path
from typing import Any

from app.db.connection import Database, to_iso_utc, utc_now, utc_now_iso
from app.domain.models import Cinema, Hall, Movie


def _ensure_future_starts_at(raw_starts_at: str, index_offset: int) -> str:
    parsed = datetime.fromisoformat(raw_starts_at.replace("Z", "+00:00"))
    now = utc_now()
    if parsed > now + timedelta(hours=1):
        return to_iso_utc(parsed)
    # Shift onto tomorrow keeping fixture hour/minute so demo sessions are always bookable
    tomorrow = (now + timedelta(days=1)).replace(
        hour=parsed.hour,
        minute=parsed.minute,
        second=0,
        microsecond=0,
    )
    if tomorrow <= now + timedelta(hours=1):
        tomorrow = tomorrow + timedelta(hours=2 + index_offset)
    return to_iso_utc(tomorrow)


def seed_from_fixtures(db: Database, fixtures_dir: Path) -> dict[str, int]:
    catalog_path = fixtures_dir / "catalog.json"
    halls_path = fixtures_dir / "halls.json"
    availability_path = fixtures_dir / "availability.json"

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    halls_data = json.loads(halls_path.read_text(encoding="utf-8"))["items"]
    availability_data = json.loads(availability_path.read_text(encoding="utf-8"))["items"]
    avail_by_session = {item["session_id"]: item for item in availability_data}
    # Move an expired demo schedule as one block: preserve film durations, intervals and days.
    fixture_starts = [datetime.fromisoformat(item["starts_at"].replace("Z", "+00:00")) for item in catalog["sessions"]]
    schedule_shift = timedelta(0)
    if fixture_starts and min(fixture_starts) <= utc_now() + timedelta(hours=1):
        schedule_shift = timedelta(days=(utc_now().date() - min(fixture_starts).date()).days + 1)

    inserted_counts = {"cinemas": 0, "movies": 0, "halls": 0, "sessions": 0, "session_seats": 0}
    now_iso = utc_now_iso()

    with db.immediate_transaction() as conn:
        for item in catalog["cinemas"]:
            cinema = Cinema.model_validate(item)
            cur = conn.execute(
                """
                INSERT INTO cinemas (id, name, address, timezone)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, address = excluded.address, timezone = excluded.timezone
                WHERE NOT EXISTS (
                    SELECT 1 FROM orders o JOIN sessions s ON s.id = o.session_id
                    WHERE s.cinema_id = cinemas.id
                );
                """,
                (cinema.id, cinema.name, cinema.address, cinema.timezone),
            )
            inserted_counts["cinemas"] += cur.rowcount

        for item in catalog["movies"]:
            movie = Movie.model_validate(item)
            cur = conn.execute(
                """
                INSERT INTO movies (id, title, duration_minutes, age_rating, poster_url)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title, duration_minutes = excluded.duration_minutes,
                    age_rating = excluded.age_rating, poster_url = excluded.poster_url
                WHERE NOT EXISTS (
                    SELECT 1 FROM orders o JOIN sessions s ON s.id = o.session_id
                    WHERE s.movie_id = movies.id
                );
                """,
                (
                    movie.id,
                    movie.title,
                    movie.duration_minutes,
                    movie.age_rating,
                    movie.poster_url,
                ),
            )
            inserted_counts["movies"] += cur.rowcount

        for item in halls_data:
            hall = Hall.model_validate(item)
            existing = conn.execute("SELECT geometry_json FROM halls WHERE id = ?", (hall.id,)).fetchone()
            has_orders = conn.execute(
                "SELECT 1 FROM orders o JOIN sessions s ON s.id = o.session_id WHERE s.hall_id = ? LIMIT 1",
                (hall.id,),
            ).fetchone()
            if existing:
                previous_hall = Hall.model_validate_json(existing["geometry_json"])
                # Preserve the physical seat identity of every existing purchase/hold.
                # Non-additive room changes need an explicit migration, never an automatic seed.
                removed_ids = {seat.id for seat in previous_hall.seats} - {seat.id for seat in hall.seats}
                if has_orders or removed_ids:
                    hall = previous_hall
            cur = conn.execute(
                """
                INSERT INTO halls (id, cinema_id, name, geometry_json, seat_count)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, geometry_json = excluded.geometry_json,
                    seat_count = excluded.seat_count;
                """,
                (
                    hall.id,
                    hall.cinema_id,
                    hall.name,
                    json.dumps(hall.model_dump(mode="json"), ensure_ascii=False),
                    len(hall.seats),
                ),
            )
            inserted_counts["halls"] += cur.rowcount
            for idx, seat in enumerate(hall.seats):
                conn.execute(
                    """
                    INSERT INTO hall_seats (
                        hall_id, seat_id, row_num, seat_number, seat_type, zone, sort_order, seat_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(hall_id, seat_id) DO UPDATE SET
                        row_num = excluded.row_num, seat_number = excluded.seat_number,
                        seat_type = excluded.seat_type, zone = excluded.zone,
                        sort_order = excluded.sort_order, seat_json = excluded.seat_json;
                    """,
                    (
                        hall.id,
                        seat.id,
                        seat.row,
                        seat.number,
                        seat.type.value,
                        seat.zone.value,
                        idx,
                        json.dumps(seat.model_dump(mode="json"), ensure_ascii=False),
                    ),
                )

        for idx, session_item in enumerate(catalog["sessions"]):
            session_id = session_item["id"]
            exists = conn.execute(
                "SELECT 1 FROM sessions WHERE id = ?;",
                (session_id,),
            ).fetchone()
            if not exists:
                starts_at = to_iso_utc(fixture_starts[idx] + schedule_shift)
                movie_id = session_item["movie"]["id"]
                cur = conn.execute(
                    """
                    INSERT INTO sessions (
                        id, cinema_id, hall_id, movie_id, starts_at, format, currency, price_from_minor
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        session_id,
                        session_item["cinema_id"],
                        session_item["hall_id"],
                        movie_id,
                        starts_at,
                        session_item["format"],
                        session_item.get("currency", "RUB"),
                        int(session_item["price_from_minor"]),
                    ),
                )
                inserted_counts["sessions"] += cur.rowcount

            # Existing session times, films, prices and payment-related rows stay immutable.
            # Availability must always correspond to the geometry actually stored for this session.
            session_hall = conn.execute("SELECT hall_id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            seat_ids = {
                row["seat_id"] for row in conn.execute(
                    "SELECT seat_id FROM hall_seats WHERE hall_id = ?", (session_hall["hall_id"],)
                )
            }

            avail_fixture = avail_by_session.get(session_id)
            if avail_fixture:
                for seat_idx, seat_avail in enumerate(avail_fixture["seats"]):
                    if seat_avail["seat_id"] not in seat_ids:
                        continue
                    cur = conn.execute(
                        """
                        INSERT INTO session_seats (
                            session_id, seat_id, status, price_minor, currency, sort_order, active_order_id, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
                        ON CONFLICT(session_id, seat_id) DO NOTHING;
                        """,
                        (
                            session_id,
                            seat_avail["seat_id"],
                            seat_avail["status"],
                            int(seat_avail["price_minor"]),
                            seat_avail.get("currency", "RUB"),
                            seat_idx,
                            now_iso,
                        ),
                    )
                    inserted_counts["session_seats"] += cur.rowcount

    return inserted_counts


def register_hall_with_sessions(
    db: Database,
    *,
    cinema: Cinema | None = None,
    hall: Hall,
    zone_prices_minor: dict[str, int],
    sessions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Data-driven onboarding of a new Hall (and optional Cinema/Movies/Sessions) without touching code/routes."""
    now_iso = utc_now_iso()
    created_sessions: list[str] = []

    with db.immediate_transaction() as conn:
        if cinema is not None:
            conn.execute(
                """
                INSERT INTO cinemas (id, name, address, timezone)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    address = excluded.address,
                    timezone = excluded.timezone;
                """,
                (cinema.id, cinema.name, cinema.address, cinema.timezone),
            )

        cinema_exists = conn.execute(
            "SELECT 1 FROM cinemas WHERE id = ?;", (hall.cinema_id,)
        ).fetchone()
        if not cinema_exists:
            raise ValueError(f"Cinema {hall.cinema_id!r} does not exist.")

        conn.execute(
            """
            INSERT INTO halls (id, cinema_id, name, geometry_json, seat_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                geometry_json = excluded.geometry_json,
                seat_count = excluded.seat_count;
            """,
            (
                hall.id,
                hall.cinema_id,
                hall.name,
                json.dumps(hall.model_dump(mode="json"), ensure_ascii=False),
                len(hall.seats),
            ),
        )
        for idx, seat in enumerate(hall.seats):
            conn.execute(
                """
                INSERT INTO hall_seats (
                    hall_id, seat_id, row_num, seat_number, seat_type, zone, sort_order, seat_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(hall_id, seat_id) DO UPDATE SET
                    row_num = excluded.row_num,
                    seat_number = excluded.seat_number,
                    seat_type = excluded.seat_type,
                    zone = excluded.zone,
                    sort_order = excluded.sort_order,
                    seat_json = excluded.seat_json;
                """,
                (
                    hall.id,
                    seat.id,
                    seat.row,
                    seat.number,
                    seat.type.value,
                    seat.zone.value,
                    idx,
                    json.dumps(seat.model_dump(mode="json"), ensure_ascii=False),
                ),
            )

        for idx, sess in enumerate(sessions or []):
            movie_data = sess.get("movie")
            if isinstance(movie_data, dict):
                movie = Movie.model_validate(movie_data)
                conn.execute(
                    """
                    INSERT INTO movies (id, title, duration_minutes, age_rating, poster_url)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO NOTHING;
                    """,
                    (movie.id, movie.title, movie.duration_minutes, movie.age_rating, movie.poster_url),
                )
                movie_id = movie.id
            else:
                movie_id = str(sess["movie_id"])

            min_price = min(
                (int(zone_prices_minor.get(seat.zone.value, 50000)) for seat in hall.seats),
                default=35000,
            )
            starts_at = _ensure_future_starts_at(str(sess["starts_at"]), idx)
            session_id = str(sess["id"])
            conn.execute(
                """
                INSERT INTO sessions (
                    id, cinema_id, hall_id, movie_id, starts_at, format, currency, price_from_minor
                )
                VALUES (?, ?, ?, ?, ?, ?, 'RUB', ?)
                ON CONFLICT(id) DO NOTHING;
                """,
                (
                    session_id,
                    hall.cinema_id,
                    hall.id,
                    movie_id,
                    starts_at,
                    str(sess.get("format", "2D")),
                    min_price,
                ),
            )
            for seat_idx, seat in enumerate(hall.seats):
                price_minor = int(zone_prices_minor.get(seat.zone.value, min_price))
                conn.execute(
                    """
                    INSERT INTO session_seats (
                        session_id, seat_id, status, price_minor, currency, sort_order, active_order_id, updated_at
                    )
                    VALUES (?, ?, 'available', ?, 'RUB', ?, NULL, ?)
                    ON CONFLICT(session_id, seat_id) DO NOTHING;
                    """,
                    (session_id, seat.id, price_minor, seat_idx, now_iso),
                )
            created_sessions.append(session_id)

    return {"hall_id": hall.id, "seat_count": len(hall.seats), "sessions": created_sessions}
