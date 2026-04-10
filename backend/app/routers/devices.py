from fastapi import APIRouter, HTTPException

from ..services import frida_server
from ..services.adb import SERIAL_RE
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
