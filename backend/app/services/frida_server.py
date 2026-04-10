"""frida-server installer.

Downloads the matching ``frida-server-{version}-{arch}`` binary from GitHub
releases, decompresses it locally with stdlib ``lzma``, caches under
``~/.frida-ide/frida-server-cache/``, then pushes to the device and starts it
as root.

Why we control this from the IDE:

* Users frequently forget to push frida-server before attaching, or end up
  with a version mismatch after upgrading the Python ``frida`` package. The
  IDE pins both sides to ``frida.__version__`` and offers one-click reinstall
  on mismatch — that's the biggest concrete UX win over running things by
  hand.
"""

from __future__ import annotations

import asyncio
import lzma
from datetime import UTC, datetime
from pathlib import Path

import frida
import httpx

from ..config import settings
from ..utils.arch import frida_arch_for_abi
from .adb import AdbClient, validate_serial
from .pubsub import pubsub

REMOTE_SERVER_PATH = "/data/local/tmp/frida-server"


def _publish(serial: str, payload: dict) -> None:
    pubsub.publish_nowait(
        "devices",
        {
            "type": "frida_server_progress",
            "ts": datetime.now(UTC).isoformat(),
            "payload": {"serial": serial, **payload},
        },
    )


# ---------------------------------------------------------------------------
# Local cache
# ---------------------------------------------------------------------------


def cache_path_for(version: str, arch: str) -> Path:
    return settings.frida_server_cache_dir / version / arch / "frida-server"


async def ensure_cached(version: str, arch: str) -> Path:
    """Download + decompress frida-server-{version}-{arch}.xz if not already cached."""
    target = cache_path_for(version, arch)
    if target.exists():
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    asset = f"frida-server-{version}-{arch}.xz"
    url = f"https://github.com/frida/frida/releases/download/{version}/{asset}"

    async with (
        httpx.AsyncClient(follow_redirects=True, timeout=300.0) as client,
        client.stream("GET", url) as resp,
    ):
        if resp.status_code != 200:
            raise RuntimeError(
                f"failed to download frida-server: HTTP {resp.status_code} {url}"
            )
        xz_path = target.with_suffix(".xz")
        with open(xz_path, "wb") as f:
            async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                f.write(chunk)

    # Decompress
    with lzma.open(xz_path, "rb") as src, open(target, "wb") as dst:
        while True:
            block = src.read(64 * 1024)
            if not block:
                break
            dst.write(block)
    xz_path.unlink(missing_ok=True)
    target.chmod(0o755)
    return target


# ---------------------------------------------------------------------------
# Device-side operations
# ---------------------------------------------------------------------------


async def detect_remote_version(adb: AdbClient, serial: str) -> str | None:
    """Run ``frida-server --version`` on the device, returning the version or None."""
    try:
        out = await adb.shell(serial, REMOTE_SERVER_PATH, "--version")
        return out.strip() or None
    except Exception:  # noqa: BLE001
        return None


async def is_running(adb: AdbClient, serial: str) -> bool:
    """Quick liveness check via ``frida.get_device(...).enumerate_processes()``."""
    try:
        device = await asyncio.to_thread(frida.get_device, serial, 2)
        await asyncio.to_thread(device.enumerate_processes)
        return True
    except Exception:  # noqa: BLE001
        return False


async def install(serial: str) -> dict:
    """End-to-end install: download → push → start. Streams progress to /ws/devices."""
    validate_serial(serial)
    adb = AdbClient()
    # The device may have been rebooted since we last probed root state
    # (especially common with emulators). Force a fresh detection so a stale
    # "none" cache entry doesn't fail the chmod step below.
    adb.clear_root_cache(serial)

    expected_version = frida.__version__
    _publish(serial, {"stage": "detect_abi"})

    abi = (await adb.getprop(serial, "ro.product.cpu.abi")).strip()
    arch = frida_arch_for_abi(abi)
    if not arch:
        raise RuntimeError(f"unsupported device ABI: {abi!r}")

    _publish(serial, {"stage": "downloading", "version": expected_version, "arch": arch})
    cached = await ensure_cached(expected_version, arch)

    _publish(serial, {"stage": "pushing", "size": cached.stat().st_size})
    # Push first to a writable location, then move into /data/local/tmp via root
    await adb._run("push", str(cached), REMOTE_SERVER_PATH, serial=serial, timeout=120)
    await adb.shell(serial, "chmod", "755", REMOTE_SERVER_PATH, as_root=True)

    _publish(serial, {"stage": "starting"})
    await start(serial)

    _publish(serial, {"stage": "ready", "version": expected_version})
    return {"ok": True, "version": expected_version, "arch": arch}


async def start(serial: str) -> None:
    """Spawn frida-server in the background as root via ``nohup`` + ``setsid``."""
    validate_serial(serial)
    adb = AdbClient()
    # Best-effort: kill any existing instance first so a re-install doesn't double-run
    try:  # noqa: SIM105
        await adb.shell(serial, "pkill", "-f", "frida-server", as_root=True)
    except Exception:  # noqa: BLE001
        pass

    # Fire-and-forget — adb shell would otherwise block waiting for the child to exit
    await adb.shell(
        serial,
        "nohup",
        REMOTE_SERVER_PATH,
        ">/dev/null",
        "2>&1",
        "&",
        as_root=True,
    )

    # Poll for liveness up to 5 seconds
    for _ in range(10):
        if await is_running(adb, serial):
            return
        await asyncio.sleep(0.5)
    raise RuntimeError("frida-server did not become responsive within 5s")


async def stop(serial: str) -> None:
    validate_serial(serial)
    adb = AdbClient()
    try:  # noqa: SIM105
        await adb.shell(serial, "pkill", "-f", "frida-server", as_root=True)
    except Exception:  # noqa: BLE001
        pass
    _publish(serial, {"stage": "stopped"})


async def status(serial: str) -> dict:
    validate_serial(serial)
    adb = AdbClient()
    running = await is_running(adb, serial)
    remote_version = await detect_remote_version(adb, serial) if running else None
    return {
        "running": running,
        "remote_version": remote_version,
        "expected_version": frida.__version__,
        "version_match": remote_version == frida.__version__ if remote_version else None,
    }


async def ensure_running(serial: str) -> bool:
    """Best-effort: make sure frida-server is alive on the device.

    Called from the spawn/attach hot path so users don't have to manually
    install before their first hook. Returns ``True`` if frida-server is
    running by the time this returns, ``False`` otherwise (in which case
    the caller should surface a clear error).

    Behavior:
    1. If frida-server is already running → return True immediately.
    2. If the binary is on disk under ``/data/local/tmp/`` → just start it.
    3. Otherwise → run the full ``install`` flow (download + push + start).
    """
    validate_serial(serial)
    adb = AdbClient()

    if await is_running(adb, serial):
        return True

    # Is the binary already on the device?
    try:
        out = await adb.shell(serial, "ls", REMOTE_SERVER_PATH)
        already_on_disk = REMOTE_SERVER_PATH in out and "No such" not in out
    except Exception:  # noqa: BLE001
        already_on_disk = False

    try:
        if already_on_disk:
            await start(serial)
        else:
            await install(serial)
        return True
    except Exception:  # noqa: BLE001
        return False
