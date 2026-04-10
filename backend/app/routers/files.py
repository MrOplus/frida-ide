"""Project file browser — tree listing + file content."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from sqlmodel import Session

from ..db import engine
from ..models.project import Project
from ..services.apk_pipeline import project_root, safe_join

router = APIRouter(prefix="/api/projects", tags=["files"])

# File extensions we treat as text and will return as content
TEXT_EXTENSIONS = {
    ".java", ".kt", ".kts", ".smali", ".xml", ".json", ".yaml", ".yml",
    ".txt", ".md", ".properties", ".html", ".js", ".ts", ".css", ".gradle",
    ".pro", ".cfg", ".ini", ".toml", ".manifest", ".sh", ".bat", ".rs",
    ".c", ".cpp", ".h", ".hpp", ".m", ".mm", ".py",
}

MAX_TEXT_BYTES = 2 * 1024 * 1024  # 2 MB cap on text file responses


def _project_or_404(project_id: int) -> None:
    with Session(engine()) as db:
        if db.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")


def _resolve_root(project_id: int, source: str) -> Path:
    """Pick the apktool-out or jadx-out root for a given project."""
    root = project_root(project_id)
    if source == "apktool":
        return root / "apktool-out"
    if source == "jadx":
        return root / "jadx-out"
    raise HTTPException(status_code=400, detail="source must be 'jadx' or 'apktool'")


@router.get("/{project_id}/tree")
async def get_tree(
    project_id: int,
    path: str = Query(default=""),
    source: str = Query(default="jadx", pattern="^(jadx|apktool)$"),
) -> dict:
    """List the immediate children of `path` within the chosen output tree.

    Lazy-loading: clients fetch one level at a time. The frontend recursively
    expands as the user clicks into directories.
    """
    _project_or_404(project_id)
    root = _resolve_root(project_id, source)

    try:
        target = safe_join(root, path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if not target.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")

    entries: list[dict] = []
    for child in sorted(target.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
        try:
            stat = child.stat()
        except OSError:
            continue
        entries.append(
            {
                "name": child.name,
                "path": str(child.relative_to(root)).replace("\\", "/"),
                "type": "dir" if child.is_dir() else "file",
                "size": stat.st_size if child.is_file() else None,
            }
        )

    return {
        "source": source,
        "path": path,
        "entries": entries,
    }


@router.get("/{project_id}/file")
async def get_file(
    project_id: int,
    path: str = Query(...),
    source: str = Query(default="jadx", pattern="^(jadx|apktool)$"),
) -> Response:
    _project_or_404(project_id)
    root = _resolve_root(project_id, source)

    try:
        target = safe_join(root, path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="not a file")

    suffix = target.suffix.lower()
    if suffix not in TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"binary or unsupported file type: {suffix or '(no extension)'}",
        )

    size = target.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"file too large: {size} bytes")

    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return PlainTextResponse(content, headers={"X-File-Size": str(size)})
