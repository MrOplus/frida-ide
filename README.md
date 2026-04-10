# Frida IDE

A web-based IDE for [Frida](https://frida.re/) with an integrated AI assistant powered by [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). It collapses the usual *terminal soup* — `adb`, `frida-server`, `frida` CLI, `apktool`, `jadx`, and a separate AI chat — into a single browser tab.

> **Status:** active development. The full M0–M5 milestone set in [`backend/`](backend/) and [`frontend/`](frontend/) is wired up: device management, APK pipeline, Monaco editor, live `send()` console, AI chat, codeshare browser, emulator launcher, and session recording.

---

## What it does

| Pain point | What the IDE does |
|---|---|
| `adb push frida-server …` and version drift | One-click installer that downloads the matching `frida-server-<version>-<arch>.xz`, pushes it, `chmod`s it, starts it as root, and re-checks the version on every device connect |
| Forgetting to start `frida-server` | A background watcher polls every 10 s and auto-restarts it on failure |
| Picking the right `device.spawn` arguments | Inline app/process picker on the Editor tab — search by name or package, click **Spawn** or **Attach** |
| Spawn-time injector bugs (`unable to pick a payload base`) | Falls back to `monkey -p <pkg> -c LAUNCHER 1` + attach when `device.spawn` raises this Frida-side error |
| Java/ObjC/Swift bridges missing in Frida 17 | The IDE injects the same lazy bridge loader the `frida` CLI uses, so `Java.perform(...)` works out of the box |
| `apktool` + `jadx` orchestration | Drop an APK on the Projects tab, watch the pipeline progress over WebSocket, then browse the decompiled tree |
| Switching between AI chat and the editor | Per-project Claude session, scoped `cwd` to the decompiled tree, streamed via stream-json. **Extract Script** lifts the latest hook (from a fenced block *or* a `Write` tool call) into Monaco |
| Reusable hook libraries | First-boot seeded snippet library (SSL pinning bypass, root-detection bypass, intent logger, crypto observer, method tracer, …) plus a [codeshare.frida.re](https://codeshare.frida.re/) browser with one-click import |
| Lost output on reconnect | All four WebSocket topics back onto a 10k-event ring buffer with `last_event_id` replay |
| Multiple devices in parallel | Multi-device dashboard + per-device process listing |

---

## Architecture

```
                ┌─────────────────────────────────────────┐
   Browser      │  React + Vite + Monaco + xterm.js       │
   (port 5173)  │   /devices  /editor  /projects  /ai …   │
                └────────────────┬────────────────────────┘
                                 │  REST + WebSocket
                ┌────────────────┴────────────────────────┐
                │  FastAPI + uvicorn (port 8765)          │
                │                                         │
                │  routers:                               │
                │    devices  processes  scripts          │
                │    snippets projects   files            │
                │    ai       sessions   ws               │
                │    codeshare emulators                  │
                │                                         │
                │  services:                              │
   Frida ─────► │    frida_manager   frida_server         │
   (frida-core) │    adb             apk_pipeline         │
   subprocess   │    claude_runner   session_recorder     │
                │    pubsub          device_watcher       │
                │                                         │
                └──┬──────────────────────────────┬───────┘
                   │                              │
            ┌──────┴──────┐              ┌────────┴────────┐
            │ SQLite WAL  │              │  ~/.frida-ide/  │
            │ workbench.db│              │   projects/     │
            └─────────────┘              │   frida-server- │
                                         │    cache/       │
                                         └─────────────────┘
```

| Layer | Stack |
|---|---|
| Backend | Python 3.11+ · FastAPI · uvicorn · `frida` (pinned) · sqlmodel · asyncio + WebSockets |
| Frontend | React 19 · TypeScript · Vite · TailwindCSS · shadcn/ui · Monaco Editor · xterm.js · TanStack Query · Zustand |
| AI | `claude` CLI as subprocess in `--input-format=stream-json --output-format=stream-json --print` mode, `cwd` = the project's decompiled tree |
| Persistence | SQLite (WAL) at `~/.frida-ide/workbench.db` |

The trickiest part of the backend is the **Frida → asyncio bridge** in `services/frida_manager.py`. Frida's `script.on('message', cb)` callback runs on a private thread; every cross-thread publish goes through `loop.call_soon_threadsafe(pubsub.publish_nowait, …)` so the FastAPI loop is the only writer to the WebSocket queues. Blocking Frida calls (`enumerate_processes`, `attach`, `spawn`, …) are wrapped in `asyncio.to_thread`.

---

## Quick start (development)

Prereqs: Python 3.11–3.13, Node 20+, `pnpm`, `adb`, and an Android device or emulator reachable via `adb devices`. (`apktool`, `jadx`, and the `claude` CLI are looked up via `$PATH` if you want the corresponding tabs to work.)

```bash
git clone https://github.com/mroplus/frida-ide.git
cd frida-ide

# Backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Frontend
pnpm --dir frontend install

# Run both with hot reload
./scripts/dev.sh
```

Then open <http://127.0.0.1:5173>.

The first time you connect a device, the watcher will detect that `frida-server` isn't running and offer to install it for you (or auto-install silently — you'll see the status dot flip green within a few seconds).

### Packaged install

```bash
pnpm --dir frontend build      # bake the SPA into frontend/dist/
pip install .                  # the wheel includes frontend/dist/ via hatch force-include
frida-ide                      # console entry point — serves API + SPA on :8765
```

---

## End-to-end walkthrough

1. **Devices tab** — your phone/emulator appears with ABI, Android version, root status, and `frida-server` health. Hit **Install frida-server** if needed.
2. **Projects tab** — drag-and-drop an APK. Watch `queued → apktool → jadx → done` over WebSocket. Project root materializes under `~/.frida-ide/projects/<id>/`.
3. **Files** — browse the decompiled `sources/` tree with syntax highlighting.
4. **AI Chat** — start a Claude session in the project. Ask things like *"Find the authentication flow"* or *"Hook all Log.d calls and print tag+message"*. Tool calls (Read, Grep, Glob, Write) stream live in the chat.
5. **Extract Script → Editor** — pulls the most recent JS from the assistant's response: a fenced ` ```javascript ` block, or the `content` of a `Write` tool call to a `.js` file.
6. **Editor tab** — pick a target inline (device dropdown + app picker with icons + Spawn/Attach buttons). Monaco buffer is shared with the rest of the IDE.
7. **Spawn / Attach** — script loads, `send()` messages stream into the xterm console next to the editor.
8. **Sessions tab** — every run is recorded; export the JSON for replay or sharing.

---

## API surface

```
GET    /api/devices                                       Frida + ADB merged
POST   /api/devices/connect                               adb connect host:port
POST   /api/devices/{serial}/frida-server/install         download → push → start
POST   /api/devices/{serial}/frida-server/{start,stop}
GET    /api/devices/{serial}/frida-server/status

GET    /api/devices/{serial}/processes                    sorted like frida-ps -U + icons
GET    /api/devices/{serial}/apps                         sorted like frida-ps -Uai + icons
POST   /api/devices/{serial}/spawn / attach / kill

GET    /api/emulators                                     AVD list
POST   /api/emulators/{name}/start

CRUD   /api/scripts
POST   /api/scripts/run                                   {device, target, mode, source} → run_session_id
POST   /api/scripts/{id}/stop

CRUD   /api/snippets
POST   /api/snippets/{id}/render                          template parameters

POST   /api/projects                                      multipart APK upload
GET    /api/projects, /api/projects/{id}
GET    /api/projects/{id}/tree?path=
GET    /api/projects/{id}/file?path=

POST   /api/projects/{id}/ai/session                      spawn claude in decompiled tree
POST   /api/projects/{id}/ai/session/{sid}/message
POST   /api/projects/{id}/ai/session/{sid}/extract-script
GET    /api/projects/{id}/ai/session/{sid}/messages       persistent backfill
DELETE /api/projects/{id}/ai/session/{sid}

GET    /api/codeshare/browse                              scrape codeshare.frida.re catalog
POST   /api/codeshare/import                              one-click import to local snippets

GET    /api/sessions, /api/sessions/{id}/events, /api/sessions/{id}/export
```

### WebSocket topics

```
/ws/devices                              device add/remove, frida-server status
/ws/run/{run_session_id}                 stdout/stderr/send/error from active script
/ws/ai/{ai_session_id}                   Claude stream-json events
/ws/projects/{project_id}/pipeline       apktool/jadx progress
```

Envelope: `{type, ts, payload, event_id}`. Reconnect with `?last_event_id=N` to replay buffered events with id > N from the per-topic 10k-line ring buffer.

---

## Built-in snippets

Seeded into the SQLite snippet table on first boot from `backend/app/builtins/snippets/`:

- `ssl_pinning_bypass.js` — universal Android SSL pinning bypass (OkHttp, TrustManager, Conscrypt, …)
- `root_detection_bypass.js` — common root-check overrides (`RootBeer`, `getprop`, file existence, `su` lookup)
- `license_bypass_pairip.js` — PairIP license-check no-op
- `intent_logger.js` — every `startActivity` / `sendBroadcast` with extras
- `sharedprefs_logger.js` — every `SharedPreferences.get*` and `put*`
- `crypto_observer.js` — `Cipher.doFinal`, `MessageDigest.digest`, `Mac.doFinal` payloads
- `method_tracer.js` — generic class+method tracer with templated parameters

The codeshare browser tab supplements these with the full [codeshare.frida.re](https://codeshare.frida.re/browse) catalog, importable in one click.

---

## Configuration

Runtime data lives under `~/.frida-ide/` (created on first run):

```
~/.frida-ide/
├── workbench.db                            # SQLite (WAL mode)
├── workbench.db-{wal,shm}
├── projects/<id>/
│   ├── apk/base.apk
│   ├── apktool-out/
│   ├── jadx-out/
│   └── meta.json
├── frida-server-cache/<version>/<arch>/
│   └── frida-server                        # decompressed binary
└── logs/
```

Environment variables (all optional, see `backend/app/config.py` and `backend/app/utils/paths.py`):

| Var | Default | Purpose |
|---|---|---|
| `FRIDA_IDE_HOST` | `127.0.0.1` | Bind host. Setting this to `0.0.0.0` requires `FRIDA_IDE_UNSAFE_EXPOSE=1` (red banner in UI). |
| `FRIDA_IDE_PORT` | `8765` | API + SPA port. |
| `FRIDA_IDE_DATA_DIR` | `~/.frida-ide` | Override the data root. |
| `FRIDA_IDE_ADB` | autodetect | Path to `adb`. |
| `FRIDA_IDE_APKTOOL` | autodetect | Path to `apktool`. |
| `FRIDA_IDE_JADX` | autodetect | Path to `jadx`. |
| `FRIDA_IDE_CLAUDE_BIN` | `shutil.which("claude")` | Path to the `claude` CLI for the AI tab. |

Discovery order for ADB / jadx / apktool / claude: explicit env var → `$PATH` → standard SDK locations (e.g. `~/Library/Android/sdk/platform-tools/adb` on macOS, `~/Android/Sdk/platform-tools/adb` on Linux).

---

## Repository layout

```
frida-ide/
├── pyproject.toml
├── scripts/dev.sh                  # uvicorn + vite hot-reload runner
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI factory + lifespan
│   │   ├── config.py               # pydantic-settings
│   │   ├── db.py                   # SQLModel engine, WAL pragma
│   │   ├── models/                 # project, script, snippet, run_session, hook_event, ai_session, ai_message
│   │   ├── routers/                # devices, processes, scripts, snippets, projects, files, ai, sessions, ws, codeshare, emulators
│   │   ├── services/
│   │   │   ├── frida_manager.py    # ★ Frida ↔ asyncio bridge, spawn/attach/load
│   │   │   ├── frida_server.py     # ★ download → push → start, version sync
│   │   │   ├── apk_pipeline.py     # apktool + jadx orchestration
│   │   │   ├── claude_runner.py    # ★ stream-json subprocess pump
│   │   │   ├── session_recorder.py
│   │   │   ├── device_watcher.py   # background frida-server health loop
│   │   │   ├── codeshare.py
│   │   │   ├── emulator.py         # avdmanager + emulator -avd
│   │   │   ├── snippet_loader.py   # seed builtins on first boot
│   │   │   └── pubsub.py           # in-process topic broker + ring buffer
│   │   ├── builtins/snippets/      # seeded JS hooks
│   │   └── utils/{paths,arch}.py
│   └── tests/
└── frontend/
    └── src/
        ├── routes/                 # Dashboard, Devices, Editor, Processes, Projects, ProjectFiles, ProjectAi, Snippets, Sessions
        ├── components/
        │   ├── layout/             # Sidebar, TopBar
        │   ├── devices/            # DeviceCard, FridaServerControls
        │   ├── editor/             # MonacoPane, RunControls, OutputConsole, SnippetPicker
        │   ├── projects/           # ApkUpload, FileTree, FileViewer
        │   ├── ai/                 # ChatPane, ChatMessage, streamReducer
        │   └── snippets/           # SnippetCard, CodeshareBrowser
        ├── lib/{api.ts, ws.ts, utils.ts}
        └── store/{editorStore.ts}
```

---

## Security notes

- Bound to `127.0.0.1` by default. Exposing on `0.0.0.0` is gated behind `FRIDA_IDE_UNSAFE_EXPOSE=1` and shows a red banner in the UI.
- All subprocesses are launched with `create_subprocess_exec(...)` and **argv arrays** — never shell strings. Device serials are validated against `^[A-Za-z0-9:._-]+$`.
- APK uploads are size-capped (500 MB) and project names are sanitised against path traversal.
- **The Claude subprocess inherits your user's permissions and has full filesystem access.** Tool calls (Read / Write / Edit / Bash) are surfaced in the chat sidebar so you can see what it's touching.
- **Editor scripts run inside the *target process* via Frida**, not on the host. There is no `eval` path on the backend itself.

---

## Tests + lint

```bash
.venv/bin/python -m pytest backend/tests/ -q
.venv/bin/ruff check backend/
pnpm --dir frontend tsc --noEmit
```

---

## License

MIT — see [`pyproject.toml`](pyproject.toml).
