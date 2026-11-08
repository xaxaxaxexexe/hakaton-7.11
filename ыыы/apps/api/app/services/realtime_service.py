"""Real-time SSE broker for instant seat status updates across tabs and devices."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
import json

from app.db.connection import utc_now_iso


class RealtimeSeatBroker:
    """In-process pub/sub hub broadcasting seat state changes (`held`, `sold`, `available`)."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)

    def publish_seat_change(self, *, session_id: str, seat_id: str, status: str) -> None:
        listeners = self._subscribers.get(session_id)
        if not listeners:
            return
        payload = json.dumps(
            {
                "type": "seat_status_changed",
                "session_id": session_id,
                "seat_id": seat_id,
                "status": status,
                "updated_at": utc_now_iso(),
            },
            ensure_ascii=False,
        )
        for queue in list(listeners):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    async def subscribe(self, session_id: str) -> AsyncIterator[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128)
        self._subscribers[session_id].add(queue)
        try:
            connected_msg = json.dumps(
                {
                    "type": "connected",
                    "session_id": session_id,
                    "updated_at": utc_now_iso(),
                },
                ensure_ascii=False,
            )
            yield f"event: connected\ndata: {connected_msg}\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: seat_update\ndata: {data}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            self._subscribers[session_id].discard(queue)
            if not self._subscribers[session_id]:
                self._subscribers.pop(session_id, None)
