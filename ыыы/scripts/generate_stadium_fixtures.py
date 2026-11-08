#!/usr/bin/env python3
"""Generate contracts/fixtures from the stadium description below.

A stadium is a Cinema, a sector is a Hall and a match is a Movie with one Session per sector.
Coordinates are metres from the centre of the pitch; rotation_y is the viewing direction,
so the seat map and the 3D scene read the same geometry.
"""
import json
import math
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "contracts/fixtures"

PITCH_X, PITCH_Z = 52.5, 33.75
SEAT_SPACING, BOX_SPACING = 1.65, 3.6
ROW_DEPTH, ROW_RISE, FIRST_ROW = 1.725, 0.93, 1.5
BOX_LIFT, BOX_DEPTH = 3.6, 1.8
ALWAYS_FREE = {(1, 3), (6, 12), (10, 7)}

STADIUMS = [
    {"id": "nevskaya", "name": "Арена Невская", "address": "Санкт-Петербург, Спортивная наб., 1", "roof": True, "setback": 7.5,
     "rows": 10, "per_row": 16, "boxes": 7, "prices": (700, 1200, 3500), "fan": "F", "time": "16:00",
     "sectors": [("A", "north", -33), ("B", "north", 33), ("C", "south", 0), ("D", "south", -33), ("E", "south", 33), ("F", "east", 0)],
     "matches": [("Северная Звезда", "Волжане", "Премьер-дивизион, 14-й тур", "2026-12-05"), ("Северная Звезда", "Атлант", "Кубок страны, 1/8 финала", "2026-12-19"),
                 ("Северная Звезда", "Прибой", "Премьер-дивизион, 17-й тур", "2027-03-06"), ("Северная Звезда", "Гранит", "Премьер-дивизион, 20-й тур", "2027-04-03")]},
    {"id": "volzhsky", "name": "Стадион Волжский берег", "address": "Нижний Новгород, Волжская наб., 12", "roof": True, "setback": 10.5,
     "rows": 9, "per_row": 14, "boxes": 6, "prices": (550, 950, 2800), "fan": "E", "time": "13:30",
     "sectors": [("A", "north", 0), ("B", "south", -24), ("C", "south", 0), ("D", "south", 24), ("E", "west", 0)],
     "matches": [("Волжане", "Кварц", "Премьер-дивизион, 15-й тур", "2026-12-12"), ("Волжане", "Рассвет", "Кубок страны, 1/4 финала", "2027-02-27"),
                 ("Волжане", "Прибой", "Премьер-дивизион, 19-й тур", "2027-03-20"), ("Волжане", "Атлант", "Премьер-дивизион, 22-й тур", "2027-04-17")]},
    {"id": "pribrezhny", "name": "Стадион Прибрежный", "address": "Сочи, Олимпийский пр., 8", "roof": False, "setback": 6,
     "rows": 10, "per_row": 12, "boxes": 5, "prices": (600, 1000, 3000), "fan": "A", "time": "12:00",
     "sectors": [("A", "north", 0), ("B", "south", -22), ("C", "south", 0), ("D", "south", 22)],
     "matches": [("Прибой", "Гранит", "Премьер-дивизион, 16-й тур", "2026-12-26"), ("Прибой", "Рассвет", "Кубок страны, 1/4 финала", "2027-03-13"),
                 ("Прибой", "Атлант", "Премьер-дивизион, 21-й тур", "2027-04-10"), ("Прибой", "Кварц", "Премьер-дивизион, 24-й тур", "2027-05-01")]},
]
YAW = {"south": 0.0, "north": math.pi, "east": -math.pi / 2, "west": math.pi / 2}


def position(side, offset, setback, row, rows, number, count):
    is_box = row == rows
    along = offset + (number - (count + 1) / 2) * (BOX_SPACING if is_box else SEAT_SPACING)
    depth = setback + (row - 1) * ROW_DEPTH + (BOX_DEPTH if is_box else 0)
    y = FIRST_ROW + (row - 1) * ROW_RISE + (BOX_LIFT if is_box else 0)
    x, z = {"south": (along, PITCH_Z + depth), "north": (-along, -PITCH_Z - depth),
            "east": (PITCH_X + depth, -along), "west": (-PITCH_X - depth, along)}[side]
    return {"x": round(x, 3), "y": round(y, 3), "z": round(z, 3)}


def price_factor(stadium, code, side, offset):
    if code == stadium["fan"]:
        return 0.75
    if side in ("east", "west"):
        return 0.8
    return 1.0 if offset == 0 else 0.9


def main():
    cinemas, movies, sessions, halls, availability = [], [], [], [], []
    for stadium in STADIUMS:
        cinema_id = "stadium_" + stadium["id"]
        cinemas.append({"id": cinema_id, "name": stadium["name"], "address": stadium["address"], "timezone": "Europe/Moscow"})
        extent = max(PITCH_X, PITCH_Z) * 2 + 2 * (stadium["setback"] + stadium["rows"] * ROW_DEPTH + 40)
        hall_prices = {}
        fan_side, fan_offset = next((s, o) for c, s, o in stadium["sectors"] if c == stadium["fan"])
        fan_point = position(fan_side, fan_offset, stadium["setback"], 5, stadium["rows"], 1, 1)
        for code, side, offset in stadium["sectors"]:
            hall_id = f"hall_{stadium['id']}_{code}"
            prefix = stadium["id"][:3] + code
            seats = {}
            for row in range(1, stadium["rows"] + 1):
                is_box = row == stadium["rows"]
                count = stadium["boxes"] if is_box else stadium["per_row"]
                zone = "sofa" if is_box else "front" if row <= 3 else "middle"
                for number in range(1, count + 1):
                    seats[f"{prefix}-r{row:02d}-s{number:02d}"] = {
                        "id": f"{prefix}-r{row:02d}-s{number:02d}", "row": row, "number": number,
                        "type": "sofa" if is_box else "standard", "zone": zone,
                        "position": position(side, offset, stadium["setback"], row, stadium["rows"], number, count),
                        "rotation_y": round(YAW[side], 3), "width": 3.15 if is_box else 1.35, "depth": 0.93,
                    }
            factor = price_factor(stadium, code, side, offset)
            front, middle, box = stadium["prices"]
            hall_prices[code] = {"front": round(front * factor / 50) * 50, "middle": round(middle * factor / 50) * 50, "sofa": round(box * factor / 50) * 50}
            halls.append({
                "id": hall_id, "cinema_id": cinema_id,
                "name": f"Сектор {code}" + (" · фан-сектор" if code == stadium["fan"] else ""),
                # A height of 45 m marks a roofed bowl for the 3D scene, 30 m an open one.
                "dimensions": {"width": extent, "height": 45.0 if stadium["roof"] else 30.0, "depth": extent},
                "screen": {"center": {"x": 0, "y": 0, "z": 0}, "width": PITCH_X * 2, "height": PITCH_Z * 2},
                "camera": {"eye_height": 1.53, "fov_degrees": 55, "near": 0.1, "far": 700},
                # Crowd sound sources: the home end and the opposite stand.
                "speakers": [{"id": "left", "position": fan_point}, {"id": "right", "position": {"x": -fan_point["x"], "y": fan_point["y"], "z": -fan_point["z"]}}],
                "seats": list(seats.values()),
            })
        for index, (home, away, tournament, date) in enumerate(stadium["matches"], 1):
            movie = {"id": f"match_{stadium['id']}_{index}", "title": f"{home} — {away}", "duration_minutes": 120, "age_rating": "6+", "poster_url": None}
            movies.append(movie)
            for code, side, offset in stadium["sectors"]:
                session_id = f"session_{stadium['id']}_{index}_{code}"
                hall = next(h for h in halls if h["id"] == f"hall_{stadium['id']}_{code}")
                prices = hall_prices[code]
                states = []
                for seat in hall["seats"]:
                    share = 72 if code == stadium["fan"] else 30 if seat["type"] == "sofa" else 42
                    taken = zlib.crc32(f"{session_id}:{seat['id']}".encode()) % 100 < share and (seat["row"], seat["number"]) not in ALWAYS_FREE
                    states.append({"seat_id": seat["id"], "status": "sold" if taken else "available", "price_minor": prices[seat["zone"]] * 100, "currency": "RUB"})
                sessions.append({"id": session_id, "cinema_id": cinema_id, "hall_id": hall["id"], "movie": movie,
                                 "starts_at": f"{date}T{stadium['time']}:00Z", "format": tournament, "currency": "RUB",
                                 "price_from_minor": min(s["price_minor"] for s in states)})
                availability.append({"session_id": session_id, "updated_at": "2026-11-08T09:00:00Z", "seats": states})
    dump = lambda name, value: (OUT / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    dump("catalog.json", {"cinemas": cinemas, "movies": movies, "sessions": sessions})
    dump("halls.json", {"items": halls})
    dump("availability.json", {"items": availability})
    print(f"{len(cinemas)} stadiums, {len(movies)} matches, {len(halls)} sectors, {len(sessions)} sessions")


if __name__ == "__main__":
    main()
