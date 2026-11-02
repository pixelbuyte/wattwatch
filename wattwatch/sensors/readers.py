"""Real power sensors. Each reader returns watts or None when unavailable.

* Linux  - Intel/AMD RAPL via /sys/class/powercap (CPU package), amdgpu hwmon (GPU)
* macOS  - `powermetrics` (needs passwordless sudo, see README)
* Windows- LibreHardwareMonitor's built-in web server (optional)
* All    - NVIDIA NVML (GPU)
"""

from __future__ import annotations

import glob
import json
import logging
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

log = logging.getLogger(__name__)


class RaplReader:
    """CPU package energy counters. Often root-only since 2020 - we fail gracefully."""

    def __init__(self):
        self.domains = []
        for path in sorted(glob.glob("/sys/class/powercap/*-rapl:[0-9]")):
            try:
                with open(f"{path}/name") as fh:
                    name = fh.read().strip()
                if not name.startswith("package"):
                    continue
                with open(f"{path}/energy_uj") as fh:
                    e = int(fh.read())
                try:
                    with open(f"{path}/max_energy_range_uj") as fh:
                        rng = int(fh.read())
                except OSError:
                    rng = 2**32
                self.domains.append({"path": f"{path}/energy_uj", "last": e, "range": rng})
            except (OSError, ValueError, PermissionError):
                continue
        self._t = time.monotonic()
        self.available = bool(self.domains)

    def read(self) -> float | None:
        if not self.available:
            return None
        now = time.monotonic()
        dt = now - self._t
        if dt <= 0.05:
            return None
        total_uj = 0
        try:
            for d in self.domains:
                with open(d["path"]) as fh:
                    e = int(fh.read())
                delta = e - d["last"]
                if delta < 0:
                    delta += d["range"]
                d["last"] = e
                total_uj += delta
        except (OSError, ValueError):
            self.available = False
            return None
        self._t = now
        return total_uj / 1e6 / dt


class PowermetricsReader:
    """macOS: stream `sudo -n powermetrics` in a background thread."""

    PATTERNS = {
        "cpu": re.compile(r"^CPU Power:\s*([\d.]+)\s*mW", re.M),
        "gpu": re.compile(r"^GPU Power:\s*([\d.]+)\s*mW", re.M),
        "ane": re.compile(r"^ANE Power:\s*([\d.]+)\s*mW", re.M),
        "package": re.compile(r"Package Power:\s*([\d.]+)\s*mW", re.M),
    }

    def __init__(self):
        self.values: dict[str, float] = {}
        self.updated = 0.0
        self.available = False
        if sys.platform != "darwin" or not shutil.which("powermetrics"):
            return
        try:
            probe = subprocess.run(["sudo", "-n", "powermetrics", "-n", "1", "-i", "200",
                                    "--samplers", "cpu_power,gpu_power"],
                                   capture_output=True, text=True, timeout=10)
        except Exception:
            return
        if probe.returncode != 0:
            log.info("powermetrics needs passwordless sudo; using the model instead")
            return
        self.available = True
        self._parse(probe.stdout)
        threading.Thread(target=self._loop, daemon=True, name="powermetrics").start()

    def _parse(self, text: str):
        for key, pat in self.PATTERNS.items():
            m = pat.findall(text)
            if m:
                self.values[key] = float(m[-1]) / 1000.0
        self.updated = time.time()

    def _loop(self):
        while True:
            try:
                proc = subprocess.Popen(["sudo", "-n", "powermetrics", "-i", "2000",
                                         "--samplers", "cpu_power,gpu_power"],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                buf = []
                for line in proc.stdout:  # type: ignore[union-attr]
                    buf.append(line)
                    if line.startswith("*** Sampled system activity"):
                        self._parse("".join(buf))
                        buf = []
                    elif line.startswith("GPU") and "Power" in line:
                        self._parse("".join(buf))
            except Exception as exc:
                log.debug("powermetrics stream ended: %s", exc)
            time.sleep(10)

    def read(self, key: str) -> float | None:
        if not self.available or time.time() - self.updated > 15:
            return None
        return self.values.get(key)


class LHMReader:
    """Windows: LibreHardwareMonitor -> Options -> Remote Web Server (http://localhost:8085)."""

    def __init__(self, url: str):
        self.url = url
        self.values: dict[str, float] = {}
        self.updated = 0.0
        self._busy = False

    def poll(self):
        if not self.url or self._busy:
            return
        self._busy = True
        threading.Thread(target=self._fetch, daemon=True).start()

    def _fetch(self):
        try:
            with urllib.request.urlopen(self.url, timeout=2) as resp:
                tree = json.loads(resp.read().decode("utf-8", "replace"))
            vals: dict[str, float] = {}
            self._walk(tree, [], vals)
            self.values = vals
            self.updated = time.time()
        except Exception as exc:
            log.debug("LibreHardwareMonitor fetch failed: %s", exc)
        finally:
            self._busy = False

    def _walk(self, node, path, vals):
        text = str(node.get("Text", ""))
        value = str(node.get("Value", ""))
        here = path + [text]
        if value.endswith(" W") and node.get("Type", "Power") == "Power":
            try:
                watts = float(value[:-2].replace(",", "."))
            except ValueError:
                watts = None
            if watts is not None:
                joined = " / ".join(here).lower()
                if "package" in text.lower() and ("cpu" in joined or "intel" in joined or "amd ryzen" in joined):
                    vals.setdefault("cpu", watts)
                elif ("gpu" in joined or "nvidia" in joined or "radeon" in joined) and (
                        "package" in text.lower() or "total" in text.lower() or text.lower() == "gpu power"):
                    vals["gpu"] = vals.get("gpu", 0.0) + watts
        for child in node.get("Children", []) or []:
            self._walk(child, here, vals)

    def read(self, key: str) -> float | None:
        if time.time() - self.updated > 10:
            return None
        return self.values.get(key)


class NvmlReader:
    def __init__(self):
        self.handles = []
        try:
            import pynvml
            pynvml.nvmlInit()
            self._nvml = pynvml
            self.handles = [pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(pynvml.nvmlDeviceGetCount())]
        except Exception:
            self._nvml = None
        self.available = bool(self.handles)

    def read(self) -> tuple[float, float] | None:
        """(watts, utilization 0-1) summed / averaged across NVIDIA GPUs."""
        if not self.available:
            return None
        total, util = 0.0, 0.0
        try:
            for h in self.handles:
                total += self._nvml.nvmlDeviceGetPowerUsage(h) / 1000.0
                try:
                    util += self._nvml.nvmlDeviceGetUtilizationRates(h).gpu / 100.0
                except Exception:
                    pass
        except Exception:
            return None
        return total, util / len(self.handles)


class AmdSysfsReader:
    def __init__(self, paths: list[str]):
        self.paths = [p for p in paths if p]
        self.available = bool(self.paths)

    def read(self) -> float | None:
        if not self.available:
            return None
        total = 0.0
        try:
            for p in self.paths:
                with open(p) as fh:
                    total += int(fh.read().strip()) / 1e6
        except (OSError, ValueError):
            return None
        return total
