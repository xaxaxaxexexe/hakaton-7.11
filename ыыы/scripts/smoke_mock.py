#!/usr/bin/env python3
"""Exercise local purchase semantics. Never calls external payment services."""
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from check_contract import SPEC, validate
from mock_api import make_server


def run():
    server = make_server(0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_address[1])

    def request(path, method="GET", body=None, token=None, key=None, schema=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if key:
            headers["Idempotency-Key"] = key
        req = Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with urlopen(req, timeout=5) as response:
                status, data = response.status, json.load(response)
        except HTTPError as error:
            status, data = error.code, json.load(error)
        if status >= 400:
            validate(data, SPEC["components"]["schemas"]["Error"])
        elif schema:
            validate(data, SPEC["components"]["schemas"][schema])
        return status, data

    try:
        assert request("/api/v1/health", schema="Health")[1]["mode"] == "mock"
        assert len(request("/api/v1/cinemas")[1]["items"]) == 3
        sessions = request("/api/v1/sessions?cinema_id=stadium_nevskaya")[1]["items"]
        assert len(sessions) >= 2
        assert all(s["cinema_id"] == "stadium_nevskaya" for s in sessions)
        assert request("/api/v1/sessions")[0] == 422
        session = request("/api/v1/sessions/session_nevskaya_1_C", schema="Session")[1]
        assert request("/api/v1/halls/" + session["hall_id"], schema="Hall")[0] == 200
        path = "/api/v1/sessions/session_nevskaya_1_C/seats"
        request(path, schema="Availability")
        body = {"session_id": session["id"], "seat_id": "nevC-r06-s12", "customer_email": "buyer@example.org"}
        key = str(uuid.uuid4())
        status, created = request("/api/v1/orders", "POST", body, key=key, schema="CreateOrderResponse")
        assert status == 201
        order, token = created["order"], created["access_token"]
        assert order["status"] == "pending_payment" and order["ticket_id"] is None
        assert order["total_minor"] == 120000
        status, repeated = request("/api/v1/orders", "POST", body, key=key, schema="CreateOrderResponse")
        assert status == 200 and repeated == created
        conflict = dict(body, seat_id="nevC-r01-s03")
        assert request("/api/v1/orders", "POST", conflict, key=key)[1]["error"]["code"] == "IDEMPOTENCY_CONFLICT"
        assert request("/api/v1/orders", "POST", body, key=str(uuid.uuid4()))[0] == 409
        order_path = "/api/v1/orders/" + order["id"]
        assert request(order_path)[0] == 401
        assert request(order_path + "/ticket", token=token)[0] == 409
        assert request(order_path, token=token, schema="Order")[0] == 200
        confirm_path = "/__mock/orders/" + order["id"] + "/confirm"
        assert request(confirm_path, "POST", {}, token=token, schema="Order")[1]["status"] == "paid"
        first_ticket = request(order_path + "/ticket", token=token, schema="Ticket")[1]
        request(confirm_path, "POST", {}, token=token)
        assert request(order_path + "/ticket", token=token)[1]["id"] == first_ticket["id"]
        public_token = first_ticket["verification_url"].rsplit("/", 1)[-1]
        assert request("/api/v1/tickets/" + public_token, schema="Ticket")[1]["status"] == "valid"
        seats = request(path)[1]["seats"]
        assert next(s for s in seats if s["seat_id"] == body["seat_id"])["status"] == "sold"
        race_body = dict(body, seat_id="nevC-r01-s03")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: request("/api/v1/orders", "POST", race_body, key=str(uuid.uuid4()))[0], range(2)))
        assert sorted(results) == [201, 409], results
        assert request("/api/v1/orders", "POST", dict(body, customer_email="bad"), key=str(uuid.uuid4()))[0] == 422
        print("Mock smoke OK: read API, pending payment, auth, idempotency, conflict, single ticket, QR and concurrent booking.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    run()
