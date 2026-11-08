"""SQLite connection factory with WAL, busy_timeout, foreign_keys, and BEGIN IMMEDIATE."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import threading


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    return to_iso_utc(utc_now())


class Database:
    """Manages SQLite connections per operation/request with explicit transaction boundaries.

    Designed for safe single-process concurrency (WAL + busy_timeout + write lock + BEGIN IMMEDIATE),
    and cleanly encapsulated behind repositories so migrating to PostgreSQL requires zero route/service edits.
    """

    def __init__(self, db_path: Path, *, busy_timeout_ms: int = 8000) -> None:
        self.db_path = db_path
        self.busy_timeout_ms = busy_timeout_ms
        self._write_lock = threading.RLock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=max(5.0, self.busy_timeout_ms / 1000.0),
            isolation_level=None,  # Explicit transaction control
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms};")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        return conn

    def initialize_pragmas(self) -> None:
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            conn.execute("PRAGMA foreign_keys = ON;")

    @contextmanager
    def read_connection(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def immediate_transaction(self) -> Iterator[sqlite3.Connection]:
        """Short atomic write transaction serialized with BEGIN IMMEDIATE."""
        with self._write_lock:
            conn = self.connect()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                yield conn
                conn.execute("COMMIT;")
            except BaseException:
                try:
                    conn.execute("ROLLBACK;")
                except sqlite3.Error:
                    pass
                raise
            finally:
                conn.close()

    def ping(self) -> bool:
        with self.read_connection() as conn:
            row = conn.execute("SELECT 1 AS ok;").fetchone()
            return bool(row and row["ok"] == 1)
