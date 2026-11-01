"""Weekly report (JSON + printable HTML) and CSV export."""

from __future__ import annotations

import csv
import html
import io
import time
from datetime import datetime, timezone

from .collector import local_midnight


def _sum(days: list[dict], key: str) -> float:
    return sum(d[key] for d in days)


def weekly(ww) -> dict:
    an = ww.analytics
    s = ww.settings
    co2 = float(s.get("co2_g_per_kwh", 0)) / 1000
    days = an.daily(14)
    prev, cur = days[:7], days[7:]

    def totals(ds):
        wh = _sum(ds, "wh")
        secs = _sum(ds, "seconds")
        return {"kwh": wh / 1000, "cost": _sum(ds, "cost"), "co2_kg": wh / 1000 * co2,
                "avg_w": wh * 3600 / secs if secs else 0.0, "peak_w": max((d["peak_w"] for d in ds), default=0),
                "idle_hours": _sum(ds, "idle_seconds") / 3600, "idle_kwh": _sum(ds, "idle_wh") / 1000,
                "loss_kwh": _sum(ds, "loss_wh") / 1000, "tracked_hours": secs / 3600}

    t, p = totals(cur), totals(prev)

    def pct(a, b):
        return (a - b) / b * 100 if b > 0.0001 else None

    tracked = [d for d in cur if d["seconds"] > 3600]
    best = min(tracked, key=lambda d: d["wh"], default=None)
    worst = max(tracked, key=lambda d: d["wh"], default=None)
    sm = an.summary()
    breakdown = an.breakdown("7d")
    cursym = s.get("currency", "$")
    highlights = []
    if t["kwh"] > 0:
        change = pct(t["kwh"], p["kwh"])
        if change is not None:
            highlights.append(f"Energy is {'down' if change < 0 else 'up'} {abs(change):.0f}% on the previous week.")
        if worst:
            highlights.append(f"Hungriest day: {datetime.fromisoformat(worst['date']).strftime('%A')} "
                              f"({worst['wh'] / 1000:.2f} kWh, {cursym}{worst['cost']:.2f}).")
        if t["idle_kwh"] > 0:
            highlights.append(f"{t['idle_kwh'] / t['kwh'] * 100:.0f}% of the week's energy was spent idling "
                              f"({t['idle_hours']:.0f} h).")
        if breakdown["components"]:
            top = breakdown["components"][0]
            highlights.append(f"Biggest consumer: {top['name']} at ~{top['w']:.0f} W on average.")
        st = sm["streaks"]
        if st["sleep_nights"]:
            highlights.append(f"Current sleep streak: {st['sleep_nights']} night{'s' if st['sleep_nights'] != 1 else ''}. 🌙")
    ww.db.set_meta("report_opened", True)
    return {
        "generated": time.time(), "currency": cursym,
        "period": {"start": cur[0]["date"], "end": cur[-1]["date"]},
        "totals": t, "previous": p,
        "change": {k: pct(t[k], p[k]) for k in ("kwh", "cost", "avg_w", "idle_hours")},
        "days": cur, "best_day": best, "worst_day": worst,
        "breakdown": breakdown["components"], "grade": sm["score"]["grade"], "score": sm["score"]["points"],
        "projected_year_cost": sm["year"]["projected_cost"], "tips": sm["tips"][:3], "highlights": highlights,
    }


def weekly_html(ww) -> str:
    r = weekly(ww)
    cur = r["currency"]
    t = r["totals"]
    e = html.escape
    maxkwh = max((d["wh"] / 1000 for d in r["days"]), default=0) or 1
    bars = []
    for i, d in enumerate(r["days"]):
        kwh = d["wh"] / 1000
        h = 150 * kwh / maxkwh
        x = 20 + i * 90
        label = datetime.fromisoformat(d["date"]).strftime("%a")
        bars.append(f'<rect x="{x}" y="{170 - h:.1f}" width="56" height="{h:.1f}" rx="6" fill="url(#bar)"/>'
                    f'<text x="{x + 28}" y="190" text-anchor="middle" class="ax">{label}</text>'
                    f'<text x="{x + 28}" y="{164 - h:.1f}" text-anchor="middle" class="val">{kwh:.2f}</text>')

    def chg(k):
        v = r["change"].get(k)
        if v is None:
            return '<span class="flat">new</span>'
        cls = "down" if v < 0 else "up"
        return f'<span class="{cls}">{"▼" if v < 0 else "▲"} {abs(v):.0f}%</span>'

    rows = "".join(
        f"<tr><td>{datetime.fromisoformat(d['date']).strftime('%a %d %b')}</td><td>{d['wh'] / 1000:.2f}</td>"
        f"<td>{cur}{d['cost']:.2f}</td><td>{d['avg_w']:.0f} W</td><td>{d['peak_w']:.0f} W</td>"
        f"<td>{d['idle_seconds'] / 3600:.1f} h</td></tr>" for d in r["days"])
    comps = "".join(f"<li><b>{e(c['name'])}</b> {c['w']:.0f} W</li>" for c in r["breakdown"][:6])
    highlights = "".join(f"<li>{e(h)}</li>" for h in r["highlights"]) or "<li>Not much data yet - check back in a few days.</li>"
    tips = "".join(f"<li><b>{e(tp['title'])}</b> - {e(tp['text'])}</li>" for tp in r["tips"])
    start = datetime.fromisoformat(r["period"]["start"]).strftime("%d %b")
    end = datetime.fromisoformat(r["period"]["end"]).strftime("%d %b %Y")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>WattWatch weekly report</title>
<link rel="icon" href="/static/img/icon.svg">
<style>
:root{{--bg:#05060f;--panel:#0d1128;--b:rgba(120,140,255,.18);--t:#e8ecff;--d:#9aa3c7;--c:#22f0ff;--m:#ff3df2;--l:#3dffa0;--r:#ff5a6e}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 "Segoe UI",-apple-system,Roboto,sans-serif}}
main{{max-width:900px;margin:0 auto;padding:36px 20px 60px}}h1{{margin:0;font-size:30px}}h1 b{{color:var(--c);text-shadow:0 0 14px rgba(34,240,255,.5)}}
.sub{{color:var(--d);margin:4px 0 26px}}.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
.card{{background:var(--panel);border:1px solid var(--b);border-radius:14px;padding:16px 18px}}
.k{{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--d)}}.v{{font-size:26px;font-weight:700;margin-top:2px}}
.up{{color:var(--r)}}.down{{color:var(--l)}}.flat{{color:var(--d)}}h2{{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--d);margin:28px 0 10px}}
svg{{width:100%;height:auto}}.ax{{fill:#9aa3c7;font-size:12px}}.val{{fill:#e8ecff;font-size:11px}}
table{{width:100%;border-collapse:collapse}}td,th{{text-align:left;padding:8px 6px;border-bottom:1px solid var(--b);font-variant-numeric:tabular-nums}}
th{{color:var(--d);font-weight:500;font-size:12px;letter-spacing:.08em;text-transform:uppercase}}ul{{padding-left:20px}}li{{margin:6px 0}}
.grade{{font-size:44px;font-weight:800;color:var(--l);text-shadow:0 0 18px rgba(61,255,160,.5)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}.foot{{color:var(--d);font-size:12px;margin-top:30px}}
@media(max-width:700px){{.grid{{grid-template-columns:1fr 1fr}}.two{{grid-template-columns:1fr}}}}
@media print{{body{{background:#fff;color:#000}}.card{{background:#fff;border-color:#ccc}}.ax,.val{{fill:#333}}}}
</style></head><body><main>
<h1>Watt<b>Watch</b> weekly report</h1><div class="sub">{start} – {end} · estimates, not a utility bill</div>
<div class="grid">
<div class="card"><div class="k">Energy</div><div class="v">{t['kwh']:.2f} kWh</div>{chg('kwh')}</div>
<div class="card"><div class="k">Cost</div><div class="v">{cur}{t['cost']:.2f}</div>{chg('cost')}</div>
<div class="card"><div class="k">Average draw</div><div class="v">{t['avg_w']:.0f} W</div>{chg('avg_w')}</div>
<div class="card"><div class="k">Grade</div><div class="grade">{e(r['grade'])}</div></div>
</div>
<h2>Daily energy (kWh)</h2>
<div class="card"><svg viewBox="0 0 660 200"><defs><linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#22f0ff"/><stop offset="1" stop-color="#aa5aff"/></linearGradient></defs>{''.join(bars)}</svg></div>
<div class="two"><div><h2>Highlights</h2><div class="card"><ul>{highlights}</ul></div></div>
<div><h2>Where the watts went</h2><div class="card"><ul>{comps or '<li>No data yet</li>'}</ul></div></div></div>
<h2>Day by day</h2><div class="card"><table><tr><th>Day</th><th>kWh</th><th>Cost</th><th>Avg</th><th>Peak</th><th>Idle</th></tr>{rows}</table></div>
<h2>Tips</h2><div class="card"><ul>{tips or '<li>Nothing to fix - nice.</li>'}</ul></div>
<div class="sub" style="margin-top:20px">CO₂ this week: {t['co2_kg']:.2f} kg · PSU heat loss: {t['loss_kwh']:.2f} kWh ·
Projected yearly cost: {cur}{r['projected_year_cost']:.0f}</div>
<div class="foot">Generated by WattWatch on {datetime.now().strftime('%Y-%m-%d %H:%M')}. Values are software estimates unless calibrated or measured by a smart plug.</div>
</main></body></html>"""


def export_csv(ww, granularity: str = "hour", days: int = 30) -> str:
    days = max(1, min(int(days), 3650))
    step = {"minute": 60, "hour": 3600, "day": 86400}.get(granularity, 3600)
    start = local_midnight() - (days - 1) * 86400
    co2 = float(ww.settings.get("co2_g_per_kwh", 0)) / 1000
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp_local", "timestamp_utc", "kwh", "cost", "avg_watts", "max_watts", "idle_kwh",
                "psu_loss_kwh", "co2_kg", "tracked_seconds", "source"])
    if step == 60:
        rows = ww.db.query("SELECT ts, wh, cost, avg_w, max_w, idle_wh, loss_wh, seconds, source FROM minutes "
                           "WHERE ts >= ? ORDER BY ts", (int(start),))
        for r in rows:
            w.writerow(_line(r["ts"], r["wh"], r["cost"], r["avg_w"], r["max_w"], r["idle_wh"], r["loss_wh"],
                             r["seconds"], co2, r["source"]))
    else:
        # group in local time so days start at local midnight
        acc: dict[float, list] = {}
        for r in ww.analytics._quarters(start):
            dt = datetime.fromtimestamp(r["q"])
            key = dt.replace(minute=0, second=0, microsecond=0) if step == 3600 else dt.replace(hour=0, minute=0, second=0, microsecond=0)
            a = acc.setdefault(key.timestamp(), [0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            a[0] += r["wh"]
            a[1] += r["cost"]
            a[2] = max(a[2], r["mx"] or 0)
            a[3] += r["idle_wh"]
            a[4] += r["loss_wh"]
            a[5] += r["s"]
        for ts in sorted(acc):
            wh, cost, mx, idle, loss, secs = acc[ts]
            w.writerow(_line(ts, wh, cost, wh * 3600 / secs if secs else 0, mx, idle, loss, secs, co2, ""))
    ww.db.set_meta("exported", True)
    return buf.getvalue()


def _line(ts, wh, cost, avg, mx, idle, loss, secs, co2, source):
    return [datetime.fromtimestamp(ts).isoformat(timespec="minutes"),
            datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="minutes"),
            f"{wh / 1000:.5f}", f"{cost:.5f}", f"{avg or 0:.2f}", f"{mx or 0:.2f}", f"{idle / 1000:.5f}",
            f"{loss / 1000:.5f}", f"{wh / 1000 * co2:.5f}", f"{secs:.0f}", source]
