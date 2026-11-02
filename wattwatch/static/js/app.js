import { get, live } from "./api.js";
import { Donut, LineChart, colorFor, renderHeatmap } from "./charts.js";
import { Odometer } from "./odometer.js";
import { PowerOrb } from "./orb.js";
import { refreshSummary } from "./panels.js";
import { applyPlan, initSettings, sleepNow } from "./settings.js";
import { toast } from "./ui.js";

const $ = (id) => document.getElementById(id);
const state = { live: null, currency: "$", chartRange: "live", donutRange: "live", heatDays: 7, idleDismissed: null };

const fmt = {
  money: (v, cur, d = 2) => `${cur}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`,
  kwh: (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)),
  watts: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)),
  pct: (v) => `${Math.round(v * 100)}%`,
  mins: (s) => (s >= 5400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`),
};

// ------------------------------------------------------------------ widgets
// Power orb: WebGL 3D by default, 2D canvas as the fallback (and a user choice, remembered)
const ORB_KEY = "ww-orb-mode";
const orbs = { "2d": null, "3d": null };
let orbMode = "3d";
let orbLast = [0, 300];
try { orbMode = localStorage.getItem(ORB_KEY) === "2d" ? "2d" : "3d"; } catch { /* storage blocked */ }

async function useOrb(mode) {
  if (mode === "3d") {
    try {
      if (!orbs["3d"]) {
        const { PowerOrb3D } = await import("./orb3d.js");
        if (!PowerOrb3D.isSupported()) throw new Error("WebGL is not available");
        orbs["3d"] = new PowerOrb3D($("orb3d"));
      }
    } catch (e) {
      console.info("3D orb unavailable, using the 2D orb:", e.message);
      mode = "2d";
      $("orbToggle").disabled = true;
      $("orbToggle").title = "3D orb needs WebGL";
    }
  }
  if (mode === "2d" && !orbs["2d"]) orbs["2d"] = new PowerOrb($("orb"));
  orbMode = mode;
  for (const k of ["2d", "3d"]) {
    if (orbs[k]) orbs[k].paused = k !== mode;
  }
  $("orb3d").classList.toggle("hidden", mode !== "3d");
  $("orb").classList.toggle("hidden", mode !== "2d");
  orbs[mode].set(...orbLast);
  $("orbToggle").textContent = mode === "3d" ? "3D" : "2D";
  $("orbToggle").setAttribute("aria-pressed", String(mode === "3d"));
}
const orb = {
  set(watts, peak) {
    orbLast = [watts, peak];
    orbs[orbMode]?.set(watts, peak);
  },
};
$("orbToggle").addEventListener("click", () => {
  const next = orbMode === "3d" ? "2d" : "3d";
  try { localStorage.setItem(ORB_KEY, next); } catch { /* storage blocked */ }
  useOrb(next);
});
useOrb(orbMode);
const odo = new Odometer($("odometer"), { decimals: 4, prefix: "$" });
const chart = new LineChart($("lineChart"), $("chartTip"));
const donut = new Donut($("donut"), $("donutCenter"));
$("todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

const SOURCE_TEXT = {
  estimated: ["Estimated · ±30%", "Modelled from CPU/GPU load, sensors and a PSU efficiency curve. Calibrate with a meter to tighten this."],
  calibrated: ["Calibrated · ±10%", "Model corrected with your plug-in meter readings."],
  measured: ["Measured · smart plug", "Live wall power from your smart plug."],
};

// ------------------------------------------------------------------ live feed
function render(d) {
  if (!d.ready) return;
  state.live = d;
  state.currency = d.currency;
  orb.set(d.on_battery ? d.system_w : d.wall_w, d.peak_w);
  $("watts").textContent = d.on_battery ? fmt.watts(d.system_w) : fmt.watts(d.wall_w);
  $("wattsSub").textContent = d.on_battery ? "on battery · 0 W from the wall" : d.charging ? "at the wall · charging" : "at the wall";
  $("cpuUtil").textContent = fmt.pct(d.cpu_util);
  $("psuEff").textContent = fmt.pct(d.psu_eff);
  $("lossW").textContent = `${fmt.watts(d.loss_w)} W`;
  odo.set(d.today.cost, d.currency);
  $("costHour").textContent = fmt.money(d.cost_per_hour, d.currency, 4);
  $("rateNow").textContent = `${d.currency}${d.rate.toFixed(3)}/kWh`;
  $("kwhTodayInline").textContent = fmt.kwh(d.today.kwh);
  $("ratePill").textContent = `${d.currency}${d.rate.toFixed(3)}/kWh · ${d.rate_name}`;
  const [text, title] = SOURCE_TEXT[d.source] || SOURCE_TEXT.estimated;
  $("sourcePill").className = `pill ${d.source}`;
  $("sourcePill").title = title;
  $("sourceText").textContent = text;
  $("updated").textContent = `updated ${new Date(d.ts * 1000).toLocaleTimeString()}`;

  const comps = Object.fromEntries(d.components.map((c) => [c.id, c.w]));
  chart.push({ t: d.ts, w: d.wall_w, c: comps }, d.ts);
  if (state.donutRange === "live") {
    donut.set(d.components, "live");
    renderLegend(d.components, true);
  }
  renderIdle(d);
  document.dispatchEvent(new CustomEvent("ww:live", { detail: d }));
}

function renderLegend(components, live) {
  const total = components.reduce((s, c) => s + c.w, 0) || 1;
  $("donutLegend").innerHTML = components.filter((c) => c.w > 0.05).map((c) => `<li>
      <i style="background:${colorFor(c.id)};box-shadow:0 0 8px ${colorFor(c.id)}"></i>
      <span>${c.name}${live && c.measured ? ' <em class="sensor" title="Read from a real sensor">sensor</em>' : ""}</span>
      <b>${c.w.toFixed(1)} W</b><small>${Math.round((c.w / total) * 100)}%</small></li>`).join("");
}

// ------------------------------------------------------------------ idle detector banner
function renderIdle(d) {
  const banner = $("idleBanner");
  const idle = d.idle;
  const cur = d.currency;
  let key = null, title = "", msg = "";
  if (idle.is_idle && idle.since) {
    key = `now-${Math.round(idle.since)}`;
    const perHour = Math.max(0, d.wall_w - idle.sleep_w) / 1000 * d.rate;
    title = `Idle for ${fmt.mins(idle.seconds)} — still drawing ${Math.round(d.wall_w)} W`;
    msg = `That's ${fmt.money(perHour, cur, 3)} an hour for nothing. Asleep it would draw ~${idle.sleep_w} W.`;
  } else if (idle.last && Date.now() / 1000 - idle.last.end < 20 * 60 && idle.last.minutes >= idle.threshold_s / 60) {
    key = `last-${Math.round(idle.last.start)}`;
    const saved = Math.max(0, idle.last.wh - (idle.sleep_w * idle.last.minutes) / 60) / 1000 * d.rate;
    title = `Welcome back! Your PC idled ${fmt.mins(idle.last.minutes * 60)} at ~${Math.round(idle.last.avg_w)} W`;
    msg = `Sleeping after ${Math.round(idle.threshold_s / 60)} min would have saved ${fmt.money(saved, cur, 3)} — make it automatic with a power plan.`;
  }
  const show = key && key !== state.idleDismissed;
  banner.classList.toggle("hidden", !show);
  if (show) {
    $("idleTitle").textContent = title;
    $("idleMsg").textContent = msg;
    banner.dataset.key = key;
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  if (a.dataset.action === "plan") applyPlan();
  if (a.dataset.action === "sleep") sleepNow();
  if (a.dataset.action === "dismiss") {
    state.idleDismissed = $("idleBanner").dataset.key;
    $("idleBanner").classList.add("hidden");
  }
});

// ------------------------------------------------------------------ chart ranges
const SPANS = { live: 300, "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
async function loadChart() {
  const r = state.chartRange;
  if (r === "live") {
    const h = await get("/api/live/history?seconds=300");
    chart.setLive(h.points.map((p) => ({ t: p.t, w: p.w, c: p.c })), SPANS.live);
  } else {
    const h = await get(`/api/history?range=${r}`);
    chart.setHistory(h.points, SPANS[r], h.step);
  }
}
segment("chartRange", "r", (v) => { state.chartRange = v; loadChart(); });

async function loadDonut() {
  if (state.donutRange === "live") {
    if (state.live) { donut.set(state.live.components, "live"); renderLegend(state.live.components, true); }
    return;
  }
  const b = await get(`/api/breakdown?range=${state.donutRange}`);
  const label = state.donutRange === "today" ? "avg today" : "avg 7 days";
  donut.set(b.components, label);
  renderLegend(b.components, false);
}
segment("donutRange", "r", (v) => { state.donutRange = v; loadDonut(); });

async function loadHeatmap() {
  renderHeatmap($("heatmap"), await get(`/api/heatmap?days=${state.heatDays}`));
}
segment("heatRange", "d", (v) => { state.heatDays = Number(v); loadHeatmap(); });

function segment(id, attr, fn) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    fn(b.dataset[attr]);
  });
}

// ------------------------------------------------------------------ export menu
$("exportBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("exportMenu");
  m.classList.toggle("hidden");
  $("exportBtn").setAttribute("aria-expanded", String(!m.classList.contains("hidden")));
});
document.addEventListener("click", () => $("exportMenu").classList.add("hidden"));

// ------------------------------------------------------------------ events -> toasts
let lastEvent = 0;
async function pollEvents() {
  try {
    const r = await get(`/api/events?since=${lastEvent}`);
    if (lastEvent > 0) {
      for (const ev of r.events) {
        const kind = ev.kind === "achievement" ? "win" : ev.kind === "budget" || ev.kind === "idle" ? "warn" : "";
        toast(ev.title, ev.message, kind);
      }
    }
    lastEvent = r.last_id || lastEvent;
  } catch { /* offline */ }
}

// ------------------------------------------------------------------ boot
async function refreshAll() {
  try { await refreshSummary(); } catch (e) { console.warn("summary", e); }
  try { await loadHeatmap(); } catch (e) { console.warn("heatmap", e); }
  if (state.chartRange !== "live") loadChart().catch(() => {});
  if (state.donutRange !== "live") loadDonut().catch(() => {});
}

initSettings({ saved: () => refreshAll() });
live(render, (s) => { if (s !== "live") $("updated").textContent = s; });
loadChart().catch(() => {});
get("/api/system").then((sys) => { $("sensorList").textContent = `CPU: ${sys.sensors.cpu}, GPU: ${sys.sensors.gpu}`; }).catch(() => {});
refreshAll();
pollEvents();
setInterval(refreshAll, 30000);
setInterval(pollEvents, 8000);
