"""Script run lifecycle.

POST /api/scripts/run -> creates a RunSession, spawns or attaches via Frida,
loads the user's JS script, and returns the run_session_id. The client then
opens /ws/run/{run_session_id} to stream send() output.

POST /api/scripts/{run_session_id}/stop -> unload script, detach, mark stopped.
"""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..db import engine
from ..models.run_session import RunSession
from ..services.adb import SERIAL_RE
from ..services.frida_manager import get_manager

router = APIRouter(prefix="/api/scripts", tags=["scripts"])


class RunRequest(BaseModel):
    device_serial: str
    mode: Literal["spawn", "attach"]
    target_identifier: str | None = None  # required for spawn (package name)
    pid: int | None = None  # required for attach
    source: str = Field(..., min_length=1)


class RunResponse(BaseModel):
    run_session_id: int
    pid: int
    mode: str
    status: str


@router.post("/run", response_model=RunResponse)
async def run_script(req: RunRequest) -> RunResponse:
    if not SERIAL_RE.match(req.device_serial):
        raise HTTPException(status_code=400, detail="Invalid serial")
    if req.mode == "spawn" and not req.target_identifier:
        raise HTTPException(status_code=400, detail="target_identifier required for spawn")
    if req.mode == "attach" and not req.pid:
        raise HTTPException(status_code=400, detail="pid required for attach")

    mgr = get_manager()

    # Create RunSession row first so we have the id for the topic
    with Session(engine()) as db:
        rs = RunSession(
            device_serial=req.device_serial,
            target_identifier=req.target_identifier,
            pid=req.pid,
            mode=req.mode,
            status="starting",
        )
        db.add(rs)
        db.commit()
        db.refresh(rs)
        run_id = rs.id  # type: ignore[assignment]
        assert run_id is not None

    try:
        if req.mode == "spawn":
            attached = await mgr.spawn(req.device_serial, req.target_identifier, run_id)  # type: ignore[arg-type]
        else:
            attached = await mgr.attach(req.device_serial, req.pid, run_id)  # type: ignore[arg-type]

        await mgr.load_script(run_id, req.source)

        if req.mode == "spawn":
            await mgr.resume(run_id)

        # Update DB row with the actual PID + status
        with Session(engine()) as db:
            rs = db.get(RunSession, run_id)
            assert rs is not None
            rs.pid = attached.pid
            rs.status = "running"
            db.add(rs)
            db.commit()

        return RunResponse(
            run_session_id=run_id,
            pid=attached.pid,
            mode=req.mode,
            status="running",
        )
    except Exception as e:  # noqa: BLE001
        # Mark error status, attempt cleanup
        with Session(engine()) as db:
            rs = db.get(RunSession, run_id)
            if rs is not None:
                rs.status = "error"
                rs.error_message = str(e)
                rs.ended_at = datetime.now(UTC)
                db.add(rs)
                db.commit()
        try:  # noqa: SIM105
            await mgr.stop(run_id)
        except Exception:  # noqa: BLE001
            pass

        # Distinguish "frida-server isn't there" (a setup problem we couldn't
        # auto-recover from) from a generic Frida error so the frontend can
        # surface a useful action.
        msg = str(e)
        if "frida-server is not running" in msg:
            raise HTTPException(status_code=409, detail=msg) from e
        if "need Gadget" in msg:
            raise HTTPException(
                status_code=409,
                detail=(
                    "frida-server is not running on the target device. "
                    "Open the Devices page and click 'Install frida-server' to fix this."
                ),
            ) from e
        raise HTTPException(status_code=502, detail=f"Frida error: {e}") from e


@router.post("/{run_session_id}/stop")
async def stop_script(run_session_id: int) -> dict:
    mgr = get_manager()
    await mgr.stop(run_session_id)
    with Session(engine()) as db:
        rs = db.get(RunSession, run_session_id)
        if rs is not None:
            rs.status = "stopped"
            rs.ended_at = datetime.now(UTC)
            db.add(rs)
            db.commit()
    return {"ok": True}


@router.get("/{run_session_id}")
async def get_run_session(run_session_id: int) -> dict:
    with Session(engine()) as db:
        rs = db.get(RunSession, run_session_id)
        if rs is None:
            raise HTTPException(status_code=404, detail="run_session not found")
        return {
            "id": rs.id,
            "device_serial": rs.device_serial,
            "target_identifier": rs.target_identifier,
            "pid": rs.pid,
            "mode": rs.mode,
            "status": rs.status,
            "started_at": rs.started_at.isoformat(),
            "ended_at": rs.ended_at.isoformat() if rs.ended_at else None,
            "error_message": rs.error_message,
        }
