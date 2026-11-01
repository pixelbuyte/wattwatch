"""Desktop notifications with a fallback chain: tray balloon -> OS command -> log only."""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys

log = logging.getLogger(__name__)


class Notifier:
    def __init__(self):
        self.tray_icon = None  # set by tray.py when a tray is running

    def notify(self, title: str, message: str) -> None:
        log.info("notify: %s - %s", title, message)
        if self.tray_icon is not None and sys.platform.startswith("win"):
            try:
                self.tray_icon.notify(message, title)
                return
            except Exception:
                pass
        try:
            if sys.platform == "darwin":
                script = f'display notification {_q(message)} with title {_q(title)}'
                subprocess.Popen(["osascript", "-e", script])
            elif sys.platform.startswith("linux") and shutil.which("notify-send"):
                subprocess.Popen(["notify-send", "-a", "WattWatch", title, message])
            elif sys.platform.startswith("win"):
                ps = (
                    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;"
                    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
                    f"$x=$t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode({_ps(title)})) > $null;"
                    f"$x.Item(1).AppendChild($t.CreateTextNode({_ps(message)})) > $null;"
                    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('WattWatch').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
                )
                subprocess.Popen(["powershell", "-NoProfile", "-Command", ps],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception as exc:  # notifications are best-effort
            log.debug("notification failed: %s", exc)


def _q(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ps(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"
