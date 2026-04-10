"""Discovery helpers for external CLI tools (adb, jadx, apktool, claude)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from ..config import settings


def _candidates(env_value: str | None, name: str, extras: list[Path]) -> list[Path]:
    out: list[Path] = []
    if env_value:
        out.append(Path(env_value))
    which = shutil.which(name)
    if which:
        out.append(Path(which))
    out.extend(extras)
    return out


def find_adb() -> Path | None:
    extras: list[Path] = []
    home = Path.home()
    if os.name == "posix":
        if (home / "Library/Android/sdk/platform-tools/adb").exists():
            extras.append(home / "Library/Android/sdk/platform-tools/adb")
        if (home / "Android/Sdk/platform-tools/adb").exists():
            extras.append(home / "Android/Sdk/platform-tools/adb")
    if android_home := os.environ.get("ANDROID_HOME"):
        extras.append(Path(android_home) / "platform-tools/adb")
    return _first_existing(_candidates(settings.adb_bin, "adb", extras))


def find_emulator() -> Path | None:
    """Locate the Android `emulator` binary that ships with the SDK."""
    extras: list[Path] = []
    home = Path.home()
    if os.name == "posix":
        if (home / "Library/Android/sdk/emulator/emulator").exists():
            extras.append(home / "Library/Android/sdk/emulator/emulator")
        if (home / "Android/Sdk/emulator/emulator").exists():
            extras.append(home / "Android/Sdk/emulator/emulator")
    for env_key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if root := os.environ.get(env_key):
            extras.append(Path(root) / "emulator/emulator")
    return _first_existing(_candidates(None, "emulator", extras))


def find_jadx() -> Path | None:
    return _first_existing(_candidates(settings.jadx_bin, "jadx", []))


def find_apktool() -> Path | None:
    return _first_existing(_candidates(settings.apktool_bin, "apktool", []))


def find_claude() -> Path | None:
    extras = [Path.home() / ".local/bin/claude", Path("/usr/local/bin/claude")]
    return _first_existing(_candidates(settings.claude_bin, "claude", extras))


def _first_existing(paths: list[Path]) -> Path | None:
    for p in paths:
        if p.exists():
            return p
    return None
