"""Unit tests for the AndroidManifest.xml parser."""

from pathlib import Path

from app.services.apk_pipeline import parse_android_manifest, safe_join

SAMPLE = """<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.app"
    android:versionCode="42"
    android:versionName="1.2.3"
    platformBuildVersionCode="35"
    platformBuildVersionName="15">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.WAKE_LOCK"/>
    <application android:name="com.example.app.App" android:debuggable="false">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <activity android:name=".SettingsActivity"/>
    </application>
</manifest>
"""


def test_parse_android_manifest(tmp_path: Path):
    p = tmp_path / "AndroidManifest.xml"
    p.write_text(SAMPLE)
    meta = parse_android_manifest(p)
    assert meta["package_name"] == "com.example.app"
    assert meta["version_name"] == "1.2.3"
    assert meta["version_code"] == 42
    assert "android.permission.INTERNET" in meta["permissions"]
    assert "android.permission.WAKE_LOCK" in meta["permissions"]
    assert meta["launcher_activity"] == ".MainActivity"
    assert meta["application_name"] == "com.example.app.App"
    assert meta["debuggable"] is False


def test_parse_missing_manifest(tmp_path: Path):
    assert parse_android_manifest(tmp_path / "nope.xml") == {}


def test_parse_falls_back_to_apktool_yml(tmp_path: Path):
    """When the manifest lacks version attrs, apktool.yml provides them."""
    # Manifest without versionCode/versionName
    (tmp_path / "AndroidManifest.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    package="app.example.test">\n'
        '</manifest>\n'
    )
    (tmp_path / "apktool.yml").write_text(
        "version: 3.0.1\n"
        "apkFileName: base.apk\n"
        "versionInfo:\n"
        "  versionCode: 107\n"
        "  versionName: 1.0.7\n"
        "doNotCompress:\n"
        "- arsc\n"
    )
    meta = parse_android_manifest(tmp_path / "AndroidManifest.xml")
    assert meta["package_name"] == "app.example.test"
    assert meta["version_code"] == 107
    assert meta["version_name"] == "1.0.7"


def test_safe_join_blocks_escape(tmp_path: Path):
    import pytest

    (tmp_path / "subdir").mkdir()
    # Valid relative path
    assert safe_join(tmp_path, "subdir") == (tmp_path / "subdir").resolve()
    # Path traversal attempts
    for evil in ("../etc/passwd", "/etc/passwd", "subdir/../../etc/passwd"):
        with pytest.raises(ValueError):
            safe_join(tmp_path, evil)
