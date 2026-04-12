"""WebSocket endpoints.

All WS topics share a single ``PubSub`` broker (``app.services.pubsub.pubsub``).
Producers (Frida message thread, Claude pumps, APK pipeline tasks) call
``pubsub.publish_nowait`` from any thread; subscribers iterate via
``pubsub.subscribe`` on the asyncio loop.

Reconnect support: clients may pass ``?last_event_id=N`` and the server will
replay buffered events with ``event_id > N`` from the topic ring buffer (10k).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..services.pubsub import pubsub

router = APIRouter(tags=["websocket"])


async def _stream_topic(ws: WebSocket, topic: str, last_event_id: int | None) -> None:
    """Pump events from a single topic to a WebSocket until disconnect.

    Two concurrent tasks share this socket: the pubsub pump (sends events as
    they're published) and the main receive loop (reads client frames and
    sends ping/pong heartbeats). Starlette/uvicorn's ``send_json`` is NOT
    concurrency-safe at the ASGI layer — two overlapping awaits can
    interleave wire frames and raise inside starlette, which would kill the
    pump, exit the main loop, and drop the connection. All sends here go
    through ``send()`` below, which serialises writes with a single lock, so
    the pump and heartbeat can run in parallel without corrupting the frame
    stream.
    """
    await ws.accept()

    send_lock = asyncio.Lock()
    closed = False

    async def send(obj: dict) -> None:
        nonlocal closed
        if closed:
            return
        async with send_lock:
            if closed:
                return
            try:
                await ws.send_json(obj)
            except (WebSocketDisconnect, RuntimeError):
                # RuntimeError is raised by starlette when the socket has
                # already been closed ("Cannot call 'send' once a close
                # message has been sent"). Either way, mark the socket dead
                # so later sends short-circuit instead of raising again.
                closed = True

    # Send a hello message so the client immediately knows the connection is live.
    await send(
        {
            "type": "hello",
            "topic": topic,
            "ts": datetime.now(UTC).isoformat(),
        }
    )

    sender_done = asyncio.Event()

    async def _pump() -> None:
        try:
            async for event in pubsub.subscribe(topic, last_event_id=last_event_id):
                await send(event)
                if closed:
                    break
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            await send({"type": "error", "payload": str(e)})
        finally:
            sender_done.set()

    pump_task = asyncio.create_task(_pump())

    try:
        # Drain incoming frames so we notice disconnects + handle ping/pong.
        # The receive-side timeout is deliberately LONGER than the client's
        # 15 s heartbeat interval so the client's ping normally lands first
        # and resets the timer; if the client is silent for a full 30 s we
        # fall back to a server-initiated ping.
        while not sender_done.is_set() and not closed:
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
            except TimeoutError:
                await send({"type": "ping", "ts": datetime.now(UTC).isoformat()})
                continue
            except WebSocketDisconnect:
                break
            except RuntimeError:
                # Starlette raises "Cannot call 'receive' once a disconnect
                # message has been received" if we race with a close frame.
                break

            # Handle client commands (ping, etc.)
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "ping":
                await send({"type": "pong", "ts": datetime.now(UTC).isoformat()})
            # pongs from the client are ignored by design — they count as a
            # received frame (resetting the recv timeout above) which is all
            # we need from them.
    finally:
        closed = True
        pump_task.cancel()
        try:  # noqa: SIM105
            await pump_task
        except asyncio.CancelledError:
            pass


@router.websocket("/ws/devices")
async def ws_devices(
    ws: WebSocket,
    last_event_id: int | None = Query(default=None),
) -> None:
    await _stream_topic(ws, "devices", last_event_id)


@router.websocket("/ws/run/{run_session_id}")
async def ws_run(
    ws: WebSocket,
    run_session_id: int,
    last_event_id: int | None = Query(default=None),
) -> None:
    await _stream_topic(ws, f"run:{run_session_id}", last_event_id)


@router.websocket("/ws/ai/{ai_session_id}")
async def ws_ai(
    ws: WebSocket,
    ai_session_id: int,
    last_event_id: int | None = Query(default=None),
) -> None:
    await _stream_topic(ws, f"ai:{ai_session_id}", last_event_id)


@router.websocket("/ws/projects/{project_id}/pipeline")
async def ws_pipeline(
    ws: WebSocket,
    project_id: int,
    last_event_id: int | None = Query(default=None),
) -> None:
    await _stream_topic(ws, f"pipeline:{project_id}", last_event_id)
