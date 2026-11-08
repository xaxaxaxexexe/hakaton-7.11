"""Additive anonymous room chat endpoints. No order tokens, emails or accounts."""
import asyncio
import json
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import AppContainer, get_container
from app.services.room_chat_service import RoomChatService

chat_router = APIRouter(prefix="/api/v1", tags=["Session chat"])


class ChatMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visitor_id: UUID
    client_message_id: UUID
    nickname: str = Field(min_length=1, max_length=24)
    text: str = Field(default="", max_length=300)
    emote_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{24}$")


class ChatReactionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visitor_id: UUID
    message_id: UUID
    emoji: str = Field(min_length=1, max_length=8)


class ChatLeaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visitor_id: UUID
    connection_id: UUID


def room_service(request: Request) -> RoomChatService:
    return request.app.state.room_chat


def client_ip(request: Request) -> str:
    # Uvicorn applies forwarded addresses only from the configured trusted proxy.
    # Do not trust an arbitrary caller's X-Forwarded-For header for rate limiting.
    return request.client.host if request.client else "unknown"


@chat_router.get("/chat/emotes")
async def chat_emotes(service: RoomChatService = Depends(room_service)):
    return {"items": await service.emotes(), "source": "BetterTTV", "source_url": "https://betterttv.com/emotes/global"}


@chat_router.get("/sessions/{session_id}/chat/stream")
async def chat_stream(session_id: str, request: Request, visitor_id: UUID = Query(), service: RoomChatService = Depends(room_service), container: AppContainer = Depends(get_container)):
    container.catalog_service.get_session(session_id)
    async def events():
        connection_id = None
        try:
            # Register only once the generator starts, so an early aborted response
            # cannot leave behind a phantom participant before finally is entered.
            connection_id, queue, snapshot = service.connect(session_id, str(visitor_id), client_ip(request))
            yield "event: history\ndata: " + json.dumps(snapshot, ensure_ascii=False) + "\n\n"
            while service.connected(session_id, connection_id) and not await request.is_disconnected():
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=12)
                    yield f"event: {event}\ndata: " + json.dumps(data, ensure_ascii=False) + "\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if connection_id is not None:
                service.disconnect(session_id, connection_id)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Referrer-Policy": "no-referrer"})


@chat_router.post("/sessions/{session_id}/chat/leave")
async def chat_leave(session_id: str, body: ChatLeaveRequest, service: RoomChatService = Depends(room_service)):
    # Explicit browser cleanup supplements TCP disconnects buffered by dev/reverse proxies.
    service.leave(session_id, str(body.connection_id), str(body.visitor_id))
    return {"ok": True}


@chat_router.post("/sessions/{session_id}/chat/messages", status_code=201)
async def chat_message(session_id: str, body: ChatMessageRequest, request: Request, service: RoomChatService = Depends(room_service), container: AppContainer = Depends(get_container)):
    container.catalog_service.get_session(session_id)
    return await service.send(session_id, visitor=str(body.visitor_id), ip=client_ip(request), nickname=body.nickname, text=body.text, emote_id=body.emote_id, client_message_id=str(body.client_message_id))


@chat_router.post("/sessions/{session_id}/chat/reactions")
async def chat_reaction(session_id: str, body: ChatReactionRequest, request: Request, service: RoomChatService = Depends(room_service), container: AppContainer = Depends(get_container)):
    container.catalog_service.get_session(session_id)
    return service.react(session_id, visitor=str(body.visitor_id), ip=client_ip(request), message_id=str(body.message_id), emoji=body.emoji)
