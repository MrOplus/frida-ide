"""Background watcher that keeps each USB device's frida-server alive.

Every ``POLL_INTERVAL_S`` seconds it:

1. Enumerates Frida USB devices.
2. Probes each one's frida-server liveness via ``enumerate_processes``.
3. If the previously-running daemon disappears, attempts ``frida_server.start``.
4. Publishes a ``device_status`` event to the ``devices`` topic on every
   transition (so the UI flips its dot in real-time).

A single watcher task is started in main.py's lifespan and cancelled on
shutdown.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import frida

from . import frida_server
from .pubsub import pubsub

POLL_INTERVAL_S = 10.0

log = logging.getLogger(__name__)


def _publish_status(serial: str, running: bool, restarted: bool = False) -> None:
    pubsub.publish_nowait(
        "devices",
        {
            "type": "device_status",
            "ts": datetime.now(UTC).isoformat(),
            "payload": {
                "serial": serial,
                "frida_server_running": running,
                "restarted": restarted,
            },
        },
    )


async def _check_device(serial: str, last_state: dict[str, bool]) -> None:
    try:
        device = await asyncio.to_thread(frida.get_device, serial, 2)
        try:
            await asyncio.to_thread(device.enumerate_processes)
            running = True
        except Exception:  # noqa: BLE001
            running = False
    except Exception:  # noqa: BLE001
        running = False

    previous = last_state.get(serial)

    # First-time observation: if frida-server isn't there yet, try to bring
    # it up automatically so the user doesn't have to click Install before
    # their first spawn.
    if previous is None:
        if not running:
            log.info("frida-server missing on %s, attempting auto-install", serial)
            try:
                ok = await frida_server.ensure_running(serial)
            except Exception as e:  # noqa: BLE001
                log.warning("auto-install on %s failed: %s", serial, e)
                ok = False
            if ok:
                _publish_status(serial, True, restarted=True)
                last_state[serial] = True
                return
        last_state[serial] = running
        return

    if previous and not running:
        # frida-server died — try to restart it
        log.info("frida-server died on %s, restarting", serial)
        try:
            ok = await frida_server.ensure_running(serial)
        except Exception as e:  # noqa: BLE001
            log.warning("failed to restart frida-server on %s: %s", serial, e)
            ok = False
        if ok:
            _publish_status(serial, True, restarted=True)
            last_state[serial] = True
        else:
            _publish_status(serial, False)
            last_state[serial] = False
        return

    if running != previous:
        _publish_status(serial, running)
        last_state[serial] = running


async def _watch_loop(stop_event: asyncio.Event) -> None:
    last_state: dict[str, bool] = {}
    while not stop_event.is_set():
        try:
            devices = await asyncio.to_thread(
                frida.get_device_manager().enumerate_devices
            )
            usb = [d for d in devices if d.type == "usb"]
            await asyncio.gather(
                *(_check_device(d.id, last_state) for d in usb),
                return_exceptions=True,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("device watcher iteration failed: %s", e)

        try:  # noqa: SIM105
            await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_S)
        except TimeoutError:
            pass


_task: asyncio.Task | None = None
_stop_event: asyncio.Event | None = None


def start_watcher() -> None:
    global _task, _stop_event
    if _task is not None and not _task.done():
        return
    _stop_event = asyncio.Event()
    _task = asyncio.create_task(_watch_loop(_stop_event))


async def stop_watcher() -> None:
    global _task, _stop_event
    if _stop_event is not None:
        _stop_event.set()
    if _task is not None:
        try:
            await asyncio.wait_for(_task, timeout=2.0)
        except (TimeoutError, asyncio.CancelledError):
            _task.cancel()
    _task = None
    _stop_event = None
