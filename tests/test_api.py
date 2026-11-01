import pytest
from fastapi.testclient import TestClient

from wattwatch.server import create_app


@pytest.fixture
def client(ww):
    return TestClient(create_app(ww))


def test_index_injects_token(client, ww):
    r = client.get("/")
    assert r.status_code == 200
    assert ww.token in r.text


def test_live_payload(client):
    d = client.get("/api/live").json()
    assert d["ready"] is True
    assert d["wall_w"] > 0
    assert {"cpu", "ram"} <= {c["id"] for c in d["components"]}
    assert d["source"] == "estimated"


def test_rejects_foreign_host(client):
    r = client.get("/api/live", headers={"Host": "evil.example"})
    assert r.status_code == 403


def test_mutations_need_token(client, ww):
    assert client.post("/api/settings", json={"rate_per_kwh": 0.3}).status_code == 403
    r = client.post("/api/settings", json={"rate_per_kwh": 0.3}, headers={"X-WattWatch-Token": ww.token})
    assert r.status_code == 200 and r.json()["rate_per_kwh"] == 0.3
    assert ww.db.load_settings()["rate_per_kwh"] == 0.3   # persisted
    assert client.post("/api/power/sleep").status_code == 403


def test_calibration_flow(client, ww):
    h = {"X-WattWatch-Token": ww.token}
    raw = ww.collector.latest["raw_wall_w"]
    r = client.post("/api/calibrate", json={"measured_w": raw * 1.5}, headers=h)
    assert r.status_code == 200
    assert r.json()["a"] == pytest.approx(1.5, rel=0.05)
    assert client.post("/api/calibrate", json={"measured_w": "lots"}, headers=h).status_code == 400
    assert client.delete("/api/calibration", headers=h).status_code == 200
    assert client.get("/api/calibration").json()["active"] is False


def test_read_endpoints(client):
    for path in ["/api/summary", "/api/history?range=7d", "/api/heatmap?days=14", "/api/breakdown?range=today",
                 "/api/facts", "/api/achievements", "/api/system", "/api/daily", "/api/events",
                 "/api/report/weekly", "/report/weekly", "/api/live/history"]:
        assert client.get(path).status_code == 200, path
    csv = client.get("/api/export.csv?granularity=hour&days=2")
    assert csv.headers["content-type"].startswith("text/csv")
    assert csv.text.startswith("timestamp_local")
