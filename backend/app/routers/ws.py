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
    """Pump events from a single topic to a WebSocket until disconnect."""
    await ws.accept()

    # Send a hello message so the client immediately knows the connection is live.
    await ws.send_json(
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
                await ws.send_json(event)
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            try:  # noqa: SIM105
                await ws.send_json({"type": "error", "payload": str(e)})
            except Exception:  # noqa: BLE001
                pass
        finally:
            sender_done.set()

    pump_task = asyncio.create_task(_pump())

    try:
        # Drain incoming frames so we notice disconnects + handle ping/pong.
        while not sender_done.is_set():
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=15.0)
            except TimeoutError:
                # Heartbeat — keeps NAT/proxies happy
                await ws.send_json({"type": "ping", "ts": datetime.now(UTC).isoformat()})
                continue
            except WebSocketDisconnect:
                break

            # Handle client commands (ping, etc.)
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "ping":
                await ws.send_json({"type": "pong", "ts": datetime.now(UTC).isoformat()})
    finally:
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
