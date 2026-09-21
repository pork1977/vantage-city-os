// Routing optimisation. Fetches alternatives from OSRM (FOSSGIS servers), then scores every
// alternative on travel time, modelled air-quality exposure along the path, and live TfL road
// disruptions it passes. The winner is drawn as the animated red corridor.
import * as THREE from 'three';
import { toScene, haversine } from '../geo.js';
import { ribbonGeometry, RIBBON_VERT } from '../overlay.js';
import { fetchJSON, fmt, fmtDist, fmtDuration, esc } from '../util.js';

const PROFILES = {
  car: { label: 'Drive', url: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/', fallback: 'https://router.project-osrm.org/route/v1/driving/' },
  bike: { label: 'Cycle', url: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/' },
  foot: { label: 'Walk', url: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/' },
};
const DISRUPTION_PENALTY_S = { Severe: 240, Serious: 150, Moderate: 60, Minimal: 15 };

const ROUTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uDash;
uniform float uDim;
uniform float uReveal;
uniform float uPrimary;
varying float vDist;
varying float vSide;
void main() {
  float a = abs(vSide);
  float core = 1.0 - smoothstep(0.12, 0.42, a);
  float glow = pow(1.0 - a, 2.4);
  float ph = fract((vDist - uTime * uSpeed) / uDash);
  float dash = smoothstep(0.0, 0.04, ph) * (1.0 - smoothstep(0.52, 0.56, ph));
  float packet = exp(-abs(mod(vDist - uTime * uSpeed * 5.0, 1100.0) - 550.0) / 20.0) * uPrimary;
  float reveal = 1.0 - smoothstep(uReveal - 40.0, uReveal, vDist);
  vec3 col = uColor * (glow * 0.28 + core * (0.25 + dash * 1.0)) + vec3(1.0, 0.9, 0.9) * core * (packet * 1.6 + dash * 0.25 * uPrimary);
  gl_FragColor = vec4(col * uDim * reveal, 1.0);
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
void main() {
  float h = vUv.y;
  float fall = pow(1.0 - h, 2.2);
  float pulse = 0.75 + 0.25 * sin(uTime * 3.0 - h * 12.0);
  gl_FragColor = vec4(uColor * fall * pulse * 0.55, 1.0);
}`;

export class RouteLayer {
  constructor(overlay, app, air, tfl) {
    this.overlay = overlay;
    this.app = app;
    this.air = air;
    this.tfl = tfl;
    this.group = new THREE.Group();
    this.profile = 'car';
    this.routes = [];
    this.meshes = [];
    this.visible = true;
    this.origin = null;
    this.dest = null;
    this.revealStart = 0;

    this.beams = [0, 1].map((k) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5),
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(k ? '#ff4d6a' : '#7ff0ff') }, uTime: overlay.u.uTime },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
          fragmentShader: BEAM_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      m.visible = false;
      m.renderOrder = 6;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
    if (!on) this.app.panels.hide('route');
  }

  setProfile(p) {
    if (!PROFILES[p] || p === this.profile) return;
    this.profile = p;
    if (this.origin && this.dest) this.compute();
  }

  async setEndpoints(origin, dest) {
    this.origin = origin;
    this.dest = dest;
    return this.compute();
  }

  async compute() {
    const { origin: o, dest: d } = this;
    if (!o || !d) return;
    const prof = PROFILES[this.profile];
    const coords = `${o[0].toFixed(6)},${o[1].toFixed(6)};${d[0].toFixed(6)},${d[1].toFixed(6)}`;
    const q = '?overview=full&geometries=geojson&alternatives=3&steps=false';
    const token = (this.token = {});
    this.app.feed('route', { status: 'loading' });
    let data;
    try {
      data = await fetchJSON(prof.url + coords + q);
    } catch (e) {
      if (!prof.fallback) throw e;
      data = await fetchJSON(prof.fallback + coords + q);
    }
    if (token !== this.token) return;
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message || 'No route found between those points');
    this.routes = data.routes.map((r, i) => this.score(r, i));
    const fastest = this.routes.reduce((a, b) => (b.duration < a.duration ? b : a));
    const best = this.routes.reduce((a, b) => (b.score < a.score ? b : a));
    best.best = true;
    fastest.fastest = true;
    this.best = best;
    this.fastest = fastest;
    this.app.state.rerouted = best !== fastest;
    this.build();
    this.revealStart = this.overlay.u.uTime.value;
    this.app.feed('route', { status: 'live', detail: `${this.routes.length} evaluated`, ms: data.__ms });
    return this.routes;
  }

  score(r, i) {
    const coords = r.geometry.coordinates;
    let aqSum = 0, no2Sum = 0, n = 0, acc = 0;
    for (let k = 1; k < coords.length; k++) {
      acc += haversine(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]);
      if (acc >= 120 || k === coords.length - 1) {
        acc = 0;
        const a = this.air.sample(coords[k][0], coords[k][1], 'aqi');
        const b = this.air.sample(coords[k][0], coords[k][1], 'no2');
        if (a != null) { aqSum += a; n++; }
        if (b != null) no2Sum += b;
      }
    }
    const meanAqi = n ? aqSum / n : null;
    const meanNo2 = n ? no2Sum / n : null;
    // TfL disruptions within 45 m of the path.
    const hits = [];
    for (const dsr of this.tfl.disruptions || []) {
      for (let k = 0; k < coords.length; k += 2) {
        if (Math.abs(coords[k][1] - dsr.lat) > 0.001) continue;
        if (haversine(coords[k][0], coords[k][1], dsr.lon, dsr.lat) < 45) { hits.push(dsr); break; }
      }
    }
    const penalty = hits.reduce((s, h) => s + (DISRUPTION_PENALTY_S[h.severity] || 30), 0);
    // Exposure weighting: every 10 EAQI points above "good" costs 4% extra perceived time.
    const exposureFactor = meanAqi == null ? 1 : 1 + Math.max(0, meanAqi - 20) * 0.004;
    return {
      i,
      coords,
      duration: r.duration,
      distance: r.distance,
      meanAqi,
      meanNo2,
      dose: meanAqi == null ? null : (meanAqi * r.duration) / 60,
      hits,
      score: r.duration * exposureFactor + penalty,
    };
  }

  build() {
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); }
    this.meshes = [];
    const ordered = [...this.routes].sort((a, b) => (a.best ? 1 : 0) - (b.best ? 1 : 0));
    for (const r of ordered) {
      const pts = r.coords.map(([lon, lat]) => toScene(lon, lat, r.best ? 3 : 2));
      const geo = ribbonGeometry(pts);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(r.best ? '#ff2d55' : '#ffb547') },
            uTime: this.overlay.u.uTime,
            uWidth: { value: 8 },
            uSpeed: { value: r.best ? 26 : 12 },
            uDash: { value: r.best ? 46 : 30 },
            uDim: { value: r.best ? 1 : 0.55 },
            uReveal: { value: 0 },
            uPrimary: { value: r.best ? 1 : 0 },
          },
          vertexShader: RIBBON_VERT,
          fragmentShader: ROUTE_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      mesh.userData.route = r;
      mesh.userData.length = geo.userData.length;
      mesh.renderOrder = r.best ? 7 : 6;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    const a = toScene(...this.origin), b = toScene(...this.dest);
    this.beams[0].position.set(a[0], a[1], 0);
    this.beams[1].position.set(b[0], b[1], 0);
    this.beams.forEach((m) => (m.visible = true));
  }

  rebuild() { if (this.routes.length) this.build(); }

  clear() {
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); }
    this.meshes = [];
    this.routes = [];
    this.beams.forEach((m) => (m.visible = false));
    this.app.panels.remove('route');
    this.app.state.rerouted = false;
  }

  panelHtml() {
    const b = this.best, f = this.fastest;
    const prof = PROFILES[this.profile];
    let verdict;
    if (b === f) verdict = this.routes.length > 1 ? `Fastest corridor is also the cleanest of ${this.routes.length}` : 'Single viable corridor';
    else {
      const dt = Math.round((b.duration - f.duration) / 60);
      const why = [];
      if (f.meanAqi != null && b.meanAqi != null && f.meanAqi > b.meanAqi) why.push(`−${(((f.meanAqi - b.meanAqi) / f.meanAqi) * 100).toFixed(1)}% AQ exposure`);
      if (f.hits.length > b.hits.length) why.push(`avoids ${f.hits.length - b.hits.length} disruption${f.hits.length - b.hits.length > 1 ? 's' : ''}`);
      verdict = `Rerouted: ${why.join(', ') || 'lower combined cost'} · ${dt >= 0 ? '+' : ''}${dt} min`;
    }
    return `<div class="hp-kicker">OSRM · ${esc(prof.label)} · ${this.routes.length} alternative${this.routes.length > 1 ? 's' : ''} scored</div>
      <div class="hp-title">Routing optimisation</div>
      <div class="hp-sub">${fmtDist(b.distance)} · ${fmtDuration(b.duration)}</div>
      <dl class="hp-rows">
        <dt>Mean EAQI</dt><dd>${fmt(b.meanAqi, 1)}</dd>
        <dt>NO₂ on path</dt><dd>${fmt(b.meanNo2, 1)} µg/m³</dd>
        <dt>Disruptions</dt><dd>${b.hits.length}</dd>
      </dl>
      <div class="hp-note">${esc(verdict)}</div>`;
  }

  update(ctx) {
    if (!this.visible || !this.meshes.length) return;
    const age = ctx.t - this.revealStart;
    for (const m of this.meshes) {
      const u = m.material.uniforms;
      const r = m.userData.route;
      u.uWidth.value = Math.max(r.best ? 5 : 3, ctx.mpp * (r.best ? 7 : 4));
      u.uReveal.value = Math.min(m.userData.length + 60, age * Math.max(900, m.userData.length / 1.6));
    }
    const radius = Math.max(4, ctx.mpp * 5);
    const height = Math.max(160, ctx.mpp * 260);
    for (const b of this.beams) {
      b.scale.set(radius, radius, height);
      b.updateMatrixWorld(true);
    }
    const b = this.best;
    if (b) {
      const k = Math.floor(b.coords.length * 0.42);
      const [lon, lat] = b.coords[k];
      this.app.panels.set('route', { lon, lat, key: `${this.origin}|${this.dest}|${this.profile}`, base: 3, lift: 130, variant: 'route', width: 280, html: this.panelHtml() });
    }
  }
}

export { PROFILES };
