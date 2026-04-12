"""Tests for the extract-script regex used by the AI router."""

from app.config import settings
from app.routers.ai import extract_javascript_from_messages


def test_extract_javascript_fenced_block():
    messages = [
        {"role": "user", "content": "Write a hook"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Here's the hook:\n\n"
                        "```javascript\n"
                        "Java.perform(function () {\n"
                        "  send('hi');\n"
                        "});\n"
                        "```\n"
                        "Run it with attach mode."
                    ),
                }
            ],
        },
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert result.language == "javascript"
    assert "Java.perform" in (result.source or "")
    assert "send('hi')" in (result.source or "")


def test_extract_prefers_javascript_over_other_blocks():
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Background:\n```bash\nadb logcat\n```\n"
                        "Now the hook:\n```js\nsend('hi');\n```"
                    ),
                }
            ],
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert result.language == "js"
    assert result.source == "send('hi');"


def test_extract_walks_back_to_most_recent_assistant_message():
    messages = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "```javascript\nsend('old');\n```"}
            ],
        },
        {"role": "user", "content": "do it differently"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "```javascript\nsend('new');\n```"}
            ],
        },
    ]
    result = extract_javascript_from_messages(messages)
    assert result.source == "send('new');"


def test_extract_returns_not_found_on_empty():
    assert extract_javascript_from_messages([]).found is False
    assert extract_javascript_from_messages([{"role": "user", "content": "hi"}]).found is False


def test_extract_handles_text_string_content():
    messages = [
        {
            "role": "assistant",
            "content": "Plain string: ```javascript\nsend('plain');\n```",
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert "send('plain')" in (result.source or "")


def test_extract_from_write_tool_use():
    """Claude often saves long scripts via the Write tool instead of inlining
    them in the chat. The script body lives in the tool_use.input.content
    field — extract should pick it up when the file_path ends in .js."""
    messages = [
        {"role": "user", "content": "save a hook for me"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "Sure, writing it now.",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "Write",
                    "input": {
                        "file_path": "/tmp/projects/1/bypass_premium.js",
                        "content": (
                            "Java.perform(function () {\n"
                            "  send('written via tool');\n"
                            "});\n"
                        ),
                    },
                },
            ],
        },
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert result.language == "javascript"
    assert "send('written via tool')" in (result.source or "")


def test_extract_write_tool_beats_fence_in_same_turn():
    """When the same assistant turn has both an inline JS fence and a Write
    tool call, the Write tool wins. The fence is typically just a partial
    preview Claude pasted after saving the real file, so extracting the
    fence ends up with a fragment (a closing block or a few lines) instead
    of the full script."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "```javascript\nsend('preview snippet');\n```",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_02",
                    "name": "Write",
                    "input": {
                        "file_path": "/tmp/x.js",
                        "content": "// full script\nsend('written');\n// …500 more lines…\n",
                    },
                },
            ],
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert "full script" in (result.source or "")
    assert "written" in (result.source or "")


def test_extract_older_write_beats_newer_fence():
    """Even when a LATER assistant turn pastes a preview fence, the older
    Write-saved script is still canonical. This is the real-world case that
    motivated the priority flip: Claude writes a 300-line file, then sends
    a short fenced snippet showing just the tail for discussion, and we
    used to extract the tail instead of the full file."""
    messages = [
        # Older: Claude writes the full file
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_write",
                    "name": "Write",
                    "input": {
                        "file_path": "/tmp/bypass.js",
                        "content": (
                            "// full bypass script\n"
                            "Java.perform(function () {\n"
                            "  // …hundreds of lines of hooks…\n"
                            "});\n"
                            "Java.scheduleOnMainThread(function () {\n"
                            "  send('all hooks loaded');\n"
                            "});\n"
                        ),
                    },
                },
            ],
        },
        {"role": "user", "content": "great, show me the Toast bit"},
        # Newer: Claude pastes a snippet for discussion
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Here's the Toast preview section:\n\n"
                        "```javascript\n"
                        "Java.scheduleOnMainThread(function () {\n"
                        "  send('all hooks loaded');\n"
                        "});\n"
                        "```"
                    ),
                }
            ],
        },
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    # Must be the full script, not the tail-end preview
    assert "full bypass script" in (result.source or "")
    assert "hundreds of lines of hooks" in (result.source or "")


def test_extract_ignores_write_to_non_js_path():
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_03",
                    "name": "Write",
                    "input": {
                        "file_path": "/tmp/notes.md",
                        "content": "# notes\n\nsend('not really a script');\n",
                    },
                },
            ],
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is False


def test_extract_unwraps_new_persistence_shape():
    """Current persistence stores the full Claude message dict
    ``{id, role, content: [...]}`` instead of just the content array, so the
    frontend can dedupe by message.id. Extract must unwrap that."""
    messages = [
        {
            "role": "assistant",
            "content": {
                "id": "msg_01abc",
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "```javascript\nsend('wrapped');\n```",
                    }
                ],
            },
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is True
    assert "send('wrapped')" in (result.source or "")


def test_edit_tool_use_alone_is_not_extracted():
    """An Edit tool_use carries only a patch fragment (``new_string``) —
    returning it would give the caller a tail-of-script snippet, not the
    full file. Without a ``project_id`` to read the real file from disk,
    extract_javascript_from_messages should fall through to fences
    (none here) and report nothing found."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_04",
                    "name": "Edit",
                    "input": {
                        "file_path": "/tmp/hook.js",
                        "old_string": "send('old');",
                        "new_string": "Java.perform(function () { send('edited'); });",
                    },
                },
            ],
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.found is False


def test_extract_reads_edited_file_from_disk(tmp_path, monkeypatch):
    """When Claude iterates on a script via Write → Edit, the extract must
    return the *current file on disk* (which is the real full script),
    not the Edit's ``new_string`` patch fragment.

    This is the real-world regression motivating the disk-read path:
    users hit Extract Script → Editor and got just the tail block.
    """
    # Point the data dir at tmp so we don't touch the real ~/.frida-ide
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    project_id = 42
    (tmp_path / "projects" / str(project_id)).mkdir(parents=True)
    script_path = tmp_path / "projects" / str(project_id) / "bypass.js"
    full_script = (
        "// full bypass script\n"
        "Java.perform(function () {\n"
        "  // …hundreds of lines…\n"
        "  Java.scheduleOnMainThread(function () {\n"
        "    send('all hooks loaded');\n"
        "  });\n"
        "});\n"
    )
    script_path.write_text(full_script, encoding="utf-8")

    messages = [
        # Write the initial full script
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_w",
                    "name": "Write",
                    "input": {
                        "file_path": str(script_path),
                        "content": "// old version\n",
                    },
                }
            ],
        },
        # Then Edit it a few times — each Edit's new_string is just a
        # patch fragment, NOT the full script
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_e1",
                    "name": "Edit",
                    "input": {
                        "file_path": str(script_path),
                        "old_string": "// old version\n",
                        "new_string": (
                            "Java.scheduleOnMainThread(function () {\n"
                            "  send('all hooks loaded');\n"
                            "});\n"
                        ),
                    },
                }
            ],
        },
    ]
    result = extract_javascript_from_messages(messages, project_id=project_id)
    assert result.found is True
    assert "full bypass script" in (result.source or "")
    assert "hundreds of lines" in (result.source or "")


def test_extract_disk_read_refuses_paths_outside_project(tmp_path, monkeypatch):
    """Paths outside the project tree are refused — can't be tricked into
    leaking ~/.ssh/id_rsa.js via a crafted tool_use."""
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    project_id = 42
    (tmp_path / "projects" / str(project_id)).mkdir(parents=True)

    # Put a file *outside* the project dir
    rogue = tmp_path / "secret.js"
    rogue.write_text("send('leaked');", encoding="utf-8")

    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_w",
                    "name": "Write",
                    "input": {
                        "file_path": str(rogue),
                        "content": "// decoy\nsend('decoy');\n",
                    },
                }
            ],
        }
    ]
    result = extract_javascript_from_messages(messages, project_id=project_id)
    # Disk read refused → falls through to the Write's in-band content
    assert result.found is True
    assert "decoy" in (result.source or "")
    assert "leaked" not in (result.source or "")
