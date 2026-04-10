"""Frida CodeShare router — browse the catalog and import projects as snippets."""

from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, HTTPException
from sqlmodel import Session, select

from ..db import engine
from ..models.snippet import Snippet
from ..services import codeshare

router = APIRouter(prefix="/api/codeshare", tags=["codeshare"])


@router.get("/browse")
async def browse(q: str | None = None, refresh: bool = False) -> list[dict]:
    try:
        entries = await codeshare.browse(force_refresh=refresh)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"codeshare unreachable: {e}") from e

    if q:
        ql = q.lower().strip()
        entries = [
            e
            for e in entries
            if ql in e.name.lower()
            or ql in e.handle.lower()
            or ql in e.slug.lower()
            or ql in e.description.lower()
        ]

    return [
        {
            "handle": e.handle,
            "slug": e.slug,
            "full_slug": e.full_slug,
            "name": e.name,
            "description": e.description,
            "likes": e.likes,
            "views": e.views,
            "url": e.url,
        }
        for e in entries
    ]


@router.get("/project/{handle}/{slug}")
async def get_project(handle: str, slug: str) -> dict:
    try:
        data = await codeshare.fetch_project(handle, slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"codeshare error: {e}") from e
    return {
        "handle": data["handle"],
        "slug": data["slug"],
        "full_slug": data["full_slug"],
        "name": data["name"],
        "source": data["source"],
        "fingerprint": data["fingerprint"],
        "url": data["url"],
    }


@router.post("/import/{handle}/{slug}")
async def import_project(handle: str, slug: str) -> dict:
    """Fetch a CodeShare project and persist it as a local Snippet row."""
    try:
        data = await codeshare.fetch_project(handle, slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"codeshare error: {e}") from e

    description = f"Imported from CodeShare · @{handle} · {data['url']}"
    tags = ["codeshare", handle]

    with Session(engine()) as db:
        # Idempotent: if a non-builtin snippet with this name already exists, update it.
        existing = db.exec(
            select(Snippet).where(
                Snippet.name == data["name"], Snippet.builtin == False  # noqa: E712
            )
        ).first()
        if existing is not None:
            existing.source = data["source"]
            existing.description = description
            existing.tags_json = json.dumps(tags)
            db.add(existing)
            db.commit()
            db.refresh(existing)
            sid = existing.id
        else:
            snippet = Snippet(
                name=data["name"],
                description=description,
                source=data["source"],
                tags_json=json.dumps(tags),
                parameters_json="[]",
                builtin=False,
            )
            db.add(snippet)
            db.commit()
            db.refresh(snippet)
            sid = snippet.id

    return {
        "ok": True,
        "snippet_id": sid,
        "full_slug": data["full_slug"],
        "fingerprint": data["fingerprint"],
    }
