"""Frida CodeShare integration.

CodeShare doesn't expose a JSON browse API, so we scrape the HTML browse
page (it's stable enough — each project is one ``<article>`` block with a
predictable shape). Single-project fetches DO have a JSON API at
``/api/project/<handle>/<slug>/``.

We cache browse results for 10 minutes to avoid hammering the upstream and
to keep the UI snappy. Single-project fetches are not cached because the
fingerprint check is the user's trust signal.
"""

from __future__ import annotations

import asyncio
import hashlib
import platform
import re
import time
from dataclasses import dataclass
from typing import Any

import frida
import httpx

CODESHARE_BASE = "https://codeshare.frida.re"
USER_AGENT = f"Frida-IDE v0.1.0 / Frida v{frida.__version__} / {platform.platform()}"
BROWSE_CACHE_TTL_S = 600  # 10 minutes
MAX_PAGES = 5  # cap how many list pages we'll fetch in one go


@dataclass
class CodeshareEntry:
    handle: str  # author username, e.g. "pcipolloni"
    slug: str  # project slug, e.g. "universal-android-ssl-pinning-bypass-with-frida"
    name: str  # display name, e.g. "Universal Android SSL Pinning Bypass with Frida"
    description: str
    likes: int | None
    views: str | None  # display string like "540K"

    @property
    def full_slug(self) -> str:
        return f"{self.handle}/{self.slug}"

    @property
    def url(self) -> str:
        return f"{CODESHARE_BASE}/@{self.handle}/{self.slug}/"


# Compiled outside the function so each browse() call doesn't pay regex setup cost
_ARTICLE_RE = re.compile(
    r'<article>(.*?)</article>',
    re.DOTALL,
)
_NAME_RE = re.compile(
    r'<h2><a href="https?://codeshare\.frida\.re/@([^/]+)/([^/]+)/">([^<]+)</a></h2>'
)
_LIKES_RE = re.compile(r'fa-thumbs-o-up[^|]*?\|\s*(?:\d+\.?\d*[KkMm]?)?(?=\s*\|)')
_LIKES_NUM_RE = re.compile(r'fa-thumbs-o-up[^>]*></i>\s*(\d+)')
_VIEWS_RE = re.compile(r'fa-eye[^>]*></i>\s*([\d.]+[KkMm]?)')
_DESC_RE = re.compile(r'<p>(.*?)</p>', re.DOTALL)


def _parse_browse_html(html: str) -> list[CodeshareEntry]:
    out: list[CodeshareEntry] = []
    for match in _ARTICLE_RE.finditer(html):
        block = match.group(1)
        name_match = _NAME_RE.search(block)
        if not name_match:
            continue
        handle = name_match.group(1)
        slug = name_match.group(2)
        name = name_match.group(3).strip()

        likes_match = _LIKES_NUM_RE.search(block)
        likes = int(likes_match.group(1)) if likes_match else None

        views_match = _VIEWS_RE.search(block)
        views = views_match.group(1) if views_match else None

        desc_match = _DESC_RE.search(block)
        description = ""
        if desc_match:
            # Strip any inline tags + collapse whitespace
            description = re.sub(r"<[^>]+>", "", desc_match.group(1))
            description = re.sub(r"\s+", " ", description).strip()

        out.append(
            CodeshareEntry(
                handle=handle,
                slug=slug,
                name=name,
                description=description,
                likes=likes,
                views=views,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Browse cache
# ---------------------------------------------------------------------------


class _BrowseCache:
    def __init__(self) -> None:
        self.entries: list[CodeshareEntry] = []
        self.fetched_at: float = 0.0
        self.lock = asyncio.Lock()


_cache = _BrowseCache()


async def _fetch_browse_page(client: httpx.AsyncClient, page: int) -> str:
    url = f"{CODESHARE_BASE}/browse/" + (f"?page={page}" if page > 1 else "")
    resp = await client.get(url, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.text


async def browse(force_refresh: bool = False) -> list[CodeshareEntry]:
    now = time.time()
    if (
        not force_refresh
        and _cache.entries
        and (now - _cache.fetched_at) < BROWSE_CACHE_TTL_S
    ):
        return _cache.entries

    async with _cache.lock:
        if (
            not force_refresh
            and _cache.entries
            and (time.time() - _cache.fetched_at) < BROWSE_CACHE_TTL_S
        ):
            return _cache.entries

        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            results: list[CodeshareEntry] = []
            seen: set[str] = set()
            for page in range(1, MAX_PAGES + 1):
                try:
                    html = await _fetch_browse_page(client, page)
                except httpx.HTTPError:
                    break
                entries = _parse_browse_html(html)
                if not entries:
                    break
                # Codeshare's pagination sometimes returns the same entry on
                # adjacent pages due to vote-count tie-breaking. Dedupe by
                # full_slug so the frontend doesn't see duplicate keys.
                novel = [e for e in entries if e.full_slug not in seen]
                for e in novel:
                    seen.add(e.full_slug)
                results.extend(novel)
                if len(entries) < 10:
                    # Last page — codeshare returns < 10 entries when out of items
                    break

        _cache.entries = results
        _cache.fetched_at = time.time()
        return results


# ---------------------------------------------------------------------------
# Single-project fetch
# ---------------------------------------------------------------------------


async def fetch_project(handle: str, slug: str) -> dict[str, Any]:
    """Fetch one project's source + metadata via codeshare's JSON API."""
    if not re.match(r"^[A-Za-z0-9_.-]+$", handle):
        raise ValueError(f"Invalid handle: {handle!r}")
    if not re.match(r"^[A-Za-z0-9_.-]+$", slug):
        raise ValueError(f"Invalid slug: {slug!r}")

    url = f"{CODESHARE_BASE}/api/project/{handle}/{slug}/"
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.get(url, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        data = resp.json()

    source = data.get("source", "")
    fingerprint = hashlib.sha256(source.encode("utf-8")).hexdigest()
    return {
        "handle": handle,
        "slug": slug,
        "full_slug": f"{handle}/{slug}",
        "name": data.get("project_name") or slug,
        "source": source,
        "fingerprint": fingerprint,
        "url": f"{CODESHARE_BASE}/@{handle}/{slug}/",
        "raw": data,
    }
