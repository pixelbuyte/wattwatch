"""Seconds since the last keyboard/mouse input, per platform, with graceful fallbacks."""

from __future__ import annotations

import ctypes
import ctypes.util
import logging
import re
import shutil
import subprocess
import sys
import time

log = logging.getLogger(__name__)


class IdleDetector:
    def __init__(self):
        self.method = "none"
        self._fn = None
        self._cache = (0.0, None)
        if sys.platform.startswith("win"):
            self._setup_windows()
        elif sys.platform == "darwin":
            self._fn, self.method = self._macos, "ioreg"
        else:
            self._setup_linux()

    # ---------------------------------------------------------------- windows
    def _setup_windows(self):
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        def fn():
            lii = LASTINPUTINFO()
            lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
            if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):  # type: ignore[attr-defined]
                return None
            millis = ctypes.windll.kernel32.GetTickCount() - lii.dwTime  # type: ignore[attr-defined]
            return (millis & 0xFFFFFFFF) / 1000.0

        self._fn, self.method = fn, "win32"

    # ---------------------------------------------------------------- macOS
    @staticmethod
    def _macos():
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True, timeout=3)
        m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out.stdout)
        return int(m.group(1)) / 1e9 if m else None

    # ---------------------------------------------------------------- linux
    def _setup_linux(self):
        lib_x11 = ctypes.util.find_library("X11")
        lib_xss = ctypes.util.find_library("Xss")
        if lib_x11 and lib_xss:
            try:
                x11 = ctypes.cdll.LoadLibrary(lib_x11)
                xss = ctypes.cdll.LoadLibrary(lib_xss)
                x11.XOpenDisplay.restype = ctypes.c_void_p
                x11.XDefaultRootWindow.restype = ctypes.c_ulong
                x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]

                class XScreenSaverInfo(ctypes.Structure):
                    _fields_ = [("window", ctypes.c_ulong), ("state", ctypes.c_int), ("kind", ctypes.c_int),
                                ("since", ctypes.c_ulong), ("idle", ctypes.c_ulong), ("event_mask", ctypes.c_ulong)]

                xss.XScreenSaverAllocInfo.restype = ctypes.POINTER(XScreenSaverInfo)
                xss.XScreenSaverQueryInfo.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XScreenSaverInfo)]
                display = x11.XOpenDisplay(None)
                if display:
                    root = x11.XDefaultRootWindow(display)
                    info = xss.XScreenSaverAllocInfo()

                    def fn():
                        if not xss.XScreenSaverQueryInfo(display, root, info):
                            return None
                        return info.contents.idle / 1000.0

                    if fn() is not None:
                        self._fn, self.method = fn, "x11"
                        return
            except Exception as exc:
                log.debug("XScreenSaver unavailable: %s", exc)
        if shutil.which("gdbus"):
            def gnome():
                out = subprocess.run(
                    ["gdbus", "call", "--session", "--dest", "org.gnome.Mutter.IdleMonitor",
                     "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
                     "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"],
                    capture_output=True, text=True, timeout=3)
                m = re.search(r"uint64 (\d+)", out.stdout)
                return int(m.group(1)) / 1000.0 if m else None
            try:
                if gnome() is not None:
                    self._fn, self.method = gnome, "gnome-mutter"
                    return
            except Exception:
                pass
        if shutil.which("xprintidle"):
            def xpi():
                out = subprocess.run(["xprintidle"], capture_output=True, text=True, timeout=3)
                return int(out.stdout.strip()) / 1000.0
            try:
                xpi()
                self._fn, self.method = xpi, "xprintidle"
                return
            except Exception:
                pass
        self.method = "cpu-heuristic"

    # ---------------------------------------------------------------- public
    def seconds(self) -> float | None:
        """Idle seconds, or None if this platform has no input-idle source (use CPU heuristic)."""
        if self._fn is None:
            return None
        now = time.monotonic()
        # subprocess-based methods are polled at most every 5 s
        if self.method in ("ioreg", "gnome-mutter", "xprintidle") and now - self._cache[0] < 5 and self._cache[1] is not None:
            return self._cache[1] + (now - self._cache[0])
        try:
            val = self._fn()
        except Exception:
            val = None
        self._cache = (now, val)
        return val
