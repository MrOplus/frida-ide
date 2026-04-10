"""In-process topic-based pub/sub broker.

Decouples producers (Frida message thread, Claude subprocess pumps, APK
pipeline tasks) from WebSocket consumers. All publishers MUST go through
``publish_nowait`` so cross-thread producers can use ``loop.call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _Topic:
    subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    # Replay buffer (last N events) for late subscribers / WS reconnects
    history: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=10_000))
    next_event_id: int = 0


class PubSub:
    def __init__(self) -> None:
        self._topics: dict[str, _Topic] = {}
        self._lock = asyncio.Lock()

    def _get_topic(self, name: str) -> _Topic:
        topic = self._topics.get(name)
        if topic is None:
            topic = _Topic()
            self._topics[name] = topic
        return topic

    def publish_nowait(self, topic_name: str, payload: dict[str, Any]) -> None:
        """Thread-safe publish (do NOT await). Used by Frida callback thread.

        For cross-thread callers, wrap in loop.call_soon_threadsafe(...).
        """
        topic = self._get_topic(topic_name)
        event = {"event_id": topic.next_event_id, **payload}
        topic.next_event_id += 1
        topic.history.append(event)
        for q in list(topic.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop oldest by reading one then putting; subscriber is too slow.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    async def subscribe(
        self, topic_name: str, last_event_id: int | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Async iterator over events on a topic.

        If ``last_event_id`` is given, first yield buffered history events with
        ``event_id > last_event_id`` (snapshotted under the lock), then yield
        new events from the live queue as they arrive.

        The history snapshot is yielded outside the queue so the queue's bound
        cannot deadlock the replay path on large histories.
        """
        async with self._lock:
            topic = self._get_topic(topic_name)
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1024)
            topic.subscribers.add(queue)
            # Snapshot history while the lock is held; any concurrent publish
            # will go to BOTH history (which we already snapshotted) AND our
            # queue, but we filter by event_id so each event is yielded once.
            if last_event_id is not None:
                snapshot = [ev for ev in topic.history if ev["event_id"] > last_event_id]
                snapshot_max_id = snapshot[-1]["event_id"] if snapshot else last_event_id
            else:
                snapshot = []
                snapshot_max_id = None

        try:
            for ev in snapshot:
                yield ev
            while True:
                ev = await queue.get()
                # Skip events we already yielded via the history snapshot
                if snapshot_max_id is not None and ev["event_id"] <= snapshot_max_id:
                    continue
                yield ev
        finally:
            async with self._lock:
                topic = self._get_topic(topic_name)
                topic.subscribers.discard(queue)


# Module-level singleton; main.py wires this into app.state in lifespan
pubsub = PubSub()
