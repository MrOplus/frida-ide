import re
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import settings
from ..services import frida_server
from ..services.adb import SERIAL_RE, AdbClient, AdbCommandError
from ..services.frida_manager import get_manager

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("")
async def list_devices() -> list[dict]:
    mgr = get_manager()
    devices = await mgr.list_devices()
    return [
        {
            "id": d.id,
            "name": d.name,
            "type": d.type,
            "abi": d.abi,
            "android_release": d.android_release,
            "android_sdk": d.android_sdk,
            "rooted": d.rooted,
            "frida_server_running": d.frida_server_running,
            "frida_server_version": d.frida_server_version,
        }
        for d in devices
    ]


@router.post("/connect")
async def connect_device(payload: dict) -> dict:
    host = payload.get("host")
    port = int(payload.get("port", 5555))
    if not host:
        raise HTTPException(status_code=400, detail="host is required")
    mgr = get_manager()
    if mgr.adb is None:
        raise HTTPException(status_code=503, detail="adb not available")
    try:
        result = await mgr.adb.connect(host, port)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "result": result}


def _validate_serial_or_404(serial: str) -> str:
    if not SERIAL_RE.match(serial):
        raise HTTPException(status_code=400, detail=f"Invalid serial: {serial!r}")
    return serial


# ---------------------------------------------------------------------------
# frida-server lifecycle
# ---------------------------------------------------------------------------


@router.post("/{serial}/frida-server/install")
async def install_frida_server(serial: str) -> dict:
    _validate_serial_or_404(serial)
    try:
        return await frida_server.install(serial)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/{serial}/frida-server/start")
async def start_frida_server(serial: str) -> dict:
    _validate_serial_or_404(serial)
    try:
        await frida_server.start(serial)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@router.post("/{serial}/frida-server/stop")
async def stop_frida_server(serial: str) -> dict:
    _validate_serial_or_404(serial)
    await frida_server.stop(serial)
    return {"ok": True}


@router.get("/{serial}/frida-server/status")
async def frida_server_status(serial: str) -> dict:
    _validate_serial_or_404(serial)
    try:
        return await frida_server.status(serial)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


# ---------------------------------------------------------------------------
# Pull APK from device
# ---------------------------------------------------------------------------

# Android package identifiers: letters, digits, underscores, dots. No slashes
# or shell metacharacters — we use argv arrays to adb so this is belt-and-
# suspenders, but we still validate to produce friendly 400s.
_PKG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$")


def _sanitize_pkg(identifier: str) -> str:
    if not _PKG_RE.match(identifier):
        raise HTTPException(
            status_code=400, detail=f"Invalid package identifier: {identifier!r}"
        )
    return identifier


@router.post("/{serial}/apps/{identifier}/pull")
async def pull_apk(serial: str, identifier: str) -> dict:
    """Pull every APK making up an installed app (base + splits) from the
    device into ``~/.frida-ide/pulled/<serial>/<identifier>/``.

    Works for split APKs (``--user 0`` + ``pm path`` returns one line per
    split). Each line looks like ``package:/data/app/.../base.apk``. We
    strip the ``package:`` prefix and ``adb pull`` each file.
    """
    _validate_serial_or_404(serial)
    _sanitize_pkg(identifier)
    adb = AdbClient()

    # 1. Resolve on-device paths.
    try:
        out = await adb.shell(serial, "pm", "path", identifier)
    except AdbCommandError as e:
        raise HTTPException(status_code=502, detail=f"adb shell failed: {e}") from e

    remote_paths = [
        line.removeprefix("package:").strip()
        for line in out.splitlines()
        if line.startswith("package:")
    ]
    if not remote_paths:
        raise HTTPException(
            status_code=404,
            detail=f"Package {identifier!r} not installed on {serial}",
        )

    # 2. Build a clean output directory.
    out_dir = settings.data_dir / "pulled" / serial / identifier
    # Wipe and recreate so a re-pull gives a deterministic set of files
    # without stale splits from a previous pull lingering.
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    saved: list[dict] = []
    total_size = 0
    for rp in remote_paths:
        # Defensive: the remote side shouldn't produce anything weird, but
        # we still strip to a basename so a crafted path can't climb out of
        # our out_dir.
        local_name = Path(rp).name or "unknown.apk"
        local_path = out_dir / local_name
        try:
            await adb._run("pull", rp, str(local_path), serial=serial, timeout=300)
        except AdbCommandError as e:
            raise HTTPException(
                status_code=502, detail=f"adb pull {rp} failed: {e}"
            ) from e
        try:
            size = local_path.stat().st_size
        except OSError:
            size = 0
        total_size += size
        saved.append(
            {
                "remote_path": rp,
                "local_path": str(local_path),
                "filename": local_name,
                "size": size,
            }
        )

    return {
        "ok": True,
        "serial": serial,
        "identifier": identifier,
        "output_dir": str(out_dir),
        "apks": saved,
        "total_size": total_size,
    }
