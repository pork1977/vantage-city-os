// Santander Cycles (TfL BikePoint): every docking station as a light column whose height is
// the number of bikes docked right now, coloured from empty (red) to full (cyan).
import * as THREE from 'three';
import { toScene } from '../geo.js';
import { fetchJSON, esc, fmt, ago } from '../util.js';

const BAR_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute float aH;
attribute float aFill;
uniform float uW;
uniform float uTime;
uniform float uRise;
varying float vH;
varying float vFill;
varying float vTop;
void main() {
  float h = max(aH, 1.5) * uRise;
  vec3 p = vec3(position.xy + aCorner * uW, position.z * h);
  vH = position.z;
  vFill = aFill;
  vTop = h;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const BAR_FRAG = /* glsl */ `
varying float vH;
varying float vFill;
varying float vTop;
void main() {
  vec3 empty = vec3(1.0, 0.22, 0.32);
  vec3 mid = vec3(1.0, 0.72, 0.28);
  vec3 full = vec3(0.35, 0.95, 1.0);
  vec3 c = vFill < 0.5 ? mix(empty, mid, vFill * 2.0) : mix(mid, full, (vFill - 0.5) * 2.0);
  float cap = smoothstep(0.9, 1.0, vH);
  gl_FragColor = vec4(c * (0.12 + 0.5 * vH * vH + cap * 0.9), 1.0);
}`;

export class BikesLayer {
  constructor(overlay, app) {
    this.overlay = overlay;
    this.app = app;
    this.group = new THREE.Group();
    this.docks = [];
    this.selected = null;
    this.uniforms = { uW: { value: 4 }, uTime: overlay.u.uTime, uRise: { value: 0 } };
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: BAR_VERT,
        fragmentShader: BAR_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
  }

  setVisible(on) {
    this.group.visible = on;
    if (!on) this.app.panels.hide('bike');
  }

  async load() {
    const data = await fetchJSON('https://api.tfl.gov.uk/BikePoint');
    const prop = (d, k) => d.additionalProperties?.find((p) => p.key === k)?.value;
    this.docks = data
      .map((d) => {
        const bikes = +prop(d, 'NbBikes') || 0;
        const ebikes = +prop(d, 'NbEBikes') || 0;
        const empty = +prop(d, 'NbEmptyDocks') || 0;
        const total = +prop(d, 'NbDocks') || bikes + empty;
        return {
          id: d.id,
          name: d.commonName,
          lon: d.lon,
          lat: d.lat,
          bikes,
          ebikes,
          empty,
          total,
          locked: prop(d, 'Locked') === 'true',
        };
      })
      .filter((d) => Number.isFinite(d.lon) && Number.isFinite(d.lat));
    this.loadedAt = Date.now();
    this.build();
    if (this.selected) {
      const s = this.docks.find((d) => d.id === this.selected.id);
      if (s) this.select(s);
    }
    const bikes = this.docks.reduce((s, d) => s + d.bikes, 0);
    const emptyDocks = this.docks.filter((d) => d.bikes === 0).length;
    return { docks: this.docks.length, bikes, emptyDocks };
  }

  build() {
    // Two crossed vertical quads per dock read as a solid column from any angle.
    const corners = [[-0.5, 0], [0.5, 0], [0.5, 0], [-0.5, 0], [0, -0.5], [0, 0.5], [0, 0.5], [0, -0.5]];
    const zs = [0, 0, 1, 1, 0, 0, 1, 1];
    const n = this.docks.length;
    const pos = new Float32Array(n * 8 * 3), cor = new Float32Array(n * 8 * 2), h = new Float32Array(n * 8), fill = new Float32Array(n * 8);
    const idx = new Uint32Array(n * 12);
    this.docks.forEach((d, i) => {
      const p = toScene(d.lon, d.lat);
      d.scene = p;
      const height = 6 + d.bikes * 3.2;
      d.height = height;
      const f = d.total ? d.bikes / d.total : 0;
      for (let k = 0; k < 8; k++) {
        const v = i * 8 + k;
        pos.set([p[0], p[1], zs[k]], v * 3);
        cor.set(corners[k], v * 2);
        h[v] = height;
        fill[v] = f;
      }
      const b = i * 8;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3, b + 4, b + 5, b + 6, b + 4, b + 6, b + 7], i * 12);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(cor, 2));
    g.setAttribute('aH', new THREE.BufferAttribute(h, 1));
    g.setAttribute('aFill', new THREE.BufferAttribute(fill, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.riseStart ??= this.overlay.u.uTime.value;
  }

  rebuild() { if (this.docks.length) this.build(); }

  pick(x, y) {
    if (!this.group.visible) return null;
    let best = null, bd = 16;
    const p = {};
    for (const d of this.docks) {
      for (const z of [d.height, d.height * 0.5, 0]) {
        const s = this.overlay.project(d.scene[0], d.scene[1], z, p);
        if (!s) continue;
        const dist = Math.hypot(s.x - x, s.y - y);
        if (dist < bd) { bd = dist; best = d; }
      }
    }
    return best;
  }

  select(d, force = false) {
    this.selected = d;
    const pct = d.total ? Math.round((d.bikes / d.total) * 100) : 0;
    const variant = d.bikes === 0 ? 'crit' : pct < 25 ? 'warn' : '';
    const [name, area] = d.name.split(/\s*,\s*(?=[^,]+$)/);
    this.app.panels.set('bike', {
      lon: d.lon, lat: d.lat, key: d.id, force, base: d.height, lift: 50, variant, width: 250,
      html: `<div class="hp-kicker">Santander Cycles · live · ${esc(ago(this.loadedAt))}</div>
        <div class="hp-title">${esc(name)}</div>
        <div class="hp-sub">${esc(area || '')}</div>
        <dl class="hp-rows">
          <dt>Bikes</dt><dd>${fmt(d.bikes)} <small>(${fmt(d.ebikes)} e-bikes)</small></dd>
          <dt>Free docks</dt><dd>${fmt(d.empty)} of ${fmt(d.total)}</dd>
          <dt>Fill</dt><dd>${pct}%</dd>
        </dl>`,
    });
  }

  update(ctx) {
    this.uniforms.uW.value = Math.max(3, ctx.mpp * 3.5);
    const k = Math.min(1, (ctx.t - (this.riseStart || 0)) / 1.6);
    this.uniforms.uRise.value = 1 - Math.pow(1 - k, 3);
  }
}
