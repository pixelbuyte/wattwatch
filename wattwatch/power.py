"""OS power controls: sleep now, and a one-click "sensible power plan"."""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys

log = logging.getLogger(__name__)

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run(cmd: list[str], timeout: int = 20) -> tuple[bool, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)
        out = (p.stdout + p.stderr).strip()
        return p.returncode == 0, out
    except Exception as exc:
        return False, str(exc)


def plan_commands(sleep_min: int, display_min: int) -> tuple[str, list[list[str]]]:
    """Return (description, commands) that apply the plan on this OS (while plugged in)."""
    if sys.platform.startswith("win"):
        return "Windows power options (on AC power)", [
            ["powercfg", "/setactive", "381b4222-f694-41f0-9685-ff5bb260df2e"],  # Balanced
            ["powercfg", "/change", "monitor-timeout-ac", str(display_min)],
            ["powercfg", "/change", "standby-timeout-ac", str(sleep_min)],
        ]
    if sys.platform == "darwin":
        script = f"do shell script \"pmset -c displaysleep {display_min} sleep {sleep_min}\" with administrator privileges"
        return "macOS Energy settings (charger) - you'll be asked for your password", [["osascript", "-e", script]]
    if shutil.which("gsettings"):
        schema = "org.gnome.settings-daemon.plugins.power"
        return "GNOME power settings (plugged in)", [
            ["gsettings", "set", schema, "sleep-inactive-ac-type", "suspend"],
            ["gsettings", "set", schema, "sleep-inactive-ac-timeout", str(sleep_min * 60)],
            ["gsettings", "set", "org.gnome.desktop.session", "idle-delay", str(display_min * 60)],
        ]
    if shutil.which("kwriteconfig6") or shutil.which("kwriteconfig5"):
        kw = shutil.which("kwriteconfig6") or shutil.which("kwriteconfig5")
        return "KDE Plasma power management (AC profile)", [
            [kw, "--file", "powermanagementprofilesrc", "--group", "AC", "--group", "SuspendSession",
             "--key", "idleTime", str(sleep_min * 60 * 1000)],
            [kw, "--file", "powermanagementprofilesrc", "--group", "AC", "--group", "SuspendSession",
             "--key", "suspendType", "1"],
            [kw, "--file", "powermanagementprofilesrc", "--group", "AC", "--group", "DPMSControl",
             "--key", "idleTime", str(display_min * 60)],
        ]
    return "", []


def apply_power_plan(sleep_min: int = 30, display_min: int = 10) -> dict:
    sleep_min = max(1, min(int(sleep_min), 600))
    display_min = max(1, min(int(display_min), 600))
    desc, cmds = plan_commands(sleep_min, display_min)
    if not cmds:
        return {"ok": False, "message": "Couldn't find a power-settings tool on this system. "
                                        f"Set 'sleep after {sleep_min} min' in your desktop's power settings."}
    errors = []
    for cmd in cmds:
        ok, out = _run(cmd, timeout=120)
        if not ok:
            errors.append(f"{' '.join(cmd[:3])}…: {out[:160]}")
    if errors:
        return {"ok": False, "message": "Some settings could not be applied: " + "; ".join(errors)}
    return {"ok": True, "message": f"Applied: display off after {display_min} min, sleep after {sleep_min} min ({desc})."}


def sleep_now() -> dict:
    if sys.platform.startswith("win"):
        # SetSuspendState(hibernate=False, force=True, disableWakeEvents=False)
        import ctypes
        try:
            ok = ctypes.windll.powrprof.SetSuspendState(False, True, False)  # type: ignore[attr-defined]
            return {"ok": bool(ok), "message": "Going to sleep…" if ok else "Windows refused to sleep."}
        except Exception as exc:
            return {"ok": False, "message": str(exc)}
    if sys.platform == "darwin":
        ok, out = _run(["pmset", "sleepnow"])
    elif shutil.which("systemctl"):
        ok, out = _run(["systemctl", "suspend"])
    elif shutil.which("loginctl"):
        ok, out = _run(["loginctl", "suspend"])
    else:
        ok, out = False, "no suspend command found"
    return {"ok": ok, "message": "Going to sleep…" if ok else f"Couldn't sleep: {out[:200]}"}
