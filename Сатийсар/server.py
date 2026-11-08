"""Small dependency-free stadium ticketing API and static server."""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import sqlite3
import ssl
import hashlib
import hmac
import time
import zlib
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DB_PATH = Path(os.environ.get("STADIUM_DB", ROOT / "data" / "stadium.sqlite3"))
DATA_PATH = Path(os.environ.get("STADIUM_DATA", ROOT / "stadiums.json"))
TZ = ZoneInfo("Europe/Moscow")
MAX_BODY = 4096
SESSION_DAYS = 30
HOLD_MINUTES = 10
COOKIE_NAME = "tribuna_session"
WEATHER_TTL_SECONDS = 1800
FORECAST_DAYS = 14
_weather_cache: dict[str, tuple[float, dict]] = {}

# Stand geometry in scene units (1 unit is 1.5 m). The 3D view reads these
# coordinates from the API, so the seat map and the scene cannot disagree.
PITCH_HALF_X = 35.0
PITCH_HALF_Z = 22.5
SEAT_SPACING = 1.1
BOX_SPACING = 2.4
ROW_DEPTH = 1.15
ROW_RISE = 0.62
FIRST_ROW_HEIGHT = 1.0
BOX_TIER_LIFT = 2.4
BOX_TIER_DEPTH = 1.2


def seat_position(sector: dict, setback: float, row: int, rows: int, number: int, count: int) -> tuple[float, float, float, float]:
    """Return x, y, z and viewing yaw. Seat numbers grow left to right for a seated fan."""
    is_box = row == rows
    spacing = BOX_SPACING if is_box else SEAT_SPACING
    along = sector["offset"] + (number - (count + 1) / 2) * spacing
    depth = setback + (row - 1) * ROW_DEPTH + (BOX_TIER_DEPTH if is_box else 0)
    height = FIRST_ROW_HEIGHT + (row - 1) * ROW_RISE + (BOX_TIER_LIFT if is_box else 0)
    side = sector["side"]
    if side == "south":
        return along, height, PITCH_HALF_Z + depth, 0.0
    if side == "north":
        return -along, height, -PITCH_HALF_Z - depth, math.pi
    if side == "east":
        return PITCH_HALF_X + depth, height, -along, -math.pi / 2
    if side == "west":
        return -PITCH_HALF_X - depth, height, along, math.pi / 2
    raise ValueError(f"Неизвестная сторона трибуны: {side}")


def seat_price(stadium: dict, sector: dict, row: int) -> int:
    prices = stadium["prices"]
    base = prices["box"] if row == stadium["rows"] else prices["front"] if row <= 3 else prices["middle"]
    return int(round(base * sector.get("price_factor", 1) / 50) * 50)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


def init_db() -> None:
    with closing(connect()) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS clubs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, short TEXT NOT NULL, color TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stadiums (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL,
                lat REAL NOT NULL, lon REAL NOT NULL, rows_count INTEGER NOT NULL,
                seats_per_row INTEGER NOT NULL, boxes INTEGER NOT NULL, roof INTEGER NOT NULL,
                setback REAL NOT NULL, home_club TEXT NOT NULL REFERENCES clubs(id)
            );
            CREATE TABLE IF NOT EXISTS sectors (
                stadium_id TEXT NOT NULL REFERENCES stadiums(id), code TEXT NOT NULL,
                side TEXT NOT NULL, offset_along REAL NOT NULL, is_fan INTEGER NOT NULL,
                PRIMARY KEY(stadium_id, code)
            );
            CREATE TABLE IF NOT EXISTS seats (
                id INTEGER PRIMARY KEY, stadium_id TEXT NOT NULL REFERENCES stadiums(id),
                sector TEXT NOT NULL, row_number INTEGER NOT NULL, seat_number INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('regular','box')),
                x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, yaw REAL NOT NULL, price_rub INTEGER NOT NULL,
                UNIQUE(stadium_id, sector, row_number, seat_number)
            );
            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY, stadium_id TEXT NOT NULL REFERENCES stadiums(id),
                home_club TEXT NOT NULL REFERENCES clubs(id), away_club TEXT NOT NULL REFERENCES clubs(id),
                tournament TEXT NOT NULL, starts_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE,
                match_id TEXT NOT NULL REFERENCES matches(id),
                seat_id INTEGER NOT NULL REFERENCES seats(id),
                customer_name TEXT NOT NULL, price_rub INTEGER NOT NULL,
                created_at TEXT NOT NULL, user_id INTEGER REFERENCES users(id),
                UNIQUE(match_id, seat_id)
            );
            CREATE TABLE IF NOT EXISTS demo_seeded (match_id TEXT PRIMARY KEY REFERENCES matches(id));
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                password_salt BLOB NOT NULL, password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS demo_payments (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
                match_id TEXT NOT NULL REFERENCES matches(id),
                seat_id INTEGER NOT NULL REFERENCES seats(id), amount_rub INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','succeeded','declined','expired','cancelled')),
                created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
                ticket_token TEXT REFERENCES tickets(token)
            );
            CREATE INDEX IF NOT EXISTS idx_matches_stadium_time ON matches(stadium_id, starts_at);
            CREATE INDEX IF NOT EXISTS idx_tickets_match ON tickets(match_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_payments_seat ON demo_payments(match_id,seat_id,status);
        """)
        sync_data(db)


def sync_data(db: sqlite3.Connection) -> None:
    """Load stadiums, prices and fixtures from JSON; issued tickets keep their paid price."""
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    db.execute("BEGIN IMMEDIATE")
    try:
        for club in data["clubs"]:
            db.execute("""INSERT INTO clubs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,short=excluded.short,color=excluded.color""",
                (club["id"], club["name"], club["short"], club["color"]))
        for stadium in data["stadiums"]:
            sid, rows = stadium["id"], stadium["rows"]
            db.execute("""INSERT INTO stadiums VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,city=excluded.city,address=excluded.address,lat=excluded.lat,lon=excluded.lon,
                roof=excluded.roof,home_club=excluded.home_club""",
                (sid, stadium["name"], stadium["city"], stadium["address"], stadium["lat"], stadium["lon"], rows,
                 stadium["seats_per_row"], stadium["boxes"], int(stadium["roof"]), stadium["setback"], stadium["home"]))
            for sector in stadium["sectors"]:
                db.execute("""INSERT INTO sectors VALUES (?,?,?,?,?) ON CONFLICT(stadium_id,code) DO UPDATE SET
                    side=excluded.side,offset_along=excluded.offset_along,is_fan=excluded.is_fan""",
                    (sid, sector["code"], sector["side"], sector["offset"], int(sector.get("fan", False))))
                for row in range(1, rows + 1):
                    is_box = row == rows
                    count = stadium["boxes"] if is_box else stadium["seats_per_row"]
                    for number in range(1, count + 1):
                        x, y, z, yaw = seat_position(sector, stadium["setback"], row, rows, number, count)
                        db.execute("""INSERT INTO seats(stadium_id,sector,row_number,seat_number,kind,x,y,z,yaw,price_rub)
                            VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stadium_id,sector,row_number,seat_number) DO UPDATE SET
                            x=excluded.x,y=excluded.y,z=excluded.z,yaw=excluded.yaw,price_rub=excluded.price_rub""",
                            (sid, sector["code"], row, number, "box" if is_box else "regular", x, y, z, yaw, seat_price(stadium, sector, row)))
        for match in data["matches"]:
            db.execute("""INSERT INTO matches VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                home_club=excluded.home_club,away_club=excluded.away_club,tournament=excluded.tournament,starts_at=excluded.starts_at""",
                (match["id"], match["stadium"], match["home"], match["away"], match["tournament"], match["starts_at"]))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def seed_demo_crowd(db: sqlite3.Connection, match_id: str) -> None:
    """Fill a match with demo fans on first open so the map and 3D crowd start out believable."""
    match = db.execute("SELECT stadium_id FROM matches WHERE id=?", (match_id,)).fetchone()
    if not match or db.execute("SELECT 1 FROM demo_seeded WHERE match_id=?", (match_id,)).fetchone():
        return
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute("SELECT 1 FROM demo_seeded WHERE match_id=?", (match_id,)).fetchone():
            db.execute("COMMIT")
            return
        fan_sectors = {r["code"] for r in db.execute("SELECT code FROM sectors WHERE stadium_id=? AND is_fan=1", (match["stadium_id"],))}
        now = datetime.now(TZ).isoformat()
        for seat in db.execute("SELECT id,sector,kind,price_rub FROM seats WHERE stadium_id=?", (match["stadium_id"],)).fetchall():
            share = 72 if seat["sector"] in fan_sectors else 30 if seat["kind"] == "box" else 42
            if zlib.crc32(f"{match_id}:{seat['id']}".encode()) % 100 < share:
                db.execute("""INSERT OR IGNORE INTO tickets(token,match_id,seat_id,customer_name,price_rub,created_at)
                    VALUES (?,?,?,?,?,?)""", (secrets.token_urlsafe(24), match_id, seat["id"], "Болельщик", seat["price_rub"], now))
        db.execute("INSERT INTO demo_seeded(match_id) VALUES (?)", (match_id,))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


MATCH_SELECT = """SELECT m.id,m.stadium_id,m.tournament,m.starts_at,
    h.id AS home_id,h.name AS home_name,h.short AS home_short,h.color AS home_color,
    a.id AS away_id,a.name AS away_name,a.short AS away_short,a.color AS away_color
    FROM matches m JOIN clubs h ON h.id=m.home_club JOIN clubs a ON a.id=m.away_club"""


def catalog() -> dict:
    now = datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S")
    with closing(connect()) as db:
        stadiums = []
        for row in db.execute("SELECT * FROM stadiums ORDER BY name").fetchall():
            sectors = [dict(s) for s in db.execute("""SELECT code,side,offset_along,is_fan FROM sectors
                WHERE stadium_id=? ORDER BY code""", (row["id"],))]
            prices = db.execute("SELECT MIN(price_rub) AS low,MAX(price_rub) AS high FROM seats WHERE stadium_id=?", (row["id"],)).fetchone()
            stadiums.append({**dict(row), "roof": bool(row["roof"]), "sectors": sectors, "price_from": prices["low"], "price_to": prices["high"]})
        matches = [dict(r) for r in db.execute(f"{MATCH_SELECT} WHERE m.starts_at > ? ORDER BY m.starts_at", (now,))]
    return {"stadiums": stadiums, "matches": matches, "server_time": now}


def match_details(match_id: str) -> dict | None:
    with closing(connect()) as db:
        expire_payments(db)
        match = db.execute(f"{MATCH_SELECT} WHERE m.id=?", (match_id,)).fetchone()
        if not match:
            return None
        seed_demo_crowd(db, match_id)
        seats = [dict(r) for r in db.execute("""SELECT s.id,s.sector,s.row_number,s.seat_number,s.kind,s.x,s.y,s.z,s.yaw,s.price_rub,
            (t.id IS NOT NULL OR EXISTS(SELECT 1 FROM demo_payments p WHERE p.seat_id=s.id AND p.match_id=? AND p.status='pending')) AS occupied
            FROM seats s LEFT JOIN tickets t ON t.seat_id=s.id AND t.match_id=?
            WHERE s.stadium_id=? ORDER BY s.sector,s.row_number,s.seat_number""", (match_id, match_id, match["stadium_id"]))]
    return {"match": dict(match), "seats": seats}


def tls_context() -> ssl.SSLContext:
    """Python.org builds on macOS ship without CA roots, so fall back to the system bundle."""
    context = ssl.create_default_context()
    if not context.get_ca_certs() and Path("/etc/ssl/cert.pem").is_file():
        context.load_verify_locations("/etc/ssl/cert.pem")
    return context


def match_weather(match_id: str) -> dict | None:
    """Kick-off forecast from Open-Meteo. The purchase path never depends on this call."""
    with closing(connect()) as db:
        row = db.execute("""SELECT m.starts_at,s.lat,s.lon,s.city FROM matches m
            JOIN stadiums s ON s.id=m.stadium_id WHERE m.id=?""", (match_id,)).fetchone()
    if not row:
        return None
    kickoff = datetime.fromisoformat(row["starts_at"])
    days_ahead = (kickoff.date() - datetime.now(TZ).date()).days
    if days_ahead < 0 or days_ahead > FORECAST_DAYS:
        return {"available": False, "message": f"Прогноз появится за {FORECAST_DAYS} дней до матча."}
    cached = _weather_cache.get(match_id)
    if cached and time.monotonic() - cached[0] < WEATHER_TTL_SECONDS:
        return cached[1]
    query = urlencode({"latitude": row["lat"], "longitude": row["lon"], "timezone": "Europe/Moscow",
                       "hourly": "temperature_2m,precipitation_probability,wind_speed_10m",
                       "start_date": kickoff.date().isoformat(), "end_date": kickoff.date().isoformat()})
    try:
        with urlopen(Request(f"https://api.open-meteo.com/v1/forecast?{query}", headers={"User-Agent": "Tribuna/1.0"}), timeout=8, context=tls_context()) as response:
            hourly = json.load(response)["hourly"]
        index = hourly["time"].index(kickoff.strftime("%Y-%m-%dT%H:00"))
        result = {"available": True, "city": row["city"], "temperature_c": round(hourly["temperature_2m"][index]),
                  "precipitation_pct": hourly["precipitation_probability"][index],
                  "wind_kmh": round(hourly["wind_speed_10m"][index]), "source": "Open-Meteo"}
    except (OSError, URLError, TimeoutError, KeyError, ValueError, IndexError, TypeError):
        return {"available": False, "message": "Сервис погоды сейчас недоступен."}
    _weather_cache[match_id] = (time.monotonic(), result)
    return result


def create_order(match_id: str, seat_id: int, name: str) -> tuple[int, dict]:
    name = name.strip()
    if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
        return 400, {"error": "Укажите имя (до 80 символов)."}
    with closing(connect()) as db:
        seed_demo_crowd(db, match_id)
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT s.price_rub, m.starts_at
                FROM matches m JOIN seats s ON s.stadium_id=m.stadium_id
                WHERE m.id=? AND s.id=?""", (match_id, seat_id)).fetchone()
            if row is None:
                db.execute("ROLLBACK")
                return 404, {"error": "Матч или место не найдены."}
            if datetime.fromisoformat(row["starts_at"]).replace(tzinfo=TZ) <= datetime.now(TZ):
                db.execute("ROLLBACK")
                return 409, {"error": "Этот матч уже начался."}
            token = secrets.token_urlsafe(24)
            db.execute("INSERT INTO tickets(token,match_id,seat_id,customer_name,price_rub,created_at) VALUES (?,?,?,?,?,?)", (token, match_id, seat_id, name, row["price_rub"], datetime.now(TZ).isoformat()))
            db.execute("COMMIT")
            return 201, {"token": token}
        except sqlite3.IntegrityError:
            db.execute("ROLLBACK")
            return 409, {"error": "Это место уже куплено. Выберите другое."}


def ticket_details(token: str) -> dict | None:
    with closing(connect()) as db:
        row = db.execute("""SELECT t.token,t.customer_name,t.price_rub,t.created_at,
            m.starts_at,m.tournament,h.name AS home_name,a.name AS away_name,
            st.name AS stadium_name,st.address,
            s.sector,s.row_number,s.seat_number,s.kind
            FROM tickets t JOIN matches m ON m.id=t.match_id
            JOIN clubs h ON h.id=m.home_club JOIN clubs a ON a.id=m.away_club
            JOIN stadiums st ON st.id=m.stadium_id
            JOIN seats s ON s.id=t.seat_id WHERE t.token=?""", (token,)).fetchone()
        return dict(row) if row else None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def expire_payments(db: sqlite3.Connection) -> None:
    db.execute("UPDATE demo_payments SET status='expired' WHERE status='pending' AND expires_at<=?", (stamp(utc_now()),))


def password_digest(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)


def register_user(email: str, name: str, password: str) -> tuple[int, dict]:
    email, name = email.strip().lower(), name.strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        return 400, {"error": "Укажите корректный email."}
    if not 1 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
        return 400, {"error": "Укажите имя (до 80 символов)."}
    if not 8 <= len(password) <= 128:
        return 400, {"error": "Пароль должен содержать от 8 до 128 символов."}
    salt = secrets.token_bytes(16)
    with closing(connect()) as db:
        try:
            cursor = db.execute("INSERT INTO users(email,name,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)",
                                (email, name, salt, password_digest(password, salt), stamp(utc_now())))
        except sqlite3.IntegrityError:
            return 409, {"error": "Этот email уже зарегистрирован."}
        return 201, {"id": cursor.lastrowid, "email": email, "name": name}


def login_user(email: str, password: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        row = db.execute("SELECT * FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
        if not row or not hmac.compare_digest(password_digest(password, row["password_salt"]), row["password_hash"]):
            return 401, {"error": "Неверный email или пароль."}
        return 200, {"id": row["id"], "email": row["email"], "name": row["name"]}


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with closing(connect()) as db:
        db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
                   (hashlib.sha256(token.encode()).hexdigest(), user_id, stamp(utc_now() + timedelta(days=SESSION_DAYS))))
    return token


def user_from_token(token: str | None) -> dict | None:
    if not token:
        return None
    with closing(connect()) as db:
        row = db.execute("""SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>?""", (hashlib.sha256(token.encode()).hexdigest(), stamp(utc_now()))).fetchone()
        return dict(row) if row else None


def delete_session(token: str | None) -> None:
    if token:
        with closing(connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))


def create_demo_payment(user_id: int, match_id: str, seat_id: int) -> tuple[int, dict]:
    with closing(connect()) as db:
        seed_demo_crowd(db, match_id)
        db.execute("BEGIN IMMEDIATE")
        try:
            expire_payments(db)
            row = db.execute("""SELECT s.price_rub,m.starts_at FROM matches m
                JOIN seats s ON s.stadium_id=m.stadium_id WHERE m.id=? AND s.id=?""", (match_id, seat_id)).fetchone()
            if not row:
                return 404, {"error": "Матч или место не найдены."}
            if datetime.fromisoformat(row["starts_at"]).replace(tzinfo=TZ) <= datetime.now(TZ):
                return 409, {"error": "Этот матч уже начался."}
            taken = db.execute("""SELECT 1 FROM tickets WHERE match_id=? AND seat_id=? UNION ALL
                SELECT 1 FROM demo_payments WHERE match_id=? AND seat_id=? AND status='pending' LIMIT 1""",
                (match_id, seat_id, match_id, seat_id)).fetchone()
            if taken:
                return 409, {"error": "Место уже занято или ожидает оплату. Выберите другое."}
            now = utc_now()
            payment_id = secrets.token_urlsafe(18)
            expires_at = stamp(now + timedelta(minutes=HOLD_MINUTES))
            db.execute("""INSERT INTO demo_payments(id,user_id,match_id,seat_id,amount_rub,status,created_at,expires_at)
                VALUES (?,?,?,?,?,'pending',?,?)""", (payment_id, user_id, match_id, seat_id, row["price_rub"], stamp(now), expires_at))
            db.execute("COMMIT")
            return 201, {"payment_id": payment_id, "amount_rub": row["price_rub"], "expires_at": expires_at, "status": "pending"}
        finally:
            if db.in_transaction:
                db.execute("ROLLBACK")


def finish_demo_payment(user_id: int, payment_id: str, test_card: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            expire_payments(db)
            payment = db.execute("SELECT * FROM demo_payments WHERE id=? AND user_id=?", (payment_id, user_id)).fetchone()
            if not payment:
                return 404, {"error": "Тестовый платёж не найден."}
            if payment["status"] == "succeeded":
                return 200, {"status": "succeeded", "token": payment["ticket_token"]}
            if payment["status"] != "pending":
                return 409, {"error": "Время оплаты истекло. Выберите место заново."}
            card = re.sub(r"[ -]", "", test_card)
            if card not in ("4242424242424242", "4000000000000002"):
                return 400, {"error": "Используйте только указанные тестовые номера карт."}
            if card == "4000000000000002":
                db.execute("UPDATE demo_payments SET status='declined' WHERE id=?", (payment_id,))
                db.execute("COMMIT")
                return 402, {"error": "Тестовая оплата отклонена. Деньги не списаны."}
            user = db.execute("SELECT name FROM users WHERE id=?", (user_id,)).fetchone()
            token = secrets.token_urlsafe(24)
            try:
                db.execute("""INSERT INTO tickets(token,match_id,seat_id,customer_name,price_rub,created_at,user_id)
                    VALUES (?,?,?,?,?,?,?)""", (token, payment["match_id"], payment["seat_id"], user["name"],
                    payment["amount_rub"], stamp(utc_now()), user_id))
            except sqlite3.IntegrityError:
                return 409, {"error": "Место уже занято. Выберите другое."}
            db.execute("UPDATE demo_payments SET status='succeeded',ticket_token=? WHERE id=?", (token, payment_id))
            db.execute("COMMIT")
            return 200, {"status": "succeeded", "token": token}
        finally:
            if db.in_transaction:
                db.execute("ROLLBACK")


def cancel_demo_payment(user_id: int, payment_id: str) -> tuple[int, dict]:
    with closing(connect()) as db:
        cursor = db.execute("UPDATE demo_payments SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'",
                            (payment_id, user_id))
        return (200, {"status": "cancelled"}) if cursor.rowcount else (404, {"error": "Активный платёж не найден."})


def user_tickets(user_id: int) -> list[dict]:
    with closing(connect()) as db:
        tokens = [r[0] for r in db.execute("SELECT token FROM tickets WHERE user_id=? ORDER BY id DESC", (user_id,))]
    return [ticket_details(token) for token in tokens]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        message = format % args
        message = re.sub(r"/api/tickets/[A-Za-z0-9_-]+", "/api/tickets/[redacted]", message)
        super().log_message("%s", message)

    def session_token(self) -> str | None:
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
        except Exception:
            return None

    def current_user(self) -> dict | None:
        return user_from_token(self.session_token())

    def cookie_header(self, token: str | None) -> str:
        secure = "; Secure" if os.environ.get("COOKIE_SECURE") == "1" else ""
        if token:
            return f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_DAYS * 86400}{secure}"
        return f"{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}"

    def send_json(self, status: int, value: dict, cookie: str | None = None) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(200, {"status": "ok"})
        if path == "/api/catalog":
            return self.send_json(200, catalog())
        if path == "/api/auth/me":
            return self.send_json(200, {"user": self.current_user()})
        if path == "/api/me/tickets":
            user = self.current_user()
            return self.send_json(200, {"tickets": user_tickets(user["id"])}) if user else self.send_json(401, {"error": "Войдите в аккаунт."})
        match = re.fullmatch(r"/api/matches/([a-z0-9-]{1,64})/weather", path)
        if match:
            result = match_weather(match.group(1))
            return self.send_json(200, result) if result else self.send_json(404, {"error": "Матч не найден."})
        match = re.fullmatch(r"/api/matches/([a-z0-9-]{1,64})", path)
        if match:
            result = match_details(match.group(1))
            return self.send_json(200, result) if result else self.send_json(404, {"error": "Матч не найден."})
        match = re.fullmatch(r"/api/tickets/([A-Za-z0-9_-]{20,64})", path)
        if match:
            result = ticket_details(match.group(1))
            return self.send_json(200, result) if result else self.send_json(404, {"error": "Билет не найден."})
        if path.startswith("/api/"):
            return self.send_json(404, {"error": "Адрес не найден."})
        file_name = "index.html" if path in ("/", "/index.html") or re.fullmatch(r"/match/[a-z0-9-]{1,64}", path) else path.lstrip("/")
        file_path = (WEB / file_name).resolve()
        if not file_path.is_relative_to(WEB.resolve()) or not file_path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".webmanifest": "application/manifest+json"}.get(file_path.suffix, "application/octet-stream")
        if file_path.suffix == ".mp4" and (range_header := self.headers.get("Range")):
            requested = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            size = file_path.stat().st_size
            if not requested or not any(requested.groups()):
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            start_text, end_text = requested.groups()
            if start_text:
                start = int(start_text)
                end = min(int(end_text), size - 1) if end_text else size - 1
            else:
                length = int(end_text)
                start, end = max(0, size - length), size - 1
            if start >= size or end < start:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with file_path.open("rb") as media:
                media.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = media.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        if file_path.suffix == ".mp4":
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        allowed = {"/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/payments/create", "/api/orders"}
        payment_match = re.fullmatch(r"/api/payments/([A-Za-z0-9_-]{20,40})/(confirm|cancel)", path)
        if path not in allowed and not payment_match:
            return self.send_json(404, {"error": "Адрес не найден."})
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.send_json(403, {"error": "Запрос с другого сайта отклонён."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.send_json(413, {"error": "Слишком большой запрос."})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Неверные данные запроса."})
        if path == "/api/orders":
            return self.send_json(410, {"error": "Используйте тестовую оплату для оформления билета."})
        if path == "/api/auth/register":
            if not all(isinstance(data.get(key), str) for key in ("email", "name", "password")):
                return self.send_json(400, {"error": "Заполните имя, email и пароль."})
            status, result = register_user(data["email"], data["name"], data["password"])
            return self.send_json(status, {"user": result} if status == 201 else result,
                                  self.cookie_header(new_session(result["id"])) if status == 201 else None)
        if path == "/api/auth/login":
            if not all(isinstance(data.get(key), str) for key in ("email", "password")):
                return self.send_json(400, {"error": "Укажите email и пароль."})
            status, result = login_user(data["email"], data["password"])
            return self.send_json(status, {"user": result} if status == 200 else result,
                                  self.cookie_header(new_session(result["id"])) if status == 200 else None)
        if path == "/api/auth/logout":
            delete_session(self.session_token())
            return self.send_json(200, {"ok": True}, self.cookie_header(None))
        user = self.current_user()
        if not user:
            return self.send_json(401, {"error": "Войдите в аккаунт, чтобы оформить билет."})
        if path == "/api/payments/create":
            if not isinstance(data.get("match_id"), str) or type(data.get("seat_id")) is not int:
                return self.send_json(400, {"error": "Выберите матч и место."})
            status, result = create_demo_payment(user["id"], data["match_id"], data["seat_id"])
            return self.send_json(status, result)
        if payment_match:
            payment_id, action = payment_match.groups()
            if action == "cancel":
                status, result = cancel_demo_payment(user["id"], payment_id)
            else:
                if not isinstance(data.get("test_card"), str):
                    return self.send_json(400, {"error": "Укажите тестовый номер карты."})
                status, result = finish_demo_payment(user["id"], payment_id, data["test_card"])
            return self.send_json(status, result)


def main() -> None:
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Трибуна: http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
