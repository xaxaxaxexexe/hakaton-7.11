"""Versioned SQLite schema migrations."""
from __future__ import annotations

import secrets

from app.db.connection import Database, utc_now_iso

MIGRATION_V1_SQL = """
CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cinemas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    timezone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 0),
    age_rating TEXT NOT NULL,
    poster_url TEXT
);

CREATE TABLE IF NOT EXISTS halls (
    id TEXT PRIMARY KEY,
    cinema_id TEXT NOT NULL REFERENCES cinemas(id),
    name TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    seat_count INTEGER NOT NULL CHECK (seat_count > 0)
);

CREATE TABLE IF NOT EXISTS hall_seats (
    hall_id TEXT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
    seat_id TEXT NOT NULL,
    row_num INTEGER NOT NULL CHECK (row_num >= 1),
    seat_number INTEGER NOT NULL CHECK (seat_number >= 1),
    seat_type TEXT NOT NULL CHECK (seat_type IN ('standard', 'sofa')),
    zone TEXT NOT NULL CHECK (zone IN ('front', 'middle', 'sofa')),
    sort_order INTEGER NOT NULL,
    seat_json TEXT NOT NULL,
    PRIMARY KEY (hall_id, seat_id),
    UNIQUE (hall_id, row_num, seat_number)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cinema_id TEXT NOT NULL REFERENCES cinemas(id),
    hall_id TEXT NOT NULL REFERENCES halls(id),
    movie_id TEXT NOT NULL REFERENCES movies(id),
    starts_at TEXT NOT NULL,
    format TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    price_from_minor INTEGER NOT NULL CHECK (price_from_minor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sessions_cinema_starts
    ON sessions(cinema_id, starts_at);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    email_normalized TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seat_id TEXT NOT NULL,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    customer_email TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'creating_payment',
            'pending_payment',
            'paid',
            'canceled',
            'expired',
            'payment_review',
            'refunded'
        )
    ),
    total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    token_nonce TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('mock', 'platega')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    last_reconciled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status_expires
    ON orders(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_orders_session_seat
    ON orders(session_id, seat_id);

CREATE TABLE IF NOT EXISTS session_seats (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seat_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('available', 'held', 'sold')),
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active_order_id TEXT REFERENCES orders(id),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, seat_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_seats_active_order
    ON session_seats(active_order_id)
    WHERE active_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_seats_session_sort
    ON session_seats(session_id, sort_order);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idem_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('mock', 'platega')),
    provider_transaction_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (
        status IN (
            'CREATING',
            'PENDING',
            'CONFIRMED',
            'CANCELED',
            'EXPIRED',
            'FAILED',
            'DISPUTED',
            'CHARGEBACKED',
            'PARTIALLY_REFUNDED',
            'UNKNOWN'
        )
    ),
    payment_url TEXT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    expires_at TEXT,
    raw_response_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_tx
    ON payment_attempts(provider_transaction_id);

CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY,
    event_dedup_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    provider_transaction_id TEXT NOT NULL,
    payload_order_id TEXT,
    event_status TEXT NOT NULL,
    amount_minor INTEGER,
    currency TEXT,
    refund_id TEXT,
    refund_status TEXT,
    refunded_amount_minor INTEGER,
    raw_json TEXT NOT NULL,
    processing_status TEXT NOT NULL,
    error_note TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_events_pending
    ON payment_events(processing_status, received_at);

CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    token_hash TEXT NOT NULL UNIQUE,
    qr_token TEXT NOT NULL UNIQUE,
    film_title TEXT NOT NULL,
    cinema_name TEXT NOT NULL,
    hall_name TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    row_num INTEGER NOT NULL CHECK (row_num >= 1),
    seat_number INTEGER NOT NULL CHECK (seat_number >= 1),
    seat_type TEXT NOT NULL CHECK (seat_type IN ('standard', 'sofa')),
    paid_minor INTEGER NOT NULL CHECK (paid_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    status TEXT NOT NULL CHECK (status IN ('valid', 'suspended', 'revoked')),
    issued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

MIGRATIONS: list[tuple[int, str]] = [
    (1, MIGRATION_V1_SQL),
]


def run_migrations(db: Database) -> None:
    db.initialize_pragmas()
    with db.immediate_transaction() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            """
        )
        applied = {
            int(row["version"])
            for row in conn.execute("SELECT version FROM schema_migrations;").fetchall()
        }
        for version, sql_script in MIGRATIONS:
            if version in applied:
                continue
            for statement in (stmt.strip() for stmt in sql_script.split(";") if stmt.strip()):
                conn.execute(statement + ";")
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);",
                (version, utc_now_iso()),
            )


def resolve_or_persist_token_secret(db: Database, configured_secret: str) -> str:
    """Uses configured ORDER_TOKEN_SECRET if provided, else persists a stable generated secret in SQLite."""
    if configured_secret:
        return configured_secret
    with db.immediate_transaction() as conn:
        row = conn.execute(
            "SELECT value FROM system_meta WHERE key = 'order_token_secret';"
        ).fetchone()
        if row:
            return str(row["value"])
        generated = secrets.token_hex(32)
        conn.execute(
            "INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?);",
            ("order_token_secret", generated, utc_now_iso()),
        )
        return generated
