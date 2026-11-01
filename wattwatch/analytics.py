"""Number crunching over the minute history: series, heatmaps, waste, projections, scores."""

from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta

from .collector import local_midnight, month_start
from .pricing import rate_at
from .sensors import psu
from .sensors.model import COMPONENT_NAMES

RANGES = {"1h": (3600, 60), "6h": (6 * 3600, 120), "24h": (86400, 300), "7d": (7 * 86400, 3600), "30d": (30 * 86400, 3 * 3600)}


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


class Analytics:
    def __init__(self, ww):
        self.ww = ww
        self.db = ww.db
        self._cache: dict = {}

    @property
    def settings(self) -> dict:
        return self.ww.settings

    def _cached(self, key: str, ttl: float, fn):
        hit = self._cache.get(key)
        now = time.time()
        if hit and now - hit[0] < ttl:
            return hit[1]
        val = fn()
        self._cache[key] = (now, val)
        return val

    # ------------------------------------------------------------------ series
    def history(self, rng: str = "24h") -> dict:
        span, step = RANGES.get(rng, RANGES["24h"])
        start = time.time() - span
        rows = self.db.query(
            "SELECT (ts / ?) * ? AS t, SUM(wh) wh, SUM(seconds) s, MAX(max_w) mx FROM minutes "
            "WHERE ts >= ? GROUP BY t ORDER BY t", (step, step, int(start)))
        pts = [{"t": r["t"] + step / 2, "w": round(r["wh"] * 3600 / r["s"], 2) if r["s"] else 0,
                "max": round(r["mx"] or 0, 1)} for r in rows if r["s"]]
        return {"range": rng, "step": step, "points": pts}

    def _quarters(self, start: float, end: float | None = None) -> list:
        end = end or time.time() + 60
        return self.db.query(
            "SELECT (ts / 900) * 900 AS q, SUM(wh) wh, SUM(cost) cost, SUM(seconds) s, SUM(idle_wh) idle_wh,"
            " SUM(idle_seconds) idle_s, SUM(loss_wh) loss_wh, MAX(max_w) mx,"
            " SUM(CASE WHEN source IN ('sleep','off') THEN seconds ELSE 0 END) asleep_s"
            " FROM minutes WHERE ts >= ? AND ts < ? GROUP BY q ORDER BY q", (int(start), int(end)))

    def heatmap(self, days: int = 7) -> dict:
        days = max(1, min(days, 60))
        first = datetime.fromtimestamp(local_midnight()) - timedelta(days=days - 1)
        grid: dict[date, list] = {}
        for i in range(days):
            grid[(first + timedelta(days=i)).date()] = [[0.0, 0.0, 0.0] for _ in range(24)]  # wh, seconds, asleep
        for r in self._quarters(first.timestamp()):
            dt = datetime.fromtimestamp(r["q"])
            cells = grid.get(dt.date())
            if cells is None:
                continue
            c = cells[dt.hour]
            c[0] += r["wh"]
            c[1] += r["s"]
            c[2] += r["asleep_s"]
        out, vmax = [], 0.0
        for d, cells in grid.items():
            row = []
            for wh, s, asleep in cells:
                if s <= 0:
                    row.append(None)
                    continue
                w = wh * 3600 / s
                vmax = max(vmax, w)
                row.append({"w": round(w, 1), "kwh": round(wh / 1000, 4), "asleep": asleep >= s * 0.5,
                            "coverage": round(min(1.0, s / 3600), 2)})
            out.append({"date": d.isoformat(), "label": d.strftime("%a %d"), "hours": row})
        return {"days": out, "max_w": round(vmax, 1)}

    def daily(self, days: int = 14) -> list[dict]:
        first = datetime.fromtimestamp(local_midnight()) - timedelta(days=days - 1)
        acc: dict[date, dict] = {}
        for i in range(days):
            d = (first + timedelta(days=i)).date()
            acc[d] = {"date": d.isoformat(), "wh": 0.0, "cost": 0.0, "seconds": 0.0, "idle_wh": 0.0,
                      "idle_seconds": 0.0, "loss_wh": 0.0, "peak_w": 0.0, "asleep_seconds": 0.0}
        for r in self._quarters(first.timestamp()):
            d = datetime.fromtimestamp(r["q"]).date()
            a = acc.get(d)
            if a is None:
                continue
            a["wh"] += r["wh"]
            a["cost"] += r["cost"]
            a["seconds"] += r["s"]
            a["idle_wh"] += r["idle_wh"]
            a["idle_seconds"] += r["idle_s"]
            a["loss_wh"] += r["loss_wh"]
            a["asleep_seconds"] += r["asleep_s"]
            a["peak_w"] = max(a["peak_w"], r["mx"] or 0)
        # include the minute currently being collected
        today = self.ww.collector.today()
        t = acc.get(date.today())
        if t is not None:
            db_today = self.db.totals(local_midnight())
            for k_out, k_in in (("wh", "wh"), ("cost", "cost"), ("idle_wh", "idle_wh"), ("loss_wh", "loss_wh"),
                                ("idle_seconds", "idle_seconds")):
                t[k_out] += today.get(k_in, 0) - db_today.get(k_in, 0)
        for a in acc.values():
            a["avg_w"] = a["wh"] * 3600 / a["seconds"] if a["seconds"] else 0.0
        return list(acc.values())

    def breakdown(self, rng: str = "today") -> dict:
        start = local_midnight() if rng == "today" else time.time() - (7 if rng == "7d" else 30) * 86400
        rows = self.db.query("SELECT components, seconds FROM minutes WHERE ts >= ? AND source NOT IN ('sleep','off')",
                             (int(start),))
        acc: dict[str, float] = {}
        total_s = 0.0
        for r in rows:
            s = r["seconds"]
            total_s += s
            for k, v in json.loads(r["components"] or "{}").items():
                acc[k] = acc.get(k, 0.0) + v * s
        comps = [{"id": k, "name": COMPONENT_NAMES.get(k, k.title()), "w": round(v / total_s, 2),
                  "kwh": round(v / 3600 / 1000, 4)} for k, v in acc.items() if total_s and v / total_s > 0.05]
        comps.sort(key=lambda c: -c["w"])
        return {"range": rng, "components": comps, "hours": round(total_s / 3600, 2)}

    # ------------------------------------------------------------------ nights & streaks
    def nights(self, count: int = 14) -> list[dict]:
        """Was the PC asleep/off for at least half of each recent night window?"""
        s = self.settings
        hh, mm = (int(x) for x in s.get("night_start", "23:00").split(":"))
        night_len = float(s.get("night_hours", 8)) * 3600
        now = time.time()
        today = datetime.fromtimestamp(now).replace(hour=hh, minute=mm, second=0, microsecond=0)
        out = []
        for i in range(count + 1):
            start = (today - timedelta(days=i)).timestamp()
            end = start + night_len
            if start > now:
                continue
            rows = self.db.query('SELECT start, "end" FROM downtime WHERE kind IN (\'sleep\',\'off\') '
                                 'AND "end" > ? AND start < ?', (int(start), int(end)))
            covered = sum(max(0, min(r["end"], end) - max(r["start"], start)) for r in rows)
            awake = self.db.one("SELECT COALESCE(SUM(seconds),0) s FROM minutes WHERE ts >= ? AND ts < ? "
                                "AND source NOT IN ('sleep','off')", (int(start), int(end)))["s"]
            finished = end <= now
            slept = covered >= night_len * 0.5
            if not finished and not slept:
                continue  # tonight isn't over yet
            known = slept or awake > 600
            out.append({"date": datetime.fromtimestamp(start).date().isoformat(), "slept": slept,
                        "known": known, "asleep_h": round(covered / 3600, 1), "awake_h": round(awake / 3600, 1)})
        return out

    def streaks(self) -> dict:
        nights = self.nights(30)
        sleep_streak = 0
        for n in nights:
            if n["slept"]:
                sleep_streak += 1
            else:
                break
        days = self.daily(60)
        tracking = 0
        for d in reversed(days):
            if d["seconds"] - d["asleep_seconds"] >= 3600:
                tracking += 1
            elif d["date"] == date.today().isoformat():
                continue
            else:
                break
        budget = float(self.settings.get("monthly_budget") or 0)
        under = 0
        if budget > 0:
            daily_budget = budget * 12 / 365
            for d in reversed(days[:-1]):  # completed days only
                if d["seconds"] >= 12 * 3600 and d["cost"] <= daily_budget:
                    under += 1
                else:
                    break
        # longest continuous awake run ending now (for the 'Insomniac' badge)
        last_sleep = self.db.one('SELECT MAX("end") e FROM downtime WHERE kind IN (\'sleep\',\'off\')')["e"]
        first = self.db.first_minute_ts() or time.time()
        awake_since = max(last_sleep or first, first)
        return {"sleep_nights": sleep_streak, "tracking_days": tracking, "under_budget_days": under,
                "nights": nights[:14], "awake_hours": round((time.time() - awake_since) / 3600, 1)}

    # ------------------------------------------------------------------ the big summary
    def summary(self) -> dict:
        return self._cached("summary", 8, self._summary)

    def _summary(self) -> dict:
        s = self.settings
        ww = self.ww
        now = time.time()
        rate_now, _ = rate_at(s, now)
        co2_per_kwh = float(s.get("co2_g_per_kwh", 0)) / 1000.0
        sleep_w = float(s.get("sleep_watts", 2.0))
        laptop = ww.hw.is_laptop or ww.hw.is_apple_silicon

        today = ww.collector.today()
        month = ww.collector.month()
        week = self.db.totals(now - 7 * 86400)
        tracked_s = week["awake_seconds"] + week["asleep_seconds"]
        awake_s = week["awake_seconds"]
        awake_wh = week["wh"] - week["asleep_wh"]

        avg_w = week["wh"] * 3600 / tracked_s if tracked_s > 0 else (ww.collector.latest or {}).get("wall_w", 0)
        avg_awake_w = awake_wh * 3600 / awake_s if awake_s > 0 else avg_w
        price = week["cost"] / (week["wh"] / 1000) if week["wh"] > 1 else rate_now

        # idle baseline: average draw while nobody's using it
        if week["idle_seconds"] >= 1800:
            idle_w = week["idle_wh"] * 3600 / week["idle_seconds"]
        else:
            r = self.db.one("SELECT avg_w FROM minutes WHERE ts >= ? AND source NOT IN ('sleep','off') "
                            "ORDER BY avg_w LIMIT 1 OFFSET (SELECT COUNT(*) / 5 FROM minutes WHERE ts >= ? "
                            "AND source NOT IN ('sleep','off'))", (int(now - 7 * 86400), int(now - 7 * 86400)))
            idle_w = r["avg_w"] if r else avg_awake_w * 0.6

        # ---- cost projections
        daily_kwh = avg_w * 24 / 1000
        daily_cost = daily_kwh * price
        dt_now = datetime.fromtimestamp(now)
        next_month = (dt_now.replace(day=28) + timedelta(days=4)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        days_left = (next_month.timestamp() - now) / 86400
        days_in_month = (next_month - dt_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)).days
        projected_month = month.get("cost", 0) + daily_cost * days_left
        budget = float(s.get("monthly_budget") or 0)

        # ---- 24/7 vs sleeping at night (TOU-aware)
        night_h = float(s.get("night_hours", 8))
        hh, mm = (int(x) for x in s.get("night_start", "23:00").split(":"))
        base = dt_now.replace(minute=30, second=0, microsecond=0)
        hourly_rate = [rate_at(s, (base.replace(hour=h)).timestamp())[0] for h in range(24)]
        night_hours = {(hh + i) % 24 for i in range(int(round(night_h)))}
        day_cost = sum(avg_awake_w / 1000 * hourly_rate[h] for h in range(24) if h not in night_hours)
        night_cost_on = sum(idle_w / 1000 * hourly_rate[h] for h in night_hours)
        night_cost_sleep = sum(sleep_w / 1000 * hourly_rate[h] for h in night_hours)
        day_kwh = avg_awake_w * (24 - len(night_hours)) / 1000
        never_kwh = (day_kwh + idle_w * len(night_hours) / 1000) * 365
        sleep_kwh = (day_kwh + sleep_w * len(night_hours) / 1000) * 365
        projection = {
            "never_sleeps": {"kwh": never_kwh, "cost": (day_cost + night_cost_on) * 365, "co2_kg": never_kwh * co2_per_kwh},
            "sleeps_nightly": {"kwh": sleep_kwh, "cost": (day_cost + night_cost_sleep) * 365, "co2_kg": sleep_kwh * co2_per_kwh},
            "night_hours": len(night_hours), "awake_w": avg_awake_w, "idle_w": idle_w, "sleep_w": sleep_w,
            "always_on_now": {"kwh": avg_w * 8.76, "cost": avg_w * 8.76 * price},
        }
        projection["savings"] = {k: projection["never_sleeps"][k] - projection["sleeps_nightly"][k] for k in ("kwh", "cost", "co2_kg")}

        # ---- waste
        def waste(t: dict) -> dict:
            wh = t.get("wh", 0) or 0
            p = (t.get("cost", 0) / (wh / 1000)) if wh > 1 else price
            idle_kwh = t.get("idle_wh", 0) / 1000
            idle_h = t.get("idle_seconds", 0) / 3600
            avoid = max(0.0, idle_kwh - idle_h * sleep_w / 1000)
            loss = t.get("loss_wh", 0) / 1000
            mk = lambda kwh: {"kwh": kwh, "cost": kwh * p, "co2_kg": kwh * co2_per_kwh}  # noqa: E731
            return {"idle": mk(idle_kwh), "avoidable": mk(avoid), "psu_loss": mk(loss), "idle_hours": idle_h,
                    "total": mk(avoid + loss), "share": (avoid + loss) / (wh / 1000) if wh > 1 else 0.0}

        all_time = self.db.totals(0)
        waste_out = {"today": waste(today), "month": waste(month), "all": waste(all_time)}

        # ---- efficiency score
        streaks = self.streaks()
        nights = [n for n in streaks["nights"][:7] if n["known"]]
        slept = sum(1 for n in nights if n["slept"])
        idle_share = week["idle_wh"] / awake_wh if awake_wh > 1 else 0.0
        good_idle, bad_idle = (6, 25) if laptop else (40, 120)
        rating = ww.model.psu_rating
        eff_typ = psu.efficiency(ww.model.psu_tier, avg_awake_w * 0.87 / rating) if avg_awake_w else 0.85
        parts = [
            {"id": "idle", "label": "Idle waste", "weight": 35, "score": 35 * _clamp(1 - idle_share / 0.5),
             "detail": f"{idle_share * 100:.0f}% of energy used while idle"},
            {"id": "sleep", "label": "Sleep habit", "weight": 25,
             "score": 25 * (slept / len(nights) if nights else 0.5),
             "detail": f"slept {slept} of the last {len(nights)} nights" if nights else "no nights tracked yet"},
            {"id": "baseline", "label": "Idle draw", "weight": 20,
             "score": 20 * _clamp((bad_idle - idle_w) / (bad_idle - good_idle)),
             "detail": f"idles at {idle_w:.0f} W"},
            {"id": "psu", "label": "PSU efficiency", "weight": 10, "score": 10 * _clamp((eff_typ - 0.70) / 0.20),
             "detail": f"~{eff_typ * 100:.0f}% efficient at your typical load"},
            {"id": "budget", "label": "Budget", "weight": 10,
             "score": 10.0 if budget <= 0 or projected_month <= budget else 10 * _clamp(2 - projected_month / budget),
             "detail": "no budget set" if budget <= 0 else f"projected {s.get('currency', '$')}{projected_month:.2f} of {s.get('currency', '$')}{budget:.2f}"},
        ]
        total = sum(p["score"] for p in parts)
        enough = tracked_s >= 3600
        grade = ("A" if total >= 85 else "B" if total >= 70 else "C" if total >= 55 else "D" if total >= 40 else "F") if enough else "?"

        summary = {
            "generated": now,
            "currency": s.get("currency", "$"),
            "rate_now": rate_now,
            "price_effective": price,
            "today": {"kwh": today.get("wh", 0) / 1000, "cost": today.get("cost", 0),
                      "co2_kg": today.get("wh", 0) / 1000 * co2_per_kwh,
                      "hours": (today.get("awake_seconds", 0)) / 3600},
            "month": {"kwh": month.get("wh", 0) / 1000, "cost": month.get("cost", 0),
                      "co2_kg": month.get("wh", 0) / 1000 * co2_per_kwh, "projected": projected_month,
                      "days_in_month": days_in_month, "budget": budget},
            "year": {"projected_cost": daily_cost * 365, "projected_kwh": daily_kwh * 365,
                     "projected_co2_kg": daily_kwh * 365 * co2_per_kwh},
            "all_time": {"kwh": all_time["wh"] / 1000, "cost": all_time["cost"],
                         "since": self.db.get_meta("installed_ts")},
            "averages": {"avg_w": avg_w, "awake_w": avg_awake_w, "idle_w": idle_w, "daily_kwh": daily_kwh,
                         "daily_cost": daily_cost, "tracked_hours_7d": tracked_s / 3600},
            "projection": projection,
            "waste": waste_out,
            "score": {"grade": grade, "points": round(total, 1), "parts": parts, "enough_data": enough},
            "streaks": streaks,
            "psu": {"rating": rating, "tier": ww.model.psu_tier, "typical_eff": eff_typ},
        }
        summary["tips"] = self.tips(summary)
        return summary

    # ------------------------------------------------------------------ tips
    def tips(self, sm: dict) -> list[dict]:
        s = self.settings
        cur = s.get("currency", "$")
        price = sm["price_effective"]
        tips = []
        proj = sm["projection"]
        laptop = self.ww.hw.is_laptop or self.ww.hw.is_apple_silicon
        nights = [n for n in sm["streaks"]["nights"][:7] if n["known"]]
        slept = sum(1 for n in nights if n["slept"])
        if proj["savings"]["cost"] > 0.5 and slept < max(1, len(nights)) * 0.7:
            tips.append({
                "id": "sleep-night", "impact": proj["savings"]["cost"], "action": "plan",
                "title": "Let it sleep at night",
                "text": f"Overnight your PC idles at ~{proj['idle_w']:.0f} W. Sleeping {proj['night_hours']} h a night "
                        f"would save about {cur}{proj['savings']['cost']:.0f}/yr ({proj['savings']['kwh']:.0f} kWh).",
            })
        idle_h_day = sm["waste"]["month"]["idle_hours"] / max(1, datetime.now().day)
        if idle_h_day > 1:
            save = idle_h_day * max(0, proj["idle_w"] - proj["sleep_w"]) / 1000 * 365 * price
            tips.append({
                "id": "auto-sleep", "impact": save, "action": "plan",
                "title": f"Auto-sleep after {s.get('idle_threshold_min', 15)} idle minutes",
                "text": f"It sits idle ~{idle_h_day:.1f} h a day. A shorter sleep timer could save ~{cur}{save:.0f}/yr.",
            })
        rating, eff = sm["psu"]["rating"], sm["psu"]["typical_eff"]
        awake_w = sm["averages"]["awake_w"]
        if not laptop and awake_w > 0 and eff < 0.86:
            dc = awake_w * eff
            better = psu.efficiency("platinum", dc / psu.pick_size(self.ww.model.peak_dc(), False))
            saved_w = awake_w - dc / better
            if saved_w > 1:
                save = saved_w * 8.76 * price
                tips.append({
                    "id": "psu", "impact": save, "action": None,
                    "title": "Your PSU is coasting in its least-efficient zone",
                    "text": f"At ~{dc / rating * 100:.0f}% load your {rating:.0f} W supply is only ~{eff * 100:.0f}% efficient - "
                            f"{awake_w - dc:.0f} W becomes heat. A right-sized Platinum unit would waste ~{saved_w:.0f} W less "
                            f"(~{cur}{save:.0f}/yr). Next upgrade, not today.",
                })
        live = self.ww.collector.latest or {}
        gpu_w = live.get("components", {}).get("gpu", 0)
        if live.get("measured", {}).get("gpu") and live.get("gpu_util", 1) < 0.1 and gpu_w > 25:
            tips.append({
                "id": "gpu-idle", "impact": (gpu_w - 12) * 8.76 * price * 0.5, "action": None,
                "title": f"GPU idles hot at {gpu_w:.0f} W",
                "text": "Multi-monitor setups and very high refresh rates often stop the GPU memory clock from "
                        "dropping. Try matching refresh rates or 60 Hz on secondary screens.",
            })
        if s.get("tou_enabled"):
            peak = max(s.get("tou_periods") or [{"rate": 0}], key=lambda p: p.get("rate", 0))
            cheap = min(s.get("tou_periods") or [{"rate": 0}], key=lambda p: p.get("rate", 0))
            if peak.get("rate", 0) > cheap.get("rate", 0):
                tips.append({
                    "id": "tou", "impact": 0.0, "action": None,
                    "title": f"Shift heavy jobs to {cheap.get('name', 'off-peak')}",
                    "text": f"Renders, game updates and backups cost {cur}{peak['rate']:.2f}/kWh during {peak.get('name')} "
                            f"vs {cur}{cheap['rate']:.2f} during {cheap.get('name')} ({cheap.get('start')}-{cheap.get('end')}).",
                })
        if sm["averages"]["idle_w"] > (20 if laptop else 80):
            tips.append({
                "id": "background", "impact": 0.0, "action": None,
                "title": "High idle draw",
                "text": "Check for background apps keeping the CPU/GPU awake (launchers, RGB software, miners, "
                        "browser tabs with video) and enable your OS's balanced power plan.",
            })
        if self.ww.model.calibration.n == 0 and not self.ww.plug.active:
            tips.append({
                "id": "calibrate", "impact": -1, "action": "calibrate",
                "title": "Make these numbers real",
                "text": "Plug your PC into a power meter (Kill-A-Watt, smart plug) and enter the reading once at idle "
                        "and once under load. WattWatch will fit its model to your hardware.",
            })
        tips.sort(key=lambda t: -t["impact"])
        return tips[:6]
