// The whole set: a desk in a dark room, a glass PC, a wall socket with a metering smart plug,
// a power cable carrying pulses of energy, a monitor running WattWatch, and the plasma orb.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { PlasmaOrb, loadColor } from "./orb.js";
import { buildPC, PC_SIZE } from "./pc.js";
import { mulberry32 } from "./glsl.js";

export const PEAK_W = 430;
export const DESK_Y = 0.75;
export const PC_POS = new THREE.Vector3(0.6, DESK_Y + 0.02, -0.06);
export const ORB_POS = new THREE.Vector3(0.02, 1.36, 0.0);
export const PLUG_POS = new THREE.Vector3(1.05, 1.02, -0.585);

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

function woodTexture() {
  const rng = mulberry32(3);
  return canvasTex(2048, 1024, (g, w, h) => {
    g.fillStyle = "#24160f"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      const n = Math.sin(y * 0.021) * 0.5 + Math.sin(y * 0.0057 + 1.3) * 0.8 + Math.sin(y * 0.11) * 0.15;
      const l = 14 + n * 6 + rng() * 2.5;
      g.fillStyle = `hsl(22, 38%, ${l}%)`;
      g.fillRect(0, y, w, 2);
    }
    g.globalAlpha = 0.18;
    for (let i = 0; i < 900; i++) {
      const y = rng() * h, x = rng() * w, len = 40 + rng() * 260;
      g.strokeStyle = rng() < 0.5 ? "#0c0704" : "#3a2418";
      g.lineWidth = 0.6 + rng() * 1.6;
      g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + len * 0.3, y + (rng() - 0.5) * 6, x + len * 0.6, y + (rng() - 0.5) * 6, x + len, y); g.stroke();
    }
    g.globalAlpha = 1;
  });
}

function plasterTexture() {
  const rng = mulberry32(5);
  return canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = "#151824"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) {
      const v = Math.floor(rng() * 30);
      g.fillStyle = `rgba(${v + 10},${v + 12},${v + 22},${0.12 + rng() * 0.2})`;
      g.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1 + rng() * 3);
    }
  });
}

export class World {
  constructor(canvas, { width, height, pixelRatio = Math.min(devicePixelRatio || 1, 2), quality = "high", dashboardUrl } = {}) {
    this.quality = quality;
    this.rng = mulberry32(11);
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== "low", powerPreference: "high-performance",
      preserveDrawingBuffer: false }));
    r.setPixelRatio(pixelRatio);
    r.setSize(width, height, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    RectAreaLightUniformsLib.init();

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x030409);
    scene.fog = new THREE.FogExp2(0x030409, 0.07);
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(r), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(32, width / height, 0.01, 30);
    this.camera.position.set(1.2, 1.5, 2.2);
    this.target = new THREE.Vector3(0.2, 1.05, 0);

    this.watts = 72; this.targetWatts = 72;
    this.color = new THREE.Color();
    this._buildRoom(dashboardUrl);
    this._buildPower();
    this.pc = buildPC();
    this.pc.group.position.copy(PC_POS);
    scene.add(this.pc.group);
    this.orb = new PlasmaOrb({ radius: 0.115, seed: 7 });
    this.orb.group.position.copy(ORB_POS);
    this.orb.setPixelRatio(pixelRatio);
    scene.add(this.orb.group);
    this._buildBeam();
    this._buildDust();
    this._buildLights();
    this._buildPost(width, height, pixelRatio);
    // The PMREM room is only for reflections: keep it dim so the scene stays lit by the machine.
    this.scene.traverse((o) => {
      const list = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of list) if (m.envMapIntensity !== undefined && !m.userData.keepEnv) m.envMapIntensity = 0.14;
    });
  }

  // ---------------------------------------------------------------- set dressing
  _buildRoom(dashboardUrl) {
    const s = this.scene;
    // floor + back wall + side wall
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: 0x07080d, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    const plaster = plasterTexture();
    plaster.tex.wrapS = plaster.tex.wrapT = THREE.RepeatWrapping; plaster.tex.repeat.set(3, 2);
    const wallMat = new THREE.MeshStandardMaterial({ map: plaster.tex, roughness: 0.92, color: 0x8c93b0 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), wallMat);
    wall.position.set(0, 2, -0.6); wall.receiveShadow = true; s.add(wall);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), wallMat);
    side.rotation.y = Math.PI / 2; side.position.set(-1.9, 2, 2.4); s.add(side);
    // vertical acoustic slats on the wall behind the desk
    const slatMat = new THREE.MeshStandardMaterial({ color: 0x1b1310, roughness: 0.6 });
    for (let i = 0; i < 26; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.5, 0.02), slatMat);
      slat.position.set(-1.35 + i * 0.06, 1.62, -0.585); slat.castShadow = true; slat.receiveShadow = true;
      s.add(slat);
    }
    // neon strip above the slats
    this.stripMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBoost: { value: 1 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: /* glsl */ `uniform float uTime; uniform float uBoost; varying vec2 vUv;
        void main(){ vec3 a=vec3(0.13,0.94,1.0), b=vec3(0.67,0.35,1.0), c=vec3(1.0,0.24,0.95);
          float x=fract(vUv.x*0.7 + uTime*0.03);
          vec3 col = x<0.5 ? mix(a,b,x*2.0) : mix(b,c,(x-0.5)*2.0);
          gl_FragColor=vec4(col*2.6*uBoost,1.0);} `,
    });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.012, 0.012), this.stripMat);
    strip.position.set(-0.57, 2.42, -0.57); s.add(strip);

    // desk
    const wood = woodTexture();
    const deskMat = new THREE.MeshPhysicalMaterial({ map: wood.tex, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    const desk = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.045, 0.95, 4, 0.01), deskMat);
    desk.position.set(0, DESK_Y - 0.0225, -0.12); desk.receiveShadow = true; desk.castShadow = true; s.add(desk);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x0b0c10, metalness: 0.9, roughness: 0.35 });
    for (const x of [-1.1, 1.1]) for (const z of [-0.5, 0.26]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, DESK_Y - 0.045, 0.05), legMat);
      leg.position.set(x, (DESK_Y - 0.045) / 2, z); leg.castShadow = true; s.add(leg);
    }
    // desk mat
    const deskPad = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.004, 0.36, 2, 0.002),
      new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 1 }));
    deskPad.position.set(-0.32, DESK_Y + 0.002, 0.13); deskPad.receiveShadow = true; s.add(deskPad);
    const padEdge = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.0045, 0.004), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.6, 1.8) }));
    padEdge.position.set(-0.32, DESK_Y + 0.0025, 0.31); s.add(padEdge);

    // monitor running WattWatch
    const mon = new THREE.Group();
    const bezelMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0b10, metalness: 0.5, roughness: 0.4, clearcoat: 0.5 });
    const bezel = new THREE.Mesh(new RoundedBoxGeometry(0.66, 0.39, 0.025, 3, 0.006), bezelMat);
    bezel.castShadow = true;
    this.screenMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 0.95, roughness: 0.15, metalness: 0 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.635, 0.357), this.screenMat);
    screen.position.z = 0.0131;
    const fallback = canvasTex(1280, 720, (g, w, h) => {
      g.fillStyle = "#05060f"; g.fillRect(0, 0, w, h);
      const grd = g.createRadialGradient(w * 0.3, h * 0.45, 10, w * 0.3, h * 0.45, 220);
      grd.addColorStop(0, "#ffffff"); grd.addColorStop(0.3, "#aa5aff"); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.fillStyle = "#3dffa0"; g.font = "bold 90px monospace"; g.fillText("$0.4841", w * 0.58, h * 0.32);
      g.fillStyle = "#22f0ff"; g.font = "bold 40px sans-serif"; g.fillText("WattWatch", 40, 60);
    });
    this.screenMat.emissiveMap = fallback.tex;
    if (dashboardUrl) {
      new THREE.TextureLoader().load(dashboardUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
        this.screenMat.emissiveMap = tex; this.screenMat.needsUpdate = true;
      });
    }
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.025), bezelMat);
    neck.position.set(0, -0.22, -0.04); neck.castShadow = true;
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.012, 0.17, 2, 0.005), bezelMat);
    foot.position.set(0, -0.315, -0.02); foot.castShadow = true;
    mon.add(bezel, screen, neck, foot);
    mon.position.set(-0.42, DESK_Y + 0.32, -0.28);
    mon.rotation.y = 0.12;
    s.add(mon);
    this.monitor = mon;
    const screenLight = new THREE.RectAreaLight(0x9fb8ff, 2.2, 0.62, 0.35);
    screenLight.position.set(0, 0, 0.02);
    screenLight.lookAt(0, 0, 1);
    mon.add(screenLight);
    this.screenLight = screenLight;

    // keyboard
    const kb = new THREE.Group();
    const kbBase = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.018, 0.12, 3, 0.006),
      new THREE.MeshPhysicalMaterial({ color: 0x15171d, metalness: 0.9, roughness: 0.3 }));
    kbBase.castShadow = true; kbBase.receiveShadow = true;
    const capGeo = new RoundedBoxGeometry(0.0175, 0.009, 0.0175, 2, 0.003);
    const caps = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.62 }), 15 * 5 + 1);
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (let row = 0; row < 5; row++) for (let col = 0; col < 15; col++) {
      m4.makeTranslation(-0.163 + col * 0.0233 + (row % 2) * 0.004, 0.012, -0.045 + row * 0.0215);
      caps.setMatrixAt(k++, m4);
    }
    m4.compose(new THREE.Vector3(0, 0.012, 0.062), new THREE.Quaternion(), new THREE.Vector3(6, 1, 1));
    caps.setMatrixAt(k++, m4);
    caps.castShadow = true;
    this.kbGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1, 1.2), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.11), this.kbGlowMat);
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.0095;
    kb.add(kbBase, glow, caps);
    kb.position.set(-0.4, DESK_Y + 0.013, 0.12);
    kb.rotation.y = 0.05;
    s.add(kb);
    // mouse
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.03, 32, 16), new THREE.MeshPhysicalMaterial({ color: 0x111319, roughness: 0.35, clearcoat: 0.8 }));
    mouse.scale.set(1, 0.42, 1.6); mouse.position.set(-0.05, DESK_Y + 0.01, 0.14); mouse.castShadow = true;
    s.add(mouse);
    // coffee mug
    const pts = [];
    for (let i = 0; i <= 12; i++) pts.push(new THREE.Vector2(0.036 + Math.sin(i / 12 * Math.PI) * 0.002, i / 12 * 0.09));
    pts.push(new THREE.Vector2(0.032, 0.09), new THREE.Vector2(0.032, 0.006), new THREE.Vector2(0.0, 0.006));
    const mug = new THREE.Mesh(new THREE.LatheGeometry(pts, 48),
      new THREE.MeshPhysicalMaterial({ color: 0xe8e4dc, roughness: 0.32, clearcoat: 0.9, side: THREE.DoubleSide }));
    mug.position.set(-0.78, DESK_Y, 0.06); mug.castShadow = true; mug.receiveShadow = true;
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.032, 32), new THREE.MeshPhysicalMaterial({ color: 0x1a0d06, roughness: 0.08, clearcoat: 1 }));
    coffee.rotation.x = -Math.PI / 2; coffee.position.set(-0.78, DESK_Y + 0.075, 0.06);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 12, 32, Math.PI), mug.material);
    handle.rotation.z = -Math.PI / 2; handle.position.set(-0.742, DESK_Y + 0.045, 0.06); handle.castShadow = true;
    s.add(mug, coffee, handle);
  }

  _buildPower() {
    const s = this.scene;
    // wall socket faceplate
    const plate = new THREE.Mesh(new RoundedBoxGeometry(0.085, 0.13, 0.01, 3, 0.008),
      new THREE.MeshPhysicalMaterial({ color: 0xe9e9ee, roughness: 0.45, clearcoat: 0.4 }));
    plate.position.set(PLUG_POS.x, PLUG_POS.y, -0.595); plate.castShadow = true; plate.receiveShadow = true;
    s.add(plate);
    // smart plug body
    const plug = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.085, 0.04, 4, 0.014),
      new THREE.MeshPhysicalMaterial({ color: 0xf2f2f5, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }));
    body.castShadow = true;
    this.plugDisplay = canvasTex(256, 160, () => {});
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.044, 0.0275),
      new THREE.MeshBasicMaterial({ map: this.plugDisplay.tex, color: new THREE.Color(1.6, 1.6, 1.6) }));
    disp.position.set(0, 0.012, 0.0201);
    this.plugLedMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.5, 1.2) });
    const led = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0016, 8, 32), this.plugLedMat);
    led.position.set(0, -0.022, 0.0201);
    plug.add(body, disp, led);
    plug.position.set(PLUG_POS.x, PLUG_POS.y, PLUG_POS.z + 0.01);
    s.add(plug);
    this.plug = plug;
    this.plugAnchor = new THREE.Object3D(); this.plugAnchor.position.set(PLUG_POS.x, PLUG_POS.y + 0.03, PLUG_POS.z + 0.03);
    s.add(this.plugAnchor);

    // the power cable: plug -> down the wall -> across the desk -> PSU inlet
    const inlet = PC_POS.clone().add(new THREE.Vector3(0.04, 0.072, -PC_SIZE.D / 2 - 0.01));
    this.cableCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(PLUG_POS.x, PLUG_POS.y - 0.05, PLUG_POS.z + 0.022),
      new THREE.Vector3(PLUG_POS.x, PLUG_POS.y - 0.14, -0.565),
      new THREE.Vector3(1.03, DESK_Y + 0.02, -0.53),
      new THREE.Vector3(0.95, DESK_Y + 0.008, -0.46),
      new THREE.Vector3(0.78, DESK_Y + 0.008, -0.42),
      new THREE.Vector3(inlet.x + 0.06, DESK_Y + 0.012, inlet.z - 0.04),
      new THREE.Vector3(inlet.x, inlet.y - 0.02, inlet.z - 0.02),
      inlet,
    ], false, "catmullrom", 0.4);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(this.cableCurve, 220, 0.0055, 12),
      new THREE.MeshPhysicalMaterial({ color: 0x0b0c10, roughness: 0.5, clearcoat: 0.4 }));
    cable.castShadow = true; s.add(cable);
    this.pulseUniforms = { uTime: { value: 0 }, uSpeed: { value: 0.3 }, uColA: { value: new THREE.Color(0.1, 0.9, 1) },
      uColB: { value: new THREE.Color(1, 0.2, 0.9) }, uCount: { value: 4 }, uBoost: { value: 1 } };
    this.pulseMat = new THREE.ShaderMaterial({
      uniforms: this.pulseUniforms,
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uSpeed; uniform vec3 uColA; uniform vec3 uColB; uniform float uCount; uniform float uBoost;
        varying vec2 vUv;
        void main(){
          float x = vUv.x; float s = 0.0;
          for (int i = 0; i < 8; i++) {
            if (float(i) >= uCount) break;
            float c = fract(uTime*uSpeed + float(i)/uCount);
            float d = x - c;
            s += exp(-d*d*6000.0) + 0.3*exp(-d*d*400.0);
          }
          vec3 col = mix(uColA, uColB, smoothstep(0.0, 1.0, x));
          float base = 0.05;
          gl_FragColor = vec4(col*(s*1.7 + base)*uBoost, clamp(s + base, 0.0, 1.0));
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pulse = new THREE.Mesh(new THREE.TubeGeometry(this.cableCurve, 220, 0.0072, 12), this.pulseMat);
    s.add(pulse);
    this.cableAnchor = new THREE.Object3D(); this.cableAnchor.position.copy(this.cableCurve.getPoint(0.45)); s.add(this.cableAnchor);
  }

  _buildBeam() {
    // energy rising from the PC's top vent into the orb
    const from = PC_POS.clone().add(new THREE.Vector3(-0.02, PC_SIZE.H + 0.02, -0.02));
    const curve = new THREE.CatmullRomCurve3([
      from, from.clone().add(new THREE.Vector3(0, 0.12, 0.02)),
      new THREE.Vector3((from.x + ORB_POS.x) / 2 + 0.05, ORB_POS.y + 0.12, 0.03),
      ORB_POS.clone().add(new THREE.Vector3(0.12, 0.02, 0)),
    ]);
    this.beamUniforms = { ...this.pulseUniforms, uCount: { value: 3 }, uBoost: { value: 0.7 } };
    const mat = this.pulseMat.clone();
    mat.uniforms = this.beamUniforms;
    this.beamMat = mat;
    this.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.0035, 8), mat));
  }

  _buildDust() {
    const N = 1400, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos.set([-1.3 + this.rng() * 2.8, DESK_Y + this.rng() * 1.6, -0.55 + this.rng() * 1.6], i * 3);
      seed[i] = this.rng();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.dustUniforms = { uTime: { value: 0 }, uPx: { value: 1 } };
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: /* glsl */ `uniform float uTime; uniform float uPx; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position + vec3(sin(uTime*0.11 + aSeed*30.0)*0.05, sin(uTime*0.07 + aSeed*12.0)*0.04, cos(uTime*0.09 + aSeed*21.0)*0.05);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vA = 0.25 + 0.75*fract(aSeed*91.7);
          gl_PointSize = uPx * (0.6 + aSeed*1.4) * 2.2 / -mv.z;
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `varying float vA; void main(){ vec2 d=gl_PointCoord-0.5; float m=exp(-dot(d,d)*16.0);
        gl_FragColor=vec4(vec3(0.75,0.85,1.0)*m*vA*0.55, m*vA*0.4); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    pts.frustumCulled = false;
    this.scene.add(pts);
  }

  _buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x3a4466, 0x05060a, 0.12));
    const key = new THREE.SpotLight(0xbfd2ff, 26, 6, 0.55, 0.65, 1.6);
    key.position.set(-0.7, 2.75, 1.2);
    key.target.position.set(0.2, DESK_Y, -0.1);
    key.castShadow = true;
    key.shadow.mapSize.set(this.quality === "low" ? 1024 : 2048, this.quality === "low" ? 1024 : 2048);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.01;
    s.add(key, key.target);
    this.key = key;
    // fake volumetric cone for the key light
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.25, 2.4, 48, 1, true), new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(0.55, 0.65, 1.0) } },
      vertexShader: "varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }",
      fragmentShader: "uniform vec3 uCol; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float f=pow(abs(dot(vN,vV)),2.0); float a=pow(vUv.y,1.5)*0.016*f; gl_FragColor=vec4(uCol*a, a); }",
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    }));
    const dir = new THREE.Vector3().subVectors(key.target.position, key.position);
    cone.position.copy(key.position).addScaledVector(dir.clone().normalize(), 1.2);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    s.add(cone);
    // cool rim from behind-right, magenta kicker from the left
    const rim = new THREE.SpotLight(0x22f0ff, 8, 5, 0.6, 0.8, 1.5);
    rim.position.set(1.6, 2.0, -0.45); rim.target.position.set(0.5, 1.0, 0); s.add(rim, rim.target);
    const kick = new THREE.PointLight(0xff3df2, 1.6, 3, 1.8); kick.position.set(-1.2, 1.4, 0.4); s.add(kick);
    // wall wash from the neon strip
    const wash = new THREE.RectAreaLight(0x8a7bff, 4, 1.6, 0.05);
    wash.position.set(-0.57, 2.41, -0.5); wash.lookAt(-0.57, 1.2, -0.6); s.add(wash);
    this.wash = wash;
  }

  _buildPost(w, h, px) {
    const composer = (this.composer = new EffectComposer(this.renderer));
    composer.setPixelRatio(px);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloomScale = this.quality === "low" ? 0.5 : 1;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w * bloomScale, h * bloomScale), 0.7, 0.5, 0.92);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(w, h) }, uCA: { value: 0.0016 },
        uVig: { value: 1.0 }, uGrain: { value: 0.035 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; uniform float uCA; uniform float uVig; uniform float uGrain;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          vec2 c = vUv - 0.5;
          float r2 = dot(c,c);
          vec2 off = c * r2 * uCA * 40.0;
          vec3 col;
          col.r = texture2D(tDiffuse, vUv + off).r;
          col.g = texture2D(tDiffuse, vUv).g;
          col.b = texture2D(tDiffuse, vUv - off).b;
          col *= mix(1.0, smoothstep(0.95, 0.22, length(c*vec2(1.0, uRes.y/uRes.x)*1.25)), uVig);
          col += (hash(vUv*uRes + fract(uTime*7.0)*100.0) - 0.5) * uGrain;
          col = pow(col, vec3(0.98, 1.0, 1.03));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    composer.addPass(this.grade);
  }

  // ---------------------------------------------------------------- runtime
  setWatts(w) { this.targetWatts = w; }

  resize(w, h, px) {
    if (px) { this.renderer.setPixelRatio(px); this.composer.setPixelRatio(px); this.orb.setPixelRatio(px); this.dustUniforms.uPx.value = px; }
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.grade.uniforms.uRes.value.set(w, h);
  }

  _drawPlug(watts, color) {
    const g = this.plugDisplay.ctx;
    g.fillStyle = "#020408"; g.fillRect(0, 0, 256, 160);
    g.fillStyle = "#" + color.getHexString(THREE.SRGBColorSpace);
    g.font = "bold 78px monospace"; g.textAlign = "right";
    g.fillText(watts.toFixed(watts >= 100 ? 0 : 1), 196, 96);
    g.font = "bold 34px monospace"; g.fillText("W", 240, 96);
    g.fillStyle = "#6b7396"; g.font = "22px monospace"; g.textAlign = "left";
    g.fillText("LIVE · WALL", 16, 140);
    this.plugDisplay.tex.needsUpdate = true;
  }

  update(t, dt) {
    this.watts += (this.targetWatts - this.watts) * (1 - Math.pow(0.08, dt));
    const shown = this.watts * (1 + 0.012 * Math.sin(t * 2.3) + 0.008 * Math.sin(t * 5.7));
    const f = Math.min(1, shown / PEAK_W);
    loadColor(f, this.color);
    this.orb.setLoad(f);
    this.orb.update(t, dt);
    const eff = 0.72 + 0.18 * Math.min(1, f * 3);              // PSU efficiency rises with load
    this.lossFrac = 1 - eff;
    this.pc.update(t, dt, { load01: f, watts: shown, color: this.color, loss01: Math.min(1, shown * (1 - eff) / 60) });
    this.pulseUniforms.uTime.value = t;
    this.pulseUniforms.uSpeed.value = 0.12 + f * 0.9;
    this.pulseUniforms.uCount.value = 3 + Math.round(f * 4);
    this.pulseUniforms.uColB.value.copy(this.color);
    this.beamUniforms.uColA.value.copy(this.color);
    this.beamUniforms.uColB.value.copy(this.orb.colHot);
    this.stripMat.uniforms.uTime.value = t;
    this.dustUniforms.uTime.value = t;
    this.kbGlowMat.color.copy(this.color).multiplyScalar(0.8 + f);
    this.plugLedMat.color.copy(this.color).multiplyScalar(2.2);
    if (!this._plugT || t - this._plugT > 0.25 || t < this._plugT) { this._plugT = t; this._drawPlug(shown, this.color); }
    this.grade.uniforms.uTime.value = t;
    this.shownWatts = shown;
    this.load01 = f;
  }

  render() {
    this.camera.lookAt(this.target);
    this.composer.render();
  }

  project(obj, out = {}) {
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    const ndc = v.clone().project(this.camera);
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const facing = v.clone().sub(this.camera.position).dot(camDir) > 0;
    out.x = (ndc.x * 0.5 + 0.5);
    out.y = (-ndc.y * 0.5 + 0.5);
    out.visible = facing && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1;
    return out;
  }
}
