"""Background sampler: one power sample per second, rolled up into per-minute SQLite rows."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime

import psutil

from .db import Database
from .pricing import rate_at
from .sensors.idle import IdleDetector
from .sensors.model import PowerModel

log = logging.getLogger(__name__)

SLEEP_GAP_S = 60          # a wall-clock jump this large inside the loop means the OS was suspended
MAX_FILL_DAYS = 45        # never back-fill more than this many days of sleep/off rows


def local_midnight(ts: float | None = None) -> float:
    dt = datetime.fromtimestamp(ts if ts is not None else time.time())
    return dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def month_start(ts: float | None = None) -> float:
    dt = datetime.fromtimestamp(ts if ts is not None else time.time())
    return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()


class _Bucket:
    __slots__ = ("ts", "seconds", "wh", "dc_wh", "loss_wh", "idle_wh", "idle_seconds", "cost",
                 "max_w", "min_w", "comp", "sources")

    def __init__(self, ts: int):
        self.ts = ts
        self.seconds = self.wh = self.dc_wh = self.loss_wh = self.idle_wh = self.idle_seconds = self.cost = 0.0
        self.max_w, self.min_w = 0.0, float("inf")
        self.comp: dict[str, float] = {}
        self.sources: dict[str, float] = {}

    def add(self, sample: dict, dt: float, idle: bool, rate: float):
        w = sample["wall_w"]
        wh = w * dt / 3600.0
        self.seconds += dt
        self.wh += wh
        self.dc_wh += sample["dc_w"] * dt / 3600.0
        self.loss_wh += sample["loss_w"] * dt / 3600.0
        if idle:
            self.idle_wh += wh
            self.idle_seconds += dt
        self.cost += wh / 1000.0 * rate
        self.max_w = max(self.max_w, w)
        self.min_w = min(self.min_w, w)
        for k, v in sample["components"].items():
            self.comp[k] = self.comp.get(k, 0.0) + v * dt
        self.sources[sample["source"]] = self.sources.get(sample["source"], 0.0) + dt

    def row(self) -> dict:
        secs = max(self.seconds, 1e-9)
        return {
            "ts": self.ts, "seconds": round(self.seconds, 3), "wh": self.wh, "dc_wh": self.dc_wh,
            "loss_wh": self.loss_wh, "idle_wh": self.idle_wh, "idle_seconds": self.idle_seconds,
            "cost": self.cost, "avg_w": self.wh * 3600.0 / secs, "max_w": self.max_w,
            "min_w": 0.0 if self.min_w == float("inf") else self.min_w,
            "components": {k: v / secs for k, v in self.comp.items()},
            "source": max(self.sources, key=self.sources.get) if self.sources else "estimated",
        }


class Collector:
    def __init__(self, db: Database, model: PowerModel, settings: dict):
        self.db = db
        self.model = model
        self.settings = settings
        self.idle = IdleDetector()
        self.ring: deque = deque(maxlen=900)   # 15 minutes of 1-second samples for the live chart
        self.latest: dict | None = None
        self.bucket: _Bucket | None = None
        self.started = time.time()
        self.hooks: list = []                  # callables run every ~60 s: hook(collector)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._today_start = 0.0
        self._today_db: dict = {}
        self._month_db: dict = {}
        self._low_cpu_since: float | None = None
        self.idle_since: float | None = None
        self.listeners: list = []              # callables run every sample (e.g. tray refresh)

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        self._handle_startup_gap()
        self._refresh_cache(force=True)
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        self._flush()

    def update_settings(self, settings: dict):
        with self._lock:
            self.settings = settings
            self.model.update_settings(settings)

    # ------------------------------------------------------------------ gaps
    def _handle_startup_gap(self):
        """Work out what happened while WattWatch wasn't running."""
        last = self.db.last_minute_ts()
        now = time.time()
        if last is None:
            return
        last_end = last + 60
        if now - last_end < 600:
            return
        boot = psutil.boot_time()
        if boot > last_end:
            # The machine was shut down (or rebooted) after our last sample.
            self.db.add_downtime(last_end, boot, "off")
            self._fill(last_end, boot, "off")
            if now - boot > 600:
                self.db.add_downtime(boot, now, "unknown")  # booted, but WattWatch wasn't running
        else:
            self.db.add_downtime(last_end, now, "unknown")

    def _fill(self, start: float, end: float, kind: str):
        """Write synthetic minute rows for sleep/off periods at the configured standby draw."""
        watts = float(self.settings.get("sleep_watts" if kind == "sleep" else "off_watts", 0.0))
        start = max(start, end - MAX_FILL_DAYS * 86400)
        first = int(-(-start // 60) * 60)
        last = int(end // 60 * 60)
        rows = []
        for ts in range(first, last, 60):
            wh = watts / 60.0
            rows.append({
                "ts": ts, "seconds": 60.0, "wh": wh, "dc_wh": wh, "loss_wh": 0.0, "idle_wh": 0.0,
                "idle_seconds": 0.0, "cost": wh / 1000.0 * rate_at(self.settings, ts)[0],
                "avg_w": watts, "max_w": watts, "min_w": watts, "components": {"standby": watts}, "source": kind,
            })
            if len(rows) >= 5000:
                self.db.write_minutes_bulk(rows)
                rows = []
        if rows:
            self.db.write_minutes_bulk(rows)

    # ------------------------------------------------------------------ main loop
    def _loop(self):
        last_tick = time.time()
        last_hook = 0.0
        while not self._stop.is_set():
            now = time.time()
            gap = now - last_tick
            if gap > SLEEP_GAP_S:
                log.info("Detected system sleep of %.0f s", gap)
                self._flush()
                self.db.add_downtime(last_tick, now, "sleep")
                self._fill(last_tick, now, "sleep")
                self.db.add_event("sleep", "Welcome back",
                                  f"Your PC slept for {gap / 3600:.1f} h.")
                self._refresh_cache(force=True)
                gap = 1.0
            dt = max(0.05, min(gap, 5.0)) if self.latest else 1.0
            try:
                self._tick(now, dt)
            except Exception:
                log.exception("sample failed")
            last_tick = now
            if now - last_hook >= 60:
                last_hook = now
                for hook in list(self.hooks):
                    try:
                        hook(self)
                    except Exception:
                        log.exception("collector hook failed")
            self._stop.wait(max(0.05, 1.0 - (time.time() - now)))

    def _idle_seconds(self, cpu_util: float | None, now: float) -> tuple[float, str]:
        secs = self.idle.seconds()
        if secs is not None:
            return secs, self.idle.method
        # No input-idle API: treat sustained very low CPU as "nobody's using this".
        if cpu_util is not None and cpu_util < 0.07:
            if self._low_cpu_since is None:
                self._low_cpu_since = now
            return now - self._low_cpu_since, "cpu-heuristic"
        self._low_cpu_since = None
        return 0.0, "cpu-heuristic"

    def _tick(self, now: float, dt: float):
        prev_util = self.latest["cpu_util"] if self.latest else None
        idle_s, method = self._idle_seconds(prev_util, now)
        sample = self.model.sample(user_idle_s=idle_s)
        threshold = float(self.settings.get("idle_threshold_min", 15)) * 60
        is_idle = idle_s >= threshold
        if is_idle and self.idle_since is None:
            self.idle_since = now - idle_s
        elif not is_idle:
            self.idle_since = None
        rate, rate_name = rate_at(self.settings, now)
        minute = int(now // 60 * 60)
        with self._lock:
            if self.bucket is None or self.bucket.ts != minute:
                self._flush()
                self.bucket = _Bucket(minute)
            self.bucket.add(sample, dt, is_idle, rate)
            sample.update({"idle_s": idle_s, "idle_method": method, "is_idle": is_idle,
                           "rate": rate, "rate_name": rate_name,
                           "cost_per_hour": sample["wall_w"] / 1000.0 * rate})
            self.latest = sample
            self.ring.append({"t": round(now, 2), "w": round(sample["wall_w"], 2),
                              "raw": round(sample["raw_wall_w"], 2),
                              "c": {k: round(v, 2) for k, v in sample["components"].items()}})
        for fn in list(self.listeners):
            try:
                fn(sample)
            except Exception:
                log.debug("listener failed", exc_info=True)

    def _flush(self):
        with self._lock:
            b, self.bucket = self.bucket, None
        if b is not None and b.seconds > 0:
            self.db.write_minute(b.row())
            self._refresh_cache()

    def _refresh_cache(self, force: bool = False):
        # Two indexed SUM queries per minute (or on demand) - cheap enough to always run.
        today = local_midnight()
        self._today_start = today
        self._today_db = self.db.totals(today)
        self._month_db = self.db.totals(month_start())

    # ------------------------------------------------------------------ live totals
    def _with_bucket(self, base: dict, start: float) -> dict:
        out = dict(base)
        with self._lock:
            b = self.bucket
            if b is not None and b.ts >= start:
                out["wh"] = out.get("wh", 0) + b.wh
                out["cost"] = out.get("cost", 0) + b.cost
                out["loss_wh"] = out.get("loss_wh", 0) + b.loss_wh
                out["idle_wh"] = out.get("idle_wh", 0) + b.idle_wh
                out["idle_seconds"] = out.get("idle_seconds", 0) + b.idle_seconds
                out["awake_seconds"] = out.get("awake_seconds", 0) + b.seconds
        return out

    def today(self) -> dict:
        if local_midnight() != self._today_start:
            self._refresh_cache(force=True)
        return self._with_bucket(self._today_db, self._today_start)

    def month(self) -> dict:
        return self._with_bucket(self._month_db, month_start())

    def history(self, seconds: int = 300) -> list[dict]:
        cutoff = time.time() - seconds
        with self._lock:
            return [p for p in self.ring if p["t"] >= cutoff]
