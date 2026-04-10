"""Tests for the extract-script regex used by the AI router."""

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


def test_extract_text_fence_beats_write_tool_in_same_turn():
    """When the same assistant turn has both an inline JS fence and a Write
    call, the explicit fence wins because it's the most direct intent."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "```javascript\nsend('inline');\n```",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_02",
                    "name": "Write",
                    "input": {
                        "file_path": "/tmp/x.js",
                        "content": "send('written');",
                    },
                },
            ],
        }
    ]
    result = extract_javascript_from_messages(messages)
    assert result.source == "send('inline');"


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


def test_extract_from_edit_tool_use():
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
    assert result.found is True
    assert "send('edited')" in (result.source or "")
