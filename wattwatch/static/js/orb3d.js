// The 3D Power Orb: a plasma core (GLSL simplex-noise fbm), a glass shell, an
// atmosphere, orbiting particles, dashed energy rings, beat ripples and electric
// arcs - all scaled by how hard the machine is pulling from the wall. Bloom + ACES.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadColor } from "./orb.js";

const lerp = (a, b, t) => a + (b - a) * t;

// Ashima / Stefan Gustavson 3D simplex noise (MIT) + fbm
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){
  float f=0.0, a=0.5;
  for(int i=0;i<4;i++){ f+=a*snoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; }
  return f;
}`;

const PLASMA_VERT = /* glsl */ `
uniform float uTime; uniform float uLoad;
varying vec3 vObj; varying vec3 vNormalW; varying vec3 vViewW;
${NOISE}
void main(){
  float d = snoise(normal*1.6 + vec3(0.0, uTime*0.3, 0.0)) * (0.004 + 0.012*uLoad);
  vec3 pos = position + normal*d;
  vObj = position;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const PLASMA_FRAG = /* glsl */ `
uniform float uTime; uniform float uLoad; uniform float uPulse; uniform float uHover;
uniform vec3 uCol; uniform vec3 uHot;
varying vec3 vObj; varying vec3 vNormalW; varying vec3 vViewW;
${NOISE}
void main(){
  vec3 p = normalize(vObj);
  float t = uTime;
  // latitude-dependent swirl, faster under load
  float ang = t*(0.12 + 0.55*uLoad) + p.y*(1.4 + 1.2*uLoad);
  float c = cos(ang), s = sin(ang);
  p.xz = mat2(c, -s, s, c) * p.xz;
  float turb = 0.95 + 0.9*uLoad;
  vec3 q = p*turb + vec3(0.0, t*0.10, 0.0);
  vec3 w = vec3(fbm(q + vec3(1.7, 9.2, t*0.14)), fbm(q + vec3(8.3, 2.8, -t*0.12)), fbm(q + vec3(4.1, -3.3, t*0.09)));
  float n = fbm(q*1.25 + w*(0.9 + 0.9*uLoad));
  float n2 = fbm(q*1.9 + w*0.6 + vec3(0.0, -t*0.2, t*0.05));
  float an = abs(n);
  float veins = 1.0 - smoothstep(0.0, 0.07 + 0.05*uLoad, an);   // thin hot filaments on the zero-crossings
  float glow = 1.0 - smoothstep(0.0, 0.38, an);                     // soft field around them
  float fine = (1.0 - smoothstep(0.0, 0.12, abs(n2))) * (0.2 + 0.5*uLoad);
  vec3 N = normalize(vNormalW); vec3 V = normalize(vViewW);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.6);
  // darker centre keeps the white watts readout legible; energy gathers toward the limb
  float limb = mix(0.5, 1.0, smoothstep(0.1, 0.95, 1.0 - ndv));
  vec3 col = mix(uCol*0.012, uCol*0.11, smoothstep(-0.6, 0.6, n));
  col += uCol * glow * glow * (0.1 + 0.2*uLoad) * limb;
  col += mix(uCol, uHot, 0.5) * fine * 0.3 * limb;
  col += uHot * veins * (1.2 + 1.8*uLoad) * (0.7 + 0.5*uPulse) * limb;
  col += vec3(1.0) * pow(veins, 3.0) * (0.08 + 0.5*uLoad) * limb;
  col += uCol * fres * (0.85 + 0.5*uPulse);
  col += uHot * pow(ndv, 6.0) * (0.05 + 0.07*uPulse);
  col *= 0.92 + 0.22*uHover;
  gl_FragColor = vec4(col, 1.0);
}`;

const FRESNEL_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// glass rim highlight (front faces) and soft atmosphere (back faces)
const GLASS_RIM_FRAG = /* glsl */ `
uniform vec3 uCol; uniform float uStrength;
varying vec3 vN; varying vec3 vV;
void main(){
  float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float f = pow(1.0 - ndv, 3.2);
  vec3 c = mix(uCol, vec3(1.0), 0.35) * f * uStrength;
  gl_FragColor = vec4(c, f);
}`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uCol; uniform float uStrength;
varying vec3 vN; varying vec3 vV;
void main(){
  float ndv = dot(normalize(vN), normalize(vV));   // back faces: negative toward the centre
  float i = pow(clamp(-ndv, 0.0, 1.0), 2.6);
  gl_FragColor = vec4(uCol * i * uStrength, i);
}`;

const PARTICLE_VERT = /* glsl */ `
attribute float aRadius; attribute float aAngle; attribute float aSpeed; attribute float aTilt;
attribute float aPhase; attribute float aSize; attribute float aIdx;
uniform float uSpin; uniform float uLoad; uniform float uPixelRatio; uniform float uVisible; uniform float uTime;
varying float vAlpha; varying float vHot;
void main(){
  float a = aAngle + uSpin*aSpeed;
  float r = aRadius * (1.0 + 0.03*sin(uTime*1.7 + aPhase*20.0));
  vec3 p = vec3(cos(a)*r, sin(a*0.7 + aPhase*6.28)*0.07*r, sin(a)*r);
  float c = cos(aTilt), s = sin(aTilt);
  p = vec3(p.x, p.y*c - p.z*s, p.y*s + p.z*c);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float vis = 1.0 - step(uVisible, aIdx);
  gl_PointSize = aSize * uPixelRatio * (1.0 + 0.8*uLoad) * (7.0 / -mv.z) * vis;
  vAlpha = (0.35 + 0.65*fract(aPhase*7.13)) * vis;
  vHot = step(0.8, fract(aPhase*3.7));
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uCol; uniform vec3 uHot;
varying float vAlpha; varying float vHot;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  vec3 c = mix(uCol, uHot, vHot) * 2.2;
  gl_FragColor = vec4(c * a * vAlpha, a * vAlpha);
}`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uDash; uniform float uDuty; uniform float uSpeed; uniform float uAlpha;
varying vec2 vUv;
void main(){
  float d = fract(vUv.x*uDash - uTime*uSpeed);
  float m = smoothstep(0.0, 0.04, d) * (1.0 - smoothstep(uDuty, uDuty + 0.04, d));
  gl_FragColor = vec4(uColor * m * uAlpha * 1.8, m * uAlpha);
}`;

// Bloomed light on a transparent canvas has no alpha - give it some so the glow shows on the card.
const ALPHA_GLOW = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); float a = max(c.a, max(c.r, max(c.g, c.b)));
      gl_FragColor = vec4(c.rgb, clamp(a, 0.0, 1.0)); }`,
};

function srgb(c, out) {
  return out.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}

export class PowerOrb3D {
  static isSupported() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGL2RenderingContext && c.getContext("webgl2")) || !!c.getContext("webgl");
    } catch {
      return false;
    }
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.watts = 0;
    this.target = 0;
    this.peak = 300;
    this.paused = false;
    this.phase = 0;
    this.spin = 0;
    this.time = 0;
    this.hover = 0;
    this.hoverTarget = 0;
    this.pointer = new THREE.Vector2();
    this.reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._col = new THREE.Color();
    this._hot = new THREE.Color();

    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance", premultipliedAlpha: true }));
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    r.setPixelRatio(this.dpr);

    const scene = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(r), 0.04).texture;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0, 6);
    this.root = new THREE.Group();
    scene.add(this.root);

    this._buildCore();
    this._buildParticles();
    this._buildRings();
    this._buildRipples();
    this._buildArcs();

    const isWebGL2 = r.capabilities.isWebGL2;
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: isWebGL2 ? 4 : 0 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.25, 0.82);
    // UnrealBloom's blur targets carry alpha = 1; composite the bloom into RGB only so the
    // canvas stays transparent, then ALPHA_GLOW turns the glow's brightness into coverage.
    const bm = this.bloom.blendMaterial;
    bm.blending = THREE.CustomBlending;
    bm.blendEquation = THREE.AddEquation;
    bm.blendSrc = THREE.SrcAlphaFactor;
    bm.blendDst = THREE.OneFactor;
    bm.blendSrcAlpha = THREE.ZeroFactor;
    bm.blendDstAlpha = THREE.OneFactor;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(ALPHA_GLOW));

    canvas.addEventListener("pointerenter", () => (this.hoverTarget = 1));
    canvas.addEventListener("pointerleave", () => { this.hoverTarget = 0; this.pointer.set(0, 0); });
    canvas.addEventListener("pointermove", (e) => {
      const b = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - b.left) / b.width) * 2 - 1, ((e.clientY - b.top) / b.height) * 2 - 1);
    });

    this.last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------------ build
  _buildCore() {
    this.uniforms = {
      uTime: { value: 0 }, uLoad: { value: 0 }, uPulse: { value: 0 }, uHover: { value: 0 },
      uCol: { value: new THREE.Color() }, uHot: { value: new THREE.Color() },
    };
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 160, 120),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: PLASMA_VERT, fragmentShader: PLASMA_FRAG }),
    );
    this.root.add(this.core);

    this.glass = new THREE.Mesh(
      new THREE.SphereGeometry(1.12, 96, 64),
      // black + additive = only the glass reflections are added, the plasma stays saturated
      new THREE.MeshPhysicalMaterial({
        color: 0x000000, metalness: 0, roughness: 0.05, clearcoat: 0.45, clearcoatRoughness: 0.03, specularIntensity: 0.55,
        transparent: true, blending: THREE.AdditiveBlending, envMapIntensity: 0.9, depthWrite: false, ior: 1.5,
      }),
    );
    this.glass.renderOrder = 2;
    this.root.add(this.glass);

    this.rimUniforms = { uCol: { value: new THREE.Color() }, uStrength: { value: 1 } };
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(1.125, 96, 64),
      new THREE.ShaderMaterial({ uniforms: this.rimUniforms, vertexShader: FRESNEL_VERT, fragmentShader: GLASS_RIM_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    rim.renderOrder = 3;
    this.root.add(rim);

    this.atmoUniforms = { uCol: { value: new THREE.Color() }, uStrength: { value: 1 } };
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.55, 64, 48),
      new THREE.ShaderMaterial({ uniforms: this.atmoUniforms, vertexShader: FRESNEL_VERT, fragmentShader: ATMO_FRAG,
        side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.root.add(atmo);
  }

  _buildParticles() {
    const N = (this.particleCount = 900);
    const g = new THREE.BufferGeometry();
    const attr = (name, fn) => {
      const a = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = fn(i);
      g.setAttribute(name, new THREE.BufferAttribute(a, 1));
    };
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    attr("aRadius", () => 1.25 + Math.pow(Math.random(), 1.6) * 0.95);
    attr("aAngle", () => Math.random() * Math.PI * 2);
    attr("aSpeed", () => (0.25 + Math.random() * 0.75) * (Math.random() < 0.82 ? 1 : -1));
    attr("aTilt", () => (Math.random() - 0.5) * 1.1 + (Math.random() < 0.5 ? 0.35 : -0.25));
    attr("aPhase", () => Math.random());
    attr("aSize", () => 0.6 + Math.random() * 1.9);
    attr("aIdx", (i) => i / N);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    this.pUniforms = {
      uSpin: { value: 0 }, uLoad: { value: 0 }, uPixelRatio: { value: this.dpr }, uVisible: { value: 0.2 }, uTime: { value: 0 },
      uCol: this.uniforms.uCol, uHot: this.uniforms.uHot,
    };
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.pUniforms, vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    pts.renderOrder = 4;
    this.root.add(pts);
  }

  _buildRings() {
    this.rings = [];
    const defs = [
      { r: 1.36, tube: 0.006, dash: 46, duty: 0.55, speed: 0.08, tilt: [1.25, 0.15, 0], alpha: 0.55, hot: false },
      { r: 1.52, tube: 0.004, dash: 140, duty: 0.18, speed: -0.12, tilt: [1.45, -0.35, 0.2], alpha: 0.75, hot: true },
      { r: 1.7, tube: 0.005, dash: 9, duty: 0.6, speed: 0.04, tilt: [1.05, 0.55, -0.3], alpha: 0.35, hot: false },
    ];
    for (const d of defs) {
      const u = {
        uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uDash: { value: d.dash }, uDuty: { value: d.duty },
        uSpeed: { value: d.speed }, uAlpha: { value: d.alpha },
      };
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(d.r, d.tube, 8, 360),
        new THREE.ShaderMaterial({ uniforms: u, vertexShader: RING_VERT, fragmentShader: RING_FRAG,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      mesh.rotation.set(...d.tilt);
      mesh.renderOrder = 5;
      this.root.add(mesh);
      this.rings.push({ mesh, u, def: d });
    }
  }

  _buildRipples() {
    this.ripples = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.985, 1.0, 160),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      m.renderOrder = 1;
      this.scene.add(m); // stays facing the camera, outside the tilting root
      this.ripples.push({ mesh: m, t: 1 });
    }
  }

  _buildArcs() {
    this.arcs = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      line.visible = false;
      line.renderOrder = 6;
      this.root.add(line);
      this.arcs.push({ line, life: 0 });
    }
  }

  _spawnArc(hot) {
    const arc = this.arcs.find((a) => a.life <= 0);
    if (!arc) return;
    const dir = new THREE.Vector3().randomDirection();
    if (dir.z < -0.2) dir.z = -dir.z; // mostly on the visible hemisphere
    const tangent = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0.3)).normalize();
    const bitan = new THREE.Vector3().crossVectors(dir, tangent).normalize();
    const pos = arc.line.geometry.attributes.position;
    const reach = 1.12 + Math.random() * 0.55;
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const r = lerp(1.0, reach, t);
      const j = (i === 0 ? 0 : 0.09) * (1 - t * 0.3);
      const p = dir.clone().multiplyScalar(r)
        .addScaledVector(tangent, (Math.random() - 0.5) * j)
        .addScaledVector(bitan, (Math.random() - 0.5) * j);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    arc.line.geometry.computeBoundingSphere();
    arc.life = arc.max = 0.08 + Math.random() * 0.16;
    arc.line.material.color.copy(hot).lerp(new THREE.Color(1, 1, 1), 0.55).multiplyScalar(3.5);
    arc.line.visible = true;
  }

  // ------------------------------------------------------------------ API
  set(watts, peak) {
    this.target = Math.max(0, watts || 0);
    if (peak) this.peak = peak;
  }

  get fraction() {
    return Math.max(0, Math.min(1, this.watts / Math.max(this.peak, 1)));
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return false;
    if (w !== this._w || h !== this._h) {
      this._w = w;
      this._h = h;
      this.renderer.setSize(w, h, false);
      this.composer.setPixelRatio(this.dpr);
      this.composer.setSize(w, h);
      const aspect = w / h;
      this.camera.aspect = aspect;
      // keep the orb at ~54 % of the shorter side, like the 2D orb
      const halfTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const need = 1.0 / 0.54;
      this.camera.position.z = Math.max(need / halfTan, need / (halfTan * aspect));
      this.camera.updateProjectionMatrix();
    }
    return true;
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.paused || document.hidden) return;
    if (!this._resize()) return;
    const speed = this.reduced ? 0.25 : 1;
    this.time += dt * speed;
    this.watts = lerp(this.watts, this.target, 1 - Math.pow(0.04, dt));
    this.hover = lerp(this.hover, this.hoverTarget, 1 - Math.pow(0.01, dt));
    const f = this.fraction;

    // heartbeat
    const period = lerp(3.4, 0.6, Math.pow(f, 0.8));
    const prev = this.phase;
    this.phase += (dt / period) * Math.PI * 2 * speed;
    const beat = Math.floor(prev / (Math.PI * 2)) !== Math.floor(this.phase / (Math.PI * 2));
    const pulse = 0.5 + 0.5 * Math.sin(this.phase);

    const col = srgb(loadColor(f), this._col);
    const hot = srgb(loadColor(Math.min(1, f + 0.18)), this._hot);
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uLoad.value = f;
    u.uPulse.value = pulse;
    u.uHover.value = this.hover;
    u.uCol.value.copy(col);
    u.uHot.value.copy(hot);
    this.rimUniforms.uCol.value.copy(col);
    this.rimUniforms.uStrength.value = 0.32 + 0.22 * pulse;
    this.atmoUniforms.uCol.value.copy(col);
    this.atmoUniforms.uStrength.value = 0.2 + 0.12 * pulse + 0.15 * f;

    const s = 0.965 + 0.045 * pulse * (0.4 + f) + 0.025 * this.hover;
    this.core.scale.setScalar(s);
    this.core.rotation.y += dt * (0.05 + 0.25 * f) * speed;

    // particles: more and faster with load
    this.spin += dt * (0.35 + 2.4 * f) * speed;
    this.pUniforms.uSpin.value = this.spin;
    this.pUniforms.uLoad.value = f;
    this.pUniforms.uVisible.value = 0.2 + 0.8 * f;
    this.pUniforms.uTime.value = this.time;

    for (const ring of this.rings) {
      ring.u.uTime.value = this.time * (1 + 3 * f);
      ring.u.uColor.value.copy(ring.def.hot ? hot : col);
      ring.mesh.rotation.z += dt * (0.08 + 0.9 * f) * Math.sign(ring.def.speed) * speed;
    }

    // ripples on each beat
    if (beat && !this.reduced) {
      const rp = this.ripples.find((r) => r.t >= 1) || this.ripples[0];
      rp.t = 0;
      rp.mesh.visible = true;
    }
    for (const rp of this.ripples) {
      if (rp.t >= 1) continue;
      rp.t = Math.min(1, rp.t + dt * 0.75);
      const k = 1.03 + rp.t * 0.95;
      rp.mesh.scale.setScalar(k);
      rp.mesh.material.color.copy(col).multiplyScalar(1.6);
      rp.mesh.material.opacity = 0.55 * (1 - rp.t) * (1 - rp.t);
      if (rp.t >= 1) rp.mesh.visible = false;
    }

    // electric arcs at higher loads
    if (!this.reduced && f > 0.22 && Math.random() < (f - 0.15) * 0.45) this._spawnArc(hot);
    for (const a of this.arcs) {
      if (a.life <= 0) continue;
      a.life -= dt;
      a.line.material.opacity = Math.max(0, a.life / a.max) * (0.6 + 0.4 * Math.random());
      if (a.life <= 0) a.line.visible = false;
    }

    // gentle parallax toward the pointer
    this.root.rotation.x = lerp(this.root.rotation.x, this.pointer.y * 0.22 + Math.sin(this.time * 0.3) * 0.05, 1 - Math.pow(0.02, dt));
    this.root.rotation.y = lerp(this.root.rotation.y, this.pointer.x * 0.3 + Math.cos(this.time * 0.23) * 0.07, 1 - Math.pow(0.02, dt));

    this.bloom.strength = 0.32 + 0.3 * f + 0.1 * pulse;
    this.composer.render(dt);
  }
}
