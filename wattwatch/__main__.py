"""Entry point: `python -m wattwatch`."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser

from . import APP_NAME, __version__
from .config import DEFAULT_PORT


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/system", timeout=1.5) as resp:
            return "hardware" in json.loads(resp.read())
    except Exception:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wattwatch", description=f"{APP_NAME} - what your always-on PC really costs")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WATTWATCH_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-tray", action="store_true", help="don't show a system tray icon")
    parser.add_argument("--no-browser", action="store_true", help="don't open the dashboard on start")
    parser.add_argument("--data-dir", help="where to keep wattwatch.db (default: per-user app data)")
    parser.add_argument("--demo", action="store_true",
                        help="use a throwaway database pre-filled with 3 weeks of sample history")
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    url = f"http://127.0.0.1:{args.port}/"

    if _already_running(args.port):
        print(f"{APP_NAME} is already running - opening {url}")
        webbrowser.open(url)
        return 0

    if args.data_dir:
        os.environ["WATTWATCH_DATA_DIR"] = args.data_dir
    db_path = None
    if args.demo:
        import tempfile

        from .demo import seed_demo
        demo_dir = tempfile.mkdtemp(prefix="wattwatch-demo-")
        os.environ.setdefault("WATTWATCH_DATA_DIR", demo_dir)
        db_path = os.path.join(demo_dir, "demo.db")
        seed_demo(db_path)
        print(f"Demo mode: sample history written to {db_path}")

    import uvicorn

    from .app import WattWatch
    from .server import create_app

    ww = WattWatch(db_path=db_path, start=False)
    ww.notifier.muted = args.demo
    ww.collector.start()
    app = create_app(ww)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    server_thread.start()

    for _ in range(100):  # wait until the port is bound
        if server.started:
            break
        time.sleep(0.05)
    print(f"{APP_NAME} {__version__} running at {url}  (Ctrl+C to quit)")
    if not args.no_browser:
        webbrowser.open(url)

    def stop():
        server.should_exit = True

    try:
        tray_ran = False
        if not args.no_tray:
            from .tray import run_tray
            tray_ran = run_tray(ww, url, on_quit=stop)  # blocks on the main thread until Quit
        if not tray_ran:
            while server_thread.is_alive():
                server_thread.join(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop()
        server_thread.join(timeout=5)
        ww.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
