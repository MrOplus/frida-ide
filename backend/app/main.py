"""FastAPI app factory + console entry point.

Runs in two modes:

* **Dev** — uvicorn started by ``scripts/dev.sh``, Vite serves the SPA on
  port 5173 and proxies ``/api`` and ``/ws`` to FastAPI on port 8765. The
  CORS middleware allows the dev origin.
* **Production** — ``frida-ide`` console script. The frontend is built once
  and bundled into the wheel; FastAPI serves ``frontend/dist`` at ``/`` with
  an SPA fallback so client-side routes work on hard refresh. Console script
  also opens the default browser.
"""

from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import init_db
from .routers import (
    _dev,
    ai,
    codeshare,
    devices,
    emulators,
    files,
    health,
    processes,
    projects,
    scripts,
    sessions,
    snippets,
    ws,
)
from .services.claude_runner import stop_all_runners
from .services.device_watcher import start_watcher, stop_watcher
from .services.snippet_loader import seed_builtins

# The frontend's build output. Resolved relative to this file so it works
# both from the source repo (sibling 'frontend' directory) and from a wheel
# install (bundled into the package).
_REPO_ROOT_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"
_PACKAGED_DIST = Path(__file__).parent / "frontend_dist"


def find_dist() -> Path | None:
    for candidate in (_PACKAGED_DIST, _REPO_ROOT_DIST):
        if candidate.exists() and (candidate / "index.html").exists():
            return candidate
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    init_db()

    # Upsert built-in snippets so users always have the latest canonical versions
    seeded = seed_builtins()
    if seeded:
        print(f"[startup] Seeded {seeded} built-in snippets")

    # Start the background frida-server liveness watcher
    start_watcher()

    yield

    # Shutdown: kill subprocesses + stop background tasks
    await stop_watcher()
    await stop_all_runners()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Frida IDE",
        version="0.1.0",
        description="Web-based IDE for Frida with AI assistance via Claude Code",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # API routers
    app.include_router(health.router)
    app.include_router(devices.router)
    app.include_router(processes.router)
    app.include_router(scripts.router)
    app.include_router(projects.router)
    app.include_router(files.router)
    app.include_router(ai.router)
    app.include_router(snippets.router)
    app.include_router(sessions.router)
    app.include_router(emulators.router)
    app.include_router(codeshare.router)
    app.include_router(ws.router)
    app.include_router(_dev.router)

    # Mount the built SPA at / when present (production mode).
    dist = find_dist()
    if dist is not None:
        # Static assets (hashed under /assets/*)
        app.mount(
            "/assets",
            StaticFiles(directory=str(dist / "assets")),
            name="spa-assets",
        )

        @app.get("/", include_in_schema=False)
        async def spa_index() -> FileResponse:
            return FileResponse(dist / "index.html")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa_fallback(path: str) -> FileResponse:
            # Don't intercept API or WS paths — those should 404 cleanly if
            # they don't match a real route.
            if path.startswith("api/") or path.startswith("ws/") or path.startswith("assets/"):
                raise HTTPException(status_code=404)
            # Serve any real file under dist (favicon, etc.)
            file_path = dist / path
            if file_path.is_file():
                return FileResponse(file_path)
            # Otherwise fall back to index.html so client-side routing works
            return FileResponse(dist / "index.html")

    return app


app = create_app()


def run() -> None:
    """Console entry point: ``frida-ide``.

    Starts uvicorn on the configured host/port and (in production mode) opens
    the default browser to the local URL.
    """
    import webbrowser

    host = "0.0.0.0" if settings.unsafe_expose else settings.host
    if settings.unsafe_expose:
        print("\033[91m" + "=" * 60)
        print("⚠️  UNSAFE: Binding 0.0.0.0 — server is exposed to network")
        print("=" * 60 + "\033[0m")

    dist = find_dist()
    if dist is None:
        print(
            "\033[93m[!] Frontend bundle not found — run `pnpm --dir frontend build` first.\n"
            "    Falling back to API-only mode.\033[0m"
        )
    else:
        url = f"http://{host if host != '0.0.0.0' else '127.0.0.1'}:{settings.port}/"
        print(f"\033[92m[+] Frida IDE → {url}\033[0m")
        try:  # noqa: SIM105
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass

    uvicorn.run("app.main:app", host=host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
