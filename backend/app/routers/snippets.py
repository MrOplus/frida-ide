"""Snippets router — CRUD + render endpoint."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..db import engine
from ..models.snippet import Snippet
from ..services.snippet_loader import render_snippet

router = APIRouter(prefix="/api/snippets", tags=["snippets"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SnippetCreate(BaseModel):
    name: str = Field(..., min_length=1)
    source: str = Field(..., min_length=1)
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    parameters: list[dict] = Field(default_factory=list)


class SnippetUpdate(BaseModel):
    name: str | None = None
    source: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    parameters: list[dict] | None = None


class RenderRequest(BaseModel):
    params: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _snippet_dict(s: Snippet) -> dict:
    try:
        tags = json.loads(s.tags_json)
    except json.JSONDecodeError:
        tags = []
    try:
        parameters = json.loads(s.parameters_json)
    except json.JSONDecodeError:
        parameters = []
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "source": s.source,
        "tags": tags,
        "parameters": parameters,
        "builtin": s.builtin,
        "created_at": s.created_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_snippets(
    tag: str | None = None,
    q: str | None = None,
    builtin: bool | None = None,
) -> list[dict]:
    with Session(engine()) as db:
        stmt = select(Snippet).order_by(Snippet.builtin.desc(), Snippet.name.asc())  # type: ignore[arg-type]
        if builtin is not None:
            stmt = stmt.where(Snippet.builtin == builtin)
        rows = list(db.exec(stmt).all())
        out = [_snippet_dict(s) for s in rows]

        if tag:
            out = [s for s in out if tag in s["tags"]]
        if q:
            ql = q.lower()
            out = [
                s
                for s in out
                if ql in s["name"].lower()
                or (s["description"] and ql in s["description"].lower())
                or any(ql in t.lower() for t in s["tags"])
            ]
        return out


@router.get("/{snippet_id}")
async def get_snippet(snippet_id: int) -> dict:
    with Session(engine()) as db:
        s = db.get(Snippet, snippet_id)
        if s is None:
            raise HTTPException(status_code=404, detail="snippet not found")
        return _snippet_dict(s)


@router.post("")
async def create_snippet(req: SnippetCreate) -> dict:
    with Session(engine()) as db:
        s = Snippet(
            name=req.name,
            source=req.source,
            description=req.description,
            tags_json=json.dumps(req.tags),
            parameters_json=json.dumps(req.parameters),
            builtin=False,
        )
        db.add(s)
        db.commit()
        db.refresh(s)
        return _snippet_dict(s)


@router.put("/{snippet_id}")
async def update_snippet(snippet_id: int, req: SnippetUpdate) -> dict:
    with Session(engine()) as db:
        s = db.get(Snippet, snippet_id)
        if s is None:
            raise HTTPException(status_code=404, detail="snippet not found")
        if s.builtin:
            raise HTTPException(status_code=403, detail="cannot edit a built-in snippet")
        if req.name is not None:
            s.name = req.name
        if req.source is not None:
            s.source = req.source
        if req.description is not None:
            s.description = req.description
        if req.tags is not None:
            s.tags_json = json.dumps(req.tags)
        if req.parameters is not None:
            s.parameters_json = json.dumps(req.parameters)
        db.add(s)
        db.commit()
        db.refresh(s)
        return _snippet_dict(s)


@router.delete("/{snippet_id}")
async def delete_snippet(snippet_id: int) -> dict:
    with Session(engine()) as db:
        s = db.get(Snippet, snippet_id)
        if s is None:
            raise HTTPException(status_code=404, detail="snippet not found")
        if s.builtin:
            raise HTTPException(status_code=403, detail="cannot delete a built-in snippet")
        db.delete(s)
        db.commit()
    return {"ok": True}


@router.post("/{snippet_id}/render")
async def render(snippet_id: int, req: RenderRequest) -> dict:
    with Session(engine()) as db:
        s = db.get(Snippet, snippet_id)
        if s is None:
            raise HTTPException(status_code=404, detail="snippet not found")
        rendered = render_snippet(s.source, req.params)
        return {"name": s.name, "source": rendered}
