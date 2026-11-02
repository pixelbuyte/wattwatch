// Panels driven by /api/summary: KPIs, waste, projection, score, tips, facts, streaks, achievements.
import { get } from "./api.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function money(v, cur, digits) {
  const a = Math.abs(v || 0);
  const d = digits ?? (a >= 1000 ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : 2);
  return `${v < 0 ? "-" : ""}${cur}${a.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
const kwh = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const co2 = (kg) => (kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : kg >= 1 ? `${kg.toFixed(kg >= 100 ? 0 : 1)} kg` : `${Math.round(kg * 1000)} g`);

let wasteRange = "today";
let lastSummary = null;

export function renderSummary(sm) {
  lastSummary = sm;
  const cur = sm.currency;
  // KPIs
  $("kMonth").textContent = money(sm.month.cost, cur);
  $("kMonthSub").textContent = `${kwh(sm.month.kwh)} kWh · on pace for ${money(sm.month.projected, cur)}`;
  const bar = $("budgetBar");
  if (sm.month.budget > 0) {
    bar.classList.remove("hidden");
    const spent = Math.min(1, sm.month.cost / sm.month.budget);
    const proj = Math.min(1, sm.month.projected / sm.month.budget);
    bar.querySelector("i").style.width = `${spent * 100}%`;
    bar.querySelector("em").style.width = `${proj * 100}%`;
    bar.classList.toggle("over", sm.month.projected > sm.month.budget);
    bar.title = `Spent ${money(sm.month.cost, cur)} · projected ${money(sm.month.projected, cur)} · budget ${money(sm.month.budget, cur)}`;
  } else bar.classList.add("hidden");
  $("kYear").textContent = money(sm.year.projected_cost, cur, 0);
  $("kYearSub").textContent = `${kwh(sm.year.projected_kwh)} kWh · ${co2(sm.year.projected_co2_kg)} CO₂`;
  $("co2Today").textContent = co2(sm.today.co2_kg);
  $("co2Sub").textContent = `${co2(sm.month.co2_kg)} this month`;
  const wt = sm.waste.today;
  $("kWaste").textContent = money(wt.total.cost, cur, 3);
  $("kWasteSub").textContent = `${kwh(wt.total.kwh)} kWh idle + heat`;

  renderWaste();
  renderProjection(sm);
  renderScore(sm);
  renderTips(sm);
  renderStreaks(sm.streaks);
}

export function renderWaste() {
  const sm = lastSummary;
  if (!sm) return;
  const cur = sm.currency;
  const w = sm.waste[wasteRange];
  const total = wasteRange === "today" ? sm.today.kwh : wasteRange === "month" ? sm.month.kwh : sm.all_time.kwh;
  const idle = w.avoidable.kwh, loss = w.psu_loss.kwh;
  const useful = Math.max(0, total - idle - loss);
  const sum = useful + idle + loss || 1;
  const bar = $("wasteBar").children;
  bar[0].style.width = `${(useful / sum) * 100}%`;
  bar[1].style.width = `${(idle / sum) * 100}%`;
  bar[2].style.width = `${(loss / sum) * 100}%`;
  const row = (label, sub, o, cls) => `<div class="waste-row ${cls}"><div><b>${label}</b><span>${sub}</span></div>
    <div class="nums"><b>${money(o.cost, cur, o.cost < 1 ? 3 : 2)}</b><span>${kwh(o.kwh)} kWh · ${co2(o.co2_kg)}</span></div></div>`;
  $("wasteRows").innerHTML =
    row("Idle draw", `${w.idle_hours.toFixed(1)} h with nobody using it`, w.idle, "idle") +
    row("Could have slept", "idle energy minus sleep-mode draw", w.avoidable, "idle") +
    row("PSU heat loss", "AC→DC conversion, warms your room", w.psu_loss, "loss") +
    `<div class="waste-total">${Math.round(w.share * 100)}% of ${wasteRange === "all" ? "all tracked" : wasteRange === "today" ? "today's" : "this month's"} energy was avoidable waste</div>`;
}

function renderProjection(sm) {
  const cur = sm.currency;
  const p = sm.projection;
  const max = Math.max(p.never_sleeps.cost, p.sleeps_nightly.cost, 0.01);
  const bar = (label, o, cls, note) => `<div class="proj-row ${cls}">
      <div class="proj-label"><b>${label}</b><span>${note}</span></div>
      <div class="proj-bar"><i style="width:${(o.cost / max) * 100}%"></i></div>
      <div class="proj-nums"><b>${money(o.cost, cur, 0)}</b><span>${kwh(o.kwh)} kWh · ${co2(o.co2_kg)}</span></div></div>`;
  $("projection").innerHTML =
    bar("Never sleeps (24/7)", p.never_sleeps, "on", `${Math.round(p.awake_w)} W in use, ${Math.round(p.idle_w)} W idle overnight`) +
    bar(`Sleeps ${p.night_hours} h a night`, p.sleeps_nightly, "sleep", `${p.sleep_w} W while asleep`) +
    `<div class="proj-save"><span>Sleeping at night saves</span><b>${money(p.savings.cost, cur, 0)}/yr</b>
      <span>${kwh(p.savings.kwh)} kWh · ${co2(p.savings.co2_kg)} CO₂</span></div>
     <button class="btn small primary" data-action="plan">⚡ Apply a power plan</button>`;
}

const GRADE_COLORS = { A: "#3dffa0", B: "#22f0ff", C: "#ffe14d", D: "#ffb020", F: "#ff3d5a", "?": "#9aa3c7" };
function renderScore(sm) {
  const s = sm.score;
  const col = GRADE_COLORS[s.grade] || "#9aa3c7";
  $("grade").textContent = s.grade;
  $("grade").style.color = col;
  $("grade").style.textShadow = `0 0 24px ${col}`;
  const arc = $("gradeArc");
  const C = 2 * Math.PI * 52;
  arc.style.stroke = col;
  arc.style.strokeDasharray = `${C}`;
  arc.style.strokeDashoffset = `${C * (1 - (s.enough_data ? s.points / 100 : 0))}`;
  arc.style.filter = `drop-shadow(0 0 6px ${col})`;
  $("scorePts").textContent = s.enough_data ? `${Math.round(s.points)}/100` : "needs ~1 hour of data";
  $("scoreParts").innerHTML = s.parts.map((p) => `<li><div class="sp-top"><span>${esc(p.label)}</span><b>${Math.round(p.score)}/${p.weight}</b></div>
    <div class="sp-bar"><i style="width:${(p.score / p.weight) * 100}%"></i></div><small>${esc(p.detail)}</small></li>`).join("");
}

function renderTips(sm) {
  const cur = sm.currency;
  const tips = sm.tips || [];
  $("tips").innerHTML = tips.length ? tips.map((t) => `<li>
      <div class="tip-head"><b>${esc(t.title)}</b>${t.impact > 0.5 ? `<span class="impact">save ~${money(t.impact, cur, 0)}/yr</span>` : ""}</div>
      <p>${esc(t.text)}</p>
      ${t.action === "plan" ? '<button class="btn small" data-action="plan">Apply power plan</button>' : ""}
      ${t.action === "calibrate" ? '<button class="btn small" data-open-settings="calibration">Calibrate now</button>' : ""}
    </li>`).join("") : '<li class="faint">Nothing to fix right now — nice work. 🌱</li>';
}

function renderStreaks(st) {
  const item = (icon, n, label, sub) => `<div class="streak"><div class="streak-ico">${icon}</div><div><b>${n}</b><span>${label}</span><small>${sub}</small></div></div>`;
  $("streaks").innerHTML =
    item("🌙", st.sleep_nights, `night${st.sleep_nights === 1 ? "" : "s"} slept in a row`, "PC asleep or off for half the night") +
    item("📅", st.tracking_days, `day${st.tracking_days === 1 ? "" : "s"} tracked in a row`, "keep WattWatch running") +
    item("💰", st.under_budget_days, `day${st.under_budget_days === 1 ? "" : "s"} under budget`, "daily share of monthly budget") +
    item("⏱️", st.awake_hours >= 48 ? `${(st.awake_hours / 24).toFixed(1)} d` : `${st.awake_hours} h`, "awake since last sleep", "longer isn't better here");
  const nights = (st.nights || []).slice().reverse();
  $("nights").innerHTML = `<span class="nights-label">Last ${nights.length} nights</span>` + nights.map((n) => {
    const d = new Date(n.date + "T12:00:00");
    const cls = n.slept ? "slept" : n.known ? "awake" : "unknown";
    const title = n.slept ? `slept ${n.asleep_h} h` : n.known ? `stayed on (${n.awake_h} h awake)` : "not tracked";
    return `<span class="night ${cls}" title="${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${title}">${n.slept ? "🌙" : n.known ? "☀" : "·"}</span>`;
  }).join("");
}

// ------------------------------------------------------------------ facts carousel
let facts = [], factIdx = 0, factTimer = null;
export function setFacts(list) {
  const keep = facts[factIdx]?.text?.slice(0, 12);
  facts = list || [];
  if (!facts.length) return;
  const found = facts.findIndex((f) => f.text.slice(0, 12) === keep);
  factIdx = found >= 0 ? found : factIdx % facts.length;
  showFact(false);
  if (!factTimer) factTimer = setInterval(() => step(1), 8000);
}
function showFact(animate = true) {
  const f = facts[factIdx];
  if (!f) return;
  const el = $("fact");
  const paint = () => {
    el.innerHTML = `<div class="fact-icon">${f.icon}</div><p>${esc(f.text)}</p>`;
    el.classList.remove("out");
  };
  if (animate) { el.classList.add("out"); setTimeout(paint, 260); } else paint();
  $("factDots").innerHTML = facts.map((_, i) => `<i class="${i === factIdx ? "on" : ""}"></i>`).join("");
}
function step(d) {
  if (!facts.length) return;
  factIdx = (factIdx + d + facts.length) % facts.length;
  showFact();
}
$("factPrev").addEventListener("click", () => { step(-1); clearInterval(factTimer); factTimer = setInterval(() => step(1), 8000); });
$("factNext").addEventListener("click", () => { step(1); clearInterval(factTimer); factTimer = setInterval(() => step(1), 8000); });

// ------------------------------------------------------------------ achievements
export function renderAchievements(list) {
  const unlocked = list.filter((a) => a.unlocked && !a.shame).length;
  $("achCount").textContent = `${unlocked} / ${list.filter((a) => !a.shame).length} unlocked`;
  $("badges").innerHTML = list.map((a) => {
    const when = a.unlocked_ts ? new Date(a.unlocked_ts * 1000).toLocaleDateString() : "";
    return `<div class="badge ${a.unlocked ? "on" : ""} ${a.shame ? "shame" : ""}" title="${esc(a.desc)}${when ? ` · unlocked ${when}` : ""}">
      <div class="badge-ico">${a.icon}</div><b>${esc(a.name)}</b><span>${esc(a.desc)}</span>
      ${a.unlocked ? `<small>✓ ${when}</small>` : `<div class="badge-prog"><i style="width:${Math.round(a.progress * 100)}%"></i></div>`}
    </div>`;
  }).join("");
}

// ------------------------------------------------------------------ waste range toggle
document.querySelectorAll("#wasteRange button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#wasteRange button").forEach((x) => x.classList.toggle("on", x === b));
  wasteRange = b.dataset.r;
  renderWaste();
}));

export async function refreshSummary() {
  const [sm, f, ach] = await Promise.all([get("/api/summary"), get("/api/facts"), get("/api/achievements")]);
  renderSummary(sm);
  setFacts(f.facts);
  renderAchievements(ach.achievements);
  return sm;
}
