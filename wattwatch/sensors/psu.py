"""Power-supply efficiency curves: DC load -> AC watts pulled from the wall.

Points are (load fraction, efficiency) loosely based on the 80 PLUS (115 V internal)
requirements at 10/20/50/100 % load, extended below 10 % where real units fall off a cliff.
"""

from __future__ import annotations

CURVES: dict[str, list[tuple[float, float]]] = {
    "white":    [(0.0, 0.40), (0.02, 0.52), (0.05, 0.64), (0.10, 0.74), (0.20, 0.80), (0.50, 0.80), (1.0, 0.80)],
    "bronze":   [(0.0, 0.45), (0.02, 0.56), (0.05, 0.68), (0.10, 0.78), (0.20, 0.82), (0.50, 0.85), (1.0, 0.82)],
    "silver":   [(0.0, 0.47), (0.02, 0.58), (0.05, 0.70), (0.10, 0.80), (0.20, 0.85), (0.50, 0.88), (1.0, 0.85)],
    "gold":     [(0.0, 0.50), (0.02, 0.61), (0.05, 0.74), (0.10, 0.83), (0.20, 0.87), (0.50, 0.90), (1.0, 0.87)],
    "platinum": [(0.0, 0.53), (0.02, 0.64), (0.05, 0.77), (0.10, 0.86), (0.20, 0.90), (0.50, 0.92), (1.0, 0.89)],
    "titanium": [(0.0, 0.58), (0.02, 0.70), (0.05, 0.83), (0.10, 0.90), (0.20, 0.92), (0.50, 0.94), (1.0, 0.90)],
    # laptop / mini-PC external power brick
    "adapter":  [(0.0, 0.55), (0.02, 0.64), (0.05, 0.75), (0.10, 0.82), (0.25, 0.87), (0.50, 0.89), (1.0, 0.88)],
}

PSU_SIZES = [300, 450, 550, 650, 750, 850, 1000, 1200, 1600]
ADAPTER_SIZES = [45, 65, 90, 100, 140, 180, 240, 330]


def efficiency(tier: str, load_fraction: float) -> float:
    pts = CURVES.get(tier) or CURVES["gold"]
    x = max(0.0, min(1.2, load_fraction))
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[0][1]


def wall_watts(dc_watts: float, rated_watts: float, tier: str) -> tuple[float, float]:
    """Return (AC wall watts, efficiency)."""
    if dc_watts <= 0:
        return 0.0, efficiency(tier, 0.0)
    eff = efficiency(tier, dc_watts / max(rated_watts, 1.0))
    return dc_watts / eff, eff


def pick_size(peak_dc: float, laptop: bool) -> int:
    sizes = ADAPTER_SIZES if laptop else PSU_SIZES
    target = peak_dc * (1.0 if laptop else 1.4)  # builders usually leave ~40 % headroom
    for s in sizes:
        if s >= target:
            return s
    return sizes[-1]
