"""Detect what's inside the box: CPU model + TDP, GPUs, RAM, disks, laptop vs desktop."""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field

import psutil

log = logging.getLogger(__name__)

# Well-known CPUs (base TDP / PPT-ish sustained watts). Anything not listed falls
# back to the suffix heuristics in `guess_tdp`. Override in Settings if you know better.
KNOWN_TDP = {
    r"i9-1[34]900KS": 150, r"i9-1[234]900K": 125, r"i7-1[234]700K": 125, r"i5-1[234]600K": 125,
    r"Ultra 9 285K": 125, r"Ultra 7 265K": 125, r"Ultra 5 245K": 125,
    r"Ryzen 9 9950X3D": 170, r"Ryzen 9 9950X": 170, r"Ryzen 9 7950X3D": 120, r"Ryzen 9 7950X": 170,
    r"Ryzen 9 7900X": 170, r"Ryzen 9 9900X": 120, r"Ryzen 7 9800X3D": 120, r"Ryzen 7 7800X3D": 120,
    r"Ryzen 7 9700X": 65, r"Ryzen 7 7700X": 105, r"Ryzen 5 7600X": 105, r"Ryzen 5 9600X": 65,
    r"Ryzen 9 5950X": 105, r"Ryzen 9 5900X": 105, r"Ryzen 7 5800X3D": 105, r"Ryzen 7 5800X": 105,
    r"Ryzen 5 5600X": 65, r"Threadripper": 280, r"EPYC": 200,
    r"Apple M\d+ Ultra": 60, r"Apple M\d+ Max": 40, r"Apple M\d+ Pro": 30, r"Apple M\d+": 20,
}


def guess_tdp(brand: str, is_laptop: bool, cores: int) -> int:
    """Best-effort sustained CPU power from the marketing name."""
    b = brand or ""
    for pattern, tdp in KNOWN_TDP.items():
        if re.search(pattern, b, re.I):
            return tdp
    m = re.search(r"(i[3579]-\d{4,5}|Ultra \d \d{3})([A-Z]{0,2}\d?)\b", b)
    if m:
        suffix = m.group(2).upper()
        table = {"KS": 150, "K": 125, "KF": 125, "F": 65, "": 65, "T": 35, "HX": 55, "H": 45,
                 "HK": 45, "HS": 35, "P": 28, "U": 15, "Y": 7, "G7": 15, "G4": 15, "V": 17}
        return table.get(suffix, 45 if is_laptop else 65)
    m = re.search(r"Ryzen (?:AI )?\d+ (?:PRO )?\d{3,4}([A-Z0-9]{0,4})\b", b, re.I)
    if m:
        suffix = m.group(1).upper()
        if "X3D" in suffix:
            return 120
        if suffix.startswith("X"):
            return 105
        if suffix in ("HX",):
            return 55
        if suffix in ("H", "HS"):
            return 35 if suffix == "HS" else 45
        if suffix.startswith("U"):
            return 15
        if suffix.startswith("G") or suffix == "":
            return 65
    if re.search(r"Xeon", b, re.I):
        return max(65, min(250, cores * 8))
    if re.search(r"Celeron|Pentium|Atom|N\d{3}\b", b, re.I):
        return 10 if is_laptop else 15
    return 28 if is_laptop else 65


@dataclass
class GPUInfo:
    name: str
    vendor: str            # nvidia | amd | intel | apple | unknown
    kind: str              # discrete | integrated
    sensor: str            # nvml | amdgpu-sysfs | powermetrics | lhm | none
    max_watts: float = 0.0
    idle_watts: float = 0.0
    index: int = 0
    hwmon: str = ""


@dataclass
class DiskInfo:
    name: str
    rotational: bool


@dataclass
class Hardware:
    platform: str
    os_name: str
    cpu_brand: str
    cpu_cores: int
    cpu_threads: int
    cpu_tdp: int
    is_laptop: bool
    is_apple_silicon: bool
    ram_gb: float
    disks: list[DiskInfo] = field(default_factory=list)
    gpus: list[GPUInfo] = field(default_factory=list)
    fans_detected: int = 0
    has_battery: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _cpu_brand() -> str:
    try:
        import cpuinfo  # py-cpuinfo
        info = cpuinfo.get_cpu_info()
        brand = info.get("brand_raw") or ""
        if brand:
            return brand
    except Exception as exc:  # pragma: no cover - platform specific
        log.debug("py-cpuinfo failed: %s", exc)
    return platform.processor() or "Unknown CPU"


def _disks() -> list[DiskInfo]:
    disks: list[DiskInfo] = []
    if sys.platform.startswith("linux"):
        try:
            for name in sorted(os.listdir("/sys/block")):
                if re.match(r"(loop|ram|zram|dm-|md|sr|fd|nbd)", name):
                    continue
                rot_path = f"/sys/block/{name}/queue/rotational"
                rotational = False
                try:
                    with open(rot_path) as fh:
                        rotational = fh.read().strip() == "1"
                except OSError:
                    pass
                # virtio disks in VMs report rotational=1; treat 'vd*' as virtual SSDs
                if name.startswith("vd"):
                    rotational = False
                disks.append(DiskInfo(name, rotational))
        except OSError:
            pass
    else:
        try:
            counters = psutil.disk_io_counters(perdisk=True) or {}
        except Exception:
            counters = {}
        if sys.platform.startswith("win"):
            names = [n for n in counters if n.lower().startswith("physicaldrive")]
        else:  # macOS: synthesized APFS containers inflate the count; count disk0/disk1 style roots
            names = [n for n in counters if re.fullmatch(r"disk[0-9]", n)][:2]
        disks = [DiskInfo(n, False) for n in names] or [DiskInfo("disk0", False)]
    return disks or [DiskInfo("disk0", False)]


def _linux_amd_gpus() -> list[GPUInfo]:
    gpus = []
    base = "/sys/class/drm"
    try:
        cards = sorted(c for c in os.listdir(base) if re.fullmatch(r"card\d+", c))
    except OSError:
        return gpus
    for card in cards:
        dev = f"{base}/{card}/device"
        try:
            with open(f"{dev}/vendor") as fh:
                vendor = fh.read().strip()
        except OSError:
            continue
        if vendor != "0x1002":  # AMD
            continue
        hwmon = ""
        try:
            for h in os.listdir(f"{dev}/hwmon"):
                for fname in ("power1_average", "power1_input"):
                    if os.path.exists(f"{dev}/hwmon/{h}/{fname}"):
                        hwmon = f"{dev}/hwmon/{h}/{fname}"
                        break
        except OSError:
            pass
        cap = 0.0
        if hwmon:
            try:
                with open(os.path.join(os.path.dirname(hwmon), "power1_cap")) as fh:
                    cap = int(fh.read().strip()) / 1e6
            except (OSError, ValueError):
                pass
        gpus.append(GPUInfo(name=f"AMD Radeon ({card})", vendor="amd",
                            kind="discrete" if cap > 60 else "integrated",
                            sensor="amdgpu-sysfs" if hwmon else "none", max_watts=cap, hwmon=hwmon))
    return gpus


def _nvidia_gpus() -> list[GPUInfo]:
    gpus = []
    try:
        import pynvml
        pynvml.nvmlInit()
        for i in range(pynvml.nvmlDeviceGetCount()):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(h)
            if isinstance(name, bytes):
                name = name.decode()
            try:
                limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(h) / 1000.0
            except Exception:
                limit = 0.0
            gpus.append(GPUInfo(name=name, vendor="nvidia", kind="discrete", sensor="nvml",
                                max_watts=limit, index=i))
    except Exception as exc:
        log.debug("NVML unavailable: %s", exc)
    return gpus


def _windows_video_controllers() -> list[str]:
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json"],
            capture_output=True, text=True, timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        data = json.loads(out.stdout or "[]")
        return [data] if isinstance(data, str) else list(data)
    except Exception:
        return []


def _guess_gpu_watts(name: str) -> tuple[float, float]:
    """(idle, max) for GPUs without a power sensor."""
    n = name.lower()
    if re.search(r"rtx\s*\d0[89]0|rx\s*79\d0|rx\s*9070", n):
        return 25.0, 320.0
    if re.search(r"rtx|rx\s*[5-9]\d00|arc", n):
        return 15.0, 200.0
    if re.search(r"gtx|rx\s*\d{3}\b|radeon pro", n):
        return 10.0, 120.0
    return 3.0, 15.0  # integrated graphics


def detect() -> Hardware:
    is_apple = sys.platform == "darwin" and platform.machine() == "arm64"
    try:
        battery = psutil.sensors_battery()
    except Exception:
        battery = None
    has_battery = battery is not None
    is_laptop = has_battery or is_apple and "book" in (platform.node() or "").lower()
    brand = _cpu_brand()
    cores = psutil.cpu_count(logical=False) or psutil.cpu_count() or 1
    threads = psutil.cpu_count() or cores
    tdp = guess_tdp(brand, is_laptop, cores)

    gpus = _nvidia_gpus()
    if sys.platform.startswith("linux"):
        gpus += _linux_amd_gpus()
    elif sys.platform == "darwin" and is_apple:
        gpus.append(GPUInfo(name=f"{brand} GPU", vendor="apple", kind="integrated", sensor="powermetrics",
                            idle_watts=0.5, max_watts=tdp * 1.2))
    elif sys.platform.startswith("win"):
        for name in _windows_video_controllers():
            low = name.lower()
            if "nvidia" in low and any(g.vendor == "nvidia" for g in gpus):
                continue
            if any(x in low for x in ("microsoft basic", "remote display", "virtual")):
                continue
            idle, mx = _guess_gpu_watts(name)
            vendor = "amd" if ("amd" in low or "radeon" in low) else "intel" if "intel" in low else "nvidia" if "nvidia" in low else "unknown"
            kind = "integrated" if mx <= 20 else "discrete"
            gpus.append(GPUInfo(name=name, vendor=vendor, kind=kind, sensor="none", idle_watts=idle, max_watts=mx))

    fans = 0
    try:
        fans = sum(len(v) for v in (psutil.sensors_fans() or {}).values())
    except Exception:
        pass

    return Hardware(
        platform=sys.platform,
        os_name=f"{platform.system()} {platform.release()}",
        cpu_brand=brand.strip(),
        cpu_cores=cores,
        cpu_threads=threads,
        cpu_tdp=tdp,
        is_laptop=is_laptop,
        is_apple_silicon=is_apple,
        ram_gb=round(psutil.virtual_memory().total / 2**30, 1),
        disks=_disks(),
        gpus=gpus,
        fans_detected=fans,
        has_battery=has_battery,
    )
