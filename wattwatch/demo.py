"""Demo data: three weeks of plausible history for a gaming/work desktop.

Used by `python -m wattwatch --demo`, the screenshots, and the tests.
"""

from __future__ import annotations

import math
import random
import time
from datetime import datetime, timedelta

from .config import DEFAULT_SETTINGS
from .db import Database
from .pricing import rate_at


def _profile(dt: datetime, rng: random.Random, sleeps_tonight: bool) -> tuple[str, float, bool]:
    """(source, watts, user_idle) for one minute."""
    h = dt.hour + dt.minute / 60
    weekend = dt.weekday() >= 5
    if sleeps_tonight and (h >= 23.5 or h < 7):
        return "sleep", 2.0, False
    if 9 <= h < 17.5 and not weekend:          # work day
        base = 95 + 40 * rng.random() + (25 if 10 <= h < 12 else 0)
        return "estimated", base, rng.random() < 0.12
    if 19 <= h < 22.5:                         # evening gaming
        if rng.random() < (0.8 if weekend else 0.55):
            return "estimated", 280 + 90 * math.sin(h * 3) + 50 * rng.random(), False
        return "estimated", 110 + 30 * rng.random(), False
    if 12 <= h < 19 and weekend:
        return "estimated", 140 + 120 * rng.random(), rng.random() < 0.2
    # left on overnight / idle
    return "estimated", 68 + 8 * rng.random(), True


def _components(watts: float, rng: random.Random) -> dict:
    if watts <= 3:
        return {"standby": watts}
    dc = watts * 0.87
    board, ram, storage, fans = 16.0, 7.5 + rng.random(), 2.2 + rng.random(), 2.5 + dc / 120
    rest = max(dc - board - ram - storage - fans, 5)
    gpu_share = 0.25 if watts < 150 else 0.62
    gpu, cpu = rest * gpu_share, rest * (1 - gpu_share)
    return {"cpu": cpu, "gpu": gpu, "ram": ram, "storage": storage, "fans": fans, "board": board,
            "extra": 0.0, "psu_loss": watts - dc}


def seed_demo(path: str, days: int = 21, seed: int = 7) -> None:
    db = Database(path)
    rng = random.Random(seed)
    settings = dict(DEFAULT_SETTINGS)
    now = time.time()
    end = int(now // 60 * 60) - 60
    start = end - days * 86400
    # sleep habit improves: none in week 1, some in week 2, every night lately (streak!)
    sleep_nights = set()
    for d in range(days + 1):
        day = (datetime.fromtimestamp(start) + timedelta(days=d)).date()
        if d >= days - 5 or (d >= 8 and rng.random() < 0.45):
            sleep_nights.add(day)
    rows, downtime = [], []
    cur_sleep = None
    for ts in range(start, end, 60):
        dt = datetime.fromtimestamp(ts)
        night_of = (dt - timedelta(hours=12)).date()  # 23:30-07:00 belongs to the evening's date
        source, watts, idle = _profile(dt, rng, night_of in sleep_nights)
        if source == "sleep":
            if cur_sleep is None:
                cur_sleep = ts
        elif cur_sleep is not None:
            downtime.append((cur_sleep, ts))
            cur_sleep = None
        wh = watts / 60.0
        comps = _components(watts, rng)
        rows.append({
            "ts": ts, "seconds": 60.0, "wh": wh, "dc_wh": wh - comps.get("psu_loss", 0) / 60.0,
            "loss_wh": comps.get("psu_loss", 0) / 60.0, "idle_wh": wh if idle else 0.0,
            "idle_seconds": 60.0 if idle else 0.0, "cost": wh / 1000 * rate_at(settings, ts)[0],
            "avg_w": watts, "max_w": watts * 1.15, "min_w": watts * 0.85, "components": comps, "source": source,
        })
        if len(rows) >= 5000:
            db.write_minutes_bulk(rows)
            rows = []
    if rows:
        db.write_minutes_bulk(rows)
    for s, e in downtime:
        db.add_downtime(s, e, "sleep")
    db.set_meta("installed_ts", start)
    db.set_meta("demo", True)
    db.close()
