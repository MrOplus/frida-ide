"""APK decompilation pipeline.

Stages, with progress published to ``pipeline:{project_id}``:

  queued -> apktool -> jadx -> done
                                |
                              error  (any stage may fail)

* ``apktool d -f -o apktool-out base.apk``  — extracts AndroidManifest.xml,
  resources, and smali. We parse the manifest for package metadata.
* ``jadx -d jadx-out --show-bad-code base.apk [splits...]``  — full Java
  decompile. ``--show-bad-code`` is preferred so the IDE can still display
  partially-decompiled methods (the Teleporti DashboardScreenKt$lambda$76 case).

The pipeline runs as an asyncio task started by the projects router. Stdout +
stderr from each tool are captured and stored in the project meta_json so the
UI can show them on error.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree as ET

from sqlmodel import Session

from ..config import settings
from ..db import engine
from ..models.project import Project
from ..utils.paths import find_apktool, find_jadx
from .pubsub import pubsub

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


# ---------------------------------------------------------------------------
# Manifest parsing
# ---------------------------------------------------------------------------


def parse_android_manifest(manifest_path: Path) -> dict:
    """Extract package metadata from a decoded AndroidManifest.xml.

    apktool sometimes strips ``android:versionCode``/``versionName`` from the
    decoded manifest and stores them in ``apktool.yml`` instead. We fall back
    to reading that sibling file when the manifest attributes are absent.
    """
    if not manifest_path.exists():
        return {}
    try:
        tree = ET.parse(manifest_path)
    except ET.ParseError:
        return {}
    root = tree.getroot()

    meta: dict = {
        "package_name": root.get("package"),
        "version_name": root.get(f"{ANDROID_NS}versionName"),
        "platform_build_version_code": root.get("platformBuildVersionCode"),
        "platform_build_version_name": root.get("platformBuildVersionName"),
    }
    vc = root.get(f"{ANDROID_NS}versionCode")
    if vc and vc.isdigit():
        meta["version_code"] = int(vc)

    # Fallback: apktool.yml contains versionInfo: {versionCode, versionName}
    apktool_yml = manifest_path.parent / "apktool.yml"
    if apktool_yml.exists():
        try:
            text = apktool_yml.read_text(encoding="utf-8", errors="replace")
            # Tiny ad-hoc parser for the versionInfo block — avoids a yaml dep
            in_block = False
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith("versionInfo:"):
                    in_block = True
                    continue
                if in_block:
                    if not line.startswith(" "):
                        break
                    if stripped.startswith("versionCode:"):
                        val = stripped.split(":", 1)[1].strip().strip("'\"")
                        if val and val != "null" and "version_code" not in meta:
                            try:  # noqa: SIM105
                                meta["version_code"] = int(val)
                            except ValueError:
                                pass
                    elif stripped.startswith("versionName:"):
                        val = stripped.split(":", 1)[1].strip().strip("'\"")
                        if val and val != "null" and not meta.get("version_name"):
                            meta["version_name"] = val
        except OSError:
            pass

    permissions: list[str] = []
    for el in root.findall("uses-permission"):
        name = el.get(f"{ANDROID_NS}name")
        if name:
            permissions.append(name)
    meta["permissions"] = permissions

    # Find the launcher activity (best-effort, used for "Spawn from project")
    launcher = None
    for activity in root.iter("activity"):
        for intent in activity.findall("intent-filter"):
            actions = {a.get(f"{ANDROID_NS}name") for a in intent.findall("action")}
            categories = {c.get(f"{ANDROID_NS}name") for c in intent.findall("category")}
            if (
                "android.intent.action.MAIN" in actions
                and "android.intent.category.LAUNCHER" in categories
            ):
                launcher = activity.get(f"{ANDROID_NS}name")
                break
        if launcher:
            break
    meta["launcher_activity"] = launcher

    application = root.find("application")
    if application is not None:
        meta["application_name"] = application.get(f"{ANDROID_NS}name")
        meta["debuggable"] = application.get(f"{ANDROID_NS}debuggable") == "true"

    return meta


# ---------------------------------------------------------------------------
# Pipeline progress
# ---------------------------------------------------------------------------


def _publish(project_id: int, stage: str, **fields) -> None:
    pubsub.publish_nowait(
        f"pipeline:{project_id}",
        {
            "type": "stage",
            "ts": datetime.now(UTC).isoformat(),
            "payload": {"stage": stage, **fields},
        },
    )


def _update_status(project_id: int, status: str, **extras) -> None:
    with Session(engine()) as db:
        proj = db.get(Project, project_id)
        if proj is None:
            return
        proj.status = status
        if "package_name" in extras:
            proj.package_name = extras["package_name"]
        if "version_name" in extras:
            proj.version_name = extras["version_name"]
        if "version_code" in extras:
            proj.version_code = extras["version_code"]
        if "error_message" in extras:
            proj.error_message = extras["error_message"]
        if "meta_json" in extras:
            proj.meta_json = extras["meta_json"]
        db.add(proj)
        db.commit()
    _publish(project_id, status, **{k: v for k, v in extras.items() if k != "meta_json"})


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


async def _run_subprocess(
    project_id: int,
    label: str,
    argv: list[str],
    timeout: float,
) -> tuple[int, str, str]:
    """Run a subprocess and stream live output to the pipeline topic."""
    _publish(project_id, "running", label=label, command=argv)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        return -1, "", f"binary not found: {e}"

    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", f"{label} timed out after {timeout}s"

    return (
        proc.returncode or 0,
        stdout_b.decode("utf-8", errors="replace"),
        stderr_b.decode("utf-8", errors="replace"),
    )


def project_root(project_id: int) -> Path:
    return settings.projects_dir / str(project_id)


def _pick_base_apk(apk_paths: list[Path]) -> Path:
    """Pick the base APK from a possibly-split APK set."""
    # Prefer one literally named base.apk
    for p in apk_paths:
        if p.name == "base.apk":
            return p
    # Otherwise: largest file (splits are usually small)
    return max(apk_paths, key=lambda p: p.stat().st_size)


async def decompile_project(project_id: int, apk_paths: list[Path]) -> None:
    """End-to-end decompile pipeline. Updates the Project row + WS topic.

    Caller is responsible for creating the Project row in 'queued' state and
    persisting the uploaded APK files into ``project_root(id)/apk/`` first.
    """
    apktool = find_apktool()
    jadx = find_jadx()

    if apktool is None:
        _update_status(project_id, "error", error_message="apktool not found in PATH")
        return
    if jadx is None:
        _update_status(project_id, "error", error_message="jadx not found in PATH")
        return

    root = project_root(project_id)
    apktool_out = root / "apktool-out"
    jadx_out = root / "jadx-out"
    apktool_out.mkdir(parents=True, exist_ok=True)
    jadx_out.mkdir(parents=True, exist_ok=True)

    base = _pick_base_apk(apk_paths)

    # ----- Stage 1: apktool -----
    _update_status(project_id, "apktool")
    rc, stdout, stderr = await _run_subprocess(
        project_id,
        "apktool",
        [str(apktool), "d", "-f", "-o", str(apktool_out), str(base)],
        timeout=300,
    )
    if rc != 0:
        _update_status(
            project_id,
            "error",
            error_message=f"apktool failed: {stderr.strip() or stdout.strip()}"[:2000],
        )
        return

    # Parse the manifest now so the UI shows package name + version even before jadx finishes
    manifest = parse_android_manifest(apktool_out / "AndroidManifest.xml")
    extras: dict = {}
    if pkg := manifest.get("package_name"):
        extras["package_name"] = pkg
    if vn := manifest.get("version_name"):
        extras["version_name"] = vn
    if "version_code" in manifest:
        extras["version_code"] = manifest["version_code"]
    extras["meta_json"] = json.dumps(manifest)
    _update_status(project_id, "jadx", **extras)

    # ----- Stage 2: jadx -----
    jadx_argv = [
        str(jadx),
        "-d",
        str(jadx_out),
        "--show-bad-code",
        "--no-debug-info",
        "--no-res",  # we already have resources from apktool
        str(base),
    ]
    # Pass any split APKs jadx may want
    for p in apk_paths:
        if p != base:
            jadx_argv.append(str(p))

    rc, stdout, stderr = await _run_subprocess(
        project_id,
        "jadx",
        jadx_argv,
        timeout=900,  # 15 minutes for huge APKs
    )

    # jadx exits non-zero on partially-decompiled output, but the files are usable.
    # Treat exit 0 as success and any other exit as soft-error if jadx_out has content.
    has_output = any(jadx_out.rglob("*.java")) if jadx_out.exists() else False
    if rc == 0 or has_output:
        _update_status(project_id, "done")
    else:
        _update_status(
            project_id,
            "error",
            error_message=f"jadx failed: {stderr.strip() or stdout.strip()}"[:2000],
        )


# Track running pipeline tasks so the projects router can detach them
_running: dict[int, asyncio.Task] = {}


def start_pipeline(project_id: int, apk_paths: list[Path]) -> None:
    """Fire-and-forget: schedule a decompile task on the running event loop."""
    task = asyncio.create_task(decompile_project(project_id, apk_paths))
    _running[project_id] = task

    def _done(t: asyncio.Task) -> None:
        _running.pop(project_id, None)
        if t.cancelled():
            return
        if exc := t.exception():
            _publish(project_id, "error", error_message=f"pipeline crashed: {exc}")

    task.add_done_callback(_done)


# ---------------------------------------------------------------------------
# File tree helpers (used by routers/files.py)
# ---------------------------------------------------------------------------

_SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9_./\- $]+$")


def safe_join(root: Path, rel: str) -> Path:
    """Resolve ``rel`` against ``root`` and refuse if it escapes the root."""
    if rel.startswith("/") or ".." in rel.split("/"):
        raise ValueError("path escape attempt")
    if rel and not _SAFE_PATH_RE.match(rel):
        raise ValueError(f"invalid path characters: {rel!r}")
    candidate = (root / rel).resolve()
    if not str(candidate).startswith(str(root.resolve())):
        raise ValueError("path escape attempt")
    return candidate
