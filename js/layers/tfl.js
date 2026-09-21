// Transport for London open data: the Tube, Elizabeth line and DLR drawn as glowing ribbons at
// their real depth (tube tunnels below the streets, DLR on its viaducts), with animated train
// pulses and live line status; plus live road disruptions as pulsing ground beacons.
import * as THREE from 'three';
import { toScene } from '../geo.js';
import { ribbonGeometry, RIBBON_VERT, setGeometry } from '../overlay.js';
import { fetchJSON, esc } from '../util.js';

export const LINES = [
  ['bakerloo', 'Bakerloo', '#e08a2c', -24],
  ['central', 'Central', '#ff2a2a', -26],
  ['circle', 'Circle', '#ffd84a', -10],
  ['district', 'District', '#20c060', -10],
  ['hammersmith-city', 'Hammersmith & City', '#f7a9c1', -10],
  ['jubilee', 'Jubilee', '#b9c3cc', -32],
  ['metropolitan', 'Metropolitan', '#d33a86', -10],
  ['northern', 'Northern', '#e8eef2', -28],
  ['piccadilly', 'Piccadilly', '#3a78ff', -26],
  ['victoria', 'Victoria', '#22b5ff', -30],
  ['waterloo-city', 'Waterloo & City', '#8fe3c9', -28],
  ['elizabeth', 'Elizabeth line', '#a37cff', -34],
  ['dlr', 'DLR', '#12d6d0', 7],
];

const TUBE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlert;
uniform float uOn;
varying float vDist;
varying float vSide;
void main() {
  float a = abs(vSide);
  float core = 1.0 - smoothstep(0.2, 0.5, a);
  float glow = pow(1.0 - a, 2.0);
  float speed = mix(34.0, 12.0, uAlert);
  float train = exp(-abs(mod(vDist - uTime * speed * 6.0, 1500.0) - 750.0) / 26.0);
  float trainB = exp(-abs(mod(vDist + uTime * speed * 6.0 + 700.0, 1500.0) - 750.0) / 26.0);
  vec3 base = mix(uColor, vec3(1.0, 0.15, 0.2), uAlert * (0.5 + 0.5 * sin(uTime * 5.0)));
  vec3 col = base * (glow * 0.3 + core * 0.45) + mix(vec3(1.0), base, 0.3) * core * (train + trainB) * 1.3;
  gl_FragColor = vec4(col * uOn, 1.0);
}`;

// TfL severities: 10 Good Service, 18 No Issues, 19 Information — everything else is a disruption.
export const isDisrupted = (sev) => sev !== 10 && sev !== 18 && sev !== 19;
const isSevere = (sev) => [1, 2, 3, 4, 5, 6, 11, 16, 20].includes(sev);

const SEVERITY_COLOR = { Severe: '#ff2d55', Serious: '#ff4d4d', Moderate: '#ffb547', Minimal: '#7fd8ff' };

export class TflLayer {
  constructor(overlay, app) {
    this.overlay = overlay;
    this.app = app;
    this.group = new THREE.Group();
    this.tubeGroup = new THREE.Group();
    this.roadGroup = new THREE.Group();
    this.group.add(this.tubeGroup, this.roadGroup);
    this.lines = new Map();
    this.status = new Map();
    this.disruptions = [];
    this.stations = [];
    this.showTube = true;
    this.showRoads = true;

    this.stationPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 9.0; }`,
        fragmentShader: `void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); float a = 1.0 - smoothstep(0.0, 0.06, abs(r - 0.32)); a += 1.0 - smoothstep(0.0, 0.12, r); if (a < 0.02) discard; gl_FragColor = vec4(vec3(0.85, 0.97, 1.0) * a * 0.8, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.stationPoints.frustumCulled = false;
    this.stationPoints.renderOrder = 5;
    this.tubeGroup.add(this.stationPoints);

    this.roadPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: { uTime: overlay.u.uTime },
        vertexShader: `attribute vec3 aCol; attribute float aPhase; attribute float aSize; varying vec3 vCol; varying float vPhase; void main(){ vCol = aCol; vPhase = aPhase; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize; }`,
        fragmentShader: `uniform float uTime; varying vec3 vCol; varying float vPhase; void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p) * 2.0; float t = fract(uTime * 0.5 + vPhase); float wave = (1.0 - smoothstep(0.0, 0.08, abs(r - t))) * (1.0 - t); float core = 1.0 - smoothstep(0.08, 0.16, r); float diamond = 1.0 - smoothstep(0.0, 0.05, abs(abs(p.x) + abs(p.y) - 0.16)); float a = wave * 0.9 + core + diamond * 0.8; if (a < 0.02) discard; gl_FragColor = vec4(vCol * a, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.roadPoints.frustumCulled = false;
    this.roadPoints.renderOrder = 5;
    this.roadGroup.add(this.roadPoints);
  }

  setVisible(key, on) {
    if (key === 'tube') {
      this.showTube = on;
      this.tubeGroup.visible = on;
      if (!on) for (const id of this.lines.keys()) this.app.panels.hide(`line:${id}`);
    } else {
      this.showRoads = on;
      this.roadGroup.visible = on;
      if (!on) this.app.panels.hide('disruption');
    }
  }

  async loadNetwork() {
    const results = await Promise.allSettled(
      LINES.map(([id]) => fetchJSON(`https://api.tfl.gov.uk/Line/${id}/Route/Sequence/outbound?excludeCrowding=true`))
    );
    let ok = 0;
    const stations = new Map();
    results.forEach((r, k) => {
      if (r.status !== 'fulfilled') return;
      ok++;
      const [id, name, color, depth] = LINES[k];
      const paths = [];
      for (const s of r.value.lineStrings || []) {
        try {
          for (const line of JSON.parse(s)) if (line.length > 1) paths.push(line);
        } catch {}
      }
      for (const st of r.value.stations || []) stations.set(st.id, { name: st.name, lon: st.lon, lat: st.lat, depth: Math.min(depth, 0) });
      this.lines.set(id, { id, name, color, depth, paths, meshes: [] });
    });
    this.stations = [...stations.values()];
    this.buildNetwork();
    return { lines: ok, stations: this.stations.length };
  }

  buildNetwork() {
    for (const l of this.lines.values()) {
      for (const m of l.meshes) { this.tubeGroup.remove(m); m.geometry.dispose(); }
      if (l.meshes[0]) l.meshes[0].material.dispose();
      l.meshes = [];
      l.uniforms = l.uniforms || {
        uColor: { value: new THREE.Color(l.color) },
        uTime: this.overlay.u.uTime,
        uWidth: { value: 6 },
        uAlert: { value: 0 },
        uOn: { value: 1 },
      };
      const st = this.status.get(l.id);
      if (st) l.uniforms.uAlert.value = isDisrupted(st.severity) ? 1 : 0;
      const mat = new THREE.ShaderMaterial({
        uniforms: l.uniforms,
        vertexShader: RIBBON_VERT,
        fragmentShader: TUBE_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      for (const path of l.paths) {
        const mesh = new THREE.Mesh(ribbonGeometry(path.map(([lon, lat]) => toScene(lon, lat, l.depth))), mat);
        mesh.renderOrder = 5;
        this.tubeGroup.add(mesh);
        l.meshes.push(mesh);
      }
    }
    const pos = [];
    for (const s of this.stations) pos.push(...toScene(s.lon, s.lat, s.depth));
    setGeometry(this.stationPoints, { position: [pos, 3] });
  }

  async loadStatus() {
    const data = await fetchJSON('https://api.tfl.gov.uk/Line/Mode/tube,dlr,elizabeth-line/Status');
    const changes = [];
    for (const line of data) {
      const s = line.lineStatuses?.[0];
      if (!s) continue;
      const prev = this.status.get(line.id);
      const entry = { severity: s.statusSeverity, text: s.statusSeverityDescription, reason: s.reason || '', name: line.name };
      if (!prev || prev.severity !== entry.severity) changes.push(entry);
      this.status.set(line.id, entry);
      const l = this.lines.get(line.id);
      if (l?.uniforms) l.uniforms.uAlert.value = isDisrupted(entry.severity) ? 1 : 0;
    }
    return { changes, disrupted: [...this.status.values()].filter((s) => isDisrupted(s.severity)).length };
  }

  async loadRoads() {
    const data = await fetchJSON('https://api.tfl.gov.uk/Road/all/Disruption?stripContent=true');
    const list = [];
    for (const d of data) {
      if (d.status && d.status !== 'Active') continue;
      if (!SEVERITY_COLOR[d.severity]) continue;
      let pt;
      try { pt = JSON.parse(d.point); } catch { continue; }
      if (!Array.isArray(pt)) continue;
      list.push({
        id: d.id,
        lon: pt[0],
        lat: pt[1],
        severity: d.severity,
        category: d.category,
        sub: d.subCategory,
        comments: d.comments || '',
        update: d.currentUpdate || '',
        location: d.location || '',
      });
    }
    this.disruptions = list;
    this.buildRoads();
    return list;
  }

  buildRoads() {
    const pos = [], col = [], phase = [], size = [];
    for (const d of this.disruptions) {
      pos.push(...toScene(d.lon, d.lat, 1));
      col.push(...new THREE.Color(SEVERITY_COLOR[d.severity]).toArray());
      phase.push(Math.random());
      size.push(d.severity === 'Serious' || d.severity === 'Severe' ? 46 : d.severity === 'Moderate' ? 34 : 22);
      d.scene = toScene(d.lon, d.lat, 1);
    }
    setGeometry(this.roadPoints, { position: [pos, 3], aCol: [col, 3], aPhase: [phase, 1], aSize: [size, 1] });
  }

  rebuild() {
    if (this.lines.size) this.buildNetwork();
    if (this.disruptions.length) this.buildRoads();
  }

  pickDisruption(x, y) {
    if (!this.showRoads) return null;
    let best = null, bd = 18;
    const p = {};
    for (const d of this.disruptions) {
      const s = this.overlay.project(d.scene[0], d.scene[1], d.scene[2], p);
      if (!s) continue;
      const dist = Math.hypot(s.x - x, s.y - y);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  showDisruption(d) {
    const variant = d.severity === 'Moderate' ? 'warn' : d.severity === 'Minimal' ? '' : 'crit';
    this.app.panels.set('disruption', {
      lon: d.lon, lat: d.lat, key: d.id, force: true, base: 1, lift: 120, variant, width: 300,
      html: `<div class="hp-kicker">TfL road disruption · ${esc(d.id)}</div>
        <div class="hp-title">${esc(d.severity)} · ${esc(d.category)}</div>
        <div class="hp-sub">${esc(d.sub || '')}</div>
        <p class="hp-body">${esc(d.comments.slice(0, 220))}${d.comments.length > 220 ? '…' : ''}</p>
        ${d.update ? `<div class="hp-note">${esc(d.update.slice(0, 140))}</div>` : ''}`,
    });
  }

  update(ctx) {
    const w = Math.max(3, ctx.mpp * 3.2);
    for (const l of this.lines.values()) {
      if (!l.uniforms) continue;
      l.uniforms.uWidth.value = w;
    }
    if (!this.showTube) return;
    // Panels for lines that aren't running a good service, anchored where they cross the view.
    const c = this.overlay.u.uCenter.value;
    for (const [id, st] of this.status) {
      const l = this.lines.get(id);
      if (!l) continue;
      if (!isDisrupted(st.severity)) { this.app.panels.hide(`line:${id}`); continue; }
      let best = null, bd = Infinity;
      for (const path of l.paths) {
        for (let k = 0; k < path.length; k++) {
          const p = toScene(path[k][0], path[k][1]);
          const d = Math.hypot(p[0] - c.x, p[1] - c.y);
          if (d < bd) { bd = d; best = path[k]; }
        }
      }
      if (!best || bd > this.overlay.u.uRange.value) { this.app.panels.hide(`line:${id}`); continue; }
      const reason = st.reason.replace(/^[^:]+:\s*/, '');
      this.app.panels.set(`line:${id}`, {
        lon: best[0], lat: best[1], key: `${st.severity}:${st.text}`, base: l.depth, lift: 90, variant: isSevere(st.severity) ? 'crit' : 'warn', width: 270,
        html: `<div class="hp-kicker">TfL line status</div>
          <div class="hp-title">${esc(l.name)}</div>
          <div class="hp-sub">${esc(st.text)}</div>
          ${reason ? `<p class="hp-body">${esc(reason.slice(0, 170))}${reason.length > 170 ? '…' : ''}</p>` : ''}`,
      });
    }
  }
}
