"""Small anonymous session chat. One worker, bounded memory, no fabricated activity."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass, field
import hashlib
import re
import time
from typing import Any
import uuid

import httpx

from app.db.connection import utc_now_iso
from app.errors import not_found_error, rate_limited_error, validation_error

BTTV_GLOBALS = "https://api.betterttv.net/3/cached/emotes/global"
COLORS = ("#f78967", "#77b8f5", "#bca0ef", "#7cceac", "#e5b86f", "#ed97ba")
REACTIONS = frozenset(("👍", "❤️", "😂", "🔥", "👏"))


@dataclass
class Room:
    messages: deque = field(default_factory=lambda: deque(maxlen=50))
    connections: dict = field(default_factory=dict)
    reactions: dict = field(default_factory=dict)


class RoomChatService:
    def __init__(self, *, network_enabled: bool = True) -> None:
        self.rooms: dict[str, Room] = {}
        self._limits: dict[str, deque[float]] = defaultdict(deque)
        self._emotes: list[dict[str, str]] = []
        self._emotes_until = 0.0
        self._emotes_lock = asyncio.Lock()
        self._network_enabled = network_enabled

    def _rate(self, visitor: str, ip: str) -> None:
        now = time.monotonic()
        # The production ingress may share one proxy address across viewers.
        # Keep the strict visitor limit while allowing a room behind a shared IP.
        keys = (("visitor:" + visitor, 16), ("ip:" + ip, 300))
        for key, limit in keys:
            queue = self._limits[key]
            while queue and queue[0] <= now - 60:
                queue.popleft()
            if len(queue) >= limit:
                raise rate_limited_error("Слишком быстро. Подождите немного перед следующим сообщением.")
        for key, _ in keys:
            self._limits[key].append(now)
        if len(self._limits) > 2048:
            self._limits = defaultdict(deque, {key: value for key, value in self._limits.items() if value and value[-1] > now - 60})

    @staticmethod
    def participants(room: Room) -> int:
        return len({connection[0] for connection in room.connections.values()})

    def _publish(self, room: Room, event: str, data: dict) -> None:
        for _, _, queue in tuple(room.connections.values()):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait((event, data))

    def connect(self, room_id: str, visitor: str, ip: str) -> tuple[str, asyncio.Queue, dict]:
        all_connections = [connection for room in self.rooms.values() for connection in room.connections.values()]
        if len(all_connections) >= 250 or sum(connection[1] == ip for connection in all_connections) >= 64:
            raise rate_limited_error("Слишком много открытых окон чата. Закройте лишние и попробуйте снова.")
        room = self.rooms.setdefault(room_id, Room())
        connection_id = str(uuid.uuid4())
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        room.connections[connection_id] = (visitor, ip, queue)
        count = self.participants(room)
        self._publish(room, "presence", {"participants": count})
        snapshot = {"room_id": room_id, "connection_id": connection_id, "participants": count, "messages": [self._public(room, message) for message in room.messages]}
        return connection_id, queue, snapshot

    def disconnect(self, room_id: str, connection_id: str) -> None:
        room = self.rooms.get(room_id)
        if room and room.connections.pop(connection_id, None) is not None:
            self._publish(room, "presence", {"participants": self.participants(room)})

    def leave(self, room_id: str, connection_id: str, visitor: str) -> None:
        room = self.rooms.get(room_id)
        connection = room.connections.get(connection_id) if room else None
        if connection and connection[0] == visitor:
            self.disconnect(room_id, connection_id)

    def connected(self, room_id: str, connection_id: str) -> bool:
        room = self.rooms.get(room_id)
        return bool(room and connection_id in room.connections)

    def _connected(self, room_id: str, visitor: str) -> Room:
        room = self.rooms.get(room_id)
        if room is None or not any(connection[0] == visitor for connection in room.connections.values()):
            raise validation_error("Откройте чат и дождитесь подключения.")
        return room

    @staticmethod
    def _public(room: Room, message: dict) -> dict:
        return {key: value for key, value in message.items() if key != "client_message_id"} | {
            "reactions": [{"emoji": emoji, "count": len(visitors)} for emoji, visitors in room.reactions.get(message["id"], {}).items() if visitors]
        }

    async def send(self, room_id: str, *, visitor: str, ip: str, nickname: str, text: str, emote_id: str | None, client_message_id: str) -> dict:
        room = self._connected(room_id, visitor)
        for previous in room.messages:
            if previous["visitor_id"] == visitor and previous["client_message_id"] == client_message_id:
                return self._public(room, previous)
        nickname = " ".join(nickname.split())
        text = text.strip()
        if not nickname or len(nickname) > 24 or len(text) > 300 or any(ord(char) < 32 and char not in "\n\t" for char in text):
            raise validation_error("Имя — до 24 символов, сообщение — до 300 символов.")
        if not text and not emote_id:
            raise validation_error("Напишите сообщение или выберите эмоцию.")
        self._rate(visitor, ip)
        emote = None
        if emote_id:
            emote = next((item for item in await self.emotes() if item["id"] == emote_id), None)
            if emote is None:
                raise validation_error("Эта эмоция недоступна. Выберите обычный эмодзи.")
        message = {"id": str(uuid.uuid4()), "client_message_id": client_message_id, "visitor_id": visitor, "nickname": nickname, "color": COLORS[int(hashlib.sha256(visitor.encode()).hexdigest()[:8], 16) % len(COLORS)], "text": text, "emote": emote, "created_at": utc_now_iso()}
        if len(room.messages) == 50:
            room.reactions.pop(room.messages[0]["id"], None)
        room.messages.append(message)
        public = self._public(room, message)
        self._publish(room, "message", public)
        return public

    def react(self, room_id: str, *, visitor: str, ip: str, message_id: str, emoji: str) -> dict:
        room = self._connected(room_id, visitor)
        if emoji not in REACTIONS:
            raise validation_error("Неизвестная реакция.")
        if not any(message["id"] == message_id for message in room.messages):
            raise not_found_error("Сообщение уже не в истории чата.")
        self._rate(visitor, ip)
        reactions = room.reactions.setdefault(message_id, {})
        visitors = reactions.setdefault(emoji, set())
        visitors.remove(visitor) if visitor in visitors else visitors.add(visitor)
        data = {"message_id": message_id, "reactions": [{"emoji": key, "count": len(value)} for key, value in reactions.items() if value]}
        self._publish(room, "reaction", data)
        return data

    async def emotes(self) -> list[dict[str, str]]:
        if time.monotonic() < self._emotes_until or not self._network_enabled:
            return self._emotes
        async with self._emotes_lock:
            if time.monotonic() < self._emotes_until:
                return self._emotes
            try:
                async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
                    response = await client.get(BTTV_GLOBALS)
                    response.raise_for_status()
                    raw = response.json()
                if not isinstance(raw, list):
                    raise ValueError("Invalid emote list")
                self._emotes = [
                    {"id": item["id"], "code": item["code"], "image_url": f"https://cdn.betterttv.net/emote/{item['id']}/2x"}
                    for item in raw[:100]
                    if isinstance(item, dict) and re.fullmatch(r"[a-f0-9]{24}", str(item.get("id", ""))) and isinstance(item.get("code"), str) and 1 <= len(item["code"]) <= 40 and not item.get("modifier")
                ]
                self._emotes_until = time.monotonic() + 3600
            except (httpx.HTTPError, ValueError, TypeError):
                self._emotes_until = time.monotonic() + 60
            return self._emotes
