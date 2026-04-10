"""Internal dev/test endpoints.

Used by smoke tests and manual verification of the PubSub→WebSocket plumbing.
Mounted under /api/_dev/* and ONLY in debug mode.
"""

from datetime import UTC, datetime

from fastapi import APIRouter

from ..services.pubsub import pubsub

router = APIRouter(prefix="/api/_dev", tags=["dev"])


@router.post("/publish/{topic}")
async def publish(topic: str, payload: dict) -> dict:
    """Publish an arbitrary event to a topic. Used for end-to-end WS testing."""
    pubsub.publish_nowait(
        topic,
        {"type": "test", "ts": datetime.now(UTC).isoformat(), "payload": payload},
    )
    return {"ok": True, "topic": topic}
