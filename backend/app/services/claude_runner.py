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

from ..config import settings
from ..db import engine
from ..models.ai_session import AiMessage, AiSession
from ..utils.paths import find_claude
from .pubsub import pubsub


class ClaudeNotFoundError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# System-prompt injection
# ---------------------------------------------------------------------------

# This is appended to Claude Code's built-in system prompt via
# ``--append-system-prompt``. It doesn't replace the defaults — so tool-use
# conventions, CLAUDE.md discovery, and safety rails all stay in place — it
# just teaches Claude the Frida IDE's layout and file conventions so hooks
# land where ``Extract Script → Editor`` expects to find them.
#
# Users can override or extend this by:
#   1. Writing to ``~/.frida-ide/claude_system_prompt.md`` (takes precedence)
#   2. Setting ``FRIDA_IDE_CLAUDE_SYSTEM_PROMPT`` to a literal string
# Both are hot-loaded per session, so you can iterate on the prompt without
# restarting the IDE.

_DEFAULT_SYSTEM_PROMPT = """\
# Frida IDE context

You are running inside the **Frida IDE**, a web-based workbench for dynamic
instrumentation of Android apps. Your working directory (`cwd`) is the
project's decompiled APK tree, structured like:

    ./apk/base.apk              # original APK(s)
    ./apktool-out/              # apktool output (smali, res, AndroidManifest.xml)
    ./jadx-out/sources/         # jadx-decompiled Java sources — READ THESE FIRST
    ./meta.json                 # package_name, version, permissions, etc.

## Your job

When the user asks you to "hook X", "find Y", or "bypass Z":

1. **Investigate first.** Read `meta.json` for the package id, then grep
   `jadx-out/sources/` for relevant class names, strings, or API calls. Only
   touch `apktool-out/` if you specifically need smali or resources.
2. **Write the hook as a real file** in the project directory using the Write
   tool. Prefer absolute paths like `./hook_<name>.js` or `./bypass_<thing>.js`
   — the IDE's `Extract Script → Editor` button reads the on-disk file for
   whichever `.js` path you most recently touched, so iterative Edit calls
   always land the full current script. NEVER paste a long script inline in a
   fenced block expecting the user to copy it — always save it via Write.
3. **Iterate via Edit, not Write.** Once you've saved a script, further
   changes should use the Edit tool so the file's history is preserved and
   Extract Script still gives the user the full current version.

## Frida script conventions

- Use `send(value)` for runtime output — it streams into the IDE's xterm
  console next to the editor. `console.log` also works but `send` is richer.
- Wrap Java hooks in `Java.perform(function () { ... })`. The IDE's bridge
  loader injects Java/ObjC bridges automatically; don't add your own import
  shims.
- For native hooks, `Interceptor.attach(Module.findExportByName(...), {...})`.
- Start each script with a short banner comment that names what it hooks and
  any class/method names the user should know about, e.g.:

      // bypass_root.js — neutralises RootBeer checks + Settings.Secure.ADB
      // Target: com.example.app
      // Hooks: com.scottyab.rootbeer.RootBeer.isRooted (→ false)
      //        android.provider.Settings$Secure.getString (→ "0" for ADB)

- At the end of a hook, a Toast ("Frida: hooks loaded") or `send('all hooks
  installed')` makes it obvious the script ran.
- Prefer idempotent hooks: use `Java.use(...).method.implementation = ...`
  rather than `Java.use(...).method.overloads`, unless you genuinely need
  to disambiguate a specific overload.

## When asked for a script

Respond with a brief (1–3 sentence) explanation of what you hooked and why,
**then** call the Write tool to save the script. Do NOT paste the whole
script in a text block — the user will extract it from disk.

## When asked to explain existing code

Quote short snippets inline (a few lines in a fence is fine for discussion).
The disk-read extract path only kicks in when you touch a `.js` file via
Write/Edit/MultiEdit, so commentary on Java/smali code stays in the chat.
"""


def _load_system_prompt() -> str:
    """Return the system prompt to append for this Claude session.

    Priority: env var > user file > baked-in default. Each call re-reads the
    file so users can iterate on the prompt without restarting the IDE.
    """
    env_override = os.environ.get("FRIDA_IDE_CLAUDE_SYSTEM_PROMPT")
    if env_override and env_override.strip():
        return env_override

    user_file = settings.data_dir / "claude_system_prompt.md"
    if user_file.exists():
        try:
            text = user_file.read_text(encoding="utf-8")
            if text.strip():
                return text
        except OSError:
            pass

    return _DEFAULT_SYSTEM_PROMPT


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
            # Append Frida-IDE conventions to the built-in system prompt so
            # Claude knows to save hooks as .js files in the project dir
            # (where Extract Script picks them up off disk) and to use the
            # Frida API patterns the user expects.
            "--append-system-prompt",
            _load_system_prompt(),
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
