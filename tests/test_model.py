from datetime import datetime

import pytest

from wattwatch.config import DEFAULT_SETTINGS, validate_settings
from wattwatch.pricing import rate_at
from wattwatch.sensors import psu
from wattwatch.sensors.hardware import guess_tdp
from wattwatch.sensors.model import Calibration, fan_curve


def test_psu_curve_shape():
    for tier in psu.CURVES:
        assert psu.efficiency(tier, 0.01) < psu.efficiency(tier, 0.5)
        assert 0.3 < psu.efficiency(tier, 0.5) < 1.0
    # higher tiers are never worse at typical loads
    assert psu.efficiency("titanium", 0.2) > psu.efficiency("gold", 0.2) > psu.efficiency("bronze", 0.2)


def test_wall_watts_includes_losses():
    wall, eff = psu.wall_watts(100, 650, "gold")
    assert wall > 100
    assert wall == pytest.approx(100 / eff)
    assert psu.wall_watts(0, 650, "gold")[0] == 0


def test_pick_size_has_headroom():
    assert psu.pick_size(400, laptop=False) >= 550
    assert psu.pick_size(50, laptop=True) == 65


def test_fan_curve_is_concave_and_bounded():
    assert fan_curve(0) == 0
    assert fan_curve(1) == pytest.approx(1)
    assert fan_curve(0.2) > 0.2  # turbo makes light load relatively expensive
    assert fan_curve(5) == pytest.approx(1)


def test_calibration_single_point_is_ratio():
    c = Calibration([(100, 120)])
    assert c.apply(50) == pytest.approx(60)


def test_calibration_two_points_linear_fit():
    c = Calibration([(50, 70), (150, 190)])  # wall = 1.2 * raw + 10
    assert c.a == pytest.approx(1.2)
    assert c.b == pytest.approx(10)
    assert c.apply(100) == pytest.approx(130)


def test_calibration_empty_is_identity():
    c = Calibration([])
    assert not c.active
    assert c.apply(42) == 42


@pytest.mark.parametrize("brand,laptop,expected", [
    ("13th Gen Intel(R) Core(TM) i9-13900K", False, 125),
    ("Intel(R) Core(TM) i7-1165G7 @ 2.80GHz", True, 15),
    ("AMD Ryzen 7 7800X3D 8-Core Processor", False, 120),
    ("AMD Ryzen 5 5600G with Radeon Graphics", False, 65),
    ("Apple M2 Pro", True, 30),
    ("Some Mystery CPU", False, 65),
])
def test_guess_tdp(brand, laptop, expected):
    assert guess_tdp(brand, laptop, 8) == expected


def _ts(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm).timestamp()


def test_tou_pricing_and_midnight_crossing():
    s = dict(DEFAULT_SETTINGS, tou_enabled=True, rate_per_kwh=0.2)
    # 2026-11-02 is a Monday
    assert rate_at(s, _ts(2026, 11, 2, 17, 0)) == (0.34, "Peak")
    assert rate_at(s, _ts(2026, 11, 2, 12, 0)) == (0.2, "Standard")
    assert rate_at(s, _ts(2026, 11, 2, 23, 30))[1] == "Off-peak"
    assert rate_at(s, _ts(2026, 11, 3, 6, 0))[1] == "Off-peak"   # after midnight, belongs to Monday's period
    assert rate_at(s, _ts(2026, 11, 7, 17, 0))[1] == "Standard"  # Saturday: no peak


def test_flat_rate_when_tou_disabled():
    s = dict(DEFAULT_SETTINGS, tou_enabled=False, rate_per_kwh=0.3)
    assert rate_at(s, _ts(2026, 11, 2, 17, 0)) == (0.3, "Flat rate")


def test_validate_settings_clamps_and_ignores_unknown():
    out = validate_settings({"rate_per_kwh": "-5", "idle_threshold_min": 9999, "evil": 1,
                             "psu_tier": "unobtainium", "night_start": "25:99",
                             "smartplug": {"type": "toaster", "host": " 10.0.0.2 "}}, DEFAULT_SETTINGS)
    assert out["rate_per_kwh"] == 0
    assert out["idle_threshold_min"] == 240
    assert "evil" not in out
    assert out["psu_tier"] == "auto"
    assert out["night_start"] == DEFAULT_SETTINGS["night_start"]
    assert out["smartplug"]["type"] == "none"
    assert out["smartplug"]["host"] == "10.0.0.2"
