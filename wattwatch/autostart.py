"""Start WattWatch when you log in (it can only count what it sees while running)."""

from __future__ import annotations

import os
import plistlib
import sys
from pathlib import Path

LABEL = "app.wattwatch"


def _command() -> list[str]:
    exe = sys.executable
    if sys.platform.startswith("win"):
        pyw = Path(exe).with_name("pythonw.exe")
        if pyw.exists():
            exe = str(pyw)
    return [exe, "-m", "wattwatch", "--no-browser"]


def _linux_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "autostart" / "wattwatch.desktop"


def _mac_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def is_enabled() -> bool:
    if sys.platform.startswith("win"):
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as k:
                winreg.QueryValueEx(k, "WattWatch")
                return True
        except OSError:
            return False
    if sys.platform == "darwin":
        return _mac_path().exists()
    return _linux_path().exists()


def set_enabled(enabled: bool) -> bool:
    cmd = _command()
    if sys.platform.startswith("win"):
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_SET_VALUE) as k:
            if enabled:
                winreg.SetValueEx(k, "WattWatch", 0, winreg.REG_SZ, " ".join(f'"{c}"' if " " in c else c for c in cmd))
            else:
                try:
                    winreg.DeleteValue(k, "WattWatch")
                except OSError:
                    pass
    elif sys.platform == "darwin":
        p = _mac_path()
        if enabled:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "wb") as fh:
                plistlib.dump({"Label": LABEL, "ProgramArguments": cmd, "RunAtLoad": True,
                               "KeepAlive": False, "ProcessType": "Interactive"}, fh)
        elif p.exists():
            p.unlink()
    else:
        p = _linux_path()
        if enabled:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("[Desktop Entry]\nType=Application\nName=WattWatch\n"
                         "Comment=See what your always-on PC really costs\n"
                         f"Exec={' '.join(cmd)}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n")
        elif p.exists():
            p.unlink()
    return is_enabled()
