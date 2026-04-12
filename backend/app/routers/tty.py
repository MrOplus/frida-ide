"""TTY WebSocket — interactive pseudo-terminal for the bottom-drawer console.

One PTY is forked per WebSocket connection. The parent side's master fd is
read via ``loop.add_reader`` (no busy polling, no blocking thread), and bytes
are forwarded base64-encoded to the client. The client's keystrokes come back
as ``{"type": "data", "data": "<base64>"}`` frames and go to the PTY's stdin.

Resize is handled by ``{"type": "resize", "cols": N, "rows": N}`` which calls
``TIOCSWINSZ`` on the master fd so curses-style TUIs reflow correctly.

Security: the endpoint inherits the same bind posture as the rest of the API
(localhost by default; ``FRIDA_IDE_UNSAFE_EXPOSE=1`` to open to the network,
with a loud red banner). Because this exposes a full shell with the IDE
user's permissions, do NOT enable network binding on a shared machine.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import termios
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)
router = APIRouter(tags=["tty"])

_READ_CHUNK = 64 * 1024


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """``TIOCSWINSZ`` so the shell's LINES/COLUMNS reflect the xterm.js
    viewport. Without this, ``vi`` / ``less`` / curses apps render at an
    80×24 grid regardless of the browser window size."""
    # Fd may have been closed racing with a resize event. Not fatal.
    with contextlib.suppress(OSError):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@router.websocket("/ws/tty")
async def ws_tty(ws: WebSocket) -> None:
    """Attach the client to a freshly-forked shell."""
    await ws.accept()

    loop = asyncio.get_running_loop()
    shell = os.environ.get("SHELL") or "/bin/bash"
    cwd = str(Path.home())

    # pty.fork() returns (pid, master_fd). The child's stdin/stdout/stderr are
    # already wired to the slave side and it inherits a fresh session via
    # setsid() — so SIGHUP on master close kills the child cleanly.
    try:
        pid, master_fd = pty.fork()
    except OSError as e:
        await ws.send_json({"type": "error", "error": f"pty.fork failed: {e}"})
        await ws.close()
        return

    if pid == 0:  # pragma: no cover — child process
        # Child: replace with the user's login shell. Environment is
        # inherited from the server process (PATH, HOME, SHELL, …).
        with contextlib.suppress(OSError):
            os.chdir(cwd)
        env = dict(os.environ)
        env["TERM"] = env.get("TERM", "xterm-256color")
        # Make the shell behave like a login shell so aliases / PS1 / etc.
        # from the user's rc files are active.
        os.execvpe(shell, [shell, "-l"], env)
        os._exit(127)  # unreachable unless execvpe fails

    # Parent path.
    os.set_blocking(master_fd, False)
    close_requested = False
    send_lock = asyncio.Lock()

    async def send_json(obj: dict) -> None:
        async with send_lock:
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                await ws.send_json(obj)

    def on_master_readable() -> None:
        """Runs on the event loop thread every time the PTY has output."""
        try:
            data = os.read(master_fd, _READ_CHUNK)
        except OSError:
            data = b""
        if not data:
            # EOF — child exited, or fd was closed. Stop reading and wind
            # everything down from the async side.
            with contextlib.suppress(Exception):
                loop.remove_reader(master_fd)
            asyncio.create_task(_teardown("child exited"))
            return
        asyncio.create_task(
            send_json({"type": "data", "data": base64.b64encode(data).decode("ascii")})
        )

    async def _teardown(reason: str) -> None:
        nonlocal close_requested
        if close_requested:
            return
        close_requested = True
        with contextlib.suppress(Exception):
            loop.remove_reader(master_fd)
        with contextlib.suppress(OSError):
            os.close(master_fd)
        # Best-effort kill the child if it's still around.
        with contextlib.suppress(ProcessLookupError, OSError):
            os.kill(pid, signal.SIGHUP)
        with contextlib.suppress(Exception):
            await ws.close()
        log.debug("tty: teardown (%s)", reason)

    loop.add_reader(master_fd, on_master_readable)

    # Tell the client we're ready and give an initial prompt a chance to arrive.
    await send_json({"type": "ready"})

    # Main recv loop — pump client messages to the PTY.
    try:
        while not close_requested:
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                break
            except RuntimeError:
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            if mtype == "data":
                b64 = msg.get("data", "")
                try:
                    payload = base64.b64decode(b64) if b64 else b""
                except Exception:  # noqa: BLE001
                    continue
                if payload:
                    try:
                        os.write(master_fd, payload)
                    except OSError:
                        break
            elif mtype == "resize":
                rows = int(msg.get("rows") or 24)
                cols = int(msg.get("cols") or 80)
                _set_winsize(master_fd, rows, cols)
            elif mtype == "ping":
                await send_json({"type": "pong"})
            # Unknown types are ignored silently.
    finally:
        await _teardown("recv-loop exit")
