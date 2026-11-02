// Settings drawer: money, hardware overrides, calibration, smart plug, system.
import { del, get, post } from "./api.js";
import { confirmModal, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const form = $("settingsForm");
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
let current = null;
let tou = [];
let onSaved = () => {};

export function initSettings({ saved }) {
  onSaved = saved || onSaved;
  $("settingsBtn").addEventListener("click", () => open());
  $("drawerClose").addEventListener("click", close);
  $("scrim").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("drawer-open")) close(); });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-open-settings]");
    if (t) { e.preventDefault(); open(t.dataset.openSettings); }
  });
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  $("saveBtn").addEventListener("click", save);
  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  $("touAdd").addEventListener("click", () => { tou.push({ name: "Period", start: "07:00", end: "16:00", rate: 0.2, days: [0, 1, 2, 3, 4] }); renderTou(); });
  $("co2Preset").addEventListener("change", (e) => { if (e.target.value) form.co2_g_per_kwh.value = e.target.value; });
  $("calSave").addEventListener("click", saveCalibration);
  $("calInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCalibration(); } });
  $("calReset").addEventListener("click", resetCalibration);
  $("plugTest").addEventListener("click", testPlug);
  $("planBtn").addEventListener("click", applyPlan);
  $("sleepBtn").addEventListener("click", sleepNow);
  document.addEventListener("ww:live", (e) => {
    const d = e.detail;
    if (!document.body.classList.contains("drawer-open")) return;
    $("calShown").textContent = `${d.wall_w.toFixed(1)} W`;
    $("calRaw").textContent = `${d.raw_w.toFixed(1)} W`;
  });
}

export async function open(tab = "money") {
  document.body.classList.add("drawer-open");
  $("scrim").classList.remove("hidden");
  $("drawer").setAttribute("aria-hidden", "false");
  showTab(tab);
  await load();
}

function close() {
  document.body.classList.remove("drawer-open");
  $("scrim").classList.add("hidden");
  $("drawer").setAttribute("aria-hidden", "true");
}

function showTab(tab) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  form.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.dataset.tab !== tab));
  if (tab === "calibration") loadCalibration();
}

async function load() {
  const [s, sys] = await Promise.all([get("/api/settings"), get("/api/system")]);
  current = s;
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith("sp_")) continue;
    if (!(el.name in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else el.value = s[el.name];
  }
  const sp = s.smartplug || {};
  form.sp_type.value = sp.type || "none";
  form.sp_host.value = sp.host || "";
  form.sp_username.value = sp.username || "";
  form.sp_password.value = sp.password || "";
  form.sp_index.value = sp.index || 0;
  tou = (s.tou_periods || []).map((p) => ({ ...p, days: [...p.days] }));
  renderTou();
  renderHardware(sys);
}

function renderTou() {
  const el = $("touEditor");
  el.innerHTML = tou.map((p, i) => `<div class="tou-row" data-i="${i}">
      <input data-k="name" value="${esc(p.name)}" aria-label="Period name">
      <input data-k="start" type="time" value="${p.start}" aria-label="Start">
      <span>→</span><input data-k="end" type="time" value="${p.end}" aria-label="End">
      <input data-k="rate" type="number" step="0.001" min="0" value="${p.rate}" aria-label="Price per kWh">
      <span class="days">${DAYS.map((d, k) => `<button type="button" data-day="${k}" class="${p.days.includes(k) ? "on" : ""}">${d}</button>`).join("")}</span>
      <button type="button" class="btn small ghost" data-del aria-label="Remove period">✕</button></div>`).join("");
  el.querySelectorAll(".tou-row").forEach((row) => {
    const p = tou[Number(row.dataset.i)];
    row.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
      p[inp.dataset.k] = inp.dataset.k === "rate" ? Number(inp.value) : inp.value;
    }));
    row.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => {
      const d = Number(b.dataset.day);
      p.days = p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort();
      b.classList.toggle("on");
    }));
    row.querySelector("[data-del]").addEventListener("click", () => { tou.splice(Number(row.dataset.i), 1); renderTou(); });
  });
}

function renderHardware(sys) {
  const hw = sys.hardware;
  const gpus = hw.gpus.length ? hw.gpus.map((g) => `${esc(g.name)} (${g.sensor === "none" ? "estimated" : g.sensor})`).join(", ") : "integrated / none detected";
  const disks = hw.disks.map((d) => `${esc(d.name)}${d.rotational ? " (HDD)" : ""}`).join(", ");
  $("hwInfo").innerHTML = `<dl>
    <dt>CPU</dt><dd>${esc(hw.cpu_brand)} · ${hw.cpu_cores}C/${hw.cpu_threads}T · ~${sys.cpu_tdp} W TDP</dd>
    <dt>GPU</dt><dd>${gpus}</dd>
    <dt>Memory</dt><dd>${hw.ram_gb} GB</dd>
    <dt>Storage</dt><dd>${disks}</dd>
    <dt>Type</dt><dd>${hw.is_laptop ? "Laptop" : "Desktop"} · ${esc(hw.os_name)}</dd>
    <dt>PSU</dt><dd>${sys.psu_rating} W · ${sys.psu_tier}</dd>
    <dt>Sensors</dt><dd>CPU: ${sys.sensors.cpu} · GPU: ${sys.sensors.gpu} · idle: ${sys.sensors.idle}</dd></dl>`;
  $("sysInfo").innerHTML = `<dl><dt>Version</dt><dd>${sys.version}</dd><dt>Data folder</dt><dd><code>${esc(sys.data_dir)}</code></dd>
    <dt>Idle detection</dt><dd>${sys.sensors.idle}</dd></dl>`;
  const list = $("sensorList");
  if (list) list.textContent = `CPU: ${sys.sensors.cpu}, GPU: ${sys.sensors.gpu}`;
}

function collect() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith("sp_") || !current || !(el.name in current)) continue;
    out[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  }
  out.tou_periods = tou;
  out.smartplug = {
    type: form.sp_type.value, host: form.sp_host.value.trim(), username: form.sp_username.value,
    password: form.sp_password.value, index: Number(form.sp_index.value || 0),
  };
  return out;
}

async function save() {
  $("saveState").textContent = "Saving…";
  try {
    current = await post("/api/settings", collect());
    $("saveState").textContent = "Saved ✓";
    toast("Settings saved", "Totals already recorded keep the price they were tracked at.", "win");
    onSaved(current);
  } catch (e) {
    $("saveState").textContent = "";
    toast("Couldn't save settings", e.message, "warn");
  }
  setTimeout(() => ($("saveState").textContent = ""), 3000);
}

// ------------------------------------------------------------------ calibration
async function loadCalibration() {
  const c = await get("/api/calibration");
  const pts = c.points;
  $("calFit").innerHTML = c.active
    ? `Current fit: <b>wall = ${c.a.toFixed(3)} × model ${c.b >= 0 ? "+" : "−"} ${Math.abs(c.b).toFixed(1)} W</b> from ${pts.length} reading${pts.length === 1 ? "" : "s"}`
    : "Not calibrated yet — numbers are pure model estimates (±30%).";
  $("calTable").innerHTML = pts.length
    ? `<tr><th>When</th><th>Model</th><th>Meter</th><th>Source</th></tr>` + pts.slice(0, 12).map((p) =>
      `<tr><td>${new Date(p.ts * 1000).toLocaleString()}</td><td>${p.raw_w.toFixed(1)} W</td><td>${p.measured_w.toFixed(1)} W</td><td>${p.source}</td></tr>`).join("")
    : "";
}

async function saveCalibration() {
  const v = Number($("calInput").value);
  if (!v) { toast("Enter the watts shown on your meter", "", "warn"); return; }
  try {
    const r = await post("/api/calibrate", { measured_w: v });
    toast("Calibration saved 🎯", `Model said ${r.point.raw_w.toFixed(1)} W, meter said ${v} W.`, "win");
    $("calInput").value = "";
    loadCalibration();
  } catch (e) {
    toast("Calibration failed", e.message, "warn");
  }
}

async function resetCalibration() {
  if (!(await confirmModal("Reset calibration?", "<p>All meter and smart-plug calibration points will be deleted and WattWatch goes back to pure estimates.</p>", "Reset"))) return;
  await del("/api/calibration");
  toast("Calibration reset", "Back to model estimates.");
  loadCalibration();
}

async function testPlug() {
  $("plugResult").textContent = "Connecting…";
  const r = await post("/api/smartplug/test", {
    type: form.sp_type.value, host: form.sp_host.value.trim(), username: form.sp_username.value,
    password: form.sp_password.value, index: Number(form.sp_index.value || 0),
  });
  $("plugResult").textContent = r.ok ? `✓ Reading ${r.watts.toFixed(1)} W — save to start using it` : `✕ ${r.error}`;
}

// ------------------------------------------------------------------ power actions
export async function applyPlan() {
  const ok = await confirmModal("Apply a power-saving plan?",
    `<p>WattWatch will change your OS power settings <b>for when the PC is plugged in</b>:</p>
     <ul><li>Turn the display off after <b>10 minutes</b></li><li>Sleep after <b>30 minutes</b> of inactivity</li></ul>
     <p class="hint">You can change these back any time in your system's power settings. On macOS you'll be asked for your password.</p>`, "Apply plan");
  if (!ok) return;
  try {
    const r = await post("/api/power/plan", { sleep_min: 30, display_min: 10 });
    toast(r.ok ? "Power plan applied ⚡" : "Couldn't apply everything", r.message, r.ok ? "win" : "warn");
  } catch (e) {
    toast("Couldn't apply power plan", e.message, "warn");
  }
}

export async function sleepNow() {
  const ok = await confirmModal("Put the PC to sleep now?", "<p>Save your work first. Wake it with the keyboard, mouse or power button.</p>", "Sleep now");
  if (!ok) return;
  try {
    const r = await post("/api/power/sleep");
    toast(r.ok ? "Good night 🌙" : "Couldn't sleep", r.message, r.ok ? "" : "warn");
  } catch (e) {
    toast("Couldn't sleep", e.message, "warn");
  }
}
