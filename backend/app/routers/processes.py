from fastapi import APIRouter, HTTPException

from ..services.adb import SERIAL_RE
from ..services.frida_manager import get_manager

router = APIRouter(prefix="/api/devices/{serial}", tags=["processes"])


def _check_serial(serial: str) -> None:
    if not SERIAL_RE.match(serial):
        raise HTTPException(status_code=400, detail=f"Invalid serial: {serial!r}")


@router.get("/processes")
async def list_processes(serial: str) -> list[dict]:
    _check_serial(serial)
    mgr = get_manager()
    try:
        return await mgr.list_processes(serial)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Frida error: {e}") from e


@router.get("/apps")
async def list_apps(serial: str) -> list[dict]:
    _check_serial(serial)
    mgr = get_manager()
    try:
        return await mgr.list_apps(serial)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Frida error: {e}") from e


@router.post("/kill")
async def kill_process(serial: str, payload: dict) -> dict:
    _check_serial(serial)
    pid = int(payload.get("pid", 0))
    if pid <= 0:
        raise HTTPException(status_code=400, detail="pid required")
    mgr = get_manager()
    try:
        await mgr.kill(serial, pid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Frida error: {e}") from e
    return {"ok": True}
