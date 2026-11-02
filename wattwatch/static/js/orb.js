// The Power Orb: a pulsing plasma sphere. Colour, pulse rate, particle count and
// electric arcs all scale with how hard the machine is pulling from the wall.

const STOPS = [
  [0.0, [61, 255, 160]], [0.15, [34, 240, 255]], [0.35, [60, 140, 255]], [0.55, [170, 90, 255]],
  [0.75, [255, 61, 242]], [0.9, [255, 140, 40]], [1.0, [255, 50, 70]],
];

export function loadColor(f) {
  f = Math.max(0, Math.min(1, f));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [x0, c0] = STOPS[i], [x1, c1] = STOPS[i + 1];
    if (f >= x0 && f <= x1) {
      const t = (f - x0) / (x1 - x0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const lerp = (a, b, t) => a + (b - a) * t;

export class PowerOrb {
  constructor(canvas, { interactive = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.watts = 0;
    this.target = 0;
    this.peak = 300;
    this.phase = 0;
    this.last = performance.now();
    this.ripples = [];
    this.particles = Array.from({ length: 90 }, () => this._particle());
    this.blobs = Array.from({ length: 6 }, (_, i) => ({
      a: (i / 6) * Math.PI * 2, s: 0.25 + Math.random() * 0.5, r: 0.35 + Math.random() * 0.25,
      d: 0.25 + Math.random() * 0.3,
    }));
    this.arcs = [];
    this.hover = 0;
    this.reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (interactive) {
      canvas.addEventListener("pointerenter", () => (this.hoverTarget = 1));
      canvas.addEventListener("pointerleave", () => (this.hoverTarget = 0));
    }
    this.hoverTarget = 0;
    this.paused = false;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _particle() {
    return {
      a: Math.random() * Math.PI * 2,
      r: 1.15 + Math.random() * 0.6,
      s: (0.15 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1),
      z: Math.random(),
      size: 0.6 + Math.random() * 1.6,
    };
  }

  set(watts, peak) {
    this.target = Math.max(0, watts || 0);
    if (peak) this.peak = peak;
  }

  get fraction() {
    return Math.max(0, Math.min(1, this.watts / Math.max(this.peak, 1)));
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }

  _loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.paused || document.hidden) {
      requestAnimationFrame(this._loop);
      return;
    }
    this.watts = lerp(this.watts, this.target, 1 - Math.pow(0.04, dt));
    this.hover = lerp(this.hover, this.hoverTarget, 1 - Math.pow(0.01, dt));
    const f = this.fraction;
    const period = lerp(3.4, 0.6, Math.pow(f, 0.8));
    const prevPhase = this.phase;
    this.phase += (dt / period) * Math.PI * 2 * (this.reduced ? 0.25 : 1);
    if (Math.floor(prevPhase / (Math.PI * 2)) !== Math.floor(this.phase / (Math.PI * 2))) {
      this.ripples.push({ t: 0 });
    }
    this._draw(dt, now / 1000, f);
    requestAnimationFrame(this._loop);
  }

  _draw(dt, time, f) {
    const ctx = this.ctx;
    const [w, h] = this._resize();
    const cx = w / 2, cy = h / 2;
    const base = Math.min(w, h) * 0.27;
    const pulse = 0.5 + 0.5 * Math.sin(this.phase);
    const R = base * (0.94 + 0.05 * pulse * (0.4 + f) + 0.03 * this.hover);
    const col = loadColor(f);
    const hot = loadColor(Math.min(1, f + 0.18));
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    // outer halo
    const haloR = Math.min(R * (2.1 + 0.3 * f), Math.min(w, h) / 2 - 2);
    let g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, haloR);
    g.addColorStop(0, rgba(col, 0.30 + 0.20 * pulse));
    g.addColorStop(0.45, rgba(col, 0.10 + 0.06 * pulse));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ripples emitted on each beat
    this.ripples = this.ripples.filter((r) => r.t < 1);
    for (const r of this.ripples) {
      r.t += dt * 0.7;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1 + r.t * 0.9), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(col, 0.45 * (1 - r.t));
      ctx.lineWidth = 2 * (1 - r.t) + 0.5;
      ctx.stroke();
    }

    // rotating dashed rings
    const ringSpeed = 0.15 + f * 1.4;
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(time * ringSpeed * (i % 2 ? -1 : 1) * (1 + i * 0.35));
      ctx.beginPath();
      ctx.setLineDash(i === 0 ? [R * 0.08, R * 0.05] : i === 1 ? [2, R * 0.12] : [R * 0.4, R * 0.25]);
      ctx.arc(0, 0, R * (1.22 + i * 0.16), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(i === 1 ? hot : col, 0.35 - i * 0.08);
      ctx.lineWidth = i === 1 ? 2.5 : 1.2;
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);

    // orbiting particles - more of them, faster, when the load is high
    const visible = Math.round(18 + f * 72);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.a += p.s * dt * (0.6 + f * 2.2);
      if (i >= visible) continue;
      const rr = R * p.r * (1 + 0.04 * Math.sin(time * 2 + i));
      const x = cx + Math.cos(p.a) * rr;
      const y = cy + Math.sin(p.a) * rr * (0.55 + 0.45 * p.z);
      const a = 0.25 + 0.6 * p.z;
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 + f), 0, Math.PI * 2);
      ctx.fillStyle = rgba(i % 5 === 0 ? hot : col, a);
      ctx.fill();
    }

    // the sphere itself
    ctx.globalCompositeOperation = "source-over";
    g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.18, rgba(hot, 0.95));
    g.addColorStop(0.6, rgba(col, 0.85));
    g.addColorStop(1, rgba(col.map((v) => v * 0.25), 0.95));
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.shadowColor = rgba(col, 0.9);
    ctx.shadowBlur = 40 + 30 * pulse;
    ctx.fill();
    ctx.shadowBlur = 0;

    // swirling plasma inside the sphere
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.blobs) {
      const a = b.a + time * b.s * (0.5 + f * 2);
      const x = cx + Math.cos(a) * R * b.d;
      const y = cy + Math.sin(a * 1.3) * R * b.d;
      const bg = ctx.createRadialGradient(x, y, 0, x, y, R * b.r);
      bg.addColorStop(0, rgba(hot, 0.35));
      bg.addColorStop(1, rgba(hot, 0));
      ctx.fillStyle = bg;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    // electric filaments at higher loads
    if (f > 0.25 && !this.reduced && Math.random() < f * 0.9) {
      this.arcs.push({ life: 0.12 + Math.random() * 0.15, a: Math.random() * Math.PI * 2, seed: Math.random() * 1000 });
    }
    this.arcs = this.arcs.filter((arc) => (arc.life -= dt) > 0);
    for (const arc of this.arcs) {
      ctx.beginPath();
      let x = cx, y = cy;
      ctx.moveTo(x, y);
      const steps = 7;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const jitter = (Math.sin(arc.seed + s * 12.9898) * 43758.5453) % 1;
        const ang = arc.a + jitter * 0.5;
        x = cx + Math.cos(ang) * R * t * 0.97;
        y = cy + Math.sin(ang) * R * t * 0.97;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.9, arc.life * 5)})`;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = rgba(hot, 1);
      ctx.shadowBlur = 12;
      ctx.stroke();
    }
    ctx.restore();

    // glossy rim highlight
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.995, Math.PI * 1.05, Math.PI * 1.6);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
