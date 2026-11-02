"""The power model: combine real sensors + per-component estimates + PSU losses.

Software cannot see the wall socket. What we *can* do:

1. Read the sensors that exist (RAPL / powermetrics / LibreHardwareMonitor for the CPU,
   NVML / amdgpu for the GPU).
2. Model everything else (RAM, storage, fans, motherboard...) from utilisation.
3. Convert DC load to AC wall draw with a PSU efficiency curve.
4. Correct the result with your Kill-A-Watt calibration points, or replace it entirely with
   a smart-plug reading when one is connected.
"""

from __future__ import annotations

import logging
import sys
import time

import psutil

from . import psu
from .hardware import Hardware
from .readers import AmdSysfsReader, LHMReader, NvmlReader, PowermetricsReader, RaplReader

log = logging.getLogger(__name__)

COMPONENTS = [
    ("cpu", "CPU"), ("gpu", "GPU"), ("ram", "Memory"), ("storage", "Storage"), ("fans", "Fans"),
    ("board", "Motherboard & I/O"), ("display", "Built-in display"), ("charging", "Battery charging"),
    ("extra", "Peripherals"), ("psu_loss", "PSU heat loss"),
]
COMPONENT_NAMES = dict(COMPONENTS)


def fan_curve(u: float) -> float:
    """Fan et al. (2007) 'Power provisioning for a warehouse-sized computer' CPU curve: 2u - u^1.4."""
    u = max(0.0, min(1.0, u))
    return 2 * u - u ** 1.4


class Calibration:
    """Linear correction wall = a * raw + b, fitted to real meter readings."""

    def __init__(self, points: list[tuple[float, float]] | None = None):
        self.a, self.b, self.n = 1.0, 0.0, 0
        self.fit(points or [])

    def fit(self, points: list[tuple[float, float]]):
        pts = [(float(r), float(m)) for r, m in points if r > 0 and m > 0]
        self.n = len(pts)
        if not pts:
            self.a, self.b = 1.0, 0.0
            return
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        if len(pts) >= 2 and (max(xs) - min(xs)) >= 10:
            mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
            sxx = sum((x - mx) ** 2 for x in xs)
            sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            a = sxy / sxx if sxx else 1.0
            if 0.4 <= a <= 2.5:
                self.a, self.b = a, my - a * mx
                return
        self.a, self.b = sum(ys) / sum(xs), 0.0

    @property
    def active(self) -> bool:
        return self.n > 0

    def apply(self, raw: float) -> float:
        return max(0.0, self.a * raw + self.b) if self.active else raw


class PowerModel:
    def __init__(self, hw: Hardware, settings: dict):
        self.hw = hw
        self.settings = settings
        self.rapl = RaplReader() if sys.platform.startswith("linux") else None
        self.pm = PowermetricsReader() if sys.platform == "darwin" else None
        self.lhm = LHMReader(settings.get("lhm_url", ""))
        self.nvml = NvmlReader()
        self.amd = AmdSysfsReader([g.hwmon for g in hw.gpus if g.vendor == "amd" and g.hwmon])
        self.calibration = Calibration()
        self.plug = None  # SmartPlugPoller, attached by the app
        psutil.cpu_percent(None)
        self._disk_prev = self._disk_counters()
        self._disk_t = time.monotonic()

    # ------------------------------------------------------------------ config
    def update_settings(self, settings: dict):
        self.settings = settings
        if settings.get("lhm_url", "") != self.lhm.url:
            self.lhm = LHMReader(settings.get("lhm_url", ""))

    @property
    def tdp(self) -> float:
        return float(self.settings.get("cpu_tdp_override") or self.hw.cpu_tdp)

    @property
    def psu_tier(self) -> str:
        tier = self.settings.get("psu_tier", "auto")
        if tier == "auto":
            return "adapter" if self.hw.is_laptop or self.hw.is_apple_silicon else "gold"
        return tier

    def gpu_peak(self) -> float:
        peak = 0.0
        for g in self.hw.gpus:
            if g.vendor == "apple":
                continue
            peak += g.max_watts or 0.0
        if self.settings.get("gpu_max_watts"):
            peak = max(peak, float(self.settings["gpu_max_watts"]))
        return peak

    def peak_dc(self) -> float:
        laptop = self.hw.is_laptop
        ram = self.hw.ram_gb * (0.15 if laptop else 0.38)
        return self.tdp * 1.15 + self.gpu_peak() + ram + (8 if laptop else 30) + float(self.settings.get("extra_watts") or 0)

    @property
    def psu_rating(self) -> float:
        if self.settings.get("psu_watts"):
            return float(self.settings["psu_watts"])
        return float(psu.pick_size(self.peak_dc(), self.hw.is_laptop or self.hw.is_apple_silicon))

    def peak_wall(self) -> float:
        return self.peak_dc() / 0.85

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _disk_counters():
        try:
            return psutil.disk_io_counters(perdisk=True) or {}
        except Exception:
            return {}

    def _storage(self, laptop: bool) -> float:
        now = time.monotonic()
        cur = self._disk_counters()
        dt = max(now - self._disk_t, 1e-3)
        total = 0.0
        for d in self.hw.disks:
            prev, c = self._disk_prev.get(d.name), cur.get(d.name)
            bps = 0.0
            if prev and c:
                bps = max(0, (c.read_bytes - prev.read_bytes) + (c.write_bytes - prev.write_bytes)) / dt
            if d.rotational:
                act = min(1.0, bps / 120e6)
                total += 5.0 + 2.5 * act
            else:
                act = min(1.0, bps / 400e6)
                total += (0.1 if laptop else 0.6) + (2.8 if laptop else 4.0) * act ** 0.7
        self._disk_prev, self._disk_t = cur, now
        return total

    def _fans(self, load: float, laptop: bool) -> float:
        try:
            fans = psutil.sensors_fans() or {}
        except Exception:
            fans = {}
        rpms = [f.current for entries in fans.values() for f in entries if f.current is not None]
        if rpms:
            return sum(min(3.0, 0.15 + 1.8 * (rpm / 1800.0) ** 3) for rpm in rpms if rpm > 0)
        n = int(self.settings.get("fan_count") or (1 if laptop else 3))
        if self.hw.is_apple_silicon:
            n = min(n, 1)
        per = (0.15 + 0.9 * load ** 2) if laptop else (0.4 + 1.6 * load ** 2)
        return n * per

    # ------------------------------------------------------------------ sample
    def sample(self, user_idle_s: float | None = None) -> dict:
        hw, s = self.hw, self.settings
        laptop = hw.is_laptop or hw.is_apple_silicon
        util = psutil.cpu_percent(None) / 100.0
        measured: dict[str, bool] = {}
        comp: dict[str, float] = {}

        # ---- CPU
        idle_frac = 0.03 if hw.is_apple_silicon else 0.07 if laptop else 0.12
        cpu_est = self.tdp * (idle_frac + (1 - idle_frac) * fan_curve(util))
        cpu_real = None
        if self.rapl and self.rapl.available:
            cpu_real = self.rapl.read()
        if cpu_real is None and self.pm and self.pm.available:
            cpu_real = self.pm.read("cpu")
        if cpu_real is None and self.lhm.url:
            self.lhm.poll()
            cpu_real = self.lhm.read("cpu")
        comp["cpu"] = cpu_real if cpu_real is not None else cpu_est
        measured["cpu"] = cpu_real is not None

        # ---- GPU
        gpu_w, gpu_util, gpu_measured = 0.0, 0.0, False
        nv = self.nvml.read() if self.nvml.available else None
        if nv:
            gpu_w += nv[0]
            gpu_util = nv[1]
            gpu_measured = True
        amd = self.amd.read() if self.amd.available else None
        if amd is not None:
            gpu_w += amd
            gpu_measured = True
        if self.pm and self.pm.available:
            g = self.pm.read("gpu")
            if g is not None:
                gpu_w += g
                gpu_measured = True
        if not gpu_measured and self.lhm.url:
            g = self.lhm.read("gpu")
            if g is not None:
                gpu_w += g
                gpu_measured = True
        # GPUs we could not read get a static idle estimate (or the user's override)
        for g in hw.gpus:
            if g.sensor == "none" and g.kind == "discrete" and not gpu_measured:
                gpu_w += float(s.get("gpu_idle_watts") or g.idle_watts)
        if not hw.gpus and s.get("gpu_idle_watts"):
            gpu_w += float(s["gpu_idle_watts"])
        comp["gpu"] = gpu_w
        measured["gpu"] = gpu_measured

        # ---- memory
        if hw.is_apple_silicon:
            per_gb = 0.04 + 0.04 * util
        elif laptop:
            per_gb = 0.07 + 0.08 * util
        else:
            per_gb = 0.20 + 0.18 * util
        comp["ram"] = hw.ram_gb * per_gb

        # ---- storage, fans, board
        comp["storage"] = self._storage(laptop)
        comp["fans"] = self._fans(max(util, gpu_util), laptop)
        comp["board"] = 1.5 if hw.is_apple_silicon else 3.0 if laptop else 16.0

        # ---- built-in display (assume it turns off after ~10 idle minutes)
        display_on = user_idle_s is None or user_idle_s < 600
        comp["display"] = (3.5 if hw.is_apple_silicon else 4.5) if (laptop and display_on) else 0.0
        comp["extra"] = float(s.get("extra_watts") or 0.0)

        # ---- battery
        on_battery, charging, battery_pct = False, False, None
        if hw.has_battery:
            try:
                b = psutil.sensors_battery()
            except Exception:
                b = None
            if b is not None:
                battery_pct = b.percent
                on_battery = not b.power_plugged
                charging = bool(b.power_plugged and b.percent < 99)
        comp["charging"] = 0.0
        if charging:
            comp["charging"] = min(self.psu_rating * 0.35, 30.0) * (1.0 if battery_pct < 80 else 0.45)

        dc_raw = sum(comp.values())
        raw_wall, eff = psu.wall_watts(dc_raw, self.psu_rating, self.psu_tier)

        # ---- calibration / smart plug
        source = "estimated"
        target_wall = raw_wall
        plug_w = self.plug.read() if self.plug is not None else None
        if plug_w is not None:
            target_wall, source = plug_w, "measured"
        elif self.calibration.active:
            target_wall, source = self.calibration.apply(raw_wall), "calibrated"

        if source != "estimated" and raw_wall > 0:
            comp, eff = self._fit_to_wall(comp, measured, target_wall)

        dc = sum(comp.values())
        wall = dc / eff if eff > 0 and dc > 0 else 0.0
        if source != "estimated":
            wall = target_wall
        loss = max(0.0, wall - dc)

        if on_battery:
            # Running on battery: nothing comes from the wall right now.
            wall_out, loss_out = 0.0, 0.0
        else:
            wall_out, loss_out = wall, loss

        comp_out = dict(comp)
        comp_out["psu_loss"] = loss_out if not on_battery else 0.0
        return {
            "ts": time.time(),
            "wall_w": wall_out,
            "dc_w": dc if not on_battery else 0.0,
            "loss_w": loss_out,
            "raw_wall_w": raw_wall,
            "system_w": wall,  # what the machine itself is drawing (even on battery)
            "psu_eff": eff,
            "psu_rating": self.psu_rating,
            "psu_tier": self.psu_tier,
            "components": comp_out,
            "measured": measured,
            "source": source,
            "cpu_util": util,
            "gpu_util": gpu_util,
            "on_battery": on_battery,
            "charging": charging,
            "battery_pct": battery_pct,
            "plug_w": plug_w,
        }

    def _fit_to_wall(self, comp: dict, measured: dict, target_wall: float) -> tuple[dict, float]:
        """Rescale the *modelled* components so the total matches a trusted wall figure."""
        rating, tier = self.psu_rating, self.psu_tier
        dc = target_wall * psu.efficiency(tier, target_wall * 0.85 / rating)
        for _ in range(4):
            dc = target_wall * psu.efficiency(tier, dc / rating)
        eff = dc / target_wall if target_wall > 0 else 1.0
        fixed = sum(v for k, v in comp.items() if measured.get(k)) + comp.get("extra", 0.0)
        flexible = {k: v for k, v in comp.items() if not measured.get(k) and k != "extra"}
        flex_sum = sum(flexible.values())
        out = dict(comp)
        if flex_sum > 0 and dc - fixed > 0:
            k = (dc - fixed) / flex_sum
            for name, v in flexible.items():
                out[name] = v * k
        else:
            total = sum(comp.values()) or 1.0
            for name, v in comp.items():
                out[name] = v * dc / total
        return out, eff
