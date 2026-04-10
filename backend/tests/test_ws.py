"""End-to-end smoke test for the PubSub → WebSocket plumbing.

Publishes to a topic via the dev endpoint, then verifies the subscriber receives
the event over a real WebSocket connection.
"""

import asyncio

import pytest
from app.main import app
from app.services.pubsub import pubsub
from fastapi.testclient import TestClient


def test_ws_devices_hello_and_publish():
    client = TestClient(app)
    with client.websocket_connect("/ws/devices") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["topic"] == "devices"

        # Publish to the same topic; the subscriber should receive it.
        pubsub.publish_nowait(
            "devices",
            {"type": "device_added", "payload": {"serial": "TEST-DEVICE"}},
        )
        msg = ws.receive_json()
        assert msg["type"] == "device_added"
        assert msg["payload"]["serial"] == "TEST-DEVICE"
        assert "event_id" in msg


def test_ws_run_topic_replay():
    """Late subscriber with last_event_id receives buffered events."""
    client = TestClient(app)

    # Publish 3 events BEFORE any subscriber connects
    for i in range(3):
        pubsub.publish_nowait("run:9999", {"type": "send", "payload": {"i": i}})

    with client.websocket_connect("/ws/run/9999?last_event_id=-1") as ws:
        ws.receive_json()  # hello
        # Replay all 3 buffered events
        seen = [ws.receive_json() for _ in range(3)]
        assert [m["payload"]["i"] for m in seen] == [0, 1, 2]
        assert seen[0]["event_id"] < seen[1]["event_id"] < seen[2]["event_id"]


@pytest.mark.asyncio
async def test_pubsub_history_replay_larger_than_queue():
    """History replay must work even when buffered events exceed queue cap (1024).

    Regression: an earlier impl awaited queue.put() under the lock during
    replay, deadlocking on > 1024 buffered events.
    """
    # Publish more than the queue cap (1024) to a fresh topic
    for i in range(2_000):
        pubsub.publish_nowait("history_replay", {"i": i})

    # Subscribe with replay; should yield from the history snapshot first
    seen: list[int] = []
    sub = pubsub.subscribe("history_replay", last_event_id=-1).__aiter__()
    # Drain the most recent 10k entries (deque cap), filter to ours
    for _ in range(10_000):
        try:
            ev = await asyncio.wait_for(sub.__anext__(), timeout=0.5)
        except TimeoutError:
            break
        seen.append(ev["i"])
    assert len(seen) > 0
    # The history deque holds the last 10k events, so we should see all 2000
    assert seen == list(range(2_000))
