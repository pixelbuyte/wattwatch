// Scroll-driven camera flight through the set, live component callouts, and load presets.
import * as THREE from "three";
import { World } from "./world.js";

const $ = (id) => document.getElementById(id);
const canvas = $("gl");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = Math.min(innerWidth, innerHeight) < 640;
// ?capture renders only on demand (window.__step) - used for screenshots and the film render.
const capture = new URLSearchParams(location.search).has("capture");

let world;
try {
  world = new World(canvas, {
    width: innerWidth, height: innerHeight,
    pixelRatio: capture ? 1 : Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75),
    quality: small ? "low" : "high",
    dashboardUrl: "../assets/dashboard.webp",
  });
} catch (e) {
  document.body.classList.add("no-webgl");
  $("loader").querySelector("p").textContent = "This page needs WebGL, which your browser has turned off.";
  throw e;
}

// ---------------------------------------------------------------- camera keyframes, one per section
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const KEYS = [
  { pos: V(1.35, 1.62, 2.05), tgt: V(0.12, 1.12, -0.05), fov: 34 },   // 0 hero
  { pos: V(1.38, 1.1, -0.12), tgt: V(1.03, 1.0, -0.58), fov: 30 },     // 1 socket + smart plug
  { pos: V(1.12, 1.02, 0.42), tgt: V(0.72, 0.84, -0.32), fov: 34 },    // 2 cable into the PC
  { pos: V(0.02, 1.16, 0.5), tgt: V(0.66, 0.98, -0.1), fov: 36 },      // 3 through the glass
  { pos: V(0.12, 0.98, 0.5), tgt: V(0.6, 0.84, -0.06), fov: 32 },      // 4 PSU heat
  { pos: V(-0.42, 1.46, 1.05), tgt: V(0.26, 1.28, -0.02), fov: 32 },   // 5 the orb
  { pos: V(0.95, 2.05, 2.75), tgt: V(0.1, 1.05, -0.1), fov: 34 },      // 6 pull back
];
const posCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => k.pos), false, "centripetal");
const tgtCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => k.tgt), false, "centripetal");
const N = KEYS.length - 1;

// ---------------------------------------------------------------- callouts
const CALLOUTS = [
  { id: "plug", obj: world.plugAnchor, sec: [0.6, 1.6], label: "Smart plug", value: (w) => `${w.toFixed(1)} W measured` },
  { id: "cable", obj: world.cableAnchor, sec: [1.5, 2.6], label: "Power cable", value: (w) => `${(w / 230).toFixed(2)} A @ 230 V` },
  { id: "cpu", obj: world.pc.anchors.cpu, sec: [2.6, 3.7], label: "CPU · RAPL sensor", value: (w, p) => `${p.cpu.toFixed(1)} W` },
  { id: "gpu", obj: world.pc.anchors.gpu, sec: [2.6, 3.7], label: "GPU · NVML sensor", value: (w, p) => `${p.gpu.toFixed(1)} W` },
  { id: "ram", obj: world.pc.anchors.ram, sec: [2.6, 3.7], label: "Memory · modelled", value: (w, p) => `${p.ram.toFixed(1)} W` },
  { id: "fans", obj: world.pc.anchors.fans, sec: [2.6, 3.7], label: "Fans · modelled", value: (w, p) => `${p.fans.toFixed(1)} W` },
  { id: "psu", obj: world.pc.anchors.psu, sec: [3.5, 4.6], label: "PSU heat loss", value: (w, p) => `${p.loss.toFixed(1)} W · ${Math.round(world.lossFrac * 100)}%` },
];
const layer = $("callouts");
for (const c of CALLOUTS) {
  const el = document.createElement("div");
  el.className = `callout ${c.id}`;
  el.innerHTML = `<i></i><div><span>${c.label}</span><b>—</b></div>`;
  layer.appendChild(el);
  c.el = el;
  c.b = el.querySelector("b");
}

function breakdown(w) {
  const loss = w * world.lossFrac;
  const dc = w - loss;
  const f = Math.min(1, w / 430);
  const gpuShare = 0.12 + f * 0.5;
  const fixed = 16 + 2.4 + 4.5;
  const rest = Math.max(dc - fixed, 4);
  const fans = 1.2 + f * 6;
  return { loss, gpu: rest * gpuShare, cpu: rest * (1 - gpuShare) - fans, ram: 4.2 + f * 3, fans };
}

// ---------------------------------------------------------------- load presets
const PRESETS = { idle: 72, browse: 118, game: 340, render: 420 };
let presetName = "idle";
function setPreset(name) {
  presetName = name;
  world.setWatts(PRESETS[name]);
  document.querySelectorAll("[data-load]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.load === name)));
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-load]");
  if (b) setPreset(b.dataset.load);
});
setPreset("idle");

// ---------------------------------------------------------------- scroll + pointer
let scrollP = 0, smoothP = 0;
const sections = [...document.querySelectorAll(".sec")];
function readScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollP = max > 0 ? (scrollY / max) * N : 0;
}
addEventListener("scroll", readScroll, { passive: true });
readScroll();
smoothP = scrollP;
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener("pointermove", (e) => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; });

addEventListener("resize", () => world.resize(innerWidth, innerHeight));

// ---------------------------------------------------------------- HUD
const RATE = 0.17;
const hud = { w: $("hudW"), cost: $("hudCost"), year: $("hudYear"), bar: $("hudBar") };

// ---------------------------------------------------------------- loop
let last = performance.now(), t = 0, frames = 0, ready = false;
const tmp = {};
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt, true);
  requestAnimationFrame(frame);
}
function step(dt, draw) {
  t += dt * (reduced ? 0.4 : 1);
  smoothP += (scrollP - smoothP) * (1 - Math.pow(reduced ? 0.0001 : 0.02, dt));
  if (capture) smoothP = scrollP;
  const u = Math.min(1, Math.max(0, smoothP / N));
  posCurve.getPoint(u, world.camera.position);
  tgtCurve.getPoint(u, world.target);
  const i0 = Math.floor(Math.min(smoothP, N - 1e-6)), fr = smoothP - i0;
  const fov = KEYS[i0].fov + (KEYS[Math.min(N, i0 + 1)].fov - KEYS[i0].fov) * fr;
  if (Math.abs(world.camera.fov - fov) > 0.01) { world.camera.fov = fov; world.camera.updateProjectionMatrix(); }
  mouse.sx += (mouse.x - mouse.sx) * 0.05; mouse.sy += (mouse.y - mouse.sy) * 0.05;
  if (!reduced) {
    world.camera.position.x += mouse.sx * 0.06 + Math.sin(t * 0.3) * 0.006;
    world.camera.position.y += -mouse.sy * 0.04 + Math.sin(t * 0.23) * 0.005;
  }
  world.update(t, dt);
  if (!draw) return;
  world.render();

  // callouts
  const w = world.shownWatts, parts = breakdown(w);
  for (const c of CALLOUTS) {
    const [a, b] = c.sec;
    const vis = smoothP > a && smoothP < b;
    world.project(c.obj, tmp);
    const show = vis && tmp.visible;
    c.el.classList.toggle("on", show);
    if (show) {
      c.el.style.transform = `translate(${(tmp.x * innerWidth).toFixed(1)}px, ${(tmp.y * innerHeight).toFixed(1)}px)`;
      c.b.textContent = c.value(w, parts);
    }
  }
  // section text fades
  sections.forEach((s, i) => {
    const d = Math.abs(smoothP - i);
    s.style.setProperty("--vis", Math.max(0, 1 - d * 1.6).toFixed(3));
  });
  // HUD
  hud.w.textContent = w.toFixed(w >= 100 ? 0 : 1);
  hud.cost.textContent = `$${(w / 1000 * RATE).toFixed(4)}/h`;
  hud.year.textContent = `$${Math.round(w * 8.76 * RATE)}/yr if it never sleeps`;
  hud.bar.style.width = `${(world.load01 * 100).toFixed(1)}%`;
  hud.bar.style.background = `#${world.color.getHexString(THREE.SRGBColorSpace)}`;
  $("orbW").textContent = Math.round(w);
  $("orbYear").textContent = `$${Math.round(w * 8.76 * RATE)}`;

  if (!ready && (++frames > 2 || capture)) {
    ready = true;
    document.body.classList.add("ready");
  }
}
if (capture) {
  document.body.classList.add("capture");
  window.__world = world;
  // simulate `seconds` of time at 30 fps, then draw one frame
  window.__step = (seconds = 0) => {
    readScroll();
    const n = Math.max(1, Math.round(seconds * 30));
    for (let i = 0; i < n - 1; i++) step(1 / 30, false);
    step(1 / 30, true);
    return world.shownWatts;
  };
  window.__step(0);
} else {
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => { last = performance.now(); });
