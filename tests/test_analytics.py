import time

import pytest

from wattwatch import achievements, reports
from wattwatch.collector import _Bucket
from wattwatch.db import Database
from wattwatch.facts import build_facts


def test_bucket_integrates_energy_and_cost():
    b = _Bucket(0)
    sample = {"wall_w": 120.0, "dc_w": 100.0, "loss_w": 20.0, "components": {"cpu": 60.0, "psu_loss": 20.0},
              "source": "estimated"}
    for _ in range(60):
        b.add(sample, 1.0, idle=False, rate=0.5)
    row = b.row()
    assert row["wh"] == pytest.approx(2.0)       # 120 W for one minute
    assert row["loss_wh"] == pytest.approx(20 / 60)
    assert row["cost"] == pytest.approx(0.001)   # 2 Wh at $0.50/kWh
    assert row["avg_w"] == pytest.approx(120.0)
    assert row["components"]["cpu"] == pytest.approx(60.0)


def test_minute_merge_on_restart(tmp_path):
    db = Database(tmp_path / "t.db")
    row = {"ts": 600, "seconds": 30.0, "wh": 1.0, "dc_wh": 0.9, "loss_wh": 0.1, "idle_wh": 0.0, "idle_seconds": 0,
           "cost": 0.0002, "avg_w": 120, "max_w": 130, "min_w": 110, "components": {"cpu": 50}, "source": "estimated"}
    db.write_minute(row)
    db.write_minute(dict(row, components={"cpu": 70}))
    t = db.totals(0, 10_000)
    assert t["wh"] == 2.0 and t["minutes"] == 1
    r = db.one("SELECT seconds, components FROM minutes")
    assert r["seconds"] == 60 and '"cpu": 60' in r["components"]


def test_summary_shape_and_sanity(ww):
    sm = ww.analytics.summary()
    assert sm["score"]["grade"] in "ABCDF"
    assert 0 <= sm["score"]["points"] <= 100
    p = sm["projection"]
    assert p["never_sleeps"]["cost"] > p["sleeps_nightly"]["cost"] > 0
    assert sm["year"]["projected_kwh"] > 0
    assert sm["waste"]["month"]["psu_loss"]["kwh"] >= 0
    assert sm["streaks"]["sleep_nights"] >= 3     # demo data sleeps every night lately
    assert isinstance(sm["tips"], list)


def test_heatmap_and_history(ww):
    hm = ww.analytics.heatmap(7)
    assert len(hm["days"]) == 7
    assert all(len(d["hours"]) == 24 for d in hm["days"])
    assert hm["max_w"] > 0
    h = ww.analytics.history("24h")
    assert len(h["points"]) > 100
    assert all(p["w"] >= 0 for p in h["points"])
    b = ww.analytics.breakdown("7d")
    assert b["components"] and b["components"][0]["w"] > 0


def test_facts_use_real_numbers(ww):
    facts = build_facts(ww.analytics.summary(), ww.collector.latest)
    texts = " ".join(f["text"] for f in facts)
    assert len(facts) >= 10
    assert "phone" in texts and "litres" in texts


def test_achievements_unlock(ww):
    sm = ww.analytics.summary()
    newly = achievements.check_and_unlock(ww, sm)
    ids = {a["id"] for a in newly}
    assert {"first_light", "kwh_1", "sleep_1", "sleep_3"} <= ids
    # unlocking is idempotent
    assert achievements.check_and_unlock(ww, sm) == []
    events = ww.db.recent_events(50)
    assert any(e["kind"] == "achievement" for e in events)


def test_weekly_report_and_csv(ww):
    r = reports.weekly(ww)
    assert len(r["days"]) == 7
    assert r["totals"]["kwh"] > 0
    assert r["highlights"]
    html = reports.weekly_html(ww)
    assert "<svg" in html and "weekly report" in html
    csv_text = reports.export_csv(ww, "day", 7)
    lines = csv_text.strip().splitlines()
    assert lines[0].startswith("timestamp_local,")
    assert 6 <= len(lines) - 1 <= 8
    assert ww.db.get_meta("exported") is True


def test_sleep_gap_fill(ww):
    c = ww.collector
    start = int(time.time() // 60 * 60) - 3 * 3600
    c._fill(start, start + 3600, "sleep")
    rows = ww.db.query("SELECT avg_w FROM minutes WHERE ts >= ? AND ts < ?", (start, start + 3600))
    assert len(rows) == 60
    assert rows and all(r["avg_w"] == ww.settings["sleep_watts"] for r in rows)
