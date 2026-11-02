"""Application state: wires the database, hardware model, collector and helpers together."""

from __future__ import annotations

import logging
import secrets
import threading
import time
from pathlib import Path

from .alerts import Watchers
from .analytics import Analytics
from .collector import Collector
from .config import data_dir, validate_settings
from .db import Database
from .notify import Notifier
from .sensors import hardware
from .sensors.model import PowerModel
from .sensors.smartplug import SmartPlugPoller

log = logging.getLogger(__name__)


class WattWatch:
    def __init__(self, db_path: Path | str | None = None, start: bool = True):
        self.data_dir = data_dir()
        self.db = Database(db_path or self.data_dir / "wattwatch.db")
        self.token = secrets.token_urlsafe(24)
        self.settings = self.db.load_settings()
        self.hw = hardware.detect()
        self.db.set_meta("hardware", self.hw.to_dict())
        if self.db.get_meta("installed_ts") is None:
            self.db.set_meta("installed_ts", int(time.time()))
        self.model = PowerModel(self.hw, self.settings)
        self.plug = SmartPlugPoller()
        self.plug.configure(self.settings.get("smartplug", {}))
        self.model.plug = self.plug
        self.reload_calibration()
        self.notifier = Notifier()
        self.collector = Collector(self.db, self.model, self.settings)
        self.analytics = Analytics(self)
        self.watchers = Watchers(self)
        self.watchers.install()
        self.collector.hooks.append(self._plug_autocalibrate)
        self._lock = threading.RLock()
        self._last_plug_point = 0.0
        if start:
            self.collector.start()

    # ------------------------------------------------------------------ settings
    def update_settings(self, incoming: dict) -> dict:
        with self._lock:
            before = self.settings.get("autostart")
            self.settings = validate_settings(incoming, self.settings)
            if "autostart" in (incoming or {}) and self.settings["autostart"] != before:
                try:
                    from . import autostart
                    self.settings["autostart"] = autostart.set_enabled(self.settings["autostart"])
                except Exception as exc:
                    log.warning("autostart change failed: %s", exc)
                    self.settings["autostart"] = before
            self.db.save_settings(self.settings)
            self.collector.update_settings(self.settings)
            self.plug.configure(self.settings.get("smartplug", {}))
            self.analytics._cache.clear()
        return self.settings

    # ------------------------------------------------------------------ calibration
    def reload_calibration(self):
        rows = self.db.query("SELECT raw_w, measured_w FROM calibration ORDER BY id DESC LIMIT 60")
        self.model.calibration.fit([(r["raw_w"], r["measured_w"]) for r in rows])

    def add_calibration(self, measured_w: float, source: str = "meter") -> dict:
        recent = self.collector.history(10)
        if recent:
            # Meters average over a second or two - so do we. Use the uncalibrated model output.
            raw = sum(self._raw_from_point(p) for p in recent) / len(recent)
        else:
            raw = (self.collector.latest or {}).get("raw_wall_w", 0.0)
        if raw <= 0:
            raise ValueError("No live estimate yet - wait a few seconds and try again.")
        self.db.execute("INSERT INTO calibration(ts, raw_w, measured_w, source) VALUES(?,?,?,?)",
                        (int(time.time()), raw, float(measured_w), source))
        self.reload_calibration()
        return {"raw_w": raw, "measured_w": measured_w}

    @staticmethod
    def _raw_from_point(p: dict) -> float:
        return p.get("raw", p["w"])

    def _plug_autocalibrate(self, _collector):
        """While a smart plug is connected, keep teaching the model so it stays accurate without it."""
        if not self.settings.get("smartplug_auto_calibrate", True):
            return
        if time.time() - self._last_plug_point < 600:
            return
        recent = self.collector.history(30)
        plug_w = self.plug.read()
        if plug_w is None or len(recent) < 20:
            return
        ws = [p["raw"] for p in recent]
        if max(ws) - min(ws) > 0.25 * (sum(ws) / len(ws)):
            return  # load is jumping around - wait for a steadier moment
        self._last_plug_point = time.time()
        self.db.execute("INSERT INTO calibration(ts, raw_w, measured_w, source) VALUES(?,?,?,?)",
                        (int(time.time()), sum(ws) / len(ws), plug_w, "plug"))
        self.db.execute("DELETE FROM calibration WHERE source='plug' AND id NOT IN "
                        "(SELECT id FROM calibration WHERE source='plug' ORDER BY id DESC LIMIT 30)")
        self.reload_calibration()

    def clear_calibration(self):
        self.db.execute("DELETE FROM calibration")
        self.reload_calibration()

    def shutdown(self):
        try:
            self.collector.stop()
        finally:
            self.plug.stop()
            self.db.close()
