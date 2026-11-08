import concurrent.futures
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class BookingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(server, "DB_PATH", Path(self.temp.name) / "test.sqlite3")
        self.db_patch.start()
        server.init_db()

    def tearDown(self):
        self.db_patch.stop()
        self.temp.cleanup()

    def test_catalog_has_several_stadiums_with_their_own_matches(self):
        data = server.catalog()
        self.assertGreaterEqual(len(data["stadiums"]), 3)
        for stadium in data["stadiums"]:
            self.assertTrue(stadium["sectors"])
            self.assertTrue(any(m["stadium_id"] == stadium["id"] for m in data["matches"]))
        seats = server.match_details(data["matches"][0]["id"])["seats"]
        self.assertTrue(any(s["kind"] == "box" for s in seats))
        self.assertGreater(len({s["price_rub"] for s in seats}), 2)
        self.assertTrue(any(s["occupied"] for s in seats))
        self.assertTrue(any(not s["occupied"] for s in seats))

    def test_prices_come_from_data_and_depend_on_the_seat(self):
        seats = server.match_details("nevskaya-1")["seats"]
        price = lambda row: next(s["price_rub"] for s in seats if s["sector"] == "C" and s["row_number"] == row)
        self.assertEqual((price(1), price(6), price(10)), (700, 1200, 3500))
        fan = next(s for s in seats if s["sector"] == "F" and s["row_number"] == 6)
        self.assertLess(fan["price_rub"], price(6))

    def test_seat_geometry_rises_away_from_pitch_and_faces_it(self):
        seats = server.match_details("nevskaya-1")["seats"]
        for code, axis in (("C", "z"), ("A", "z"), ("F", "x"), ("G", "x")):
            sector = [s for s in seats if s["sector"] == code]
            front = next(s for s in sector if s["row_number"] == 1)
            back = next(s for s in sector if s["row_number"] == 10)
            self.assertGreater(back["y"], front["y"])
            self.assertGreater(abs(back[axis]), abs(front[axis]))
            look = (math.sin(front["yaw"]), -math.cos(front["yaw"]))
            self.assertLess(look[0] * front["x"] + look[1] * front["z"], 0)
        row = sorted((s for s in seats if s["sector"] == "C" and s["row_number"] == 6), key=lambda s: s["seat_number"])
        self.assertLess(row[0]["x"], row[-1]["x"])

    def test_every_seat_in_a_stadium_has_its_own_position(self):
        seats = server.match_details("nevskaya-1")["seats"]
        self.assertEqual(len({(s["x"], s["y"], s["z"]) for s in seats}), len(seats))

    def test_new_stadium_needs_only_data(self):
        source = json.loads(server.DATA_PATH.read_text(encoding="utf-8"))
        source["stadiums"].append({**source["stadiums"][0], "id": "novy", "name": "Новый стадион"})
        source["matches"].append({**source["matches"][0], "id": "novy-1", "stadium": "novy", "starts_at": "2099-01-01T19:00:00"})
        path = Path(self.temp.name) / "stadiums.json"
        path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
        with patch.object(server, "DATA_PATH", path):
            server.init_db()
        self.assertIn("novy", {s["id"] for s in server.catalog()["stadiums"]})
        self.assertTrue(server.match_details("novy-1")["seats"])

    def test_weather_failure_never_breaks_a_match(self):
        match = server.catalog()["matches"][0]
        with patch.object(server, "urlopen", side_effect=OSError("offline")):
            self.assertFalse(server.match_weather(match["id"])["available"])

    def test_booking_persists_and_second_booking_fails(self):
        show = server.catalog()["matches"][0]
        seat = next(s for s in server.match_details(show["id"])["seats"] if not s["occupied"])
        status, result = server.create_order(show["id"], seat["id"], "Тест")
        self.assertEqual(status, 201)
        ticket = server.ticket_details(result["token"])
        self.assertEqual(ticket["price_rub"], seat["price_rub"])
        self.assertEqual(ticket["customer_name"], "Тест")
        self.assertTrue(next(s for s in server.match_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.create_order(show["id"], seat["id"], "Другой")[0], 409)

    def test_concurrent_booking_has_single_winner(self):
        show = server.catalog()["matches"][0]
        seat = [s for s in server.match_details(show["id"])["seats"] if not s["occupied"]][1]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: server.create_order(show["id"], seat["id"], "Гость")[0], range(2)))
        self.assertEqual(sorted(outcomes), [201, 409])

    def test_rejects_seat_from_another_stadium(self):
        data = server.catalog()
        first = data["matches"][0]
        with server.connect() as db:
            seat = db.execute("SELECT id FROM seats WHERE stadium_id != ? LIMIT 1", (first["stadium_id"],)).fetchone()
        self.assertIsNotNone(seat)
        self.assertEqual(server.create_order(first["id"], seat["id"], "Гость")[0], 404)

    def test_registration_and_demo_payment_issues_owned_ticket_once(self):
        status, account = server.register_user(" fan@example.test ", "Болельщик", "demo-password-123")
        self.assertEqual(status, 201)
        self.assertEqual(account["email"], "fan@example.test")
        self.assertEqual(server.register_user("fan@example.test", "Болельщик", "demo-password-123")[0], 409)
        self.assertEqual(server.login_user("fan@example.test", "wrong-password")[0], 401)
        self.assertEqual(server.login_user("fan@example.test", "demo-password-123")[0], 200)
        session = server.new_session(account["id"])
        self.assertEqual(server.user_from_token(session)["id"], account["id"])
        show = server.catalog()["matches"][0]
        seat = next(s for s in server.match_details(show["id"])["seats"] if not s["occupied"])
        status, payment = server.create_demo_payment(account["id"], show["id"], seat["id"])
        self.assertEqual(status, 201)
        self.assertEqual(server.create_demo_payment(account["id"], show["id"], seat["id"])[0], 409)
        self.assertTrue(next(s for s in server.match_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4111111111111111")[0], 400)
        status, paid = server.finish_demo_payment(account["id"], payment["payment_id"], "4242 4242 4242 4242")
        self.assertEqual(status, 200)
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4242424242424242")[1]["token"], paid["token"])
        self.assertEqual(server.user_tickets(account["id"])[0]["token"], paid["token"])
        self.assertEqual(server.ticket_details(paid["token"])["customer_name"], "Болельщик")
        server.delete_session(session)
        self.assertIsNone(server.user_from_token(session))

    def test_declined_demo_payment_releases_seat(self):
        _, account = server.register_user("fan2@example.test", "Болельщик", "demo-password-123")
        show = server.catalog()["matches"][0]
        seat = next(s for s in server.match_details(show["id"])["seats"] if not s["occupied"])
        _, payment = server.create_demo_payment(account["id"], show["id"], seat["id"])
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4000000000000002")[0], 402)
        self.assertFalse(next(s for s in server.match_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.create_demo_payment(account["id"], show["id"], seat["id"])[0], 201)


if __name__ == "__main__":
    unittest.main()
