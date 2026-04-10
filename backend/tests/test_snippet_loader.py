"""Tests for the snippet header parser + renderer."""

from app.services.snippet_loader import parse_snippet_file, render_snippet


def test_parse_full_header():
    text = """// frida-ide://snippet
// name: Test Snippet
// description: A short description
// tags: foo, bar, baz
// param: PACKAGE_NAME / The target package / required
// param: METHOD / Method to hook / optional
Java.perform(function () {
    send('hi');
});
"""
    parsed = parse_snippet_file(text, fallback_name="default")
    assert parsed.name == "Test Snippet"
    assert parsed.description == "A short description"
    assert parsed.tags == ["foo", "bar", "baz"]
    assert len(parsed.parameters) == 2
    assert parsed.parameters[0].name == "PACKAGE_NAME"
    assert parsed.parameters[0].required is True
    assert parsed.parameters[1].required is False
    assert parsed.source == text  # full text preserved


def test_parse_no_header_falls_back_to_filename():
    text = "Java.perform(function () {});"
    parsed = parse_snippet_file(text, fallback_name="anon")
    assert parsed.name == "anon"
    assert parsed.tags == []
    assert parsed.parameters == []
    assert parsed.source == text


def test_render_substitutes_placeholders():
    src = "var TARGET = '{{CLASS_NAME}}';\nsend('{{METHOD}}');"
    out = render_snippet(src, {"CLASS_NAME": "com.example.A", "METHOD": "doFinal"})
    assert "var TARGET = 'com.example.A';" in out
    assert "send('doFinal');" in out


def test_render_leaves_unknown_placeholders():
    src = "{{KNOWN}} {{UNKNOWN}}"
    out = render_snippet(src, {"KNOWN": "x"})
    assert out == "x {{UNKNOWN}}"
