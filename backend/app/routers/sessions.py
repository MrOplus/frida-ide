"""Sessions router — list past RunSessions and replay their HookEvents."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlmodel import Session, func, select

from ..db import engine
from ..models.hook_event import HookEvent
from ..models.run_session import RunSession

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _run_session_dict(rs: RunSession, event_count: int = 0) -> dict:
    # SQLite drops the tz on round-trip; coerce both sides to naive UTC for the
    # duration math so we don't TypeError on offset-aware vs offset-naive.
    def _naive(dt):
        return dt.replace(tzinfo=None) if dt is not None and dt.tzinfo is not None else dt

    started = _naive(rs.started_at)
    ended = _naive(rs.ended_at)
    now = datetime.now(UTC).replace(tzinfo=None)

    duration_ms = None
    if ended and started:
        duration_ms = int((ended - started).total_seconds() * 1000)
    elif started:
        duration_ms = int((now - started).total_seconds() * 1000)
    return {
        "id": rs.id,
        "device_serial": rs.device_serial,
        "target_identifier": rs.target_identifier,
        "pid": rs.pid,
        "mode": rs.mode,
        "status": rs.status,
        "started_at": rs.started_at.isoformat(),
        "ended_at": rs.ended_at.isoformat() if rs.ended_at else None,
        "duration_ms": duration_ms,
        "error_message": rs.error_message,
        "event_count": event_count,
    }


@router.get("")
async def list_sessions(limit: int = Query(default=100, ge=1, le=500)) -> list[dict]:
    """List run sessions newest first, with event counts."""
    with Session(engine()) as db:
        rows = list(
            db.exec(
                select(RunSession).order_by(RunSession.started_at.desc()).limit(limit)  # type: ignore[arg-type]
            ).all()
        )
        # Build event counts in one query
        if rows:
            ids = [r.id for r in rows if r.id is not None]
            counts = dict(
                db.exec(
                    select(HookEvent.run_session_id, func.count(HookEvent.id))  # type: ignore[arg-type]
                    .where(HookEvent.run_session_id.in_(ids))  # type: ignore[attr-defined]
                    .group_by(HookEvent.run_session_id)
                ).all()
            )
        else:
            counts = {}
        return [_run_session_dict(r, event_count=counts.get(r.id, 0)) for r in rows]


@router.get("/{session_id}")
async def get_session(session_id: int) -> dict:
    with Session(engine()) as db:
        rs = db.get(RunSession, session_id)
        if rs is None:
            raise HTTPException(status_code=404, detail="session not found")
        count = db.exec(
            select(func.count(HookEvent.id)).where(HookEvent.run_session_id == session_id)  # type: ignore[arg-type]
        ).one()
        return _run_session_dict(rs, event_count=count or 0)


@router.get("/{session_id}/events")
async def get_events(
    session_id: int,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict:
    with Session(engine()) as db:
        rs = db.get(RunSession, session_id)
        if rs is None:
            raise HTTPException(status_code=404, detail="session not found")
        rows = list(
            db.exec(
                select(HookEvent)
                .where(HookEvent.run_session_id == session_id)
                .order_by(HookEvent.ts.asc())  # type: ignore[arg-type]
                .offset(offset)
                .limit(limit)
            ).all()
        )
        return {
            "session_id": session_id,
            "offset": offset,
            "count": len(rows),
            "events": [
                {
                    "id": e.id,
                    "ts": e.ts.isoformat(),
                    "kind": e.kind,
                    "payload": json.loads(e.payload_json) if e.payload_json else None,
                }
                for e in rows
            ],
        }


@router.get("/{session_id}/export")
async def export_session(session_id: int) -> JSONResponse:
    """Download a session as JSON (run metadata + every event)."""
    with Session(engine()) as db:
        rs = db.get(RunSession, session_id)
        if rs is None:
            raise HTTPException(status_code=404, detail="session not found")
        events = list(
            db.exec(
                select(HookEvent)
                .where(HookEvent.run_session_id == session_id)
                .order_by(HookEvent.ts.asc())  # type: ignore[arg-type]
            ).all()
        )
    body = {
        "session": _run_session_dict(rs, event_count=len(events)),
        "events": [
            {
                "id": e.id,
                "ts": e.ts.isoformat(),
                "kind": e.kind,
                "payload": json.loads(e.payload_json) if e.payload_json else None,
            }
            for e in events
        ],
    }
    return JSONResponse(
        content=body,
        headers={
            "Content-Disposition": f'attachment; filename="frida-ide-session-{session_id}.json"'
        },
    )


@router.delete("/{session_id}")
async def delete_session(session_id: int) -> dict:
    with Session(engine()) as db:
        rs = db.get(RunSession, session_id)
        if rs is None:
            raise HTTPException(status_code=404, detail="session not found")
        # Delete events first
        events = list(
            db.exec(
                select(HookEvent).where(HookEvent.run_session_id == session_id)
            ).all()
        )
        for e in events:
            db.delete(e)
        db.delete(rs)
        db.commit()
    return {"ok": True, "deleted_events": len(events)}


@router.delete("")
async def delete_all_sessions() -> dict:
    """Delete every run-session and its hook-events. Running sessions are
    stopped first via FridaManager so the Frida scripts are properly
    unloaded."""
    from ..services.frida_manager import get_manager

    mgr = get_manager()

    with Session(engine()) as db:
        all_rs = list(db.exec(select(RunSession)).all())
        total_sessions = len(all_rs)
        total_events = 0

        for rs in all_rs:
            assert rs.id is not None
            # Best-effort stop any live run
            try:  # noqa: SIM105
                await mgr.stop(rs.id)
            except Exception:  # noqa: BLE001
                pass
            events = list(
                db.exec(
                    select(HookEvent).where(HookEvent.run_session_id == rs.id)
                ).all()
            )
            total_events += len(events)
            for e in events:
                db.delete(e)
            db.delete(rs)

        db.commit()

    return {
        "ok": True,
        "deleted_sessions": total_sessions,
        "deleted_events": total_events,
    }
