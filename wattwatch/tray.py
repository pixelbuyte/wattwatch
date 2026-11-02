"""System-tray icon: a tiny glowing orb that changes colour with wattage, plus a quick menu."""

from __future__ import annotations

import logging
import os
import sys
import threading
import webbrowser

log = logging.getLogger(__name__)

# fraction-of-peak -> RGB, mirrors the dashboard orb palette
STOPS = [(0.0, (61, 255, 160)), (0.15, (34, 240, 255)), (0.35, (60, 140, 255)), (0.55, (170, 90, 255)),
         (0.75, (255, 61, 242)), (0.9, (255, 140, 40)), (1.0, (255, 50, 70))]


def load_color(f: float) -> tuple[int, int, int]:
    f = max(0.0, min(1.0, f))
    for (x0, c0), (x1, c1) in zip(STOPS, STOPS[1:]):
        if x0 <= f <= x1:
            t = (f - x0) / (x1 - x0)
            return tuple(int(a + (b - a) * t) for a, b in zip(c0, c1))  # type: ignore[return-value]
    return STOPS[-1][1]


def make_icon(fraction: float, size: int = 64):
    from PIL import Image, ImageDraw, ImageFilter

    color = load_color(fraction)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((4, 4, size - 4, size - 4), fill=color + (190,))
    glow = glow.filter(ImageFilter.GaussianBlur(size / 12))
    img.alpha_composite(glow)
    d = ImageDraw.Draw(img)
    pad = size * 0.16
    d.ellipse((pad, pad, size - pad, size - pad), fill=(8, 10, 24, 255), outline=color + (255,), width=max(2, size // 16))
    s = size / 64.0
    bolt = [(36, 12), (20, 36), (31, 36), (27, 52), (44, 27), (33, 27), (36, 12)]
    d.polygon([(x * s, y * s) for x, y in bolt], fill=color + (255,))
    return img


def run_tray(ww, url: str, on_quit) -> bool:
    """Run the tray loop on the calling (main) thread. Returns False if no tray is possible."""
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        log.info("No display - running without a tray icon")
        return False
    try:
        import pystray
    except Exception as exc:
        log.info("pystray unavailable (%s) - running without a tray icon", exc)
        return False

    def snapshot():
        s = ww.collector.latest or {}
        today = ww.collector.today()
        return s, today, ww.settings.get("currency", "$")

    def line_now(_item=None):
        s, _, cur = snapshot()
        return f"⚡ {s.get('wall_w', 0):.0f} W now  ·  {cur}{s.get('cost_per_hour', 0):.3f}/h"

    def line_today(_item=None):
        _, t, cur = snapshot()
        return f"Today: {cur}{t.get('cost', 0):.2f}  ·  {t.get('wh', 0) / 1000:.2f} kWh"

    def open_dash(icon=None, item=None):
        webbrowser.open(url)

    def open_report(icon=None, item=None):
        webbrowser.open(url + "report/weekly")

    def sleep_now(icon=None, item=None):
        from .power import sleep_now as _sleep
        _sleep()

    def quit_app(icon, item=None):
        on_quit()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(line_now, None, enabled=False),
        pystray.MenuItem(line_today, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open dashboard", open_dash, default=True),
        pystray.MenuItem("Weekly report", open_report),
        pystray.MenuItem("Sleep now", sleep_now),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit WattWatch", quit_app),
    )
    try:
        icon = pystray.Icon("WattWatch", make_icon(0.1), "WattWatch", menu)
    except Exception as exc:
        log.info("Tray icon could not be created (%s)", exc)
        return False
    ww.notifier.tray_icon = icon
    stop = threading.Event()

    def refresh():
        last_bucket = -1
        while not stop.wait(5):
            s = ww.collector.latest or {}
            peak = max(ww.model.peak_wall(), 1.0)
            frac = s.get("wall_w", 0) / peak
            bucket = int(frac * 20)
            try:
                if bucket != last_bucket:
                    icon.icon = make_icon(frac)
                    last_bucket = bucket
                icon.title = f"WattWatch - {s.get('wall_w', 0):.0f} W"
                icon.update_menu()
            except Exception:
                pass

    threading.Thread(target=refresh, daemon=True, name="tray-refresh").start()
    try:
        icon.run()
    except Exception as exc:
        log.info("Tray loop failed (%s) - continuing without it", exc)
        stop.set()
        return False
    stop.set()
    return True
