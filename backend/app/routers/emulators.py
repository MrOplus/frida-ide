"""Emulator router — list AVDs and start them."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..services import emulator as emulator_service
from ..services.emulator import EmulatorNotFoundError

router = APIRouter(prefix="/api/emulators", tags=["emulators"])


@router.get("")
async def list_emulators() -> list[dict]:
    try:
        avds = await emulator_service.list_with_status()
    except EmulatorNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return [
        {"name": a.name, "running": a.running, "serial": a.serial} for a in avds
    ]


@router.post("/{name}/start")
async def start_emulator(name: str) -> dict:
    try:
        return await emulator_service.start(name)
    except EmulatorNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
