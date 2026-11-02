// WattWatch motion film: a deterministic 30 fps timeline over the 3D world plus kinetic type.
// Rendered frame by frame (window.__renderFrame(i)) by a headless browser, then encoded with ffmpeg.
import * as THREE from "three";
import { World, ORB_POS, PLUG_POS } from "./world.js";

export const FPS = 30;
export const DURATION = 29;
const W = 1920, H = 1080;
const $ = (id) => document.getElementById(id);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a, b, t) => a + (b - a) * t;

const world = new World($("gl"), { width: W, height: H, pixelRatio: 1, quality: "high", dashboardUrl: "../assets/dashboard.webp" });
world.watts = 4;
world.setWatts(4);

// ---------------------------------------------------------------- shots
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
const cable = world.cableCurve;
const SHOTS = [
  { name: "A", t0: 0, t1: 4.2, cam(u) {
      const a = lerp(-1.05, -0.62, easeInOut(u)), r = lerp(0.78, 0.6, easeInOut(u));
      // aim left of the orb so it sits on the right third, clear of the title
      const right = V(Math.cos(a), 0, -Math.sin(a));
      return { pos: V(ORB_POS.x + Math.sin(a) * r, ORB_POS.y + lerp(0.1, 0.02, u), ORB_POS.z + Math.cos(a) * r),
        tgt: ORB_POS.clone().addScaledVector(right, -0.2).add(V(0, -0.01, 0)), fov: 32 };
    } },
  { name: "B", t0: 4.2, t1: 8.2, cam(u) {
      const e = easeInOut(u);
      return { pos: V(lerp(1.62, 1.33, e), lerp(1.16, 1.07, e), lerp(0.1, -0.2, e)),
        tgt: V(PLUG_POS.x - 0.09, PLUG_POS.y - 0.05, PLUG_POS.z), fov: 30 };
    } },
  { name: "C", t0: 8.2, t1: 12.2, cam(u) {
      const e = easeInOut(u);
      cable.getPoint(lerp(0.12, 0.8, e), tmpA);
      cable.getPoint(Math.min(1, lerp(0.12, 0.8, e) + 0.18), tmpB);
      return { pos: tmpA.clone().add(V(0.16, 0.12, 0.3)), tgt: tmpB.clone(), fov: 34 };
    } },
  { name: "D", t0: 12.2, t1: 16.6, cam(u) {
      const e = easeInOut(u);
      return { pos: V(lerp(-0.02, 0.12, e), lerp(1.15, 1.07, e), lerp(0.58, 0.42, e)),
        tgt: V(lerp(0.66, 0.62, e), lerp(1.0, 0.96, e), lerp(-0.1, -0.05, e)), fov: 36 };
    } },
  { name: "E", t0: 16.6, t1: 21.4, cam(u) {
      const e = easeInOut(u);
      return { pos: V(lerp(-0.62, -0.42, e), lerp(1.52, 1.45, e), lerp(1.32, 1.06, e)),
        tgt: V(0.3, 1.2, -0.06), fov: 32 };
    } },
  { name: "F", t0: 21.4, t1: 29, cam(u) {
      const e = easeInOut(clamp01(u * 1.4));
      return { pos: V(lerp(0.85, 1.1, e), lerp(1.75, 2.05, e), lerp(2.1, 2.95, e)), tgt: V(0.1, 1.05, -0.1), fov: 34 };
    } },
];
function shotAt(t) { return SHOTS.find((s) => t >= s.t0 && t < s.t1) || SHOTS[SHOTS.length - 1]; }

function wattsAt(t) {
  if (t < 0.4) return 4;
  if (t < 17.3) return 72;
  if (t < 19.3) return 340;
  if (t < 21.6) return 420;
  return 72;
}

// ---------------------------------------------------------------- callouts (shot D)
const calloutDefs = [
  { obj: world.pc.anchors.cpu, label: "CPU · RAPL sensor", key: "cpu", tin: 12.9 },
  { obj: world.pc.anchors.ram, label: "Memory · modelled", key: "ram", tin: 13.25 },
  { obj: world.pc.anchors.fans, label: "Fans · modelled", key: "fans", tin: 13.6 },
  { obj: world.pc.anchors.gpu, label: "GPU · NVML sensor", key: "gpu", tin: 13.95 },
  { obj: world.pc.anchors.psu, label: "PSU heat loss", key: "loss", tin: 14.3, cls: "psu" },
];
for (const c of calloutDefs) {
  const el = document.createElement("div");
  el.className = `callout ${c.cls || ""}`;
  el.innerHTML = `<i></i><div><span>${c.label}</span><b>—</b></div>`;
  $("callouts").appendChild(el);
  c.el = el; c.b = el.querySelector("b");
}
function breakdown(w) {
  const loss = w * world.lossFrac, dc = w - loss, f = Math.min(1, w / 430);
  const gpuShare = 0.12 + f * 0.5, rest = Math.max(dc - 22.9, 4), fans = 1.2 + f * 6;
  return { loss, gpu: rest * gpuShare, cpu: rest * (1 - gpuShare) - fans, ram: 4.2 + f * 3, fans };
}

// ---------------------------------------------------------------- kinetic type
function lines(el, t, tin, tout, stagger = 0.13, dur = 0.75) {
  const spans = el.querySelectorAll(".line > span");
  const on = t > tin - 0.05 && t < tout + 0.9;
  el.style.visibility = on ? "visible" : "hidden";
  if (!on) return;
  spans.forEach((s, i) => {
    const a = easeOut((t - tin - i * stagger) / dur);
    const b = easeInOut((t - tout - i * stagger * 0.5) / 0.5);
    s.style.transform = `translateY(${((1 - a) * 115 - b * 115).toFixed(2)}%)`;
  });
}
function kick(el, t, tin, tout) {
  const a = easeOut((t - tin) / 0.6), b = easeInOut((t - tout) / 0.4);
  el.style.opacity = (a * (1 - b)).toFixed(3);
  el.style.letterSpacing = `${(0.5 - 0.22 * a).toFixed(3)}em`;
}
function fadeEl(el, t, tin, tout, d = 0.5) {
  const o = easeOut((t - tin) / d) * (1 - easeInOut((t - tout) / d));
  el.style.opacity = o.toFixed(3);
  el.style.transform = `translateY(${((1 - easeOut((t - tin) / d)) * 30).toFixed(1)}px)`;
}

const RATE = 0.17;
function overlays(t) {
  kick($("aKick"), t, 0.6, 3.7); lines($("aTitle"), t, 0.75, 3.65);
  kick($("bKick"), t, 4.7, 7.7); lines($("bTitle"), t, 4.85, 7.65);
  kick($("cKick"), t, 8.7, 11.7); lines($("cTitle"), t, 8.85, 11.6, 0.32);
  kick($("dKick"), t, 12.6, 16.1); lines($("dTitle"), t, 12.75, 16.05);
  lines($("eTitle"), t, 17.0, 20.9, 0.5);
  fadeEl($("eHud"), t, 16.9, 21.0);
  kick($("fKick"), t, 21.9, 25.0); lines($("fTitle"), t, 22.0, 25.0); fadeEl($("fSub"), t, 23.0, 25.0);

  const w = world.shownWatts;
  $("eW").textContent = Math.round(w);
  $("eMode").textContent = w > 380 ? "Rendering" : w > 200 ? "Gaming" : w > 100 ? "Ramping up" : "Idle";
  $("eCost").textContent = `$${(w / 1000 * RATE).toFixed(3)}/h`;
  $("eYear").textContent = `$${Math.round(w * 8.76 * RATE)}/yr`;
  $("eMeter").style.width = `${(world.load01 * 100).toFixed(1)}%`;
  $("eMeter").style.background = `#${world.color.getHexString(THREE.SRGBColorSpace)}`;
  $("eWord").textContent = w > 380 ? "It runs hot." : w > 200 ? "The orb feels it." : "The orb feels it.";
  const never = Math.round(72 * 8.76 * RATE), sleeps = Math.round(((72 * 16 + 2 * 8) / 24) * 8.76 * RATE);
  $("fYear").textContent = `$${never}`;
  $("fSave").textContent = `$${never - sleeps}`;

  const parts = breakdown(w), tmp = {};
  for (const c of calloutDefs) {
    const a = easeOut((t - c.tin) / 0.45), b = easeInOut((t - 16.1) / 0.4);
    const o = t > 12.2 && t < 16.6 ? a * (1 - b) : 0;
    world.project(c.obj, tmp);
    c.el.style.opacity = (tmp.visible ? o : 0).toFixed(3);
    c.el.style.transform = `translate(${(tmp.x * W).toFixed(1)}px, ${(tmp.y * H).toFixed(1)}px) scale(${(0.85 + 0.15 * a).toFixed(3)})`;
    c.b.textContent = `${parts[c.key].toFixed(1)} W`;
  }

  // cuts: a short light flash at each shot boundary
  let flash = 0;
  for (const s of SHOTS.slice(1)) {
    const d = t - s.t0;
    if (d >= 0 && d < 0.35) flash = Math.max(flash, (1 - d / 0.35) * 0.55);
  }
  $("flash").style.opacity = flash.toFixed(3);
  $("end").style.opacity = (easeOut((t - 25.4) / 0.9)).toFixed(3);
  $("fade").style.opacity = Math.max(1 - easeOut(t / 0.8), easeInOut((t - 28.1) / 0.85)).toFixed(3);
}

// ---------------------------------------------------------------- frame driver
let simT = 0;
let started = false;
function applyCamera(t) {
  const s = shotAt(t);
  const u = (t - s.t0) / (s.t1 - s.t0);
  const c = s.cam(clamp01(u));
  world.camera.position.copy(c.pos);
  world.target.copy(c.tgt);
  if (world.camera.fov !== c.fov) { world.camera.fov = c.fov; world.camera.updateProjectionMatrix(); }
}
window.__renderFrame = (i) => {
  const t = i / FPS;
  if (!started) { started = true; world.update(0, 1 / FPS); }
  while (simT < t - 1e-6) {
    simT += 1 / FPS;
    world.setWatts(wattsAt(simT));
    world.update(simT, 1 / FPS);
  }
  applyCamera(t);
  world.render();
  overlays(t);
  return { t, watts: world.shownWatts };
};
window.__film = { FPS, DURATION, frames: Math.round(FPS * DURATION) };
window.__ready = true;
