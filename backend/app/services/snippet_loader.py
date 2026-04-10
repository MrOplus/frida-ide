"""Built-in snippet loader.

Walks ``backend/app/builtins/snippets/*.js``, parses the leading metadata
header (a small ad-hoc format), and upserts each file into the ``snippet``
table on first boot. Files marked ``builtin=True`` are owned by this loader
and get re-synced on every startup so user installs always have the latest
canonical versions.

Header format (lines start with ``//``, must come at the very top of the file):

    // frida-ide://snippet
    // name: SSL Pinning Bypass (Android)
    // description: Bypasses common Android SSL pinning ...
    // tags: ssl, network, android
    // param: PACKAGE_NAME / Target package (default: com.example.app) / required
    // param: METHOD / Method to hook (default: doFinal) / optional
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from sqlmodel import Session, select

from ..db import engine
from ..models.snippet import Snippet

BUILTINS_DIR = Path(__file__).parent.parent / "builtins" / "snippets"


@dataclass
class SnippetParam:
    name: str
    description: str
    required: bool


@dataclass
class ParsedSnippet:
    name: str
    description: str
    tags: list[str]
    parameters: list[SnippetParam]
    source: str


def parse_snippet_file(text: str, fallback_name: str) -> ParsedSnippet:
    """Parse a snippet file's header into a ParsedSnippet."""
    name = fallback_name
    description = ""
    tags: list[str] = []
    parameters: list[SnippetParam] = []

    lines = text.split("\n")
    in_header = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if i == 0:
            if stripped == "// frida-ide://snippet":
                in_header = True
                continue
            else:
                break
        if not in_header:
            break
        if not stripped.startswith("//"):
            break
        body = stripped[2:].strip()
        if ":" not in body:
            continue
        key, _, value = body.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "name":
            name = value
        elif key == "description":
            description = value
        elif key == "tags":
            tags = [t.strip() for t in value.split(",") if t.strip()]
        elif key == "param":
            # Format: NAME / description / required|optional
            parts = [p.strip() for p in value.split("/")]
            param_name = parts[0]
            param_desc = parts[1] if len(parts) > 1 else ""
            required = len(parts) > 2 and parts[2].lower() == "required"
            parameters.append(
                SnippetParam(name=param_name, description=param_desc, required=required)
            )

    return ParsedSnippet(
        name=name,
        description=description,
        tags=tags,
        parameters=parameters,
        source=text,
    )


def render_snippet(source: str, params: dict[str, str]) -> str:
    """Replace ``{{KEY}}`` placeholders with the supplied params."""
    out = source
    for k, v in params.items():
        out = out.replace("{{" + k + "}}", v)
    return out


def seed_builtins() -> int:
    """Upsert all builtin snippets into the DB. Returns the number written."""
    if not BUILTINS_DIR.exists():
        return 0

    count = 0
    with Session(engine()) as db:
        for path in sorted(BUILTINS_DIR.glob("*.js")):
            text = path.read_text(encoding="utf-8")
            parsed = parse_snippet_file(text, fallback_name=path.stem)

            # Look for an existing builtin snippet with this name
            existing = db.exec(
                select(Snippet).where(Snippet.name == parsed.name, Snippet.builtin == True)  # noqa: E712
            ).first()

            if existing is None:
                snippet = Snippet(
                    name=parsed.name,
                    description=parsed.description,
                    source=parsed.source,
                    tags_json=json.dumps(parsed.tags),
                    parameters_json=json.dumps(
                        [
                            {
                                "name": p.name,
                                "description": p.description,
                                "required": p.required,
                            }
                            for p in parsed.parameters
                        ]
                    ),
                    builtin=True,
                )
                db.add(snippet)
            else:
                existing.description = parsed.description
                existing.source = parsed.source
                existing.tags_json = json.dumps(parsed.tags)
                existing.parameters_json = json.dumps(
                    [
                        {
                            "name": p.name,
                            "description": p.description,
                            "required": p.required,
                        }
                        for p in parsed.parameters
                    ]
                )
                db.add(existing)
            count += 1
        db.commit()
    return count
