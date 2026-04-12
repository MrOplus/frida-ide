"""AI session router — spawns Claude as a subprocess scoped to a project's
decompiled tree, persists messages, and exposes an extract-script helper that
parses the last assistant turn for a fenced ```javascript block.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import engine
from ..models.ai_session import AiMessage, AiSession
from ..models.project import Project
from ..services.apk_pipeline import project_root
from ..services.claude_runner import (
    ClaudeNotFoundError,
    get_runner,
    start_runner,
    stop_runner,
)

router = APIRouter(prefix="/api/projects", tags=["ai"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CreateSessionResponse(BaseModel):
    id: int
    project_id: int
    pid: int | None
    status: str
    started_at: str


class SendMessageRequest(BaseModel):
    text: str


class ExtractedScript(BaseModel):
    found: bool
    source: str | None
    language: str | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_or_404(project_id: int) -> Project:
    with Session(engine()) as db:
        p = db.get(Project, project_id)
        if p is None:
            raise HTTPException(status_code=404, detail="project not found")
        if p.status != "done":
            raise HTTPException(
                status_code=409,
                detail=f"project not ready (status={p.status}); wait for decompile",
            )
        return Project.model_validate(p)


def _session_or_404(project_id: int, ai_session_id: int) -> AiSession:
    with Session(engine()) as db:
        s = db.get(AiSession, ai_session_id)
        if s is None or s.project_id != project_id:
            raise HTTPException(status_code=404, detail="ai session not found")
        return AiSession.model_validate(s)


def _ai_session_dict(s: AiSession) -> dict:
    return {
        "id": s.id,
        "project_id": s.project_id,
        "pid": s.pid,
        "status": s.status,
        "started_at": s.started_at.isoformat(),
        "ended_at": s.ended_at.isoformat() if s.ended_at else None,
    }


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


@router.post("/{project_id}/ai/session", response_model=None)
async def create_session(project_id: int) -> dict:
    proj = _project_or_404(project_id)

    cwd = project_root(project_id) / "jadx-out"
    if not cwd.exists():
        # Fallback to apktool-out if jadx output is missing
        cwd = project_root(project_id) / "apktool-out"
    if not cwd.exists():
        raise HTTPException(
            status_code=500,
            detail=f"no decompiled output found for project {project_id}",
        )

    # Create the row first so the runner can persist its PID into it
    with Session(engine()) as db:
        sess = AiSession(project_id=project_id, status="starting")
        db.add(sess)
        db.commit()
        db.refresh(sess)
        ai_session_id = sess.id
        assert ai_session_id is not None

    try:
        await start_runner(ai_session_id, cwd)
    except ClaudeNotFoundError as e:
        with Session(engine()) as db:
            s = db.get(AiSession, ai_session_id)
            if s is not None:
                s.status = "error"
                s.ended_at = datetime.now(UTC)
                db.add(s)
                db.commit()
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        with Session(engine()) as db:
            s = db.get(AiSession, ai_session_id)
            if s is not None:
                s.status = "error"
                s.ended_at = datetime.now(UTC)
                db.add(s)
                db.commit()
        raise HTTPException(status_code=500, detail=f"failed to start claude: {e}") from e

    # Re-read the row so we get the runner-set pid + status
    with Session(engine()) as db:
        sess = db.get(AiSession, ai_session_id)
        assert sess is not None
        return {
            **_ai_session_dict(sess),
            "project_name": proj.package_name or proj.name,
            "cwd": str(cwd),
        }


@router.get("/{project_id}/ai/sessions")
async def list_sessions(project_id: int) -> list[dict]:
    with Session(engine()) as db:
        rows = db.exec(
            select(AiSession)
            .where(AiSession.project_id == project_id)
            .order_by(AiSession.started_at.desc())  # type: ignore[arg-type]
        ).all()
        return [_ai_session_dict(s) for s in rows]


@router.get("/{project_id}/ai/session/{ai_session_id}")
async def get_session(project_id: int, ai_session_id: int) -> dict:
    s = _session_or_404(project_id, ai_session_id)
    return _ai_session_dict(s)


@router.get("/{project_id}/ai/session/{ai_session_id}/messages")
async def get_messages(project_id: int, ai_session_id: int) -> list[dict]:
    _session_or_404(project_id, ai_session_id)
    with Session(engine()) as db:
        rows = db.exec(
            select(AiMessage)
            .where(AiMessage.ai_session_id == ai_session_id)
            .order_by(AiMessage.ts.asc())  # type: ignore[arg-type]
        ).all()
        out: list[dict] = []
        for m in rows:
            try:
                content = json.loads(m.content_json)
            except json.JSONDecodeError:
                content = m.content_json
            out.append(
                {
                    "id": m.id,
                    "role": m.role,
                    "ts": m.ts.isoformat(),
                    "content": content,
                }
            )
        return out


@router.post("/{project_id}/ai/session/{ai_session_id}/message")
async def send_message(
    project_id: int, ai_session_id: int, req: SendMessageRequest
) -> dict:
    _session_or_404(project_id, ai_session_id)
    runner = get_runner(ai_session_id)
    if runner is None:
        raise HTTPException(status_code=409, detail="session not running")
    try:
        await runner.send_user_message(req.text)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True}


@router.delete("/{project_id}/ai/session/{ai_session_id}")
async def stop_session(project_id: int, ai_session_id: int) -> dict:
    _session_or_404(project_id, ai_session_id)
    await stop_runner(ai_session_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Extract script — pull a fenced JS block out of the last assistant message
# ---------------------------------------------------------------------------

JS_LANGS = {"javascript", "js", "frida"}

# Match ``` + optional language label + \n + body + \n + ``` (closing fence
# must follow a newline so we don't accidentally chain across blocks).
_FENCE_RE = re.compile(
    r"```(\w*)\n([\s\S]*?)\n```",
    re.IGNORECASE,
)


def _parse_fenced_blocks(text: str) -> list[tuple[str, str]]:
    """Return ``[(language_tag, body)]`` for each ``` … ``` block in the text."""
    return [(m.group(1).lower(), m.group(2)) for m in _FENCE_RE.finditer(text)]


_JS_PATH_RE = re.compile(r"\.(?:js|frida\.js)$", re.IGNORECASE)


def _write_tool_file_path(block: dict) -> str | None:
    """Return the ``file_path`` a Write/Edit/MultiEdit tool_use targeted, or
    None if this block isn't one of those tools or doesn't target a ``.js``
    file.
    """
    if not isinstance(block, dict) or block.get("type") != "tool_use":
        return None
    name = block.get("name", "")
    if name not in ("Write", "Edit", "MultiEdit"):
        return None
    inp = block.get("input") or {}
    if not isinstance(inp, dict):
        return None
    file_path = inp.get("file_path")
    if not isinstance(file_path, str) or not _JS_PATH_RE.search(file_path):
        return None
    return file_path


def _read_project_file(project_id: int, file_path: str) -> str | None:
    """Read ``file_path`` from disk if it lives inside this project's tree.

    Claude runs with its ``cwd`` under the project directory and frequently
    edits scripts in place via Write → Edit → Edit → Edit. The *on-disk*
    file is the canonical artefact at any given moment — an Edit tool's
    ``new_string`` is only a patch fragment, which is exactly what used to
    leak through the extractor as a "tail of the script" snippet.

    We only read paths inside ``projects/<id>/`` (after resolving symlinks)
    so the extractor can't be tricked into leaking arbitrary files from
    disk via a crafted tool call.
    """
    try:
        root = (settings.projects_dir / str(project_id)).resolve()
        target = Path(file_path).resolve()
        # Ensure the resolved target is inside the project root
        target.relative_to(root)
    except (ValueError, OSError):
        return None
    try:
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _extract_from_write_tool_use(block: dict) -> str | None:
    """Fallback extractor for a Write/Edit tool_use when the on-disk file
    isn't available. Only ``Write`` produces a usable full-file result;
    ``Edit``/``MultiEdit`` returns a partial patch which would give the
    caller a fragment, so we skip them here."""
    file_path = _write_tool_file_path(block)
    if file_path is None:
        return None
    name = block.get("name", "")
    inp = block.get("input") or {}
    if name == "Write":
        content = inp.get("content")
        return content if isinstance(content, str) else None
    # Edit / MultiEdit: no way to reconstruct the full file from a single
    # patch — caller should fall back to the disk read or an earlier fence.
    return None


def _split_assistant_blocks(
    msg: dict,
) -> tuple[list[str], list[dict]]:
    """Return ``(text_chunks, tool_use_blocks)`` for a persisted assistant row.

    Handles both the current persistence shape (``content`` is the full Claude
    message dict ``{id, role, content: [...]}``) and the legacy shape
    (``content`` is the raw content array). Rows with non-array content after
    unwrapping return empty lists.
    """
    content = msg.get("content")
    if (
        isinstance(content, dict)
        and "content" in content
        and isinstance(content.get("content"), list)
    ):
        content = content["content"]

    text_chunks: list[str] = []
    tool_use_blocks: list[dict] = []
    if isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text":
                text_chunks.append(c.get("text", ""))
            elif c.get("type") == "tool_use":
                tool_use_blocks.append(c)
    elif isinstance(content, str):
        text_chunks.append(content)
    return text_chunks, tool_use_blocks


def extract_javascript_from_messages(
    messages: list[dict], project_id: int | None = None
) -> ExtractedScript:
    """Walk assistant messages newest-first and return the most recent JS source.

    Lookup order (highest priority first, each pass walks newest → oldest):

    1. Most recent ``.js`` file Claude touched via ``Write``/``Edit``/
       ``MultiEdit`` — read FROM DISK when ``project_id`` points at a real
       project directory. This is the only reliable way to get the full
       script when Claude iterated on it across multiple Edit calls, since
       an Edit tool event carries just the patch fragment, not the whole
       file.
    2. Most recent ``Write`` tool_use content (no on-disk file, but Write
       itself contained the full file text). ``Edit``/``MultiEdit`` are
       deliberately NOT used at this level because their ``new_string``
       is a partial patch.
    3. Most recent ``javascript``/``js``/``frida``-tagged fenced block.
    4. Most recent untagged fenced block — last resort.
    """
    # Pass 1 — on-disk read of the newest Write/Edit target file.
    if project_id is not None:
        for msg in reversed(messages):
            if msg.get("role") != "assistant":
                continue
            _, tool_use_blocks = _split_assistant_blocks(msg)
            for tu in tool_use_blocks:
                file_path = _write_tool_file_path(tu)
                if file_path is None:
                    continue
                source = _read_project_file(project_id, file_path)
                if source is not None:
                    return ExtractedScript(
                        found=True, source=source.strip(), language="javascript"
                    )
                # Path matched but we couldn't read the file (deleted,
                # sandboxed out, …). Don't give up — fall through to the
                # later passes below.
                break

    # Pass 2 — most recent Write tool content (in-band, not from disk).
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        _, tool_use_blocks = _split_assistant_blocks(msg)
        for tu in tool_use_blocks:
            src = _extract_from_write_tool_use(tu)
            if src is not None:
                return ExtractedScript(
                    found=True, source=src.strip(), language="javascript"
                )

    # Pass 3 — most recent explicitly-tagged JS fence.
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        text_chunks, _ = _split_assistant_blocks(msg)
        if not text_chunks:
            continue
        text = "\n".join(text_chunks)
        blocks = _parse_fenced_blocks(text)
        for tag, body in blocks:
            if tag in JS_LANGS:
                return ExtractedScript(found=True, source=body.strip(), language=tag)

    # Pass 4 — most recent untagged fence as a last resort.
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        text_chunks, _ = _split_assistant_blocks(msg)
        if not text_chunks:
            continue
        text = "\n".join(text_chunks)
        blocks = _parse_fenced_blocks(text)
        for tag, body in blocks:
            if not tag:
                return ExtractedScript(
                    found=True, source=body.strip(), language="javascript"
                )

    return ExtractedScript(found=False, source=None, language=None)


@router.post("/{project_id}/ai/session/{ai_session_id}/extract-script")
async def extract_script(project_id: int, ai_session_id: int) -> ExtractedScript:
    _session_or_404(project_id, ai_session_id)
    with Session(engine()) as db:
        rows = db.exec(
            select(AiMessage)
            .where(AiMessage.ai_session_id == ai_session_id)
            .order_by(AiMessage.ts.asc())  # type: ignore[arg-type]
        ).all()
        messages = []
        for m in rows:
            try:
                content = json.loads(m.content_json)
            except json.JSONDecodeError:
                content = m.content_json
            messages.append({"role": m.role, "content": content})
    return extract_javascript_from_messages(messages, project_id=project_id)
