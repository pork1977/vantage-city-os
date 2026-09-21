// The holographic overlay: a second WebGL canvas stacked over MapLibre, driven by MapLibre's own
// camera matrix every frame, rendered through bloom and composited with mix-blend-mode: screen
// (black = transparent, light adds — exactly how a hologram behaves).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Final pass: derive alpha from brightness so the canvas composites over the map as light
// (premultiplied: black stays fully transparent, bright glow nearly opaque). This behaves like a
// screen blend without relying on CSS mix-blend-mode, which some compositors drop for WebGL.
const LightToAlpha = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0); gl_FragColor = vec4(c, max(c.r, max(c.g, c.b))); }`,
};
import { frame, metersPerPixel, toScene } from './geo.js';

export class Overlay {
  constructor(map, canvas) {
    this.map = map;
    this.canvas = canvas;
    this.layers = [];
    this.beforeRender = [];
    this.afterRender = [];
    this.bloomOn = true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;

    this.mapMatrix = new THREE.Matrix4();
    this.originMatrix = new THREE.Matrix4();
    this.M = new THREE.Matrix4();
    this.Minv = new THREE.Matrix4();
    this._v4 = new THREE.Vector4();
    this.originVersion = -1;

    // Uniforms shared by every holographic material.
    this.u = {
      uTime: { value: 0 },
      uMpp: { value: 1 },
      uEye: { value: new THREE.Vector3() },
      uCenter: { value: new THREE.Vector2() },
      uRange: { value: 2500 },
      uInner: { value: 0 },
      uScan: { value: new THREE.Vector4(0, 0, -1, 0) },
      uZoomFade: { value: 1 },
    };

    const size = this.size();
    // No MSAA on the composer target: UnrealBloomPass (r170) composites incorrectly onto a
    // multisampled read buffer. Edges are antialiased analytically in the shaders instead.
    const rt = new THREE.WebGLRenderTarget(size.w, size.h, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.w, size.h), 0.48, 0.4, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(LightToAlpha));
    this.resize();

    this.clock = new THREE.Clock();
    this.fps = 60;
    const self = this;
    map.addLayer({
      id: 'holo-sync',
      type: 'custom',
      renderingMode: '3d',
      render(gl, arg) {
        const m = arg && arg.defaultProjectionData ? arg.defaultProjectionData.mainMatrix : arg;
        self.frame(m);
      },
    });
    map.on('resize', () => this.resize());
  }

  size() {
    const r = this.map.getContainer().getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  resize() {
    const { w, h } = this.size();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  add(layer) {
    this.layers.push(layer);
    if (layer.group) this.scene.add(layer.group);
    return layer;
  }

  setBloom(on) {
    this.bloomOn = on;
    this.bloom.enabled = on;
  }

  scan(lon, lat) {
    const p = toScene(lon, lat);
    this.u.uScan.value.set(p[0], p[1], 0, 1);
    this.scanStart = this.u.uTime.value;
  }

  // Project a scene point to CSS pixels. Returns null when behind the camera.
  project(x, y, z, out = { x: 0, y: 0, w: 0 }) {
    const v = this._v4.set(x, y, z, 1).applyMatrix4(this.M);
    if (v.w <= 1e-6) return null;
    out.x = ((v.x / v.w + 1) / 2) * this.width;
    out.y = ((1 - v.y / v.w) / 2) * this.height;
    out.w = v.w;
    return out;
  }

  frame(m) {
    if (!m) return;
    if (this.originVersion !== frame.version) {
      this.originMatrix.makeTranslation(frame.ox, frame.oy, 0).multiply(new THREE.Matrix4().makeScale(frame.s, -frame.s, frame.s));
      this.originVersion = frame.version;
    }
    this.mapMatrix.fromArray(m);
    this.M.multiplyMatrices(this.mapMatrix, this.originMatrix);
    this.Minv.copy(this.M).invert();
    this.camera.projectionMatrix.copy(this.M);
    this.camera.projectionMatrixInverse.copy(this.Minv);

    // Camera eye in scene space: the point the projection maps to (0,0,1,0).
    const e = this._v4.set(0, 0, 1, 0).applyMatrix4(this.Minv);
    if (Math.abs(e.w) > 1e-12) this.u.uEye.value.set(e.x / e.w, e.y / e.w, e.z / e.w);

    const dt = Math.min(0.1, this.clock.getDelta());
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    const t = (this.u.uTime.value += dt);
    const c = this.map.getCenter();
    const zoom = this.map.getZoom();
    const cs = toScene(c.lng, c.lat);
    this.u.uCenter.value.set(cs[0], cs[1]);
    this.u.uMpp.value = metersPerPixel(c.lat, zoom);
    this.u.uZoomFade.value = THREE.MathUtils.smoothstep(zoom, 12.6, 13.6);

    const scan = this.u.uScan.value;
    if (this.scanStart != null) {
      const age = t - this.scanStart;
      scan.z = age * 900;
      scan.w = Math.max(0, 1 - age / 3.2);
      if (scan.w <= 0) this.scanStart = null;
    }

    const ctx = { t, dt, zoom, center: c, mpp: this.u.uMpp.value, overlay: this };
    for (const fn of this.beforeRender) fn(ctx);
    for (const l of this.layers) if (l.update) l.update(ctx);
    this.composer.render(dt);
    for (const fn of this.afterRender) fn(ctx);
    this.map.triggerRepaint();
  }
}

// ---------- shared GLSL ----------
export const GLSL_EAQI = /* glsl */ `
vec3 eaqiColor(float a) {
  // European AQI bands: good, fair, moderate, poor, very poor, extremely poor
  vec3 c0 = vec3(0.20, 0.95, 0.85);
  vec3 c1 = vec3(0.45, 0.95, 0.45);
  vec3 c2 = vec3(1.00, 0.80, 0.25);
  vec3 c3 = vec3(1.00, 0.45, 0.20);
  vec3 c4 = vec3(1.00, 0.18, 0.30);
  vec3 c5 = vec3(0.75, 0.20, 1.00);
  if (a < 20.0) return mix(c0, c1, a / 20.0);
  if (a < 40.0) return mix(c1, c2, (a - 20.0) / 20.0);
  if (a < 60.0) return mix(c2, c3, (a - 40.0) / 20.0);
  if (a < 80.0) return mix(c3, c4, (a - 60.0) / 20.0);
  return mix(c4, c5, clamp((a - 80.0) / 20.0, 0.0, 1.0));
}`;

export function eaqiColorJS(a) {
  const stops = [
    [0, [0.2, 0.95, 0.85]],
    [20, [0.45, 0.95, 0.45]],
    [40, [1.0, 0.8, 0.25]],
    [60, [1.0, 0.45, 0.2]],
    [80, [1.0, 0.18, 0.3]],
    [100, [0.75, 0.2, 1.0]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (a <= stops[i][0] || i === stops.length - 1) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i];
      const f = Math.max(0, Math.min(1, (a - a0) / (a1 - a0)));
      return c0.map((v, k) => v + (c1[k] - v) * f);
    }
  }
  return stops[0][1];
}

// Builds a flat ribbon along a polyline. Width is applied in the vertex shader (uWidth, metres),
// so lines keep a steady on-screen thickness as the camera zooms.
export function ribbonGeometry(points, { closed = false } = {}) {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3);
  const nrm = new Float32Array(n * 2 * 2);
  const dist = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  const idx = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[i > 0 ? i - 1 : closed ? n - 1 : i];
    const next = points[i < n - 1 ? i + 1 : closed ? 0 : i];
    if (i > 0) d += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
    let t1x = p[0] - prev[0], t1y = p[1] - prev[1];
    let t2x = next[0] - p[0], t2y = next[1] - p[1];
    const l1 = Math.hypot(t1x, t1y) || 1, l2 = Math.hypot(t2x, t2y) || 1;
    t1x /= l1; t1y /= l1; t2x /= l2; t2y /= l2;
    if (i === 0 && !closed) { t1x = t2x; t1y = t2y; }
    if (i === n - 1 && !closed) { t2x = t1x; t2y = t1y; }
    let tx = t1x + t2x, ty = t1y + t2y;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) { tx = t2x; ty = t2y; } else { tx /= tl; ty /= tl; }
    // Miter: scale the normal so the ribbon keeps its width through corners (capped at 2x).
    const cos = tx * t2x + ty * t2y;
    const miter = Math.min(2, 1 / Math.max(0.5, cos));
    const nx = -ty * miter, ny = tx * miter;
    for (let s = 0; s < 2; s++) {
      const k = i * 2 + s;
      pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2] || 0;
      nrm[k * 2] = nx; nrm[k * 2 + 1] = ny;
      dist[k] = d;
      side[k] = s ? 1 : -1;
    }
    if (i < n - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aNormal2', new THREE.BufferAttribute(nrm, 2));
  g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setIndex(idx);
  g.userData.length = d;
  return g;
}

export const RIBBON_VERT = /* glsl */ `
attribute vec2 aNormal2;
attribute float aDist;
attribute float aSide;
uniform float uWidth;
varying float vDist;
varying float vSide;
varying vec3 vPos;
void main() {
  vec3 p = position + vec3(aNormal2 * aSide * uWidth * 0.5, 0.0);
  vDist = aDist;
  vSide = aSide;
  vPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

// Swap an object's geometry for a fresh one built from plain arrays, releasing the old GPU buffers.
export function setGeometry(obj, attrs) {
  obj.geometry.dispose();
  const g = new THREE.BufferGeometry();
  for (const [name, [arr, size]] of Object.entries(attrs)) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  obj.geometry = g;
  return g;
}
