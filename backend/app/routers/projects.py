"""Projects router — APK upload, listing, deletion."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlmodel import Session, select

from ..config import settings
from ..db import engine
from ..models.project import Project
from ..services.adb import SERIAL_RE
from ..services.apk_pipeline import project_root, start_pipeline

# File(...) is hoisted to a module-level default to avoid B008 (function call in default).
_FILES_DEFAULT = File(...)

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _project_dict(p: Project) -> dict:
    try:
        meta = json.loads(p.meta_json) if p.meta_json else {}
    except json.JSONDecodeError:
        meta = {}
    return {
        "id": p.id,
        "name": p.name,
        "package_name": p.package_name,
        "version_name": p.version_name,
        "version_code": p.version_code,
        "sha256": p.sha256,
        "path": p.path,
        "status": p.status,
        "error_message": p.error_message,
        "created_at": p.created_at.isoformat(),
        "permissions": meta.get("permissions", []),
        "launcher_activity": meta.get("launcher_activity"),
        "debuggable": meta.get("debuggable"),
    }


@router.get("")
async def list_projects() -> list[dict]:
    with Session(engine()) as db:
        rows = db.exec(select(Project).order_by(Project.created_at.desc())).all()  # type: ignore[arg-type]
        return [_project_dict(p) for p in rows]


@router.get("/{project_id}")
async def get_project(project_id: int) -> dict:
    with Session(engine()) as db:
        p = db.get(Project, project_id)
        if p is None:
            raise HTTPException(status_code=404, detail="project not found")
        return _project_dict(p)


@router.post("")
async def create_project(files: list[UploadFile] = _FILES_DEFAULT) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="at least one APK required")

    # Use the largest filename (or one named base.apk) as the display name
    base_filename = next(
        (f.filename for f in files if f.filename and f.filename == "base.apk"),
        None,
    )
    if base_filename is None:
        base_filename = files[0].filename or "upload.apk"

    display_name = Path(base_filename).stem

    # Create the row first so we have an ID for the on-disk dir
    with Session(engine()) as db:
        proj = Project(
            name=display_name,
            path="",  # will be set after we know the ID
            status="queued",
        )
        db.add(proj)
        db.commit()
        db.refresh(proj)
        project_id = proj.id
        assert project_id is not None

    root = project_root(project_id)
    apk_dir = root / "apk"
    apk_dir.mkdir(parents=True, exist_ok=True)

    # Persist uploads
    saved_paths: list[Path] = []
    sha256 = hashlib.sha256()
    for upload in files:
        if not upload.filename:
            continue
        # Sanitize the filename — strip any path components
        safe_name = Path(upload.filename).name
        if not safe_name.endswith(".apk"):
            raise HTTPException(status_code=400, detail=f"not an APK: {upload.filename}")
        target = apk_dir / safe_name
        with open(target, "wb") as f:
            while chunk := await upload.read(1024 * 1024):
                f.write(chunk)
                sha256.update(chunk)
        saved_paths.append(target)

    if not saved_paths:
        # Roll back the empty project
        shutil.rmtree(root, ignore_errors=True)
        with Session(engine()) as db:
            p = db.get(Project, project_id)
            if p is not None:
                db.delete(p)
                db.commit()
        raise HTTPException(status_code=400, detail="no valid APK files in upload")

    with Session(engine()) as db:
        p = db.get(Project, project_id)
        assert p is not None
        p.path = str(root)
        p.sha256 = sha256.hexdigest()
        db.add(p)
        db.commit()
        db.refresh(p)
        result = _project_dict(p)

    # Kick off the decompile pipeline as a background task
    start_pipeline(project_id, saved_paths)

    return result


# Package-name validator shared with devices.py — keep both in sync.
_PKG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$")


@router.post("/from-pulled/{serial}/{identifier}")
async def create_project_from_pulled(serial: str, identifier: str) -> dict:
    """Create a project from APKs already pulled via the device router.

    No upload round-trip: the server copies the previously-pulled files
    from ``~/.frida-ide/pulled/<serial>/<identifier>/`` into a fresh
    project directory and kicks off the normal decompile pipeline. Used
    by the "Open in new project" action on the pull-completion toast.
    """
    if not SERIAL_RE.match(serial):
        raise HTTPException(status_code=400, detail=f"Invalid serial: {serial!r}")
    if not _PKG_RE.match(identifier):
        raise HTTPException(
            status_code=400, detail=f"Invalid package identifier: {identifier!r}"
        )

    # Resolve + sandbox-check the source directory. We refuse anything
    # outside ~/.frida-ide/pulled/ so a crafted request can't copy
    # arbitrary files into a project.
    pulled_root = (settings.data_dir / "pulled").resolve()
    source_dir = (pulled_root / serial / identifier).resolve()
    try:
        source_dir.relative_to(pulled_root)
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail="resolved source path escaped pulled root"
        ) from e
    if not source_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=(
                f"No pulled APKs found for {identifier} on {serial}. "
                "Hit Pull on the device first."
            ),
        )
    apk_files = sorted(source_dir.glob("*.apk"))
    if not apk_files:
        raise HTTPException(
            status_code=404, detail=f"No .apk files under {source_dir}"
        )

    # Pick a display name: prefer base.apk, else the largest file, else the
    # package id. ``stem`` strips .apk so e.g. "Settings" shows up, not
    # "Settings.apk".
    base = next((p for p in apk_files if p.name == "base.apk"), None)
    if base is None:
        base = max(apk_files, key=lambda p: p.stat().st_size)
    display_name = base.stem or identifier

    # Allocate the Project row up front to get the ID for on-disk layout.
    with Session(engine()) as db:
        proj = Project(name=display_name, path="", status="queued")
        db.add(proj)
        db.commit()
        db.refresh(proj)
        project_id = proj.id
        assert project_id is not None

    root = project_root(project_id)
    apk_dir = root / "apk"
    apk_dir.mkdir(parents=True, exist_ok=True)

    saved_paths: list[Path] = []
    sha256 = hashlib.sha256()
    for src in apk_files:
        dst = apk_dir / src.name
        # shutil.copy preserves file content; we hash during copy so the
        # project row's sha256 matches a fresh upload of the same file.
        with open(src, "rb") as fin, open(dst, "wb") as fout:
            while chunk := fin.read(1024 * 1024):
                fout.write(chunk)
                sha256.update(chunk)
        saved_paths.append(dst)

    with Session(engine()) as db:
        p = db.get(Project, project_id)
        assert p is not None
        p.path = str(root)
        p.sha256 = sha256.hexdigest()
        db.add(p)
        db.commit()
        db.refresh(p)
        result = _project_dict(p)

    # Kick off decompile in the background — client will see status
    # updates on the pipeline WS as the pipeline advances.
    start_pipeline(project_id, saved_paths)
    return result


@router.delete("/{project_id}")
async def delete_project(project_id: int) -> dict:
    with Session(engine()) as db:
        p = db.get(Project, project_id)
        if p is None:
            raise HTTPException(status_code=404, detail="project not found")
        path = p.path
        db.delete(p)
        db.commit()
    if path:
        shutil.rmtree(path, ignore_errors=True)
    return {"ok": True}
