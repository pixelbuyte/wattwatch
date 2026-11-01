import { live } from "./api.js";
import { PowerOrb } from "./orb.js";
import { Odometer } from "./odometer.js";

const $ = (id) => document.getElementById(id);
const state = { live: null, currency: "$" };

export const fmt = {
  money(v, cur = state.currency, digits) {
    const a = Math.abs(v);
    const d = digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2);
    return `${v < 0 ? "-" : ""}${cur}${a.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  },
  kwh(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2); },
  watts(v) { return v >= 100 ? v.toFixed(0) : v.toFixed(1); },
  co2(kg) { return kg >= 1 ? `${kg.toFixed(2)} kg` : `${Math.round(kg * 1000)} g`; },
  pct(v) { return `${Math.round(v * 100)}%`; },
};

const orb = new PowerOrb($("orb"));
const odo = new Odometer($("odometer"), { decimals: 4, prefix: "$" });
$("todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

const SOURCE_TEXT = {
  estimated: ["Estimated · ±30%", "Modelled from CPU/GPU load, sensors and a PSU efficiency curve. Calibrate with a meter to tighten this."],
  calibrated: ["Calibrated · ±10%", "Model corrected with your plug-in meter readings."],
  measured: ["Measured · smart plug", "Live wall power from your smart plug."],
};

function render(d) {
  if (!d.ready) return;
  state.live = d;
  state.currency = d.currency;
  orb.set(d.wall_w, d.peak_w);
  $("watts").textContent = d.on_battery ? fmt.watts(d.system_w) : fmt.watts(d.wall_w);
  $("wattsSub").textContent = d.on_battery ? "on battery · 0 W from the wall" : d.charging ? "at the wall · charging" : "at the wall";
  $("cpuUtil").textContent = fmt.pct(d.cpu_util);
  $("psuEff").textContent = fmt.pct(d.psu_eff);
  $("lossW").textContent = `${fmt.watts(d.loss_w)} W`;
  odo.set(d.today.cost, d.currency);
  $("costHour").textContent = fmt.money(d.cost_per_hour, d.currency, 4);
  $("rateNow").textContent = `${d.currency}${d.rate.toFixed(3)}/kWh`;
  $("kwhToday").textContent = fmt.kwh(d.today.kwh);
  $("co2Today").textContent = fmt.co2(d.today.co2_kg);
  $("ratePill").textContent = `${d.currency}${d.rate.toFixed(3)}/kWh · ${d.rate_name}`;
  const [text, title] = SOURCE_TEXT[d.source] || SOURCE_TEXT.estimated;
  const pill = $("sourcePill");
  pill.className = `pill ${d.source}`;
  pill.title = title;
  $("sourceText").textContent = text;
  $("updated").textContent = `updated ${new Date(d.ts * 1000).toLocaleTimeString()}`;
  document.dispatchEvent(new CustomEvent("ww:live", { detail: d }));
}

live(render, (s) => {
  if (s !== "live") $("updated").textContent = s;
});

export { state, $ };
