// Live aircraft from community ADS-B receivers (adsb.lol, fallback adsb.fi) via the local proxy.
// Aircraft fly at their real altitude; positions are dead-reckoned between 10 s polls so motion is
// continuous, with fading trails and tethers to the ground.
import * as THREE from 'three';
import { toScene, fromScene } from '../geo.js';
import { fetchJSON, esc, fmt } from '../util.js';

const FT = 0.3048, KT = 0.514444;
const TRAIL = 24;

const PLANE_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vRot;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p.y = -p.y;
  // Chevron pointing along +y.
  float body = 1.0 - smoothstep(0.0, 0.05, abs(abs(p.x) * 1.25 - (0.34 - p.y) * 0.6) );
  body *= step(-0.28, p.y) * step(p.y, 0.36);
  float core = 1.0 - smoothstep(0.03, 0.07, length(p));
  float a = max(body, core);
  if (a < 0.03) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

export class FlightsLayer {
  constructor(overlay, app) {
    this.overlay = overlay;
    this.app = app;
    this.group = new THREE.Group();
    this.aircraft = new Map();
    this.visible = true;
    this.source = '';

    this.uniforms = { uBearing: { value: 0 } };
    this.points = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: `attribute vec3 aCol; attribute float aTrack; uniform float uBearing; varying vec3 vCol; varying float vRot; void main(){ vCol = aCol; vRot = radians(aTrack) - uBearing; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 24.0; }`,
        fragmentShader: PLANE_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        vertexShader: `attribute vec4 aC; varying vec4 vC; void main(){ vC = aC; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec4 vC; void main(){ gl_FragColor = vec4(vC.rgb * vC.a, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    this.group.add(this.points, this.lines);
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
    if (!on) this.app.tags.clear('ac:');
  }

  async load(lon, lat) {
    const d = await fetchJSON(`/api/flights?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=45`);
    this.source = d.source;
    const now = performance.now() / 1000;
    const seen = new Set();
    for (const a of d.ac) {
      if (a.lat == null || a.lon == null) continue;
      const onGround = a.alt_baro === 'ground';
      const altFt = onGround ? 0 : Number(a.alt_geom ?? a.alt_baro) || 0;
      const id = a.hex;
      seen.add(id);
      const prev = this.aircraft.get(id);
      const age = Number(a.seen_pos) || 0;
      const rec = prev || { id, trail: [] };
      Object.assign(rec, {
        call: (a.flight || '').trim() || a.r || id.toUpperCase(),
        type: a.t || '',
        reg: a.r || '',
        lon: a.lon,
        lat: a.lat,
        alt: altFt * FT,
        altFt,
        gs: (Number(a.gs) || 0) * KT,
        kt: Number(a.gs) || 0,
        track: Number(a.track ?? a.true_heading) || 0,
        vs: ((Number(a.baro_rate ?? a.geom_rate) || 0) * FT) / 60,
        ground: onGround,
        t0: now - age,
        squawk: a.squawk,
      });
      this.aircraft.set(id, rec);
    }
    for (const id of [...this.aircraft.keys()]) if (!seen.has(id)) this.aircraft.delete(id);
    return { count: this.aircraft.size, source: this.source };
  }

  rebuild() { for (const a of this.aircraft.values()) a.trail = []; }

  // Fixed-capacity GPU buffers, rewritten in place each frame.
  alloc() {
    const MAX = 600, LV = MAX * (TRAIL + 2) * 2;
    this.cap = MAX;
    this.lineCap = LV;
    this.buf = {
      pos: new Float32Array(MAX * 3), col: new Float32Array(MAX * 3), trk: new Float32Array(MAX),
      lp: new Float32Array(LV * 3), lc: new Float32Array(LV * 4),
    };
    const g = this.points.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.buf.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.buf.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTrack', new THREE.BufferAttribute(this.buf.trk, 1).setUsage(THREE.DynamicDrawUsage));
    const lg = this.lines.geometry;
    lg.setAttribute('position', new THREE.BufferAttribute(this.buf.lp, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('aC', new THREE.BufferAttribute(this.buf.lc, 4).setUsage(THREE.DynamicDrawUsage));
  }

  update(ctx) {
    if (!this.visible) return;
    if (!this.buf) this.alloc();
    const now = performance.now() / 1000;
    this.uniforms.uBearing.value = (this.overlay.map.getBearing() * Math.PI) / 180;
    const { pos, col, trk, lp, lc } = this.buf;
    let n = 0, nl = 0;
    const seg = (a, b, c, a0, a1) => {
      if (nl + 2 > this.lineCap) return;
      lp.set(a, nl * 3); lp.set(b, nl * 3 + 3);
      lc[nl * 4] = c[0]; lc[nl * 4 + 1] = c[1]; lc[nl * 4 + 2] = c[2]; lc[nl * 4 + 3] = a0;
      lc[nl * 4 + 4] = c[0]; lc[nl * 4 + 5] = c[1]; lc[nl * 4 + 6] = c[2]; lc[nl * 4 + 7] = a1;
      nl += 2;
    };
    const center = this.overlay.u.uCenter.value;
    const list = [];
    for (const a of this.aircraft.values()) {
      if (n >= this.cap) break;
      const dt = Math.min(40, now - a.t0);
      const p0 = toScene(a.lon, a.lat, a.alt);
      const r = (a.track * Math.PI) / 180;
      const x = p0[0] + Math.sin(r) * a.gs * dt;
      const y = p0[1] + Math.cos(r) * a.gs * dt;
      const z = Math.max(0, a.alt + a.vs * dt);
      a.scene = [x, y, z];
      const last = a.trail[a.trail.length - 1];
      if (!last || Math.hypot(last[0] - x, last[1] - y) > 60) {
        a.trail.push([x, y, z]);
        if (a.trail.length > TRAIL) a.trail.shift();
      }
      const hi = Math.min(1, a.altFt / 12000);
      const c = [1.0 - 0.7 * hi, 0.75 + 0.2 * hi, 0.35 + 0.65 * hi];
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
      trk[n] = a.track;
      n++;
      for (let k = 1; k < a.trail.length; k++) {
        const f = k / a.trail.length;
        seg(a.trail[k - 1], a.trail[k], c, f * 0.35, f * 0.45);
      }
      if (a.trail.length) seg(a.trail[a.trail.length - 1], a.scene, c, 0.45, 0.5);
      if (!a.ground) seg(a.scene, [x, y, 0], c, 0.28, 0.0);
      list.push([a, Math.hypot(x - center.x, y - center.y)]);
    }
    const g = this.points.geometry;
    for (const k of ['position', 'aCol', 'aTrack']) g.attributes[k].needsUpdate = true;
    g.setDrawRange(0, n);
    const lg = this.lines.geometry;
    lg.attributes.position.needsUpdate = true;
    lg.attributes.aC.needsUpdate = true;
    lg.setDrawRange(0, nl);

    // Label the aircraft nearest the view centre.
    list.sort((a, b) => a[1] - b[1]);
    for (const [a] of list.slice(0, 14)) {
      this.app.tags.set(`ac:${a.id}`, {
        scene: a.scene,
        variant: a.ground ? 'ac ground' : 'ac',
        html: `<b>${esc(a.call)}</b><span>${a.ground ? 'GND' : fmt(Math.round(a.altFt / 100) * 100) + ' ft'} · ${fmt(a.kt)} kt${a.type ? ' · ' + esc(a.type) : ''}</span>`,
      });
    }
  }

  nearest(lon, lat) {
    let best = null, bd = Infinity;
    for (const a of this.aircraft.values()) {
      if (!a.scene) continue;
      const [alon, alat] = fromScene(a.scene[0], a.scene[1]);
      const d = Math.hypot(alon - lon, alat - lat);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }
}
