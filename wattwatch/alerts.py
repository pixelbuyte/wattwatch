"""Background watchers: budget alerts, idle-sleep nudges and achievement checks."""

from __future__ import annotations

import logging
import time
from datetime import datetime

from . import achievements

log = logging.getLogger(__name__)


class Watchers:
    def __init__(self, ww):
        self.ww = ww
        self._last_budget = 0.0
        self._idle_notified_for: float | None = None

    def install(self):
        self.ww.collector.hooks.append(self.every_minute)
        self.ww.collector.listeners.append(self.every_sample)

    # ------------------------------------------------------------------ every sample
    def every_sample(self, sample: dict):
        s = self.ww.settings
        since = self.ww.collector.idle_since
        if not sample.get("is_idle") or since is None:
            return
        if not s.get("idle_notify") or self._idle_notified_for == since:
            return
        self._idle_notified_for = since
        cur = s.get("currency", "$")
        w = sample["wall_w"]
        sleep_w = float(s.get("sleep_watts", 2))
        per_hour = max(0.0, w - sleep_w) / 1000 * sample.get("rate", 0)
        mins = int(sample["idle_s"] // 60)
        msg = (f"Idle for {mins} min and still drawing {w:.0f} W ({cur}{per_hour:.3f}/h). "
               f"Sleeping it would cut that to ~{sleep_w:.0f} W.")
        self.ww.db.add_event("idle", "Your PC is idle", msg)
        self.ww.notifier.notify("💤 Your PC is idle", msg)

    # ------------------------------------------------------------------ every minute
    def every_minute(self, _collector):
        sm = self.ww.analytics.summary()
        try:
            achievements.check_and_unlock(self.ww, sm)
        except Exception:
            log.exception("achievement check failed")
        if time.time() - self._last_budget >= 300:
            self._last_budget = time.time()
            self.check_budget(sm)

    def check_budget(self, sm: dict):
        s = self.ww.settings
        budget = float(s.get("monthly_budget") or 0)
        if budget <= 0 or not s.get("budget_alerts", True):
            return
        if sm["averages"]["tracked_hours_7d"] < 6:
            return  # not enough data for a fair projection
        cur = s.get("currency", "$")
        key = datetime.now().strftime("%Y-%m")
        sent = self.ww.db.get_meta("budget_alerts_sent", {}) or {}
        sent_this = set(sent.get(key, []))
        month = sm["month"]
        if month["cost"] >= budget and "spent" not in sent_this:
            sent_this.add("spent")
            msg = f"You've spent {cur}{month['cost']:.2f} this month - over your {cur}{budget:.2f} budget."
            self.ww.db.add_event("budget", "Budget exceeded", msg)
            self.ww.notifier.notify("💸 Budget exceeded", msg)
        elif month["projected"] > budget and "projected" not in sent_this:
            sent_this.add("projected")
            msg = (f"At this rate this month will cost {cur}{month['projected']:.2f}, over your "
                   f"{cur}{budget:.2f} budget. Letting the PC sleep when idle is the quickest fix.")
            self.ww.db.add_event("budget", "Heads up: over budget pace", msg)
            self.ww.notifier.notify("📈 Over budget pace", msg)
        sent[key] = sorted(sent_this)
        self.ww.db.set_meta("budget_alerts_sent", {key: sent[key]})
