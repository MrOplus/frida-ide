"""Subprocess wrapper around the ``adb`` CLI.

All methods are async and use ``create_subprocess_exec`` (argv arrays, never
shell strings) so user input cannot inject extra args. Device serials passed
through here MUST be validated by the caller against ``SERIAL_RE``.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from ..utils.paths import find_adb

SERIAL_RE = re.compile(r"^[A-Za-z0-9:._-]+$")


def validate_serial(serial: str) -> str:
    if not SERIAL_RE.match(serial):
        raise ValueError(f"Invalid device serial: {serial!r}")
    return serial


class AdbNotFoundError(RuntimeError):
    pass


class AdbCommandError(RuntimeError):
    def __init__(self, cmd: list[str], returncode: int, stdout: str, stderr: str):
        super().__init__(
            f"adb {' '.join(shlex.quote(c) for c in cmd)} failed "
            f"(exit {returncode}): {stderr.strip() or stdout.strip()}"
        )
        self.cmd = cmd
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@dataclass
class AdbDevice:
    serial: str
    state: str  # device | unauthorized | offline | no permissions | ...
    transport_id: str | None = None
    product: str | None = None
    model: str | None = None
    device: str | None = None
    properties: dict[str, str] = field(default_factory=dict)


# Module-level cache: serial -> root mode. Avoids re-probing on every call.
# Values: "direct" (adb shell already root), "su" (su -c works), "none" (no root).
_root_mode_cache: dict[str, str] = {}


class AdbClient:
    def __init__(self, adb_path: Path | None = None):
        self.adb_path = adb_path or find_adb()
        if self.adb_path is None:
            raise AdbNotFoundError("Could not locate `adb` binary")

    async def _run(
        self,
        *args: str,
        serial: str | None = None,
        timeout: float = 30.0,
    ) -> tuple[str, str]:
        cmd = [str(self.adb_path)]
        if serial:
            cmd += ["-s", validate_serial(serial)]
        cmd += list(args)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise AdbCommandError(cmd, -1, "", f"Timeout after {timeout}s") from None

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            raise AdbCommandError(cmd, proc.returncode or -1, stdout, stderr)
        return stdout, stderr

    async def devices(self) -> list[AdbDevice]:
        """Parse `adb devices -l` into structured rows."""
        try:
            stdout, _ = await self._run("devices", "-l", timeout=5)
        except AdbCommandError:
            return []

        devices: list[AdbDevice] = []
        for line in stdout.splitlines():
            line = line.strip()
            if not line or line.lower().startswith("list of devices"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            serial = parts[0]
            state = parts[1]
            extras: dict[str, str] = {}
            for tok in parts[2:]:
                if ":" in tok:
                    k, _, v = tok.partition(":")
                    extras[k] = v
            devices.append(
                AdbDevice(
                    serial=serial,
                    state=state,
                    transport_id=extras.get("transport_id"),
                    product=extras.get("product"),
                    model=extras.get("model"),
                    device=extras.get("device"),
                )
            )
        return devices

    async def connect(self, host: str, port: int = 5555) -> str:
        # Validate host:port — only allow safe chars
        if not re.match(r"^[A-Za-z0-9._-]+$", host):
            raise ValueError(f"Invalid host: {host!r}")
        if not (1 <= port <= 65535):
            raise ValueError(f"Invalid port: {port}")
        stdout, _ = await self._run("connect", f"{host}:{port}", timeout=10)
        return stdout.strip()

    async def getprop(self, serial: str, key: str) -> str:
        stdout, _ = await self._run("shell", "getprop", key, serial=serial, timeout=5)
        return stdout.strip()

    async def _detect_root_mode(self, serial: str) -> str:
        """Probe whether the device is rooted, and via which mechanism.

        Tries:
        1. ``adb shell id`` — already root via ``adb root``? (most emulators)
        2. ``adb shell su -c id`` — Magisk-style ``su -c`` works?
        3. ``adb root`` then re-probe ``id`` — eng/userdebug emulators that
           need an explicit ``adb root`` to switch the daemon to root.
        4. otherwise: no root.

        Result is cached per serial.
        """
        # Re-probe on a cached "none" — that's a failure state and the device
        # may have been elevated since (e.g. user ran `adb root`, or the
        # emulator was rebooted).
        cached = _root_mode_cache.get(serial)
        if cached and cached != "none":
            return cached

        # 1. Direct
        try:
            stdout, _ = await self._run("shell", "id", serial=serial, timeout=5)
            if "uid=0" in stdout:
                _root_mode_cache[serial] = "direct"
                return "direct"
        except AdbCommandError:
            pass

        # 2. su -c
        try:
            stdout, _ = await self._run("shell", "su", "-c", "id", serial=serial, timeout=5)
            if "uid=0" in stdout:
                _root_mode_cache[serial] = "su"
                return "su"
        except AdbCommandError:
            pass

        # 3. adb root — eng/userdebug Android emulator builds need the
        # daemon to be explicitly elevated. This restarts adbd and may
        # briefly drop the connection, so give it a moment then re-probe.
        try:
            await self._run("root", serial=serial, timeout=10)
            await asyncio.sleep(1.0)
            with contextlib.suppress(AdbCommandError):
                await self._run("wait-for-device", serial=serial, timeout=10)
            stdout, _ = await self._run("shell", "id", serial=serial, timeout=5)
            if "uid=0" in stdout:
                _root_mode_cache[serial] = "direct"
                return "direct"
        except AdbCommandError:
            pass

        _root_mode_cache[serial] = "none"
        return "none"

    def clear_root_cache(self, serial: str | None = None) -> None:
        """Drop cached root-mode entries so the next probe re-detects.

        Use this when the device may have been rebooted or its root state
        has otherwise changed (e.g. before retrying a failed install).
        """
        if serial is None:
            _root_mode_cache.clear()
        else:
            _root_mode_cache.pop(serial, None)

    async def shell(self, serial: str, *args: str, as_root: bool = False) -> str:
        if as_root:
            mode = await self._detect_root_mode(serial)
            if mode == "direct":
                stdout, _ = await self._run("shell", *args, serial=serial)
            elif mode == "su":
                stdout, _ = await self._run(
                    "shell",
                    "su",
                    "-c",
                    " ".join(shlex.quote(a) for a in args),
                    serial=serial,
                )
            else:
                raise AdbCommandError(["shell", *args], -1, "", "device is not rooted")
        else:
            stdout, _ = await self._run("shell", *args, serial=serial)
        return stdout

    async def is_root(self, serial: str) -> bool:
        return (await self._detect_root_mode(serial)) != "none"

    async def get_device_info(self, serial: str) -> dict[str, str | bool]:
        """Fetch ABI, Android version, and root status for one device."""

        async def safe(coro):
            try:
                return await coro
            except AdbCommandError:
                return ""

        abi, release, sdk, root = await asyncio.gather(
            safe(self.getprop(serial, "ro.product.cpu.abi")),
            safe(self.getprop(serial, "ro.build.version.release")),
            safe(self.getprop(serial, "ro.build.version.sdk")),
            self.is_root(serial),
        )
        return {
            "abi": str(abi),
            "android_release": str(release),
            "android_sdk": str(sdk),
            "rooted": bool(root),
        }
