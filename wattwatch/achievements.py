"""Achievements, streak badges and the background checks that unlock them."""

from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)

# id, icon, name, description
ACHIEVEMENTS = [
    ("first_light", "🔌", "First Light", "Start tracking your PC's power."),
    ("kwh_1", "⚡", "Kilowatt Club", "Track your first kilowatt-hour."),
    ("kwh_100", "🏭", "Power Plant", "Track 100 kWh."),
    ("sleep_1", "🌙", "Sweet Dreams", "Let your PC sleep through a night."),
    ("sleep_3", "😴", "Hibernation Habit", "Slept the PC 3 nights in a row."),
    ("sleep_7", "🛌", "Week of Dreams", "Slept the PC 7 nights in a row."),
    ("track_7", "📅", "Creature of Habit", "Use WattWatch 7 days in a row."),
    ("budget_7", "💰", "Budget Boss", "Stay under your daily budget 7 days running."),
    ("featherweight", "🪶", "Featherweight", "A full day averaging under 60 W (laptops: 15 W)."),
    ("idle_slayer", "🗡️", "Idle Slayer", "A day with under 5% of energy spent idling (8 h+ tracked)."),
    ("grade_a", "🅰️", "Straight A", "Reach an A efficiency grade."),
    ("calibrated", "🎯", "True North", "Calibrate WattWatch with a real power meter."),
    ("plug", "🛰️", "Wired In", "Connect a smart plug for true measurements."),
    ("data_nerd", "📊", "Data Nerd", "Export your history as CSV."),
    ("reader", "📰", "Weekly Reader", "Open a weekly report."),
    ("insomniac", "🦉", "Insomniac", "Shame badge: the PC stayed awake 72 hours straight."),
]


def evaluate(ww, sm: dict) -> list[dict]:
    """Return every achievement with unlocked flag + progress (0-1)."""
    db = ww.db
    unlocked = {r["id"]: r["unlocked_ts"] for r in db.query("SELECT id, unlocked_ts FROM achievements")}
    st = sm["streaks"]
    total_kwh = sm["all_time"]["kwh"]
    laptop = ww.hw.is_laptop or ww.hw.is_apple_silicon
    days = ww.analytics.daily(30)
    full_days = [d for d in days[:-1] if d["seconds"] >= 20 * 3600]
    feather_limit = 15 if laptop else 60
    best_avg = min((d["avg_w"] for d in full_days), default=None)
    slayer = [d for d in days if d["seconds"] - d["asleep_seconds"] >= 8 * 3600 and d["wh"] > 0]
    best_idle_share = min((d["idle_wh"] / d["wh"] for d in slayer), default=None)
    calib = db.one("SELECT COUNT(*) n FROM calibration WHERE source='meter'")["n"]
    previous_best = int(db.get_meta("best_sleep_streak", 0) or 0)
    best_sleep = max(st["sleep_nights"], previous_best)
    if best_sleep != previous_best:
        db.set_meta("best_sleep_streak", best_sleep)
    any_slept = any(n["slept"] for n in st["nights"])

    progress = {
        "first_light": 1.0 if total_kwh > 0 else 0.0,
        "kwh_1": total_kwh / 1,
        "kwh_100": total_kwh / 100,
        "sleep_1": 1.0 if (any_slept or best_sleep >= 1) else 0.0,
        "sleep_3": best_sleep / 3,
        "sleep_7": best_sleep / 7,
        "track_7": st["tracking_days"] / 7,
        "budget_7": st["under_budget_days"] / 7 if sm["month"]["budget"] > 0 else 0.0,
        "featherweight": (1.0 if best_avg is not None and best_avg < feather_limit else
                          (feather_limit / best_avg if best_avg else 0.0)),
        "idle_slayer": (1.0 if best_idle_share is not None and best_idle_share < 0.05 else
                        (0.05 / best_idle_share if best_idle_share else 0.0)),
        "grade_a": 1.0 if sm["score"]["grade"] == "A" else sm["score"]["points"] / 85 if sm["score"]["enough_data"] else 0.0,
        "calibrated": 1.0 if calib > 0 else 0.0,
        "plug": 1.0 if ww.plug.active and ww.plug.watts is not None else 0.0,
        "data_nerd": 1.0 if db.get_meta("exported") else 0.0,
        "reader": 1.0 if db.get_meta("report_opened") else 0.0,
        "insomniac": st["awake_hours"] / 72,
    }
    out = []
    for aid, icon, name, desc in ACHIEVEMENTS:
        p = max(0.0, min(1.0, progress.get(aid, 0.0)))
        out.append({"id": aid, "icon": icon, "name": name, "desc": desc, "progress": round(p, 3),
                    "unlocked": aid in unlocked, "unlocked_ts": unlocked.get(aid), "shame": aid == "insomniac"})
    return out


def check_and_unlock(ww, sm: dict | None = None) -> list[dict]:
    sm = sm or ww.analytics.summary()
    newly = []
    for a in evaluate(ww, sm):
        if not a["unlocked"] and a["progress"] >= 1.0:
            ww.db.execute("INSERT OR IGNORE INTO achievements(id, unlocked_ts) VALUES(?, ?)", (a["id"], int(time.time())))
            title = "Shame badge unlocked" if a["shame"] else "Achievement unlocked"
            ww.db.add_event("achievement", f"{title}: {a['icon']} {a['name']}", a["desc"])
            ww.notifier.notify(f"{a['icon']} {a['name']}", a["desc"])
            newly.append(a)
    return newly
