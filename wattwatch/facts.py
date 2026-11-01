"""'Did you know?' facts built from your real numbers.

Conversion constants are rounded, commonly cited ballpark figures - good for intuition,
not for engineering. Sources noted inline.
"""

from __future__ import annotations

import math

PHONE_CHARGE_KWH = 0.015      # ~13 Wh battery + charger losses
LAPTOP_CHARGE_KWH = 0.065     # ~55 Wh battery + losses
KETTLE_LITRE_KWH = 0.10       # 1 L from 20->100 C is 0.093 kWh, plus losses
LED_BULB_KW = 0.009           # a "60 W equivalent" LED bulb
EV_MILES_PER_KWH = 3.5        # typical modern EV, wall-to-wheels
CYCLIST_W = 100               # sustained human output on a bike
HUMAN_REST_W = 100            # a resting human body gives off ~100 W
SPACE_HEATER_W = 1500
FRIDGE_KWH_YEAR = 450         # modern full-size fridge
US_HOME_KWH_YEAR = 10500      # EIA average US household
TREE_KG_CO2_YEAR = 22         # mature tree, often quoted ~48 lb/yr
CAR_KG_CO2_PER_MILE = 0.40    # EPA average passenger car
KCAL_PER_KWH = 860
BIG_MAC_KCAL = 590
AA_BATTERY_KWH = 0.003        # ~3 Wh alkaline AA
MICROWAVE_POPCORN_KWH = 0.055 # 1.1 kW for 3 minutes
TOAST_KWH = 0.04              # one toaster cycle
COFFEE_PRICE = 4.0            # a cafe latte, in your currency


def _n(x: float) -> str:
    if x >= 100:
        return f"{x:,.0f}"
    if x >= 10:
        return f"{x:.0f}"
    if x >= 1:
        return f"{x:.1f}".rstrip("0").rstrip(".")
    return f"{x:.2f}"


def _dur(hours: float) -> str:
    if hours >= 48:
        return f"{_n(hours / 24)} days"
    if hours >= 1.5:
        return f"{_n(hours)} hours"
    return f"{_n(hours * 60)} minutes"


def build_facts(sm: dict, live: dict | None) -> list[dict]:
    cur = sm.get("currency", "$")
    kwh = sm["today"]["kwh"]
    month_kwh = sm["month"]["kwh"]
    year_kwh = sm["year"]["projected_kwh"]
    year_cost = sm["year"]["projected_cost"]
    co2_today = sm["today"]["co2_kg"]
    waste = sm["waste"]["today"]
    w_now = (live or {}).get("wall_w") or sm["averages"]["avg_w"]
    facts: list[dict] = []

    def add(icon, text, value=0.0, kind="today"):
        facts.append({"icon": icon, "text": text, "value": value, "kind": kind})

    use = kwh if kwh >= 0.02 else month_kwh
    when = "Today" if kwh >= 0.02 else "This month"
    if use > 0:
        add("📱", f"{when} your PC used enough energy to fully charge a phone {_n(use / PHONE_CHARGE_KWH)} times.", use / PHONE_CHARGE_KWH)
        add("🫖", f"{when}'s energy could boil {_n(use / KETTLE_LITRE_KWH)} litres of water for tea.", use / KETTLE_LITRE_KWH)
        add("💡", f"That's the same as running an LED bulb for {_dur(use / LED_BULB_KW)}.", use / LED_BULB_KW)
        add("🚗", f"An electric car could drive {_n(use * EV_MILES_PER_KWH)} miles ({_n(use * EV_MILES_PER_KWH * 1.609)} km) on {when.lower()}'s energy.", use * EV_MILES_PER_KWH)
        add("🚴", f"You'd have to pedal a bike generator for {_dur(use * 1000 / CYCLIST_W)} to make {when.lower()}'s electricity by hand.", use * 1000 / CYCLIST_W)
        add("🍔", f"In food terms, {when.lower()}'s energy is {_n(use * KCAL_PER_KWH / BIG_MAC_KCAL)} Big Macs ({_n(use * KCAL_PER_KWH)} kcal).", use * KCAL_PER_KWH)
        add("🔋", f"Powering it from AA batteries instead would take {_n(use / AA_BATTERY_KWH)} of them.", use / AA_BATTERY_KWH)
        add("🍿", f"Or {_n(use / MICROWAVE_POPCORN_KWH)} bags of microwave popcorn. Or {_n(use / TOAST_KWH)} rounds of toast.", use / MICROWAVE_POPCORN_KWH)
        add("💻", f"{when}'s energy would recharge a laptop {_n(use / LAPTOP_CHARGE_KWH)} times.", use / LAPTOP_CHARGE_KWH)
        lift_m = use * 3.6e6 / (1500 * 9.81)
        add("🏗️", f"Same energy could lift a 1.5-tonne car {_n(lift_m)} metres straight up.", lift_m, kind="physics")
    if w_now:
        add("🧍", f"Right now your PC gives off as much heat as {_n(w_now / HUMAN_REST_W)} resting {'person' if w_now < 150 else 'people'}.", w_now / HUMAN_REST_W, kind="live")
        bulbs = w_now / (LED_BULB_KW * 1000)
        add("✨", f"Right now it draws as much as {_n(bulbs)} LED bulbs glowing at once.", bulbs, kind="live")
    if year_kwh > 0:
        add("🧊", f"At this pace it'll use {_n(year_kwh)} kWh a year - about {_n(year_kwh / FRIDGE_KWH_YEAR)}× a modern fridge.", year_kwh / FRIDGE_KWH_YEAR, kind="year")
        add("🏠", f"That's {_n(year_kwh / US_HOME_KWH_YEAR * 100)}% of an average US home's yearly electricity.", year_kwh / US_HOME_KWH_YEAR, kind="year")
    if year_cost > 0:
        add("☕", f"Projected yearly cost: {cur}{_n(year_cost)} - about {_n(year_cost / COFFEE_PRICE)} lattes.", year_cost / COFFEE_PRICE, kind="year")
    if co2_today > 0.005:
        add("🌳", f"A mature tree needs {_dur(co2_today / TREE_KG_CO2_YEAR * 8760)} to absorb today's CO₂.", co2_today, kind="co2")
        add("⛽", f"Today's CO₂ ≈ driving a petrol car {_n(co2_today / CAR_KG_CO2_PER_MILE)} miles.", co2_today / CAR_KG_CO2_PER_MILE, kind="co2")
    loss = waste["psu_loss"]["kwh"]
    if loss > 0.005:
        add("🔥", f"Your power supply turned {_n(loss * 1000)} Wh into pure heat today - a {SPACE_HEATER_W} W space heater running {_dur(loss * 1000 / SPACE_HEATER_W)}.", loss, kind="waste")
    idle = waste["idle"]["kwh"]
    if idle > 0.01:
        add("😴", f"{_n(idle / (kwh or 1) * 100)}% of today's energy went to idling - enough to charge {_n(idle / PHONE_CHARGE_KWH)} phones.", idle, kind="waste")
    # a little physics trivia that always works
    if w_now:
        add("⚛️", f"Each second your PC uses {_n(w_now)} joules - roughly the energy of lifting an apple {_n(w_now / (0.1 * 9.81))} metres.", w_now, kind="physics")
    facts = [f for f in facts if math.isfinite(f["value"])]
    return facts
