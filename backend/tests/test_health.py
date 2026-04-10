from app.main import app
from fastapi.testclient import TestClient


def test_health_endpoint():
    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "tools" in body
    assert set(body["tools"].keys()) == {"adb", "jadx", "apktool", "claude"}
