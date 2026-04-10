"""Projects router — APK upload, listing, deletion."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlmodel import Session, select

from ..db import engine
from ..models.project import Project
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
