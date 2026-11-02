// The power orb: a plasma core (GLSL fbm + domain warping) inside a refractive glass shell,
// with orbiting charge particles, energy rings, electric arcs and a point light that tints the room.
import * as THREE from "three";
import { SNOISE, mulberry32 } from "./glsl.js";

// fraction-of-peak -> sRGB, same stops as the WattWatch app
const STOPS = [
  [0.0, [61, 255, 160]], [0.15, [34, 240, 255]], [0.35, [60, 140, 255]], [0.55, [170, 90, 255]],
  [0.75, [255, 61, 242]], [0.9, [255, 140, 40]], [1.0, [255, 50, 70]],
];

export function loadColor(f, out = new THREE.Color()) {
  f = Math.min(1, Math.max(0, f));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [x0, c0] = STOPS[i], [x1, c1] = STOPS[i + 1];
    if (f <= x1) {
      const t = (f - x0) / (x1 - x0);
      return out.setRGB(
        (c0[0] + (c1[0] - c0[0]) * t) / 255,
        (c0[1] + (c1[1] - c0[1]) * t) / 255,
        (c0[2] + (c1[2] - c0[2]) * t) / 255,
        THREE.SRGBColorSpace,
      );
    }
  }
  return out.setRGB(1, 50 / 255, 70 / 255, THREE.SRGBColorSpace);
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PlasmaOrb {
  constructor({ radius = 0.12, seed = 7 } = {}) {
    this.radius = radius;
    this.rng = mulberry32(seed);
    this.group = new THREE.Group();
    this.load = 0.2;
    this.colA = new THREE.Color();
    this.colB = new THREE.Color();
    this.colHot = new THREE.Color();

    // ---------------------------------------------------------------- plasma core
    this.uniforms = {
      uTime: { value: 0 },
      uLoad: { value: 0.2 },
      uColA: { value: new THREE.Color() },
      uColB: { value: new THREE.Color() },
      uColHot: { value: new THREE.Color() },
    };
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 128, 96),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          uniform float uTime; uniform float uLoad;
          varying vec3 vPos; varying vec3 vNormal; varying vec3 vView;
          ${SNOISE}
          void main(){
            vec3 p = position;
            float wob = snoise(normalize(position)*2.2 + vec3(0.0, uTime*0.6, 0.0));
            p += normal * wob * ${(radius * 0.02).toFixed(5)} * (0.4 + uLoad);
            vPos = position;
            vec4 wp = modelMatrix * vec4(p, 1.0);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vView = cameraPosition - wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uLoad;
          uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uColHot;
          varying vec3 vPos; varying vec3 vNormal; varying vec3 vView;
          ${SNOISE}
          void main(){
            vec3 nrm = normalize(vNormal);
            vec3 vd = normalize(vView);
            float ndv = max(dot(nrm, vd), 0.0);
            float sp = 0.16 + uLoad * 1.1;
            float t = uTime * sp;
            vec3 p = normalize(vPos);
            // domain-warped flow field over the sphere
            vec3 q = vec3(fbm(p*1.1 + vec3(0.0, t*0.35, 0.0)),
                          fbm(p*1.1 + vec3(5.2, 1.3, t*0.25)),
                          fbm(p*1.1 + vec3(1.7, 9.2, -t*0.3)));
            float n = fbm(p*0.95 + 1.25*q + vec3(t*0.1));
            float n2 = snoise(p*2.2 + q*1.5 + vec3(0.0, t*0.5, t*0.35));
            // thin veins of current where the warped noise crosses zero
            float w1 = 0.035 + uLoad*0.03;
            float vein  = exp(-abs(n) / w1);
            float vein2 = exp(-abs(n2) / (w1*0.7)) * smoothstep(-0.2, 0.5, q.x);
            // body: dark, lit from the inside (brighter towards the centre of the disc)
            vec3 col = uColA * 0.04 + uColB * (0.03 + 0.32 * pow(ndv, 2.5));
            col += uColB * vein * (1.1 + uLoad * 1.6);
            col += uColHot * vein2 * (0.9 + uLoad * 2.2);
            col += mix(uColB, uColHot, 0.5) * pow(1.0 - ndv, 3.0) * 1.2;   // rim light
            float pulse = 0.9 + 0.1*sin(uTime*(2.0 + uLoad*9.0));
            gl_FragColor = vec4(col * pulse, 1.0);
          }`,
      }),
    );
    this.group.add(core);
    this.core = core;

    // ---------------------------------------------------------------- glass shell
    // A custom glass shader (fresnel rim + crisp highlights, additive) instead of PBR transmission:
    // it never veils the plasma and never mirrors the studio environment as square highlights.
    this.shellUniforms = { uCol: { value: new THREE.Color() }, uTime: this.uniforms.uTime };
    this.shellMat = new THREE.ShaderMaterial({
      uniforms: this.shellUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = cameraPosition - wp.xyz;
          vP = position;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; uniform float uTime;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){
          vec3 n = normalize(vN); vec3 v = normalize(vV);
          float ndv = max(dot(n, v), 0.0);
          float fres = pow(1.0 - ndv, 4.0);
          vec3 L1 = normalize(vec3(-0.55, 0.85, 0.5));
          vec3 L2 = normalize(vec3(0.8, 0.25, -0.4));
          float s1 = pow(max(dot(n, normalize(L1 + v)), 0.0), 900.0);
          float s2 = pow(max(dot(n, normalize(L2 + v)), 0.0), 70.0);
          // thin-film shimmer along the rim
          float film = 0.5 + 0.5 * sin(dot(vP, vec3(40.0, 31.0, 23.0)) + uTime * 0.6);
          vec3 iri = mix(vec3(0.3, 0.9, 1.0), vec3(1.0, 0.35, 0.95), film);
          vec3 col = uCol * fres * 0.7 + iri * fres * 0.2 + vec3(1.0) * s1 * 1.6 + uCol * s2 * 0.3;
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.3, 96, 64), this.shellMat);
    this.group.add(shell);

    // ---------------------------------------------------------------- halo
    this.haloMat = new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2,
    });
    this.halo = new THREE.Sprite(this.haloMat);
    this.halo.scale.setScalar(radius * 7.5);
    this.group.add(this.halo);

    // ---------------------------------------------------------------- energy rings
    this.rings = [];
    const ringMat = (offset) => new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uCol: { value: new THREE.Color() }, uOff: { value: offset }, uLoad: this.uniforms.uLoad },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCol; uniform float uOff; uniform float uLoad; varying vec2 vUv;
        void main(){
          float a = fract(vUv.x*12.0 + uOff + uTime*(0.15 + uLoad*0.9));
          float dash = smoothstep(0.0, 0.08, a) * (1.0 - smoothstep(0.45, 0.6, a));
          float head = exp(-pow(fract(vUv.x - uTime*(0.1+uLoad*0.6) + uOff) - 0.5, 2.0)*120.0);
          float m = dash*0.35 + head*1.6;
          gl_FragColor = vec4(uCol * m * 2.0, m);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 3; i++) {
      const r = radius * (1.55 + i * 0.32);
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, radius * 0.008, 6, 220), ringMat(i * 0.31));
      m.rotation.set(Math.PI / 2 + (i - 1) * 0.5, i * 0.7, 0);
      this.group.add(m);
      this.rings.push(m);
    }

    // ---------------------------------------------------------------- orbiting charge (GPU animated)
    const N = 900;
    const pos = new Float32Array(N * 3), seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const r = radius * (1.45 + this.rng() * 1.6);
      pos[i * 3] = r;
      seeds.set([this.rng() * Math.PI * 2, (this.rng() - 0.5) * 1.4, 0.3 + this.rng() * 1.2, this.rng()], i * 4);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    pg.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    this.particleMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uLoad: this.uniforms.uLoad, uCol: this.uniforms.uColB, uHot: this.uniforms.uColHot,
        uPx: { value: 0.55 } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uLoad; uniform float uPx;
        attribute vec4 aSeed; varying float vA; varying float vHot;
        void main(){
          float r = position.x;
          float ang = aSeed.x + uTime * aSeed.z * (0.25 + uLoad*1.6);
          float tilt = aSeed.y;
          vec3 p = vec3(cos(ang)*r, sin(ang*1.7 + aSeed.w*6.28)*r*0.18, sin(ang)*r);
          float ct = cos(tilt), st = sin(tilt);
          p = vec3(p.x, p.y*ct - p.z*st, p.y*st + p.z*ct);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float show = step(aSeed.w, 0.25 + uLoad*0.75);
          vA = show * (0.35 + 0.65*fract(aSeed.w*13.7 + uTime*0.5));
          vHot = step(0.86, aSeed.w);
          gl_PointSize = uPx * (2.2 + 3.0*aSeed.w) * (1.0 + uLoad) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; uniform vec3 uHot; varying float vA; varying float vHot;
        void main(){
          vec2 d = gl_PointCoord - 0.5; float m = exp(-dot(d,d)*18.0);
          gl_FragColor = vec4(mix(uCol, uHot, vHot) * 2.4 * m * vA, m * vA);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.particles = new THREE.Points(pg, this.particleMat);
    this.particles.frustumCulled = false;
    this.group.add(this.particles);

    // ---------------------------------------------------------------- electric arcs
    const arcCount = 6, seg = 10;
    this.arcGeo = new THREE.BufferGeometry();
    this.arcPos = new Float32Array(arcCount * seg * 2 * 3);
    this.arcGeo.setAttribute("position", new THREE.BufferAttribute(this.arcPos, 3));
    this.arcMat = new THREE.LineBasicMaterial({ color: new THREE.Color(3, 3, 3.4), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.arcs = new THREE.LineSegments(this.arcGeo, this.arcMat);
    this.arcs.frustumCulled = false;
    this.group.add(this.arcs);
    this.arcTimer = 0;
    this.arcLife = 0;
    this.arcCount = arcCount;
    this.arcSeg = seg;

    // ---------------------------------------------------------------- light
    this.light = new THREE.PointLight(0xffffff, 2, 3.2, 1.6);
    this.group.add(this.light);

    this.setLoad(0.2, true);
  }

  setLoad(f, snap = false) {
    this.targetLoad = Math.min(1, Math.max(0, f));
    if (snap) this.load = this.targetLoad;
  }

  setPixelRatio(px) { this.particleMat.uniforms.uPx.value = px * 0.55; }

  _regenArcs() {
    const r = this.radius, rng = this.rng, seg = this.arcSeg;
    let k = 0;
    for (let a = 0; a < this.arcCount; a++) {
      const dir = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
      const side = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).cross(dir).normalize();
      let prev = dir.clone().multiplyScalar(r * 0.55);
      for (let s = 1; s <= seg; s++) {
        const t = s / seg;
        const p = dir.clone().multiplyScalar(r * (0.55 + t * 0.72))
          .addScaledVector(side, (rng() - 0.5) * r * 0.18 * Math.sin(t * Math.PI))
          .addScaledVector(new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5), r * 0.06);
        this.arcPos.set([prev.x, prev.y, prev.z, p.x, p.y, p.z], k);
        k += 6;
        prev = p;
      }
    }
    this.arcGeo.attributes.position.needsUpdate = true;
  }

  update(t, dt) {
    this.load += (this.targetLoad - this.load) * (1 - Math.pow(0.06, dt));
    const f = this.load;
    this.uniforms.uTime.value = t;
    this.uniforms.uLoad.value = f;
    loadColor(f, this.colB);
    loadColor(Math.min(1, f + 0.22), this.colHot);
    this.colA.copy(this.colB).multiplyScalar(0.35);
    this.uniforms.uColA.value.copy(this.colA);
    this.uniforms.uColB.value.copy(this.colB);
    this.uniforms.uColHot.value.copy(this.colHot);
    const pulse = 0.5 + 0.5 * Math.sin(t * (2 + f * 9));
    this.haloMat.color.copy(this.colB).multiplyScalar(0.55 + f * 0.9 + pulse * 0.2);
    this.halo.scale.setScalar(this.radius * (4.2 + f * 2.0 + pulse * 0.3));
    this.core.scale.setScalar(1 + pulse * 0.02 * (0.5 + f));
    this.shellUniforms.uCol.value.copy(this.colB);
    this.light.color.copy(this.colB);
    this.light.intensity = 1.6 + f * 5 + pulse * 0.8;
    this.rings.forEach((m, i) => {
      m.material.uniforms.uCol.value.copy(i === 1 ? this.colHot : this.colB);
      m.rotation.z += dt * (0.2 + f * 1.3) * (i % 2 ? -1 : 1);
    });
    // electric arcs, more often under load
    this.arcTimer -= dt;
    if (this.arcTimer <= 0 && f > 0.3) {
      this._regenArcs();
      this.arcLife = 0.09 + this.rng() * 0.08;
      this.arcTimer = 0.25 + (1 - f) * 1.6 * this.rng();
    }
    this.arcLife -= dt;
    this.arcMat.opacity = this.arcLife > 0 ? Math.min(1, this.arcLife * 12) * (0.4 + f) : 0;
  }
}
