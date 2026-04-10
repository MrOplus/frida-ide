"""AI session router — spawns Claude as a subprocess scoped to a project's
decompiled tree, persists messages, and exposes an extract-script helper that
parses the last assistant turn for a fenced ```javascript block.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

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


def _extract_from_write_tool_use(block: dict) -> str | None:
    """Return the source text if ``block`` is a Write/Edit call targeting a JS file.

    Claude's Write tool input has ``file_path`` and ``content``. Edit has
    ``file_path`` and ``new_string`` (we accept it as a fallback when the
    user asked Claude to rewrite an existing script).
    """
    if not isinstance(block, dict) or block.get("type") != "tool_use":
        return None
    name = block.get("name", "")
    inp = block.get("input") or {}
    if not isinstance(inp, dict):
        return None
    file_path = inp.get("file_path")
    if not isinstance(file_path, str) or not _JS_PATH_RE.search(file_path):
        return None
    if name == "Write":
        content = inp.get("content")
        return content if isinstance(content, str) else None
    if name == "Edit":
        new_string = inp.get("new_string")
        return new_string if isinstance(new_string, str) else None
    return None


def extract_javascript_from_messages(messages: list[dict]) -> ExtractedScript:
    """Walk assistant messages newest-first and return the most recent JS source.

    Lookup order, per assistant turn (highest priority first):
    1. ``javascript``/``js``/``frida``-tagged fenced block in the message text.
    2. ``Write``/``Edit`` tool_use targeting a ``.js`` file (the tool input
       *is* the script — common when Claude saves directly via filesystem
       tools instead of inlining the code).
    3. Untagged fenced block (heuristic: assume it's JS).
    """
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")

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
        else:
            continue

        text = "\n".join(text_chunks)
        blocks = _parse_fenced_blocks(text)

        # 1. Explicitly-tagged JS fence wins.
        for tag, body in blocks:
            if tag in JS_LANGS:
                return ExtractedScript(found=True, source=body.strip(), language=tag)

        # 2. Write/Edit tool targeting a .js path.
        for tu in tool_use_blocks:
            src = _extract_from_write_tool_use(tu)
            if src is not None:
                return ExtractedScript(
                    found=True, source=src.strip(), language="javascript"
                )

        # 3. Untagged fence as a last resort.
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
    return extract_javascript_from_messages(messages)
