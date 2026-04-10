"""Wrapper around the Frida Python bindings.

Responsibilities:
* Enumerate Frida devices and merge with ADB metadata
* Spawn / attach to a process
* Load JS scripts and bridge their ``send()`` callbacks to the asyncio loop
  via ``loop.call_soon_threadsafe`` so the callback thread never touches
  PubSub queues directly.

The asyncio bridge is the trickiest part of this file: Frida's
``script.on('message', cb)`` callback runs on a private Frida thread, NOT
on the FastAPI event loop. Every cross-thread publish goes through
``call_soon_threadsafe(pubsub.publish_nowait, ...)``.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import frida
from sqlmodel import Session

from ..db import engine
from ..models.hook_event import HookEvent
from .adb import AdbClient
from .pubsub import pubsub

# ---------------------------------------------------------------------------
# Frida 17 stripped the Java/ObjC/Swift bridges out of the default agent. The
# `frida` CLI restores them by injecting a small lazy-loader stub that
# requests the bridge source from the host the first time the user touches
# globalThis.Java/ObjC/Swift, then evaluates it in script scope. We do the
# same so user scripts that call ``Java.perform(...)`` work out of the box.
#
# Bridge sources ship inside the ``frida_tools`` package — we don't bundle
# our own copies. ``try_handle_bridge_request`` is the same helper the CLI
# uses to respond to the request message.
# ---------------------------------------------------------------------------

_BRIDGE_LOADER_PRELUDE = r"""
(function () {
    function defineBridge(name) {
        Object.defineProperty(globalThis, name, {
            enumerable: true,
            configurable: true,
            get: function () {
                var bridge;
                send({ type: 'frida:load-bridge', name: name });
                recv('frida:bridge-loaded', function (m) {
                    var define = "Object.defineProperty(globalThis, '" + name +
                        "', { value: bridge, configurable: true });";
                    bridge = Script.evaluate(
                        '/frida/bridges/' + m.filename,
                        '(function () { ' + m.source +
                        '\n' + define +
                        '\nreturn bridge;' +
                        ' })();'
                    );
                }).wait();
                return bridge;
            },
        });
    }
    defineBridge('Java');
    defineBridge('ObjC');
    defineBridge('Swift');
})();
"""


def _first_icon_b64(icons: list | None) -> str | None:
    """Encode the first PNG icon from a Frida parameters dict as base64.

    ``device.enumerate_applications(scope='full')`` returns icons as a list
    of ``{format, image, width, height}`` dicts where ``image`` is raw bytes.
    The frontend embeds these as ``data:image/png;base64,...``.
    """
    if not icons:
        return None
    import base64

    for icon in icons:
        if icon.get("format") == "png" and isinstance(icon.get("image"), bytes):
            return base64.b64encode(icon["image"]).decode("ascii")
    return None


def _bridge_source(name: str) -> tuple[str, str] | None:
    """Look up the bridge JS source from the installed frida_tools package."""
    try:
        import frida_tools
    except ImportError:
        return None
    bridges_dir = Path(frida_tools.__file__).parent / "bridges"
    candidate = bridges_dir / f"{name.lower()}.js"
    if not candidate.exists():
        return None
    return candidate.name, candidate.read_text(encoding="utf-8")


@dataclass
class FridaDeviceInfo:
    id: str  # frida device id (usually the serial for USB)
    name: str
    type: str  # local | remote | usb
    # Merged ADB metadata (only present for android USB devices)
    abi: str | None = None
    android_release: str | None = None
    android_sdk: str | None = None
    rooted: bool | None = None
    # frida-server liveness (None = unknown)
    frida_server_running: bool | None = None
    frida_server_version: str | None = None


@dataclass
class _AttachedSession:
    """Per-RunSession state held in memory by FridaManager."""

    run_session_id: int
    device_id: str
    pid: int
    session: frida.core.Session
    script: frida.core.Script | None = None
    loop: asyncio.AbstractEventLoop | None = None
    # True when this session was created via the launch-then-attach
    # fallback because device.spawn() hit "unable to pick a payload base".
    # Affects the resume() flow: there's nothing to resume, the process
    # is already running.
    spawn_via_fallback: bool = False


class FridaManager:
    def __init__(self, adb: AdbClient | None = None):
        self.dm: frida.core.DeviceManager = frida.get_device_manager()
        self.adb = adb
        self._sessions: dict[int, _AttachedSession] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Devices
    # ------------------------------------------------------------------
    async def list_devices(self) -> list[FridaDeviceInfo]:
        # Frida call is blocking IO; offload to thread
        frida_devices: list[frida.core.Device] = await asyncio.to_thread(
            self.dm.enumerate_devices
        )

        # Build base info from Frida
        out: list[FridaDeviceInfo] = []
        for d in frida_devices:
            info = FridaDeviceInfo(id=d.id, name=d.name, type=d.type)
            # Try to detect frida-server liveness on USB devices
            if d.type == "usb":
                running, version = await self._probe_frida_server(d)
                info.frida_server_running = running
                info.frida_server_version = version
            out.append(info)

        # Merge with ADB metadata for usb devices
        if self.adb is None:
            return out

        try:
            adb_devices = await self.adb.devices()
        except Exception:  # noqa: BLE001
            adb_devices = []

        adb_serials = {d.serial for d in adb_devices if d.state == "device"}

        # Fetch ABI/version/root for each USB device that adb knows about
        async def fill(info: FridaDeviceInfo) -> None:
            if info.type != "usb" or info.id not in adb_serials:
                return
            try:
                meta = await self.adb.get_device_info(info.id)
            except Exception:  # noqa: BLE001
                return
            info.abi = meta["abi"] or None  # type: ignore[assignment]
            info.android_release = meta["android_release"] or None  # type: ignore[assignment]
            info.android_sdk = meta["android_sdk"] or None  # type: ignore[assignment]
            info.rooted = bool(meta["rooted"])

        await asyncio.gather(*(fill(info) for info in out))
        return out

    async def _probe_frida_server(self, device: frida.core.Device) -> tuple[bool, str | None]:
        """Try a quick frida-server liveness probe via enumerate_processes()."""
        try:
            await asyncio.to_thread(device.enumerate_processes)
            return True, frida.__version__
        except Exception:  # noqa: BLE001
            return False, None

    def get_device(self, serial: str) -> frida.core.Device:
        """Resolve a Frida Device by its id (usually the ADB serial)."""
        return self.dm.get_device(serial, timeout=2)

    # ------------------------------------------------------------------
    # Processes
    # ------------------------------------------------------------------
    async def list_processes(self, serial: str) -> list[dict[str, Any]]:
        """Mirror ``frida-ps -U`` (with icons): processes with icons first,
        then alphabetical by name. Uses ``scope='full'`` so icons are
        available where the device supports them (Android, iOS)."""
        device = self.get_device(serial)
        procs = await asyncio.to_thread(device.enumerate_processes, scope="full")
        # frida-ps sort: items that have an icon come first, then alphabetical
        procs_sorted = sorted(
            procs,
            key=lambda p: (
                0 if p.parameters.get("icons") else 1,
                p.name.lower(),
            ),
        )
        return [
            {
                "pid": p.pid,
                "name": p.name,
                "icon_b64": _first_icon_b64(p.parameters.get("icons")),
            }
            for p in procs_sorted
        ]

    async def list_apps(self, serial: str) -> list[dict[str, Any]]:
        """Mirror ``frida-ps -Uai``: running apps first, then idle, both
        alphabetical. Includes icon as base64 PNG when available."""
        device = self.get_device(serial)
        apps = await asyncio.to_thread(device.enumerate_applications, scope="full")
        apps_sorted = sorted(
            apps,
            key=lambda a: (
                0 if a.pid != 0 else 1,
                a.name.lower(),
            ),
        )
        return [
            {
                "identifier": a.identifier,
                "name": a.name,
                "pid": a.pid if a.pid else None,
                "icon_b64": _first_icon_b64(a.parameters.get("icons")),
            }
            for a in apps_sorted
        ]

    # ------------------------------------------------------------------
    # Spawn / Attach + Script lifecycle
    # ------------------------------------------------------------------

    async def _ensure_frida_server_for(self, serial: str) -> None:
        """Make sure frida-server is alive on the target device.

        If frida-server is missing, frida falls back to gadget mode and
        ``device.spawn`` / ``device.attach`` raise the cryptic
        ``need Gadget to attach on jailed Android`` error. Pre-flighting an
        install here turns that into a transparent ~3-second auto-recovery
        on the user's first hook attempt.
        """
        # Local import to avoid a circular dep at module load time.
        from . import frida_server

        try:
            ok = await frida_server.ensure_running(serial)
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            raise RuntimeError(
                f"frida-server is not running on {serial} and could not be auto-started. "
                "Open the Devices page and click 'Install frida-server' to set it up manually."
            )

    async def attach(self, serial: str, pid: int, run_session_id: int) -> _AttachedSession:
        await self._ensure_frida_server_for(serial)
        device = self.get_device(serial)
        session = await asyncio.to_thread(device.attach, pid)
        attached = _AttachedSession(
            run_session_id=run_session_id,
            device_id=serial,
            pid=pid,
            session=session,
            loop=asyncio.get_running_loop(),
        )
        async with self._lock:
            self._sessions[run_session_id] = attached
        return attached

    async def spawn(
        self, serial: str, identifier: str, run_session_id: int
    ) -> _AttachedSession:
        await self._ensure_frida_server_for(serial)
        device = self.get_device(serial)
        try:
            pid = await asyncio.to_thread(device.spawn, [identifier])
            attached_via_fallback = False
        except frida.NotSupportedError as e:
            # Some Android emulator builds (notably old API levels with their
            # original kernel) hit "unable to pick a payload base" inside
            # frida-server's spawn-time injector — it can't find a free VA
            # range to map the agent into the not-yet-running process.
            # Attaching to an already-running PID uses a different injection
            # path that works fine, so fall back to launching the app via
            # ``am start``/``monkey`` and attaching once the process is up.
            # The trade-off is we miss hooks fired before our attach
            # completes (typically the static initializers); for most
            # workflows that's an acceptable price to keep the IDE usable
            # on broken images.
            if "payload base" not in str(e):
                raise
            pid = await self._launch_and_wait_for_pid(serial, identifier)
            attached_via_fallback = True

        session = await asyncio.to_thread(device.attach, pid)
        attached = _AttachedSession(
            run_session_id=run_session_id,
            device_id=serial,
            pid=pid,
            session=session,
            loop=asyncio.get_running_loop(),
            spawn_via_fallback=attached_via_fallback,
        )
        async with self._lock:
            self._sessions[run_session_id] = attached
        return attached

    async def _launch_and_wait_for_pid(
        self, serial: str, identifier: str, timeout_s: float = 10.0
    ) -> int:
        """Launch ``identifier`` via the launcher intent and return its PID.

        Used as a fallback when ``device.spawn`` hits a frida-injector bug.
        Uses ``monkey -p {pkg} -c android.intent.category.LAUNCHER 1`` which
        works against any installed app without needing the activity name.
        """
        if self.adb is None:
            raise RuntimeError(
                "spawn fallback (launch-then-attach) requires the AdbClient"
            )

        # Best-effort: kill any stale instance so the new launch produces a
        # fresh PID we can latch onto.
        try:  # noqa: SIM105
            await self.adb.shell(serial, "am", "force-stop", identifier)
        except Exception:  # noqa: BLE001
            pass

        await self.adb.shell(
            serial,
            "monkey",
            "-p",
            identifier,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        )

        # Resolve PID via enumerate_applications, which indexes by package
        # identifier — frida.enumerate_processes uses the human-readable
        # app label, which doesn't match the identifier we have here.
        device = self.get_device(serial)
        deadline = asyncio.get_running_loop().time() + timeout_s
        while asyncio.get_running_loop().time() < deadline:
            try:
                apps = await asyncio.to_thread(
                    device.enumerate_applications, scope="minimal"
                )
            except Exception:  # noqa: BLE001
                apps = []
            for a in apps:
                if a.identifier == identifier and a.pid:
                    return a.pid
            await asyncio.sleep(0.25)
        raise RuntimeError(
            f"launched {identifier} via monkey but the process never appeared "
            f"in frida's application list within {timeout_s:.0f}s"
        )

    async def load_script(self, run_session_id: int, source: str) -> None:
        async with self._lock:
            attached = self._sessions.get(run_session_id)
        if attached is None:
            raise ValueError(f"No session for run_session_id={run_session_id}")

        loop = attached.loop or asyncio.get_running_loop()
        topic = f"run:{run_session_id}"

        # Forward-declared so on_message can refer to it
        script_ref: list[frida.core.Script] = []

        def on_message(message: dict, data: bytes | None) -> None:  # Frida thread
            # Intercept bridge load requests (Java/ObjC/Swift lazy loaders)
            # and respond with the bridge source. Don't surface these to the
            # user's output console — they're plumbing.
            if message.get("type") == "send":
                payload = message.get("payload")
                if isinstance(payload, dict) and payload.get("type") == "frida:load-bridge":
                    name = payload.get("name", "")
                    found = _bridge_source(name)
                    if found is not None and script_ref:
                        filename, src = found
                        try:  # noqa: SIM105
                            script_ref[0].post(
                                {
                                    "type": "frida:bridge-loaded",
                                    "filename": filename,
                                    "source": src,
                                }
                            )
                        except Exception:  # noqa: BLE001
                            pass
                    return  # do NOT publish to the user-visible topic

            kind = "send" if message.get("type") == "send" else "error"
            envelope = {
                "type": kind,
                "ts": datetime.now(UTC).isoformat(),
                "payload": message,
            }
            if data is not None:
                # Forward as base64-encoded blob (rare in JS hooks)
                import base64

                envelope["data_b64"] = base64.b64encode(data).decode("ascii")
            loop.call_soon_threadsafe(pubsub.publish_nowait, topic, envelope)
            # Persist for session replay. SQLite + sqlmodel auto-handles WAL writes;
            # we run this on a worker thread so the Frida callback isn't blocked
            # waiting for disk I/O.
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(_persist_event(run_session_id, kind, message))
            )

        # Wrap the user script with the bridge loader prelude so Java/ObjC/Swift
        # become globally available the first time the user touches them.
        wrapped_source = _BRIDGE_LOADER_PRELUDE + "\n" + source

        script = await asyncio.to_thread(
            attached.session.create_script, wrapped_source
        )
        script_ref.append(script)
        script.on("message", on_message)
        await asyncio.to_thread(script.load)
        attached.script = script

        # Publish a status event so the UI knows the script is live
        pubsub.publish_nowait(
            topic,
            {
                "type": "status",
                "ts": datetime.now(UTC).isoformat(),
                "payload": {"status": "loaded"},
            },
        )

    async def resume(self, run_session_id: int) -> None:
        """For spawn flow: call AFTER load_script, otherwise hooks miss early classes."""
        async with self._lock:
            attached = self._sessions.get(run_session_id)
        if attached is None:
            raise ValueError(f"No session for run_session_id={run_session_id}")
        if attached.spawn_via_fallback:
            # Process was launched via `monkey`, not paused via frida — there
            # is nothing to resume.
            return
        device = self.get_device(attached.device_id)
        await asyncio.to_thread(device.resume, attached.pid)

    async def stop(self, run_session_id: int) -> None:
        async with self._lock:
            attached = self._sessions.pop(run_session_id, None)
        if attached is None:
            return
        topic = f"run:{run_session_id}"
        try:  # noqa: SIM105
            if attached.script is not None:
                await asyncio.to_thread(attached.script.unload)
        except Exception:  # noqa: BLE001
            pass
        try:  # noqa: SIM105
            await asyncio.to_thread(attached.session.detach)
        except Exception:  # noqa: BLE001
            pass
        pubsub.publish_nowait(
            topic,
            {
                "type": "status",
                "ts": datetime.now(UTC).isoformat(),
                "payload": {"status": "stopped"},
            },
        )

    async def kill(self, serial: str, pid: int) -> None:
        device = self.get_device(serial)
        await asyncio.to_thread(device.kill, pid)


async def _persist_event(run_session_id: int, kind: str, payload: Any) -> None:
    """Insert one HookEvent row. Wrapped in to_thread to keep SQLite I/O off the loop."""

    def _do_insert() -> None:
        try:
            with Session(engine()) as db:
                ev = HookEvent(
                    run_session_id=run_session_id,
                    kind=kind,
                    payload_json=json.dumps(payload, default=str),
                )
                db.add(ev)
                db.commit()
        except Exception:  # noqa: BLE001
            # Persistence is best-effort: never let a DB error break the WS stream.
            pass

    await asyncio.to_thread(_do_insert)


# Module-level singleton, wired in main.py lifespan
_manager: FridaManager | None = None


def get_manager() -> FridaManager:
    global _manager
    if _manager is None:
        _manager = FridaManager(adb=AdbClient())
    return _manager
