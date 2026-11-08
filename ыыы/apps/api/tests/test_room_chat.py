import asyncio
import json
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from app.errors import AppError
from app.services.room_chat_service import RoomChatService


class RoomChatTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.chat = RoomChatService(network_enabled=False)
        self.a, self.b = str(uuid4()), str(uuid4())
        self.cid_a, self.qa, _ = self.chat.connect("room-a", self.a, "127.0.0.1")
        self.cid_b, self.qb, _ = self.chat.connect("room-a", self.b, "127.0.0.1")

    async def send(self, visitor=None, text="Привет, зал 🍿", key=None, emote_id=None):
        return await self.chat.send("room-a", visitor=visitor or self.a, ip="127.0.0.1", nickname="Зритель", text=text, emote_id=emote_id, client_message_id=key or str(uuid4()))

    async def test_two_clients_receive_real_message_other_room_isolated(self):
        _, other, _ = self.chat.connect("room-b", str(uuid4()), "127.0.0.2")
        message = await self.send()
        received = []
        while not self.qb.empty():
            event, data = self.qb.get_nowait()
            if event == "message": received.append(data)
        self.assertEqual(received, [message])
        self.assertFalse(any(event == "message" for event, _ in list(other._queue)))
        _, _, snapshot = self.chat.connect("room-a", str(uuid4()), "127.0.0.3")
        self.assertEqual(snapshot["messages"], [message])

    async def test_presence_is_unique_and_disconnects(self):
        duplicate, _, snapshot = self.chat.connect("room-a", self.a, "127.0.0.1")
        self.assertEqual(snapshot["participants"], 2)
        self.chat.disconnect("room-a", self.cid_a)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 2)
        self.chat.disconnect("room-a", duplicate)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 1)
        self.chat.disconnect("room-a", self.cid_b)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 0)

    async def test_explicit_leave_only_removes_own_connection(self):
        self.chat.leave("room-a", self.cid_a, self.b)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 2)
        self.chat.leave("room-a", self.cid_a, self.a)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 1)
        self.chat.leave("room-a", self.cid_a, self.a)
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 1)

    async def test_retry_key_does_not_duplicate_message(self):
        key = str(uuid4())
        first = await self.send(key=key)
        second = await self.send(key=key)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.chat.rooms["room-a"].messages), 1)

    async def test_html_is_plain_text_and_limits_reject_overlong_payload(self):
        text = '<img src=x onerror="alert(1)">'
        message = await self.send(text=text)
        self.assertEqual(message["text"], text)
        self.assertNotIn("html", message)
        self.assertEqual(json.loads(json.dumps(message))["text"], text)
        with self.assertRaises(AppError): await self.send(text="x" * 301)
        with self.assertRaises(AppError): await self.send(text="")

    async def test_rate_limit_per_visitor(self):
        for _ in range(16): await self.send()
        with self.assertRaises(AppError) as failure: await self.send()
        self.assertEqual(failure.exception.status_code, 429)
        await self.send(visitor=self.b)

    async def test_shared_ip_limit_cannot_be_evaded_by_new_visitors(self):
        visitors = [self.a, self.b] + [str(uuid4()) for _ in range(18)]
        for visitor in visitors[2:]: self.chat.connect("room-a", visitor, "127.0.0.1")
        for index in range(300): await self.send(visitor=visitors[index % len(visitors)])
        with self.assertRaises(AppError) as failure: await self.send(visitor=self.b)
        self.assertEqual(failure.exception.status_code, 429)

    async def test_shared_proxy_allows_64_connections_but_keeps_a_bound(self):
        for _ in range(62): self.chat.connect("room-a", str(uuid4()), "127.0.0.1")
        self.assertEqual(self.chat.participants(self.chat.rooms["room-a"]), 64)
        with self.assertRaises(AppError) as failure:
            self.chat.connect("room-a", str(uuid4()), "127.0.0.1")
        self.assertEqual(failure.exception.status_code, 429)
        self.chat.connect("room-a", str(uuid4()), "127.0.0.2")

    async def test_history_is_bounded_and_reactions_toggle_and_isolate(self):
        message = await self.send()
        reaction = self.chat.react("room-a", visitor=self.b, ip="127.0.0.1", message_id=message["id"], emoji="❤️")
        self.assertEqual(reaction["reactions"], [{"emoji": "❤️", "count": 1}])
        self.assertEqual(self.chat.react("room-a", visitor=self.b, ip="127.0.0.1", message_id=message["id"], emoji="❤️")["reactions"], [])
        self.chat.connect("room-b", self.b, "127.0.0.1")
        with self.assertRaises(AppError): self.chat.react("room-b", visitor=self.b, ip="127.0.0.1", message_id=message["id"], emoji="❤️")
        for index in range(60):
            self.chat._limits.clear()
            await self.send(text=str(index))
        self.assertEqual(len(self.chat.rooms["room-a"].messages), 50)
        self.assertEqual(self.chat.rooms["room-a"].messages[0]["text"], "10")

    async def test_emote_allowlist_ignores_upstream_urls_and_caches(self):
        self.chat._network_enabled = True
        emote_id = "566c9fde65dbbdab32ec053e"
        raw = [{"id": emote_id, "code": "FeelsGoodMan", "image_url": "https://evil.invalid/x"}, {"id": "../../bad", "code": "bad"}, {"id": "a" * 24, "code": "modifier", "modifier": True}]
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=raw)))
        with patch("app.services.room_chat_service.httpx.AsyncClient", return_value=client) as mock:
            first = await self.chat.emotes()
            self.assertEqual(await self.chat.emotes(), first)
            self.assertEqual(mock.call_count, 1)
        self.assertEqual(first, [{"id": emote_id, "code": "FeelsGoodMan", "image_url": f"https://cdn.betterttv.net/emote/{emote_id}/2x"}])
        message = await self.send(text="", emote_id=emote_id)
        self.assertEqual(message["emote"], first[0])
        with self.assertRaises(AppError): await self.send(text="", emote_id="b" * 24)

    async def test_emote_outage_keeps_unicode_messages_working(self):
        self.chat._network_enabled = True
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503)))
        with patch("app.services.room_chat_service.httpx.AsyncClient", return_value=client):
            self.assertEqual(await self.chat.emotes(), [])
        message = await self.send(text="🍿🔥")
        self.assertEqual(message["text"], "🍿🔥")
        self.assertIsNone(message["emote"])


if __name__ == "__main__": unittest.main()
