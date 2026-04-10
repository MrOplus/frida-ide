"""Android emulator (AVD) management.

Lists configured AVDs via ``emulator -list-avds`` and can launch one as a
detached background subprocess (so it survives the FastAPI process). Maps
running ``emulator-NNNN`` adb serials back to AVD names by asking each
running device for its name via ``adb -s emulator-NNNN emu avd name``.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..config import settings
from ..utils.paths import find_emulator
from .adb import AdbClient, AdbCommandError


class EmulatorNotFoundError(RuntimeError):
    pass


@dataclass
class AvdInfo:
    name: str
    running: bool
    serial: str | None  # the adb serial (e.g. "emulator-5554") if currently running


def _logs_dir() -> Path:
    p = settings.logs_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


async def list_avds() -> list[str]:
    """Run ``emulator -list-avds`` and return the AVD names."""
    binary = find_emulator()
    if binary is None:
        raise EmulatorNotFoundError("Could not locate Android `emulator` binary")

    proc = await asyncio.create_subprocess_exec(
        str(binary),
        "-list-avds",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return []

    if proc.returncode != 0:
        return []

    text = stdout_b.decode("utf-8", errors="replace")
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.startswith("INFO")
    ]


async def _avd_name_for_serial(adb: AdbClient, serial: str) -> str | None:
    """Ask a running emulator for its AVD name via ``adb -s … emu avd name``."""
    try:
        out, _ = await adb._run("-s", serial, "emu", "avd", "name", timeout=5)
    except AdbCommandError:
        return None
    # Output format:
    #   <avd_name>
    #   OK
    for line in out.splitlines():
        line = line.strip()
        if line and line != "OK":
            return line
    return None


async def list_with_status() -> list[AvdInfo]:
    """List AVDs with their running/stopped status."""
    names = await list_avds()
    if not names:
        return []

    adb = AdbClient()
    try:
        devices = await adb.devices()
    except Exception:  # noqa: BLE001
        devices = []

    # Map serial -> avd name (only for emulator-* serials that respond to `emu avd name`)
    serial_to_avd: dict[str, str] = {}
    emulator_serials = [d.serial for d in devices if d.serial.startswith("emulator-")]
    if emulator_serials:
        results = await asyncio.gather(
            *(_avd_name_for_serial(adb, s) for s in emulator_serials),
            return_exceptions=True,
        )
        for serial, avd in zip(emulator_serials, results, strict=False):
            if isinstance(avd, str) and avd:
                serial_to_avd[avd] = serial

    return [
        AvdInfo(
            name=name,
            running=name in serial_to_avd,
            serial=serial_to_avd.get(name),
        )
        for name in names
    ]


async def start(name: str) -> dict:
    """Launch an AVD as a detached background subprocess.

    The emulator process must outlive the FastAPI process, so we use
    ``start_new_session=True`` (or ``setsid``) and don't keep the
    ``Popen`` handle. stdout/stderr are redirected to a per-AVD log file
    in the data dir for debugging.
    """
    binary = find_emulator()
    if binary is None:
        raise EmulatorNotFoundError("Could not locate Android `emulator` binary")

    # Validate name to avoid argument injection — AVD names are restricted to
    # alphanumerics, underscores, dots, and hyphens.
    import re

    if not re.match(r"^[A-Za-z0-9_.-]+$", name):
        raise ValueError(f"Invalid AVD name: {name!r}")

    log_path = _logs_dir() / f"emulator-{name}.log"
    # Intentionally not using a context manager: the fd is dup'd into the
    # detached child by Popen and must outlive this function.
    log_fp = open(log_path, "ab", buffering=0)  # noqa: SIM115

    # `emulator @<name>` is equivalent to `emulator -avd <name>`
    argv = [str(binary), "-avd", name]

    # Detach so the emulator survives our process. ``start_new_session`` is the
    # cross-platform way; on POSIX it calls setsid().
    popen_kwargs: dict = {
        "stdout": log_fp,
        "stderr": log_fp,
        "stdin": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True

    # Run the spawn on a worker thread so we don't block the loop.
    proc = await asyncio.to_thread(
        lambda: subprocess.Popen(argv, **popen_kwargs)  # noqa: S603
    )

    return {"ok": True, "pid": proc.pid, "log": str(log_path)}
