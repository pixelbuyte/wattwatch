"""Default settings, data-directory resolution and settings helpers."""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

DEFAULT_PORT = 8787

# Every user-tunable knob lives here. Values are stored as JSON in SQLite, so
# anything you change in the dashboard survives restarts.
DEFAULT_SETTINGS: dict = {
    # --- money ---------------------------------------------------------
    "currency": "$",
    "rate_per_kwh": 0.17,          # flat electricity price
    "tou_enabled": False,          # time-of-use pricing on/off
    "tou_periods": [
        # days: 0=Mon ... 6=Sun. Periods may cross midnight (start > end).
        {"name": "Peak", "start": "16:00", "end": "21:00", "rate": 0.34, "days": [0, 1, 2, 3, 4]},
        {"name": "Off-peak", "start": "23:00", "end": "07:00", "rate": 0.11, "days": [0, 1, 2, 3, 4, 5, 6]},
    ],
    "monthly_budget": 15.0,        # 0 disables budget alerts
    "budget_alerts": True,
    # --- environment ---------------------------------------------------
    "co2_g_per_kwh": 370,          # grid carbon intensity (US average is roughly 370 g/kWh)
    # --- hardware model (0 / "auto" = detect) --------------------------
    "cpu_tdp_override": 0,
    "gpu_idle_watts": 0,           # used only when no GPU power sensor exists
    "gpu_max_watts": 0,
    "psu_watts": 0,                # rated PSU / charger size
    "psu_tier": "auto",            # white|bronze|silver|gold|platinum|titanium|adapter|auto
    "fan_count": 0,
    "extra_watts": 0,              # monitor, speakers, hub... anything on the same plug
    "sleep_watts": 2.0,            # draw while asleep (S3 suspend is usually 1-5 W)
    "off_watts": 0.5,              # draw while shut down but still plugged in
    "lhm_url": "",                 # Windows: LibreHardwareMonitor web server, e.g. http://localhost:8085/data.json
    # --- idle / sleep ---------------------------------------------------
    "idle_threshold_min": 15,      # minutes without keyboard/mouse input = idle
    "idle_notify": True,
    "night_start": "23:00",        # used for "slept overnight" streaks and projections
    "night_hours": 8,
    # --- smart plug -----------------------------------------------------
    "smartplug": {"type": "none", "host": "", "username": "", "password": "", "index": 0},
    "smartplug_auto_calibrate": True,
    # --- misc -----------------------------------------------------------
    "autostart": False,
}

PSU_TIERS = ["auto", "white", "bronze", "silver", "gold", "platinum", "titanium", "adapter"]


def data_dir() -> Path:
    """Per-user data directory (overridable with WATTWATCH_DATA_DIR)."""
    override = os.environ.get("WATTWATCH_DATA_DIR")
    if override:
        path = Path(override).expanduser()
    elif sys.platform.startswith("win"):
        path = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "WattWatch"
    elif sys.platform == "darwin":
        path = Path.home() / "Library" / "Application Support" / "WattWatch"
    else:
        base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
        path = Path(base) / "wattwatch"
    path.mkdir(parents=True, exist_ok=True)
    return path


def merge_settings(stored: dict) -> dict:
    """Overlay stored values onto defaults so new keys appear after upgrades."""
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    for key, value in stored.items():
        if key not in merged:
            continue
        if isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


def _num(value, lo, hi, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _hhmm(value, default):
    try:
        h, m = str(value).split(":")
        h, m = int(h), int(m)
        if 0 <= h < 24 and 0 <= m < 60:
            return f"{h:02d}:{m:02d}"
    except (ValueError, AttributeError):
        pass
    return default


def validate_settings(incoming: dict, current: dict) -> dict:
    """Return a sanitised copy of `current` updated with `incoming`."""
    out = copy.deepcopy(current)
    d = DEFAULT_SETTINGS
    for key, value in (incoming or {}).items():
        if key not in d:
            continue
        if key == "currency":
            out[key] = str(value)[:4] or "$"
        elif key in ("rate_per_kwh",):
            out[key] = _num(value, 0, 10, d[key])
        elif key == "monthly_budget":
            out[key] = _num(value, 0, 100000, d[key])
        elif key == "co2_g_per_kwh":
            out[key] = _num(value, 0, 2000, d[key])
        elif key in ("cpu_tdp_override", "gpu_idle_watts", "gpu_max_watts", "extra_watts"):
            out[key] = _num(value, 0, 2000, 0)
        elif key == "psu_watts":
            out[key] = _num(value, 0, 5000, 0)
        elif key == "fan_count":
            out[key] = int(_num(value, 0, 30, 0))
        elif key in ("sleep_watts", "off_watts"):
            out[key] = _num(value, 0, 100, d[key])
        elif key == "idle_threshold_min":
            out[key] = int(_num(value, 1, 240, d[key]))
        elif key == "night_hours":
            out[key] = _num(value, 0, 16, d[key])
        elif key == "night_start":
            out[key] = _hhmm(value, d[key])
        elif key == "psu_tier":
            out[key] = value if value in PSU_TIERS else "auto"
        elif key in ("tou_enabled", "budget_alerts", "idle_notify", "smartplug_auto_calibrate", "autostart"):
            out[key] = bool(value)
        elif key == "lhm_url":
            v = str(value or "").strip()
            out[key] = v if (v == "" or v.startswith(("http://", "https://"))) else ""
        elif key == "tou_periods":
            periods = []
            for p in (value or [])[:12]:
                if not isinstance(p, dict):
                    continue
                days = [int(x) for x in p.get("days", []) if str(x).isdigit() and 0 <= int(x) <= 6]
                periods.append({
                    "name": str(p.get("name", "Period"))[:24],
                    "start": _hhmm(p.get("start"), "00:00"),
                    "end": _hhmm(p.get("end"), "00:00"),
                    "rate": _num(p.get("rate"), 0, 10, 0.0),
                    "days": sorted(set(days)) or list(range(7)),
                })
            out[key] = periods
        elif key == "smartplug":
            sp = dict(out.get("smartplug") or d["smartplug"])
            if isinstance(value, dict):
                t = value.get("type", sp.get("type"))
                sp["type"] = t if t in ("none", "shelly", "tasmota", "kasa") else "none"
                sp["host"] = str(value.get("host", sp.get("host", "")))[:120].strip()
                sp["username"] = str(value.get("username", sp.get("username", "")))[:64]
                sp["password"] = str(value.get("password", sp.get("password", "")))[:128]
                sp["index"] = int(_num(value.get("index", sp.get("index", 0)), 0, 8, 0))
            out[key] = sp
    return out
