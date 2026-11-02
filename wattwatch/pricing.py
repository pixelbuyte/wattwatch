"""Electricity pricing: flat rate with optional time-of-use periods."""

from __future__ import annotations

from datetime import datetime


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _period_matches(period: dict, dt: datetime) -> bool:
    start, end = _minutes(period["start"]), _minutes(period["end"])
    now = dt.hour * 60 + dt.minute
    day = dt.weekday()
    days = period.get("days") or list(range(7))
    if start == end:  # whole day
        return day in days
    if start < end:
        return day in days and start <= now < end
    # crosses midnight: the part after midnight belongs to the previous day's period
    if now >= start:
        return day in days
    if now < end:
        return (day - 1) % 7 in days
    return False


def rate_at(settings: dict, ts: float | None = None) -> tuple[float, str]:
    """Return (price per kWh, period name) in force at unix time `ts` (local time)."""
    base = float(settings.get("rate_per_kwh", 0.0))
    if not settings.get("tou_enabled"):
        return base, "Flat rate"
    dt = datetime.fromtimestamp(ts) if ts is not None else datetime.now()
    for period in settings.get("tou_periods") or []:
        try:
            if _period_matches(period, dt):
                return float(period["rate"]), period.get("name", "Period")
        except (KeyError, ValueError):
            continue
    return base, "Standard"


def cheapest_hours(settings: dict, day: datetime | None = None) -> list[int]:
    """Hours of the day (0-23) with the lowest rate - used for 'run heavy jobs off-peak' tips."""
    day = day or datetime.now()
    base = day.replace(minute=30, second=0, microsecond=0)
    rates = [(rate_at(settings, base.replace(hour=h).timestamp())[0], h) for h in range(24)]
    lowest = min(r for r, _ in rates)
    return [h for r, h in rates if abs(r - lowest) < 1e-9]
