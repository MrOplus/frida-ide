from fastapi import APIRouter

from ..config import settings
from ..utils.paths import find_adb, find_apktool, find_claude, find_jadx

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": "0.1.0",
        "data_dir": str(settings.data_dir),
        "tools": {
            "adb": str(find_adb()) if find_adb() else None,
            "jadx": str(find_jadx()) if find_jadx() else None,
            "apktool": str(find_apktool()) if find_apktool() else None,
            "claude": str(find_claude()) if find_claude() else None,
        },
    }
