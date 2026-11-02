// Canvas charts: animated live line chart and component donut. Plus the DOM heatmap.

export const COMPONENT_COLORS = {
  cpu: "#22f0ff", gpu: "#ff3df2", ram: "#aa5aff", storage: "#3c8cff", fans: "#3dffa0",
  board: "#ffb020", display: "#7ffcff", charging: "#ffe14d", extra: "#ff8a3d", psu_loss: "#ff3d5a",
  standby: "#646d94",
};
export const colorFor = (id) => COMPONENT_COLORS[id] || "#9aa3c7";

const lerp = (a, b, t) => a + (b - a) * t;

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

function niceMax(v) {
  if (v <= 10) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fmtTime(t, span) {
  const d = new Date(t * 1000);
  if (span > 2 * 86400) return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  if (span > 3 * 3600) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: span <= 600 ? "2-digit" : undefined });
}

export class LineChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.points = [];      // {t, w, c?}
    this.span = 300;       // seconds visible
    this.mode = "live";
    this.offset = 0;       // server clock - client clock
    this.ymax = 50;
    this.hoverX = null;
    this.series = ["cpu", "gpu"];
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
    });
    canvas.addEventListener("pointerleave", () => { this.hoverX = null; this.tooltip.classList.add("hidden"); });
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setLive(points, span) {
    this.mode = "live";
    this.span = span;
    this.points = points.slice();
  }

  setHistory(points, span, step) {
    this.mode = "history";
    this.span = span;
    this.step = step;
    this.points = points.slice();
  }

  push(p, serverTs) {
    if (serverTs) this.offset = lerp(this.offset, serverTs - Date.now() / 1000, this.offset ? 0.1 : 1);
    if (this.mode !== "live") return;
    const last = this.points[this.points.length - 1];
    if (last && p.t <= last.t) return;
    this.points.push(p);
    const cutoff = p.t - this.span - 10;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
  }

  draw() {
    const [ctx, w, h] = setupCanvas(this.canvas);
    const pad = { l: 46, r: 14, t: 12, b: 26 };
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    ctx.clearRect(0, 0, w, h);
    const now = this.mode === "live" ? Date.now() / 1000 + this.offset - 1.0 : (this.points.at(-1)?.t ?? Date.now() / 1000);
    const t0 = now - this.span;
    const vis = this.points.filter((p) => p.t >= t0 - (this.step || 2) && p.t <= now + 2);
    const peak = vis.reduce((m, p) => Math.max(m, p.w), 0);
    this.ymax = lerp(this.ymax, niceMax(Math.max(peak * 1.15, 10)), 0.08);
    const X = (t) => pad.l + ((t - t0) / this.span) * cw;
    const Y = (v) => pad.t + ch - (v / this.ymax) * ch;

    // grid
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = (this.ymax / 4) * i;
      const y = Y(v);
      ctx.strokeStyle = i === 0 ? "rgba(120,140,255,0.25)" : "rgba(120,140,255,0.08)";
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#646d94";
      ctx.fillText(`${Math.round(v)} W`, pad.l - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ticks = w < 520 ? 2 : 4;
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + (this.span / ticks) * i;
      ctx.fillStyle = "#646d94";
      ctx.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      ctx.fillText(i === ticks && this.mode === "live" ? "now" : fmtTime(t, this.span), X(t), h - pad.b + 8);
    }
    if (vis.length < 2) {
      ctx.fillStyle = "#646d94";
      ctx.textAlign = "center";
      ctx.fillText(this.mode === "live" ? "collecting…" : "no data for this range yet", pad.l + cw / 2, pad.t + ch / 2);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t - 4, cw, ch + 8);
    ctx.clip();

    // split into segments where data has gaps
    const gap = Math.max(this.mode === "live" ? 5 : (this.step || 60) * 2.5, 5);
    const segments = [];
    let seg = [];
    for (const p of vis) {
      if (seg.length && p.t - seg[seg.length - 1].t > gap) { segments.push(seg); seg = []; }
      seg.push(p);
    }
    if (seg.length) segments.push(seg);

    const path = (pts, key) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const v = key ? (p.c?.[key] ?? 0) : p.w;
        const x = X(p.t), y = Y(v);
        if (i === 0) ctx.moveTo(x, y);
        else {
          const prev = pts[i - 1];
          const pv = key ? (prev.c?.[key] ?? 0) : prev.w;
          const mx = (X(prev.t) + x) / 2;
          ctx.bezierCurveTo(mx, Y(pv), mx, y, x, y);
        }
      });
    };

    for (const s of segments) {
      // area
      path(s);
      ctx.lineTo(X(s.at(-1).t), Y(0));
      ctx.lineTo(X(s[0].t), Y(0));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
      g.addColorStop(0, "rgba(34,240,255,0.32)");
      g.addColorStop(0.6, "rgba(170,90,255,0.10)");
      g.addColorStop(1, "rgba(170,90,255,0)");
      ctx.fillStyle = g;
      ctx.fill();
      // component lines (live only)
      if (this.mode === "live") {
        for (const key of this.series) {
          path(s, key);
          ctx.strokeStyle = colorFor(key) + "99";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      // main line with glow
      path(s);
      ctx.strokeStyle = "#22f0ff";
      ctx.lineWidth = 2.2;
      ctx.shadowColor = "rgba(34,240,255,0.9)";
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // glowing head
    const last = vis.at(-1);
    if (this.mode === "live") {
      const x = X(last.t), y = Y(last.w);
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
      ctx.beginPath(); ctx.arc(x, y, 4 + pulse * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(34,240,255,${0.25 + 0.2 * pulse})`; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill();
    }
    ctx.restore();

    // hover crosshair
    if (this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= w - pad.r) {
      const t = t0 + ((this.hoverX - pad.l) / cw) * this.span;
      let best = vis[0];
      for (const p of vis) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const x = X(best.t), y = Y(best.w);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = "#22f0ff"; ctx.fill();
      const tip = this.tooltip;
      tip.classList.remove("hidden");
      const extra = best.max ? ` · peak ${Math.round(best.max)} W` : "";
      tip.innerHTML = `<b>${best.w.toFixed(1)} W</b>${extra}<br><span>${new Date(best.t * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", second: this.span <= 600 ? "2-digit" : undefined })}</span>`;
      tip.style.left = `${Math.min(x + 12, w - 170)}px`;
      tip.style.top = `${Math.max(y - 46, 0)}px`;
    }
  }
}

export class Donut {
  constructor(canvas, center) {
    this.canvas = canvas;
    this.center = center;
    this.items = [];   // {id, name, w, a (animated)}
    this.hover = -1;
    canvas.addEventListener("pointermove", (e) => this._hit(e));
    canvas.addEventListener("pointerleave", () => (this.hover = -1));
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  set(components, label) {
    const map = new Map(this.items.map((i) => [i.id, i]));
    this.items = components.filter((c) => c.w > 0.05).map((c) => {
      const prev = map.get(c.id);
      return { ...c, a: prev ? prev.a : 0 };
    });
    this.label = label;
  }

  _hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    const dist = Math.hypot(x, y);
    const R = Math.min(r.width, r.height) / 2 - 10;
    if (dist < R * 0.62 || dist > R + 8) { this.hover = -1; return; }
    let ang = Math.atan2(y, x) + Math.PI / 2;
    if (ang < 0) ang += Math.PI * 2;
    const total = this.items.reduce((s, i) => s + i.a, 0) || 1;
    let acc = 0;
    this.hover = -1;
    this.items.forEach((it, i) => {
      const span = (it.a / total) * Math.PI * 2;
      if (ang >= acc && ang < acc + span) this.hover = i;
      acc += span;
    });
  }

  draw() {
    const [ctx, w, h] = setupCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 10;
    for (const it of this.items) it.a = lerp(it.a, it.w, 0.08);
    const total = this.items.reduce((s, i) => s + i.a, 0);
    // track
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.81, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(120,140,255,0.08)";
    ctx.lineWidth = R * 0.36;
    ctx.stroke();
    if (total <= 0) return;
    let start = -Math.PI / 2;
    this.items.forEach((it, i) => {
      const span = (it.a / total) * Math.PI * 2;
      const hov = i === this.hover;
      const col = colorFor(it.id);
      ctx.beginPath();
      ctx.arc(cx, cy, R * (hov ? 0.83 : 0.81), start + 0.012, start + span - 0.012);
      ctx.strokeStyle = col;
      ctx.lineWidth = R * (hov ? 0.42 : 0.34);
      ctx.shadowColor = col;
      ctx.shadowBlur = hov ? 26 : 12;
      ctx.globalAlpha = this.hover === -1 || hov ? 1 : 0.45;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      start += span;
    });
    const it = this.items[this.hover];
    const totalW = this.items.reduce((s, i) => s + i.w, 0);
    this.center.innerHTML = it
      ? `<b style="color:${colorFor(it.id)}">${it.w.toFixed(1)} W</b><span>${it.name} · ${Math.round((it.w / totalW) * 100)}%</span>`
      : `<b>${totalW.toFixed(totalW >= 100 ? 0 : 1)} W</b><span>${this.label || ""}</span>`;
  }
}

// heat palette: deep navy -> blue -> cyan -> magenta -> orange
const HEAT = [[0, [16, 22, 52]], [0.25, [40, 70, 190]], [0.5, [34, 210, 255]], [0.75, [255, 61, 242]], [1, [255, 150, 40]]];
export function heatColor(f) {
  f = Math.max(0, Math.min(1, f));
  for (let i = 0; i < HEAT.length - 1; i++) {
    const [x0, c0] = HEAT[i], [x1, c1] = HEAT[i + 1];
    if (f <= x1) {
      const t = (f - x0) / (x1 - x0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(",")})`;
    }
  }
  return "rgb(255,150,40)";
}

export function renderHeatmap(el, data) {
  const max = data.max_w || 1;
  const head = `<div class="hm-row hm-head"><span></span>${Array.from({ length: 24 }, (_, h) =>
    `<span>${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>`).join("")}</div>`;
  const rows = data.days.map((d) => {
    const cells = d.hours.map((c, h) => {
      if (!c) return `<span class="hm-cell empty" title="${d.label} ${h}:00 - no data"></span>`;
      const f = Math.sqrt(c.w / max);
      const style = c.asleep ? "" : `background:${heatColor(f)};box-shadow:0 0 ${Math.round(f * 12)}px ${heatColor(f)}55`;
      return `<span class="hm-cell${c.asleep ? " asleep" : ""}" style="${style}" title="${d.label} ${String(h).padStart(2, "0")}:00 · ${c.w} W avg · ${(c.kwh * 1000).toFixed(0)} Wh${c.asleep ? " · asleep" : ""}"></span>`;
    }).join("");
    return `<div class="hm-row"><span class="hm-label">${d.label}</span>${cells}</div>`;
  }).join("");
  el.innerHTML = head + rows;
}
