"""FastAPI server: JSON API + WebSocket live feed + the dashboard's static files."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, achievements, autostart, power, reports
from .app import WattWatch
from .config import validate_settings
from .facts import build_facts
from .sensors.model import COMPONENT_NAMES
from .sensors.smartplug import read_plug

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1", "testserver"}


def _host_ok(host_header: str | None) -> bool:
    if not host_header:
        return False
    host = host_header.rsplit(":", 1)[0] if not host_header.startswith("[") else host_header.split("]")[0] + "]"
    return host in LOCAL_HOSTS


def live_payload(ww: WattWatch) -> dict:
    s = ww.collector.latest
    if s is None:
        return {"ready": False}
    settings = ww.settings
    today = ww.collector.today()
    co2 = float(settings.get("co2_g_per_kwh", 0)) / 1000.0
    comps = []
    for key, w in s["components"].items():
        if w <= 0.05 and key not in ("cpu", "gpu", "ram"):
            continue
        comps.append({"id": key, "name": COMPONENT_NAMES.get(key, key.title()), "w": round(w, 2),
                      "measured": bool(s["measured"].get(key)) or s["source"] == "measured"})
    comps.sort(key=lambda c: -c["w"])
    return {
        "ready": True,
        "ts": s["ts"],
        "wall_w": round(s["wall_w"], 2),
        "system_w": round(s["system_w"], 2),
        "dc_w": round(s["dc_w"], 2),
        "loss_w": round(s["loss_w"], 2),
        "psu_eff": round(s["psu_eff"], 4),
        "psu_rating": s["psu_rating"],
        "psu_tier": s["psu_tier"],
        "components": comps,
        "source": s["source"],
        "cpu_util": round(s["cpu_util"], 3),
        "gpu_util": round(s["gpu_util"], 3),
        "on_battery": s["on_battery"],
        "charging": s["charging"],
        "battery_pct": s["battery_pct"],
        "rate": s["rate"],
        "rate_name": s["rate_name"],
        "cost_per_hour": s["cost_per_hour"],
        "currency": settings.get("currency", "$"),
        "peak_w": round(ww.model.peak_wall(), 1),
        "raw_w": round(s["raw_wall_w"], 2),
        "idle": {"seconds": round(s["idle_s"]), "method": s["idle_method"], "is_idle": s["is_idle"],
                 "threshold_s": int(settings.get("idle_threshold_min", 15)) * 60,
                 "since": ww.collector.idle_since, "last": ww.collector.last_idle,
                 "sleep_w": float(settings.get("sleep_watts", 2.0))},
        "today": {
            "kwh": today.get("wh", 0) / 1000.0,
            "cost": today.get("cost", 0),
            "co2_kg": today.get("wh", 0) / 1000.0 * co2,
            "loss_kwh": today.get("loss_wh", 0) / 1000.0,
            "idle_kwh": today.get("idle_wh", 0) / 1000.0,
        },
        "plug": {"active": ww.plug.active, "watts": s["plug_w"], "error": ww.plug.error},
        "calibration": {"points": ww.model.calibration.n, "a": ww.model.calibration.a, "b": ww.model.calibration.b},
    }


def create_app(ww: WattWatch) -> FastAPI:
    app = FastAPI(title="WattWatch", version=__version__, docs_url=None, redoc_url=None)
    app.state.ww = ww

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # DNS-rebinding guard: only answer to localhost names.
        if not _host_ok(request.headers.get("host")):
            return JSONResponse({"error": "WattWatch only serves localhost"}, status_code=403)
        # CSRF guard: state-changing requests need our per-launch token in a custom header,
        # which other websites cannot send without a CORS preflight we never approve.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("x-wattwatch-token") != ww.token:
                return JSONResponse({"error": "missing or invalid token"}, status_code=403)
        return await call_next(request)

    # ------------------------------------------------------------------ pages
    @app.get("/", response_class=HTMLResponse)
    async def index():
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        return HTMLResponse(html.replace("{{WW_TOKEN}}", ww.token).replace("{{WW_VERSION}}", __version__),
                            headers={"Cache-Control": "no-store"})

    # ------------------------------------------------------------------ live
    @app.get("/api/live")
    async def api_live():
        return live_payload(ww)

    @app.get("/api/live/history")
    async def api_live_history(seconds: int = 300):
        return {"points": ww.collector.history(max(10, min(seconds, 900)))}

    @app.websocket("/ws")
    async def ws_live(websocket: WebSocket):
        origin = websocket.headers.get("origin", "")
        if origin and not any(origin.startswith(f"{p}://{h}") for p in ("http", "https")
                              for h in ("127.0.0.1", "localhost", "[::1]")):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        try:
            while True:
                await websocket.send_json(live_payload(ww))
                await asyncio.sleep(1.0)
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception:
            log.debug("websocket closed", exc_info=True)

    # ------------------------------------------------------------------ settings
    @app.get("/api/settings")
    async def get_settings():
        return ww.settings

    @app.post("/api/settings")
    async def post_settings(request: Request):
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "expected a JSON object")
        return ww.update_settings(body)

    @app.get("/api/system")
    async def system():
        m = ww.model
        return {
            "version": __version__,
            "hardware": ww.hw.to_dict(),
            "cpu_tdp": m.tdp,
            "psu_rating": m.psu_rating,
            "psu_tier": m.psu_tier,
            "peak_wall": round(m.peak_wall(), 1),
            "sensors": {
                "cpu": "rapl" if (m.rapl and m.rapl.available) else "powermetrics" if (m.pm and m.pm.available)
                else "librehardwaremonitor" if m.lhm.url else "model",
                "gpu": "nvml" if m.nvml.available else "amdgpu-sysfs" if m.amd.available
                else "powermetrics" if (m.pm and m.pm.available) else "model",
                "idle": ww.collector.idle.method,
                "smartplug": ww.settings.get("smartplug", {}).get("type", "none"),
            },
            "data_dir": str(ww.data_dir),
        }

    # ------------------------------------------------------------------ history & analytics
    @app.get("/api/history")
    async def history(range: str = "24h"):  # noqa: A002 - query param name
        return await asyncio.to_thread(ww.analytics.history, range)

    @app.get("/api/heatmap")
    async def heatmap(days: int = 7):
        return await asyncio.to_thread(ww.analytics.heatmap, days)

    @app.get("/api/breakdown")
    async def breakdown(range: str = "today"):  # noqa: A002
        return await asyncio.to_thread(ww.analytics.breakdown, range)

    @app.get("/api/daily")
    async def daily(days: int = 14):
        return {"days": await asyncio.to_thread(ww.analytics.daily, max(1, min(days, 120)))}

    @app.get("/api/summary")
    async def summary():
        return await asyncio.to_thread(ww.analytics.summary)

    @app.get("/api/facts")
    async def facts():
        sm = await asyncio.to_thread(ww.analytics.summary)
        return {"facts": build_facts(sm, ww.collector.latest)}

    @app.get("/api/achievements")
    async def get_achievements():
        def run():
            sm = ww.analytics.summary()
            return {"achievements": achievements.evaluate(ww, sm), "streaks": sm["streaks"]}
        return await asyncio.to_thread(run)

    @app.get("/api/events")
    async def events(since: int = 0):
        if since <= 0:
            recent = ww.db.recent_events(1)
            return {"events": [], "last_id": recent[0]["id"] if recent else 0}
        evs = ww.db.events_since(since)
        return {"events": evs, "last_id": evs[-1]["id"] if evs else since}

    # ------------------------------------------------------------------ calibration & smart plug
    @app.get("/api/calibration")
    async def calibration():
        rows = ww.db.query("SELECT * FROM calibration ORDER BY id DESC LIMIT 60")
        c = ww.model.calibration
        return {"points": [dict(r) for r in rows], "a": c.a, "b": c.b, "active": c.active}

    @app.post("/api/calibrate")
    async def calibrate(request: Request):
        body = await request.json()
        try:
            measured = float(body.get("measured_w"))
        except (TypeError, ValueError):
            raise HTTPException(400, "measured_w must be a number") from None
        if not 0.5 <= measured <= 5000:
            raise HTTPException(400, "That reading looks off - enter the watts shown on your meter.")
        try:
            point = ww.add_calibration(measured)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        ww.analytics._cache.clear()
        return {"ok": True, "point": point, "a": ww.model.calibration.a, "b": ww.model.calibration.b}

    @app.delete("/api/calibration")
    async def clear_calibration():
        ww.clear_calibration()
        return {"ok": True}

    @app.post("/api/smartplug/test")
    async def smartplug_test(request: Request):
        body = await request.json()
        cfg = validate_settings({"smartplug": body}, ww.settings)["smartplug"]
        try:
            watts = await asyncio.to_thread(read_plug, cfg)
            return {"ok": True, "watts": watts}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}

    # ------------------------------------------------------------------ power actions
    @app.post("/api/power/plan")
    async def power_plan(request: Request):
        body = await request.json()
        res = await asyncio.to_thread(power.apply_power_plan, body.get("sleep_min", 30), body.get("display_min", 10))
        if res["ok"]:
            ww.db.add_event("plan", "Power plan applied", res["message"])
        return res

    @app.post("/api/power/sleep")
    async def power_sleep():
        return await asyncio.to_thread(power.sleep_now)

    @app.get("/api/autostart")
    async def get_autostart():
        try:
            return {"enabled": autostart.is_enabled()}
        except Exception as exc:
            return {"enabled": False, "error": str(exc)}

    # ------------------------------------------------------------------ reports
    @app.get("/api/report/weekly")
    async def report_weekly():
        return await asyncio.to_thread(reports.weekly, ww)

    @app.get("/report/weekly", response_class=HTMLResponse)
    async def report_weekly_html():
        return HTMLResponse(await asyncio.to_thread(reports.weekly_html, ww))

    @app.get("/api/export.csv")
    async def export(granularity: str = "hour", days: int = 30):
        text = await asyncio.to_thread(reports.export_csv, ww, granularity, days)
        name = f"wattwatch-{granularity}-{datetime.now():%Y%m%d}.csv"
        return Response(text, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/favicon.ico")
    async def favicon():
        return Response((STATIC / "img" / "icon.svg").read_bytes(), media_type="image/svg+xml")

    return app
