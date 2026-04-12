"""Claude Code subprocess runner.

Spawns ``claude --print --input-format=stream-json --output-format=stream-json
--verbose`` with ``cwd`` set to the project's decompiled source tree, then:

* Pumps stdout (line-delimited JSON) → PubSub topic ``ai:{ai_session_id}``.
* Pumps stderr → same topic with ``type=stderr``.
* Lets the caller send a user message via ``send_user_message`` which writes
  one JSON line to stdin and drains.
* Persists every line to the ``aimessage`` table so the chat is rehydratable.

Stream-json event shape (relevant types):

  {"type":"system","subtype":"init","cwd","session_id","model",...}
  {"type":"assistant","message":{"role":"assistant","content":[
      {"type":"text","text":"..."} | {"type":"tool_use","id","name","input":{...}}
  ]},"session_id":"..."}
  {"type":"user","message":{"role":"user","content":[
      {"type":"tool_result","tool_use_id","content":"..."}
  ]}}
  {"type":"result","subtype":"success","is_error",...}
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ..db import engine
from ..models.ai_session import AiMessage, AiSession
from ..utils.paths import find_claude
from .pubsub import pubsub


class ClaudeNotFoundError(RuntimeError):
    pass


def _publish(ai_session_id: int, payload: dict[str, Any]) -> None:
    pubsub.publish_nowait(
        f"ai:{ai_session_id}",
        {
            "type": payload.get("type", "raw"),
            "ts": datetime.now(UTC).isoformat(),
            "payload": payload,
        },
    )


def _persist_message(
    ai_session_id: int, role: str, content: dict | list | str
) -> int | None:
    """Insert an AiMessage row and return the new primary key.

    The id round-trips into the ``user_sent`` WS payload below so the frontend
    reducer can dedupe between the /messages backfill and the live WS stream
    using a stable identifier that survives both paths.
    """
    with Session(engine()) as db:
        msg = AiMessage(
            ai_session_id=ai_session_id,
            role=role,
            content_json=json.dumps(content) if not isinstance(content, str) else content,
        )
        db.add(msg)
        db.commit()
        db.refresh(msg)
        return msg.id


class ClaudeRunner:
    """One ClaudeRunner == one long-lived subprocess + asyncio pump tasks."""

    def __init__(self, ai_session_id: int, cwd: Path):
        self.ai_session_id = ai_session_id
        self.cwd = cwd
        self.proc: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._wait_task: asyncio.Task | None = None
        self._closed = False

    async def start(self) -> None:
        claude_bin = find_claude()
        if claude_bin is None:
            raise ClaudeNotFoundError("Could not locate `claude` CLI")

        if not self.cwd.exists():
            raise FileNotFoundError(f"cwd does not exist: {self.cwd}")

        argv = [
            str(claude_bin),
            "--print",
            "--verbose",
            "--input-format=stream-json",
            "--output-format=stream-json",
            "--permission-mode=bypassPermissions",
            "--model",
            "sonnet",
        ]

        # Inherit environment so the user's keychain auth + CLAUDE_* vars work.
        env = dict(os.environ)

        self.proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(self.cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            # On Linux, ensure children die with the parent.
            preexec_fn=os.setsid if os.name == "posix" else None,
        )

        self._stdout_task = asyncio.create_task(self._pump_stdout())
        self._stderr_task = asyncio.create_task(self._pump_stderr())
        self._wait_task = asyncio.create_task(self._wait_done())

        # Persist the AiSession PID so cleanup-on-restart can find orphans.
        with Session(engine()) as db:
            sess = db.get(AiSession, self.ai_session_id)
            if sess is not None:
                sess.pid = self.proc.pid
                sess.status = "running"
                db.add(sess)
                db.commit()

        _publish(
            self.ai_session_id,
            {"type": "started", "pid": self.proc.pid, "cwd": str(self.cwd)},
        )

    async def _pump_stdout(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                _publish(self.ai_session_id, {"type": "stderr", "text": text})
                continue
            self._handle_event(obj)

    async def _pump_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if not text:
                continue
            _publish(self.ai_session_id, {"type": "stderr", "text": text})

    async def _wait_done(self) -> None:
        assert self.proc is not None
        rc = await self.proc.wait()
        _publish(self.ai_session_id, {"type": "exited", "returncode": rc})
        with Session(engine()) as db:
            sess = db.get(AiSession, self.ai_session_id)
            if sess is not None:
                sess.status = "stopped" if rc == 0 else "error"
                sess.ended_at = datetime.now(UTC)
                db.add(sess)
                db.commit()

    def _handle_event(self, obj: dict) -> None:
        """Handle one parsed JSON event from Claude's stdout."""
        ev_type = obj.get("type")
        # Forward the raw event to the WS topic
        _publish(self.ai_session_id, obj)

        # Persist messages we care about. We store the whole ``message``
        # object (not just ``content``) so Claude's ``message.id`` survives
        # round-trips through the DB — the frontend uses it to deduplicate
        # between the /messages backfill and the live WS stream when a page
        # is opened during an active response.
        if ev_type == "assistant":
            message = obj.get("message", {})
            _persist_message(self.ai_session_id, "assistant", message)
        elif ev_type == "user":
            # Tool results come back as user messages with content arrays.
            # Store the full message (including Claude's message.id) for the
            # same dedup reason.
            message = obj.get("message", {})
            _persist_message(self.ai_session_id, "tool_result", message)
        elif ev_type == "system":
            _persist_message(self.ai_session_id, "system", obj)

    async def send_user_message(self, text: str) -> None:
        if self.proc is None or self.proc.stdin is None or self._closed:
            raise RuntimeError("session not running")
        envelope = {
            "type": "user",
            "message": {"role": "user", "content": text},
        }
        line = (json.dumps(envelope) + "\n").encode("utf-8")
        self.proc.stdin.write(line)
        await self.proc.stdin.drain()
        # Persist first, capture the DB row id, then echo it in the WS event
        # so both the /messages backfill and the live WS use the same stable
        # dedup key (``us:db:<id>``) on the frontend.
        db_id = _persist_message(self.ai_session_id, "user", text)
        _publish(
            self.ai_session_id,
            {"type": "user_sent", "content": text, "db_id": db_id},
        )

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.proc is None:
            return
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:  # noqa: SIM105
            self.proc.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=3.0)
        except TimeoutError:
            try:  # noqa: SIM105
                self.proc.kill()
            except ProcessLookupError:
                pass
        for t in (self._stdout_task, self._stderr_task, self._wait_task):
            if t is not None and not t.done():
                t.cancel()


# ---------------------------------------------------------------------------
# Module-level registry of running runners
# ---------------------------------------------------------------------------

_runners: dict[int, ClaudeRunner] = {}


def get_runner(ai_session_id: int) -> ClaudeRunner | None:
    return _runners.get(ai_session_id)


async def start_runner(ai_session_id: int, cwd: Path) -> ClaudeRunner:
    runner = ClaudeRunner(ai_session_id, cwd)
    await runner.start()
    _runners[ai_session_id] = runner
    return runner


async def stop_runner(ai_session_id: int) -> None:
    runner = _runners.pop(ai_session_id, None)
    if runner is None:
        return
    await runner.stop()


async def stop_all_runners() -> None:
    for sid in list(_runners.keys()):
        await stop_runner(sid)
