"""Real SQLite/API checks; temporary databases and sandbox payments only.

Run: .venv/bin/python -m unittest discover -s tests -p 'test_catalog_integration.py' -v
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings
from app.db.seed import seed_from_fixtures
from app.main import create_app

FIXTURES = REPO_ROOT / "contracts" / "fixtures"


class CatalogIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            database_path=Path(self.tmp.name) / "integration.db",
            fixtures_dir=FIXTURES,
            payment_provider="mock",
            enable_external_media_network=False,
            enable_background_reconciler=False,
            public_app_url="http://testserver",
            public_api_url="http://testserver",
        )

    def app(self, settings: Settings | None = None, **kwargs):
        return create_app(settings or self.settings, enable_background_worker=False, **kwargs)

    def create_order(self, client: TestClient) -> tuple[dict, dict, str]:
        session = client.get("/api/v1/sessions?cinema_id=stadium_nevskaya").json()["items"][0]
        availability = client.get(f"/api/v1/sessions/{session['id']}/seats").json()
        seat = next(item for item in availability["seats"] if item["status"] == "available")
        payload = {"session_id": session["id"], "seat_id": seat["seat_id"], "customer_email": "integration@example.org"}
        key = str(uuid4())
        response = client.post("/api/v1/orders", json=payload, headers={"Idempotency-Key": key})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["order"]["total_minor"], seat["price_minor"])
        return response.json(), payload, key

    def test_demo_checkout_api_keeps_catalog_prices_and_rejects_client_amount(self):
        app = self.app(replace(self.settings, demo_checkout_minor=100))
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/v1/health').json()['demo_checkout_minor'], 100)
            payload = {'session_id': 'session_nevskaya_1_C', 'seat_id': 'nevC-r06-s12', 'customer_email': 'demo@example.org'}
            availability = client.get('/api/v1/sessions/session_nevskaya_1_C/seats').json()
            self.assertEqual({s['price_minor'] for s in availability['seats']}, {70000, 120000, 350000})
            self.assertEqual(client.post('/api/v1/orders', json=payload | {'total_minor': 1}, headers={'Idempotency-Key': str(uuid4())}).status_code, 422)
            result = client.post('/api/v1/orders', json=payload, headers={'Idempotency-Key': str(uuid4())})
            self.assertEqual(result.status_code, 201, result.text)
            data = result.json()
            self.assertEqual(data['order']['total_minor'], 100)
            pricing = client.get('/api/v1/orders/' + data['order']['id'] + '/pricing', headers={'Authorization': 'Bearer ' + data['access_token']}).json()
            self.assertEqual((pricing['catalog_price_minor'], pricing['demo_discount_minor'], pricing['seat_price_minor']), (120000, 119900, 100))

    def test_catalog_geometry_and_contract_errors(self) -> None:
        with TestClient(self.app()) as client:
            self.assertEqual(client.get("/api/v1/health").json()["mode"], "mock")
            cinemas = client.get("/api/v1/cinemas").json()["items"]
            self.assertEqual(len(cinemas), 3)
            movie_ids = set()
            total = 0
            for cinema in cinemas:
                sessions = client.get("/api/v1/sessions", params={"cinema_id": cinema["id"]}).json()["items"]
                self.assertEqual(len({s["hall_id"] for s in sessions}) * 4, len(sessions))
                total += len(sessions)
                for session in sessions:
                    movie_ids.add(session["movie"]["id"])
                    self.assertEqual(client.get(f"/api/v1/sessions/{session['id']}").json(), session)
                    hall = client.get(f"/api/v1/halls/{session['hall_id']}").json()
                    availability = client.get(f"/api/v1/sessions/{session['id']}/seats").json()
                    self.assertGreater(len(hall["seats"]), 100)
                    self.assertEqual({seat["rotation_y"] for seat in hall["seats"]}.__len__(), 1)
                    self.assertEqual({s["id"] for s in hall["seats"]}, {s["seat_id"] for s in availability["seats"]})
                    self.assertEqual(session["price_from_minor"], min(s["price_minor"] for s in availability["seats"]))
            self.assertEqual(total, 60)
            self.assertEqual(len(movie_ids), 12)
            for path, status, code in [
                ("/api/v1/sessions", 422, "VALIDATION_ERROR"),
                ("/api/v1/halls/missing", 404, "NOT_FOUND"),
                ("/api/v1/sessions/missing/seats", 404, "NOT_FOUND"),
            ]:
                response = client.get(path)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["error"]["code"], code)

    def test_restart_preserves_order_access_price_and_hold(self) -> None:
        app = self.app()
        with TestClient(app) as client:
            result, payload, key = self.create_order(client)
            order_id = result["order"]["id"]
            auth = {"Authorization": "Bearer " + result["access_token"]}
            path = "/api/v1/orders/" + order_id
            self.assertEqual(client.get(path).status_code, 401)
            self.assertEqual(client.get(path, headers={"Authorization": "Bearer incorrect-token"}).status_code, 401)
            self.assertEqual(client.get(path, headers=auth).status_code, 200)
            self.assertEqual(client.get(path + "/ticket", headers=auth).json()["error"]["code"], "TICKET_NOT_READY")
            original_session = client.get("/api/v1/sessions/" + payload["session_id"]).json()
            seed_from_fixtures(app.state.container.db, FIXTURES)
            self.assertEqual(client.get("/api/v1/sessions/" + payload["session_id"]).json(), original_session)
        # No explicit ORDER_TOKEN_SECRET: generated secret must persist in SQLite.
        with TestClient(self.app()) as client:
            restored = client.get(path, headers=auth)
            self.assertEqual(restored.status_code, 200)
            self.assertEqual(restored.json()["total_minor"], result["order"]["total_minor"])
            self.assertEqual(restored.headers["Cache-Control"], "no-store")
            repeated = client.post("/api/v1/orders", json=payload, headers={"Idempotency-Key": key})
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(repeated.json()["access_token"], result["access_token"])
            self.assertEqual(repeated.json()["order"]["id"], order_id)
            availability = client.get(f"/api/v1/sessions/{payload['session_id']}/seats").json()["seats"]
            self.assertEqual(next(s for s in availability if s["seat_id"] == payload["seat_id"])["status"], "held")
            forged = client.post("/api/v1/orders", json={**payload, "total_minor": 1}, headers={"Idempotency-Key": str(uuid4())})
            self.assertEqual(forged.status_code, 422)

    def small_fixtures(self) -> Path:
        target = Path(self.tmp.name) / "fixtures"
        target.mkdir()
        halls = json.loads((FIXTURES / "halls.json").read_text())
        by_hall = {}
        for hall in halls["items"]:
            hall["seats"] = hall["seats"][:100]
            by_hall[hall["id"]] = {seat["id"] for seat in hall["seats"]}
        catalog = json.loads((FIXTURES / "catalog.json").read_text())
        hall_by_session = {s["id"]: s["hall_id"] for s in catalog["sessions"]}
        availability = json.loads((FIXTURES / "availability.json").read_text())
        for session in availability["items"]:
            ids = by_hall[hall_by_session[session["session_id"]]]
            session["seats"] = [s for s in session["seats"] if s["seat_id"] in ids]
        for name, value in [("catalog", catalog), ("halls", halls), ("availability", availability)]:
            (target / (name + ".json")).write_text(json.dumps(value))
        return target

    def test_additive_geometry_upgrade_preserves_booked_hall(self) -> None:
        old = self.small_fixtures()
        app = self.app(replace(self.settings, fixtures_dir=old))
        with TestClient(app) as client:
            result, payload, _ = self.create_order(client)
            booked_hall_id = client.get("/api/v1/sessions/" + payload["session_id"]).json()["hall_id"]
            seed_from_fixtures(app.state.container.db, FIXTURES)
            self.assertEqual(len(client.get("/api/v1/halls/" + booked_hall_id).json()["seats"]), 100)
            other = "hall_volzhsky_C" if booked_hall_id == "hall_nevskaya_C" else "hall_nevskaya_C"
            self.assertEqual(len(client.get("/api/v1/halls/" + other).json()["seats"]), 151)
            seats = client.get(f"/api/v1/sessions/{payload['session_id']}/seats").json()["seats"]
            self.assertEqual(len(seats), 100)
            self.assertEqual(next(s for s in seats if s["seat_id"] == payload["seat_id"])["status"], "held")
            order = client.get("/api/v1/orders/" + result["order"]["id"], headers={"Authorization": "Bearer " + result["access_token"]})
            self.assertEqual(order.status_code, 200)

    def test_expired_schedule_keeps_relative_days_and_each_cinema_recovers(self) -> None:
        app = self.app()
        repo = app.state.container.catalog_repo
        before = repo.list_sessions("stadium_nevskaya")
        with app.state.container.db.immediate_transaction() as conn:
            for session in before:
                past = datetime.fromisoformat(session.starts_at.replace("Z", "+00:00")) - timedelta(days=365)
                conn.execute("UPDATE sessions SET starts_at=? WHERE id=?", (past.isoformat().replace("+00:00", "Z"), session.id))
        # Other stadiums still have future matches; this one must nevertheless recover independently.
        repo.ensure_future_schedule()
        after = repo.list_sessions("stadium_nevskaya")
        self.assertEqual(len(after), 24)
        def times(items):
            return [datetime.fromisoformat(s.starts_at.replace("Z", "+00:00")) for s in items]
        original_times, new_times = times(before), times(after)
        self.assertEqual([t - original_times[0] for t in original_times], [t - new_times[0] for t in new_times])

    def test_production_has_no_public_catalog_write_or_sandbox_confirmation(self) -> None:
        with TestClient(self.app(replace(self.settings, app_env="production"))) as client:
            self.assertIn(client.post("/api/v1/catalog/import-session", json={}).status_code, (404, 405))
            self.assertIn(client.post("/__mock/orders/anything/confirm").status_code, (404, 405))
            self.assertNotIn("/api/v1/catalog/import-session", client.get("/openapi.json").json()["paths"])

    def test_spa_cannot_read_sibling_directory_via_encoded_parent(self) -> None:
        dist = Path(self.tmp.name) / "dist"
        sibling = Path(self.tmp.name) / "dist-private"
        dist.mkdir()
        sibling.mkdir()
        (dist / "index.html").write_text("PUBLIC SPA")
        (sibling / "internal.txt").write_text("PRIVATE SIBLING CONTENT")
        with TestClient(self.app(static_web_dir=dist)) as client:
            response = client.get("/%2e%2e/dist-private/internal.txt")
            self.assertNotIn("PRIVATE SIBLING CONTENT", response.text)


if __name__ == "__main__":
    unittest.main()
