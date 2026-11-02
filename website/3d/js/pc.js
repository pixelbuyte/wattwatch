// A procedural tempered-glass gaming PC: chassis, motherboard, AIO cooler with a live LCD,
// RGB RAM, GPU, PSU shroud that glows with waste heat, and spinning RGB fans.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mulberry32 } from "./glsl.js";

export const PC_SIZE = { W: 0.23, H: 0.48, D: 0.46 };

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return { tex: t, canvas: c, ctx: g };
}

function pcbTexture() {
  const rng = mulberry32(42);
  return canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = "#0b1020"; g.fillRect(0, 0, w, h);
    // copper traces
    g.lineCap = "round";
    for (let i = 0; i < 260; i++) {
      g.strokeStyle = rng() < 0.15 ? "rgba(34,240,255,0.35)" : "rgba(120,140,190,0.18)";
      g.lineWidth = 1 + rng() * 2;
      let x = rng() * w, y = rng() * h;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        if (rng() < 0.5) x += (rng() - 0.5) * 260; else y += (rng() - 0.5) * 260;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // VRM heatsinks, chips, slots
    const block = (x, y, bw, bh, c) => { g.fillStyle = c; g.fillRect(x, y, bw, bh); };
    block(40, 40, 660, 90, "#151a26"); block(40, 40, 90, 520, "#151a26");     // VRM heatsinks
    for (let i = 0; i < 12; i++) block(50 + i * 52, 52, 30, 66, "#1d2433");
    block(300, 260, 300, 300, "#0e1320");                                      // CPU socket area
    for (let i = 0; i < 4; i++) block(720 + i * 40, 160, 16, 520, "#1a2030");  // DIMM slots
    block(120, 640, 820, 34, "#1a2030"); block(120, 830, 820, 26, "#1a2030"); // PCIe slots
    block(600, 880, 160, 110, "#141a28");                                      // chipset
    g.fillStyle = "rgba(34,240,255,0.55)"; g.font = "bold 34px monospace"; g.fillText("WW-Z790", 620, 950);
    for (let i = 0; i < 40; i++) { g.fillStyle = rng() < 0.5 ? "#2b3346" : "#3a2a1a"; g.fillRect(rng() * w, rng() * h, 10 + rng() * 26, 8 + rng() * 14); }
  });
}

function fanBladeGeometry(r) {
  const s = new THREE.Shape();
  s.moveTo(r * 0.28, -r * 0.06);
  s.quadraticCurveTo(r * 0.7, -r * 0.22, r * 0.97, -r * 0.02);
  s.quadraticCurveTo(r * 0.78, r * 0.2, r * 0.3, r * 0.1);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: r * 0.02, bevelEnabled: false, curveSegments: 10 });
  return geo;
}

class Fan {
  constructor(size, mats) {
    this.group = new THREE.Group();
    const r = size / 2;
    const frame = new THREE.Mesh(new RoundedBoxGeometry(size, size, size * 0.2, 2, size * 0.04), mats.fanFrame);
    frame.scale.z = 0.25;
    // cut-out illusion: dark disc + bright ring
    const well = new THREE.Mesh(new THREE.CircleGeometry(r * 0.93, 48), mats.fanWell);
    well.position.z = size * 0.026;
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x22f0ff });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.94, r * 0.035, 8, 64), this.ringMat);
    ring.position.z = size * 0.03;
    const ring2 = ring.clone(); ring2.position.z = -size * 0.03;
    this.rotor = new THREE.Group();
    this.rotor.position.z = size * 0.03;
    const blade = fanBladeGeometry(r * 0.9);
    for (let i = 0; i < 9; i++) {
      const b = new THREE.Mesh(blade, mats.blade);
      b.rotation.z = (i / 9) * Math.PI * 2;
      b.rotation.y = 0.35;
      this.rotor.add(b);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.27, r * 0.27, size * 0.06, 32), mats.hub);
    hub.rotation.x = Math.PI / 2;
    this.rotor.add(hub);
    const logo = new THREE.Mesh(new THREE.CircleGeometry(r * 0.2, 32), mats.hubLogo);
    logo.position.z = size * 0.031;
    this.rotor.add(logo);
    this.group.add(frame, well, ring, ring2, this.rotor);
    this.speed = 0;
  }
}

export function buildPC(env = {}) {
  const { W, H, D } = PC_SIZE;
  const group = new THREE.Group();
  const anchors = {};
  const mats = {
    frame: new THREE.MeshPhysicalMaterial({ color: 0x0b0d13, metalness: 0.85, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.22 }),
    frameEdge: new THREE.MeshPhysicalMaterial({ color: 0x1a1e29, metalness: 1, roughness: 0.22 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9fb4d8, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.08,
      clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 0.4, depthWrite: false, side: THREE.FrontSide }),
    tintGlass: new THREE.MeshPhysicalMaterial({ color: 0x1a2236, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.32,
      clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    inner: new THREE.MeshStandardMaterial({ color: 0x0a0c11, metalness: 0.6, roughness: 0.6 }),
    fanFrame: new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.55 }),
    fanWell: new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.9 }),
    blade: new THREE.MeshPhysicalMaterial({ color: 0xdfe8ff, roughness: 0.35, transmission: 0, transparent: true, opacity: 0.72,
      emissive: new THREE.Color(0x22f0ff), emissiveIntensity: 0.25, side: THREE.DoubleSide }),
    hub: new THREE.MeshStandardMaterial({ color: 0x111319, metalness: 0.4, roughness: 0.4 }),
    hubLogo: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.4, 1.6) }),
    shroud: new THREE.MeshPhysicalMaterial({ color: 0x1b1f2a, metalness: 0.9, roughness: 0.28, clearcoat: 0.4 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0xe9ecf5, roughness: 0.7 }),
    tube: new THREE.MeshStandardMaterial({ color: 0x0d0f15, roughness: 0.55 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 1, roughness: 0.3 }),
  };

  mats.glass.userData.keepEnv = true;
  mats.tintGlass.userData.keepEnv = true;
  // ---------------------------------------------------------------- chassis
  const box = (w, h, d, mat, x, y, z, r = 0.004) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  box(W, 0.014, D, mats.frame, 0, H - 0.007, 0, 0.006);            // top
  box(W, 0.014, D, mats.frame, 0, 0.007, 0, 0.006);                // bottom
  box(W, H, 0.012, mats.frame, 0, H / 2, -D / 2 + 0.006);          // back
  box(0.012, H, D, mats.frame, W / 2 - 0.006, H / 2, 0);           // right side
  box(0.016, H, 0.016, mats.frameEdge, -W / 2 + 0.008, H / 2, D / 2 - 0.008, 0.003); // pillars
  box(0.016, H, 0.016, mats.frameEdge, -W / 2 + 0.008, H / 2, -D / 2 + 0.008, 0.003);
  box(W, 0.016, 0.016, mats.frameEdge, 0, H - 0.008, D / 2 - 0.008, 0.003);
  box(W, 0.016, 0.016, mats.frameEdge, 0, 0.008, D / 2 - 0.008, 0.003);
  // top vent pattern
  const vent = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#0b0d13"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#020306";
    for (let y = 18; y < h; y += 22) for (let x = 18 + ((y / 22) % 2) * 11; x < w; x += 22) { g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
  });
  const ventMesh = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.8, D * 0.8),
    new THREE.MeshStandardMaterial({ map: vent.tex, metalness: 0.7, roughness: 0.5 }));
  ventMesh.rotation.x = -Math.PI / 2; ventMesh.position.set(0, H + 0.0005, -0.01);
  group.add(ventMesh);
  // feet
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.012, 24), mats.frameEdge);
    f.position.set(x * (W / 2 - 0.03), -0.006, z * (D / 2 - 0.04)); f.castShadow = true;
    group.add(f);
  }
  group.children.forEach((c) => (c.position.y += 0.012)); // lift onto feet
  const lift = 0.012;

  // glass: left side + tinted front
  const glassL = new THREE.Mesh(new RoundedBoxGeometry(0.006, H - 0.02, D - 0.02, 2, 0.003), mats.glass);
  glassL.position.set(-W / 2 + 0.003, H / 2 + lift, 0); glassL.renderOrder = 5;
  const glassF = new THREE.Mesh(new RoundedBoxGeometry(W - 0.02, H - 0.02, 0.006, 2, 0.003), mats.tintGlass);
  glassF.position.set(0, H / 2 + lift, D / 2 - 0.003); glassF.renderOrder = 5;
  group.add(glassL, glassF);

  // ---------------------------------------------------------------- interior
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(D - 0.03, H - 0.03), mats.inner);
  inner.rotation.y = -Math.PI / 2; inner.position.set(W / 2 - 0.014, H / 2 + lift, 0); inner.receiveShadow = true;
  group.add(inner);
  const pcb = pcbTexture();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.305, 0.305),
    new THREE.MeshStandardMaterial({ map: pcb.tex, roughness: 0.55, metalness: 0.3, emissiveMap: pcb.tex, emissive: 0xffffff, emissiveIntensity: 0.06 }));
  board.rotation.y = -Math.PI / 2;
  board.position.set(W / 2 - 0.016, 0.30 + lift, -0.045);
  board.receiveShadow = true;
  group.add(board);
  anchors.board = new THREE.Object3D(); anchors.board.position.set(W / 2 - 0.02, 0.43, -0.16); group.add(anchors.board);

  // AIO pump block with LCD
  const xb = W / 2 - 0.016;
  const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.038, 0.026, 48), mats.shroud);
  pump.rotation.z = Math.PI / 2; pump.position.set(xb - 0.013, 0.345 + lift, -0.06); pump.castShadow = true;
  group.add(pump);
  const lcd = canvasTex(256, 256, () => {});
  const lcdMat = new THREE.MeshBasicMaterial({ map: lcd.tex, toneMapped: true });
  const lcdMesh = new THREE.Mesh(new THREE.CircleGeometry(0.03, 48), lcdMat);
  lcdMesh.rotation.y = -Math.PI / 2; lcdMesh.position.set(xb - 0.0265, 0.345 + lift, -0.06);
  group.add(lcdMesh);
  const pumpRingMat = new THREE.MeshBasicMaterial({ color: 0x22f0ff });
  const pumpRing = new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.0022, 8, 64), pumpRingMat);
  pumpRing.rotation.y = -Math.PI / 2; pumpRing.position.set(xb - 0.027, 0.345 + lift, -0.06);
  group.add(pumpRing);
  anchors.cpu = new THREE.Object3D(); anchors.cpu.position.set(xb - 0.03, 0.375 + lift, -0.06); group.add(anchors.cpu);
  // AIO tubes to the front radiator
  for (const dz of [-0.012, 0.012]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(xb - 0.02, 0.37 + lift, -0.06 + dz), new THREE.Vector3(xb - 0.05, 0.43 + lift, -0.02 + dz),
      new THREE.Vector3(xb - 0.06, 0.445 + lift, 0.12 + dz), new THREE.Vector3(xb - 0.05, 0.43 + lift, D / 2 - 0.06 + dz),
    ]);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.0065, 12), mats.tube);
    tube.castShadow = true;
    group.add(tube);
  }

  // RAM with RGB light bars
  const ramMats = [];
  for (let i = 0; i < 4; i++) {
    const z = 0.035 + i * 0.011;
    const stick = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.13, 0.007, 2, 0.002), mats.shroud);
    stick.position.set(xb - 0.017, 0.33 + lift, z); stick.castShadow = true;
    const barMat = new THREE.MeshBasicMaterial({ color: 0xff3df2 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.124, 0.0062), barMat);
    bar.position.set(xb - 0.037, 0.33 + lift, z);
    ramMats.push(barMat);
    group.add(stick, bar);
  }
  anchors.ram = new THREE.Object3D(); anchors.ram.position.set(xb - 0.04, 0.4 + lift, 0.05); group.add(anchors.ram);

  // GPU
  const gpu = new THREE.Group();
  const gpuBody = new THREE.Mesh(new RoundedBoxGeometry(0.135, 0.052, 0.31, 3, 0.006), mats.shroud);
  gpuBody.castShadow = true;
  const backplate = new THREE.Mesh(new RoundedBoxGeometry(0.135, 0.004, 0.31, 2, 0.002), mats.frameEdge);
  backplate.position.y = 0.028;
  const gpuStripTex = canvasTex(1024, 64, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, "#22f0ff"); grd.addColorStop(0.5, "#aa5aff"); grd.addColorStop(1, "#ff3df2");
    g.fillStyle = "#05060a"; g.fillRect(0, 0, w, h);
    g.fillStyle = grd; g.fillRect(0, 22, w, 20);
    g.fillStyle = "#05060a"; g.font = "bold 30px monospace"; g.fillText("W A T T W A T C H", 330, 43);
  });
  const gpuStripMat = new THREE.MeshBasicMaterial({ map: gpuStripTex.tex, color: new THREE.Color(1.6, 1.6, 1.6) });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.018), gpuStripMat);
  strip.rotation.y = -Math.PI / 2; strip.position.set(-0.0681, 0, 0);
  gpu.add(gpuBody, backplate, strip);
  const gpuFans = [];
  for (const z of [-0.095, 0, 0.095]) {
    const fan = new Fan(0.09, mats);
    fan.group.rotation.x = Math.PI / 2; fan.group.position.set(0, -0.027, z);
    fan.group.scale.setScalar(0.95);
    gpu.add(fan.group); gpuFans.push(fan);
  }
  gpu.position.set(xb - 0.07, 0.205 + lift, -0.005);
  group.add(gpu);
  anchors.gpu = new THREE.Object3D(); anchors.gpu.position.set(xb - 0.135, 0.205 + lift, 0.06); group.add(anchors.gpu);

  // sleeved cables: 24-pin + GPU power
  const cable = (pts, r = 0.0045) => {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 40, r, 10), mats.sleeve);
    m.castShadow = true; group.add(m);
  };
  for (let i = 0; i < 4; i++) cable([[xb - 0.004, 0.11 + lift, 0.17 - i * 0.008], [xb - 0.02, 0.2 + lift, 0.175 - i * 0.008], [xb - 0.008, 0.33 + lift, 0.13 - i * 0.008]], 0.003);
  for (let i = 0; i < 3; i++) cable([[xb - 0.06 - i * 0.008, 0.11 + lift, 0.12], [xb - 0.07 - i * 0.008, 0.16 + lift, 0.09], [xb - 0.075 - i * 0.008, 0.23 + lift, 0.06]], 0.0028);

  // PSU shroud with heat slit
  const shroud = new THREE.Mesh(new RoundedBoxGeometry(W - 0.02, 0.1, D - 0.02, 2, 0.004), mats.frame);
  shroud.position.set(0, 0.062 + lift, 0); shroud.castShadow = true; shroud.receiveShadow = true;
  group.add(shroud);
  const heatMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.45, 0.08), transparent: true, opacity: 0.85 });
  const slit = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.012), heatMat);
  slit.rotation.y = -Math.PI / 2; slit.position.set(-W / 2 + 0.0095, 0.085 + lift, -0.05);
  group.add(slit);
  const logoTex = canvasTex(512, 96, (g) => {
    g.fillStyle = "rgba(0,0,0,0)"; g.clearRect(0, 0, 512, 96);
    g.fillStyle = "#cfd6ea"; g.font = "600 46px sans-serif"; g.fillText("850W · 80+ GOLD", 20, 62);
  });
  const psuLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.02), new THREE.MeshBasicMaterial({ map: logoTex.tex, transparent: true }));
  psuLabel.rotation.y = -Math.PI / 2; psuLabel.position.set(-W / 2 + 0.0095, 0.05 + lift, 0.11);
  group.add(psuLabel);
  anchors.psu = new THREE.Object3D(); anchors.psu.position.set(-W / 2 + 0.01, 0.09 + lift, -0.05); group.add(anchors.psu);

  // heat shimmer particles rising from the slit
  const HN = 120, hp = new Float32Array(HN * 3), hs = new Float32Array(HN);
  const hr = mulberry32(9);
  for (let i = 0; i < HN; i++) { hp.set([-W / 2 - 0.004, 0.085 + lift, -0.17 + hr() * 0.24], i * 3); hs[i] = hr(); }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute("position", new THREE.BufferAttribute(hp, 3));
  hg.setAttribute("aSeed", new THREE.BufferAttribute(hs, 1));
  const heatUniforms = { uTime: { value: 0 }, uHeat: { value: 0.3 } };
  const heat = new THREE.Points(hg, new THREE.ShaderMaterial({
    uniforms: heatUniforms,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uHeat; attribute float aSeed; varying float vA;
      void main(){
        float life = fract(aSeed*7.13 + uTime*(0.25 + uHeat*0.6));
        vec3 p = position + vec3(-life*0.02 - sin(life*9.0 + aSeed*40.0)*0.006, life*0.16, sin(life*6.0+aSeed*20.0)*0.01);
        vA = (1.0-life) * smoothstep(0.0, 0.15, life) * uHeat;
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = (3.0 + aSeed*4.0) / -mv.z;
        gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){ vec2 d=gl_PointCoord-0.5; float m=exp(-dot(d,d)*14.0);
        gl_FragColor = vec4(vec3(2.0,0.7,0.15)*m*vA, m*vA*0.7); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  heat.frustumCulled = false;
  group.add(heat);

  // front intake fans + rear exhaust
  const fans = [];
  for (const y of [0.185, 0.3, 0.415]) {
    const fan = new Fan(0.112, mats);
    fan.group.position.set(0, y + lift, D / 2 - 0.035);
    group.add(fan.group); fans.push(fan);
  }
  const rear = new Fan(0.112, mats);
  rear.group.rotation.y = Math.PI; rear.group.position.set(0.005, 0.38 + lift, -D / 2 + 0.03);
  group.add(rear.group); fans.push(rear);
  anchors.fans = new THREE.Object3D(); anchors.fans.position.set(-0.03, 0.42 + lift, D / 2 - 0.04); group.add(anchors.fans);
  anchors.inlet = new THREE.Object3D(); anchors.inlet.position.set(0.04, 0.06 + lift, -D / 2); group.add(anchors.inlet);

  // interior RGB lights
  const rgbA = new THREE.PointLight(0x22f0ff, 0.6, 0.6, 2); rgbA.position.set(0, 0.32 + lift, 0.16);
  const rgbB = new THREE.PointLight(0xff3df2, 0.5, 0.5, 2); rgbB.position.set(0.02, 0.4 + lift, -0.1);
  group.add(rgbA, rgbB);

  // ---------------------------------------------------------------- live LCD
  let lcdLast = -1;
  function drawLCD(watts, temp, color) {
    const g = lcd.ctx;
    g.clearRect(0, 0, 256, 256);
    const grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grd.addColorStop(0, "#0b1026"); grd.addColorStop(1, "#02030a");
    g.fillStyle = grd; g.beginPath(); g.arc(128, 128, 128, 0, 7); g.fill();
    g.strokeStyle = color; g.lineWidth = 10; g.lineCap = "round";
    g.beginPath(); g.arc(128, 128, 106, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.min(1, watts / 420)); g.stroke();
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.font = "bold 64px monospace"; g.fillText(Math.round(watts), 128, 140);
    g.fillStyle = color; g.font = "bold 26px monospace"; g.fillText("WATTS", 128, 176);
    g.fillStyle = "#8a93b8"; g.font = "22px monospace"; g.fillText(`CPU ${Math.round(temp)}°C`, 128, 92);
    lcd.tex.needsUpdate = true;
  }

  const tmpCol = new THREE.Color();
  return {
    group, anchors, fans, gpuFans,
    update(t, dt, s) {
      // s: { load01, watts, color(THREE.Color), loss01 }
      const spin = 6 + s.load01 * 60;
      fans.forEach((f, i) => { f.rotor.rotation.z += dt * spin * (1 + i * 0.03); });
      gpuFans.forEach((f, i) => { f.rotor.rotation.z -= dt * (s.load01 > 0.45 ? spin * 1.2 : 2 + s.load01 * 10) * (1 + i * 0.05); });
      // RGB: a slow wave through the palette, brighter under load
      const bright = 1.2 + s.load01 * 2.4;
      [...fans, ...gpuFans].forEach((f, i) => {
        const h = (0.5 + 0.15 * Math.sin(t * 0.6 + i * 0.7) + (i % 2) * 0.12) % 1;
        tmpCol.setHSL(h, 1, 0.55, THREE.SRGBColorSpace);
        f.ringMat.color.copy(tmpCol).multiplyScalar(bright);
      });
      mats.blade.emissive.copy(s.color);
      mats.blade.emissiveIntensity = 0.15 + s.load01 * 0.5;
      ramMats.forEach((m, i) => {
        tmpCol.setHSL((0.82 - 0.3 * (0.5 + 0.5 * Math.sin(t * 1.4 - i * 0.6))) % 1, 1, 0.55, THREE.SRGBColorSpace);
        m.color.copy(tmpCol).multiplyScalar(bright);
      });
      pumpRingMat.color.copy(s.color).multiplyScalar(bright * 1.2);
      gpuStripMat.color.setScalar(1.2 + s.load01 * 2.5);
      heatMat.color.setRGB(0.9 + s.loss01 * 1.6, 0.22 + s.loss01 * 0.25, 0.02);
      heatUniforms.uTime.value = t;
      heatUniforms.uHeat.value = 0.25 + s.loss01 * 1.2;
      rgbA.color.copy(s.color); rgbA.intensity = 0.3 + s.load01 * 1.2;
      rgbB.intensity = 0.25 + s.load01 * 0.8;
      if (Math.abs(s.watts - lcdLast) > 0.6) {
        lcdLast = s.watts;
        drawLCD(s.watts, 38 + s.load01 * 40, "#" + s.color.getHexString(THREE.SRGBColorSpace));
      }
    },
  };
}
