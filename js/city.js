// Holographic city: streams vector tiles around the camera, builds glowing buildings and park
// boundary fields in workers, and keeps per-tile land statistics for the sector readouts.
// Two instances run side by side: OpenMapTiles z14 everywhere, and (with an OS key) OS MasterMap
// z16 buildings inside an inner zone. uInner hides the OSM buildings where OS ones take over.
import * as THREE from 'three';
import { frame, toScene, tileCenter, mercX, mercY } from './geo.js';
import { Q } from './city-core.js';


const BUILDING_VERT = /* glsl */ `
attribute vec4 aW;
uniform float uQ;
uniform float uRise;
varying vec3 vPos;
varying vec4 vW;
varying float vZ;
void main() {
  vec3 p = position;
  p.z *= uRise;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPos = wp.xyz;
  vW = vec4(aW.x * uQ, aW.y < 0.0 ? -1.0 : aW.y * uQ, aW.z * uQ * uRise, aW.w);
  vZ = p.z * uQ;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const BUILDING_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uScan;
uniform vec2 uCenter;
uniform float uRange;
uniform float uInner;
uniform float uZoomFade;
uniform float uRise;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uEdge;
varying vec3 vPos;
varying vec4 vW;
varying float vZ;

float hash1(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  float top = max(vW.z, 0.1);
  float z = vZ;
  float h01 = clamp(top / 170.0, 0.0, 1.0);
  vec3 base = mix(uLow, uHigh, pow(h01, 0.65));
  float seed = hash1(vW.w);
  vec3 col;
  float fz = fwidth(z);
  if (vW.y < 0.0) {
    // Roof: faint plate with a fine grid so flat tops still read as surfaces.
    vec2 g = abs(fract(vPos.xy / 6.0) - 0.5) * 6.0;
    vec2 fw = fwidth(vPos.xy);
    float grid = 1.0 - smoothstep(0.0, max(fw.x, fw.y) * 1.2, min(g.x, g.y));
    grid *= 1.0 - smoothstep(0.3, 1.5, max(fw.x, fw.y));
    col = base * (0.05 + 0.07 * grid) + uEdge * 0.015;
  } else {
    float u = vW.x, len = vW.y;
    float du = min(u, len - u);
    float fu = max(fwidth(u), 1e-4);
    float edgeV = 1.0 - smoothstep(0.0, fu * 1.5, du);
    float edgeT = 1.0 - smoothstep(0.0, fz * 1.8, top - z);
    float floorLine = 1.0 - smoothstep(0.0, fz * 1.1, abs(fract(z / 3.6 + 0.5) - 0.5) * 3.6);
    floorLine *= step(7.0, top) * (1.0 - smoothstep(0.35, 1.2, fz));
    // Lit windows flicker on tall buildings, driven by a per-building seed.
    float win = step(0.62, hash1(floor(z / 3.6) * 17.0 + floor(u / 4.0) * 3.1 + vW.w));
    win *= step(12.0, top) * 0.18 * (0.6 + 0.4 * sin(uTime * 0.7 + seed * 40.0));
    float grad = 0.035 + 0.16 * pow(clamp(z / top, 0.0, 1.0), 1.6);
    col = base * (grad + floorLine * 0.28 + win) + uEdge * (edgeV * 0.55 + edgeT * 0.95) * (0.45 + 0.55 * h01);
  }
  // Radar pulse sweeping outwards from the scan origin.
  float d = length(vPos.xy - uScan.xy);
  float ring = exp(-abs(d - uScan.z) / 22.0) * uScan.w;
  col += uEdge * ring * (0.4 + 1.2 * clamp(z / top, 0.0, 1.0));
  // Scan range: fade out towards the edge of the streamed area.
  float dc = length(vPos.xy - uCenter);
  float fade = 1.0 - smoothstep(uRange * 0.55, uRange, dc);
  if (uInner > 0.0) fade *= smoothstep(uInner * 0.9, uInner, dc);
  gl_FragColor = vec4(col * fade * uZoomFade * smoothstep(0.0, 0.3, uRise), 1.0);
}`;

const FENCE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uCenter;
uniform float uRange;
uniform float uZoomFade;
uniform float uRise;
uniform vec3 uColor;
varying vec3 vPos;
varying vec4 vW;
varying float vZ;
void main() {
  float top = max(vW.z, 0.1);
  float h = clamp(vZ / top, 0.0, 1.0);
  float u = vW.x;
  float fu = max(fwidth(u), 1e-4);
  float post = 1.0 - smoothstep(0.0, fu * 1.4, abs(fract(u / 18.0 + 0.5) - 0.5) * 18.0);
  float fz = fwidth(vZ);
  float topLine = 1.0 - smoothstep(0.0, fz * 1.6, top - vZ);
  float baseLine = 1.0 - smoothstep(0.0, fz * 2.0, vZ);
  float band = smoothstep(0.92, 1.0, fract(h * 1.0 - uTime * 0.35));
  float field = (1.0 - h) * 0.16 + band * 0.18;
  vec3 col = uColor * (field + post * 0.45 * (1.0 - h * 0.6) + topLine * 0.55 + baseLine * 0.9);
  float dc = length(vPos.xy - uCenter);
  float fade = 1.0 - smoothstep(uRange * 0.55, uRange, dc);
  gl_FragColor = vec4(col * fade * uZoomFade * uRise, 1.0);
}`;

// Depth prepass: only occlude where this layer's buildings are actually shown.
const DEPTH_FRAG = /* glsl */ `
uniform vec2 uCenter;
uniform float uRange;
uniform float uInner;
varying vec3 vPos;
void main() {
  float dc = length(vPos.xy - uCenter);
  if (dc > uRange || (uInner > 0.0 && dc < uInner * 0.95)) discard;
  gl_FragColor = vec4(0.0);
}`;

const GRID_FRAG = /* glsl */ `
uniform vec2 uCenter;
uniform float uRange;
uniform float uInner;
uniform vec3 uInnerColor;
uniform float uMpp;
uniform vec4 uScan;
uniform float uTime;
uniform vec3 uColor;
varying vec3 vPos;
float gridLine(vec2 p, float step, float px) {
  vec2 g = abs(fract(p / step - 0.5) - 0.5) * step;
  vec2 fw = fwidth(p);
  vec2 l = 1.0 - smoothstep(vec2(0.0), fw * px, g);
  return max(l.x, l.y);
}
void main() {
  vec2 p = vPos.xy;
  float minor = gridLine(p, 100.0, 1.0) * (1.0 - smoothstep(1.2, 3.5, uMpp));
  float major = gridLine(p, 500.0, 1.3);
  float dc = length(p - uCenter);
  float fade = 1.0 - smoothstep(uRange * 0.35, uRange * 1.05, dc);
  float rangeRing = 1.0 - smoothstep(0.0, fwidth(dc) * 1.5, abs(dc - uRange * 0.98));
  float d = length(p - uScan.xy);
  float pulse = exp(-abs(d - uScan.z) / 14.0) * uScan.w;
  float tick = step(0.5, fract(atan(p.y - uCenter.y, p.x - uCenter.x) * 57.2958 / 4.0));
  // OS MasterMap zone boundary.
  float innerRing = uInner > 0.0 ? (1.0 - smoothstep(0.0, fwidth(dc) * 1.5, abs(dc - uInner))) * (0.5 + 0.5 * step(0.5, fract(atan(p.y - uCenter.y, p.x - uCenter.x) * 57.2958 / 1.5))) : 0.0;
  vec3 col = uColor * (minor * 0.05 + major * 0.11) * fade + uColor * rangeRing * 0.45 * tick + uColor * pulse * 0.6 + uInnerColor * innerRing * 0.55;
  gl_FragColor = vec4(col, 1.0);
}`;

export class CityLayer {
  constructor(overlay, opts = {}) {
    const { onStats, onTile, onError } = opts;
    this.overlay = overlay;
    this.Z = opts.z ?? 14;
    this.schema = opts.schema || 'omt';
    this.maxTiles = opts.maxTiles ?? 56;
    this.minZoom = opts.minZoom ?? 12.6;
    this.rangeFn = opts.range;
    this.active = true;
    this.map = overlay.map;
    this.group = new THREE.Group();
    this.tiles = new Map();
    this.failed = new Map(); // key -> { at, n } for back-off after errors
    this.buildQueue = []; // decoded tiles waiting to become GPU meshes
    this.pending = [];
    this.inFlight = 0;
    this.maxInFlight = 6;
    this.visible = { city: true, green: true, grid: true };
    this.onStats = onStats;
    this.onTile = onTile;
    this.onError = onError;
    this.template = opts.template || null;
    this.reqId = 0;
    this.callbacks = new Map();
    this.bytes = 0;
    this.triangles = 0;

    const n = opts.workers ?? Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./city-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const cb = this.callbacks.get(e.data.id);
        this.callbacks.delete(e.data.id);
        if (cb) cb(e.data);
      };
      return w;
    });
    this.nextWorker = 0;

    const u = overlay.u;
    const tint = opts.tint || {};
    const colors = {
      uLow: { value: new THREE.Color(tint.low || '#0b6f86') },
      uHigh: { value: new THREE.Color(tint.high || '#9ff4ff') },
      uEdge: { value: new THREE.Color(tint.edge || '#62e6ff') },
    };
    // The OMT layer shares the global range (grid, wind and AQ fade with it) and honours uInner;
    // the OS layer keeps its own range and never cuts a hole in itself.
    this.rangeU = opts.ownRange ? { value: 1500 } : u.uRange;
    const inner = opts.ownRange ? { value: 0 } : u.uInner;
    this.buildingUniforms = { ...u, ...colors, uQ: { value: Q }, uRange: this.rangeU, uInner: inner };
    this.fenceUniforms = { ...u, uQ: { value: Q }, uColor: { value: new THREE.Color('#45f5a1') } };
    this.grid = null;
    if (opts.grid === false) return;

    // Ground grid with scan-range ring and radar pulse.
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { ...u, uColor: { value: new THREE.Color('#4fd8ff') }, uInnerColor: { value: new THREE.Color('#b9a8ff') } },
        vertexShader: `varying vec3 vPos; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vPos = wp.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: GRID_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      })
    );
    grid.frustumCulled = false;
    grid.renderOrder = 1;
    this.grid = grid;
    this.group.add(grid);
  }

  async init() {
    if (this.template) return { tiles: [this.template] };
    const tj = await fetch('https://tiles.openfreemap.org/planet').then((r) => {
      if (!r.ok) throw new Error(`OpenFreeMap TileJSON answered ${r.status}`);
      return r.json();
    });
    this.template = tj.tiles[0];
    return tj;
  }

  setVisible(key, on) {
    this.visible[key] = on;
    for (const t of this.tiles.values()) {
      if (t.bldg) t.bldg.forEach((m) => (m.visible = this.visible.city));
      if (t.fence) t.fence.visible = this.visible.green;
    }
    if (this.grid) this.grid.visible = this.visible.grid;
  }

  // Inactive layers keep their cache but draw nothing and request nothing.
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.group.visible = on;
    if (on) this.refresh();
    else this.pending = [];
  }

  range(zoom) {
    if (this.rangeFn) return this.rangeFn(zoom);
    return Math.max(1400, Math.min(5200, 2300 * Math.pow(2, 15 - zoom)));
  }

  // Decide which tiles should be resident, nearest to the view centre first.
  refresh() {
    if (!this.template || !this.active) return;
    const zoom = this.map.getZoom();
    const c = this.map.getCenter();
    if (zoom < this.minZoom) return;
    const R = this.range(zoom);
    const n = 2 ** this.Z;
    const cx = mercX(c.lng) * n, cy = mercY(c.lat) * n;
    const tileM = (40075016.68557849 * Math.cos((c.lat * Math.PI) / 180)) / n;
    const rt = Math.ceil(R / tileM) + 1;
    const wanted = [];
    for (let dy = -rt; dy <= rt; dy++) {
      for (let dx = -rt; dx <= rt; dx++) {
        const tx = Math.floor(cx) + dx, ty = Math.floor(cy) + dy;
        const ex = Math.max(tx - cx, 0, cx - tx - 1);
        const ey = Math.max(ty - cy, 0, cy - ty - 1);
        const d = Math.hypot(ex, ey) * tileM;
        if (d <= R) wanted.push({ key: `${tx}/${ty}`, x: tx, y: ty, d });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    const keep = new Set(wanted.slice(0, this.maxTiles).map((w) => w.key));
    const now = performance.now();
    const cooling = (k) => { const f = this.failed.get(k); return f && now - f.at < Math.min(120e3, 5e3 * 2 ** f.n); };
    this.pending = wanted.slice(0, this.maxTiles).filter((w) => !this.tiles.has(w.key) && !cooling(w.key));
    for (const t of this.tiles.values()) t.wanted = keep.has(t.key);
    this.pump();
    this.evict();
  }

  pump() {
    while (this.inFlight < this.maxInFlight && this.pending.length) {
      const w = this.pending.shift();
      if (this.tiles.has(w.key)) continue;
      const tile = { key: w.key, x: w.x, y: w.y, state: 'loading', wanted: true, lastUsed: performance.now() };
      this.tiles.set(w.key, tile);
      this.inFlight++;
      const id = ++this.reqId;
      const url = this.template.replace('{z}', this.Z).replace('{x}', w.x).replace('{y}', w.y);
      this.callbacks.set(id, (msg) => {
        this.inFlight--;
        if (!this.tiles.has(w.key)) return this.pump();
        if (!msg.ok) {
          tile.state = 'error';
          this.tiles.delete(w.key);
          const f = this.failed.get(w.key);
          this.failed.set(w.key, { at: performance.now(), n: f ? f.n + 1 : 0 });
          if (this.onError) this.onError(msg.error);
        } else {
          this.failed.delete(w.key);
          this.buildQueue.push([tile, msg.out]);
        }
        this.pump();
      });
      this.workers[this.nextWorker++ % this.workers.length].postMessage({ id, url, z: this.Z, x: w.x, y: w.y, schema: this.schema });
    }
  }

  evict() {
    const loaded = [...this.tiles.values()].filter((t) => t.state === 'ready');
    const now = performance.now();
    for (const t of loaded) if (t.wanted) t.lastUsed = now;
    const idle = loaded.filter((t) => !t.wanted).sort((a, b) => a.lastUsed - b.lastUsed);
    const excess = loaded.length - Math.round(this.maxTiles * 1.3);
    for (let i = 0; i < idle.length && i < Math.max(excess, 0); i++) this.dispose(idle[i]);
  }

  dispose(t) {
    for (const m of [...(t.bldg || []), t.fence].filter(Boolean)) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.triangles -= t.triangles || 0;
    this.tiles.delete(t.key);
  }

  makeGeometry(g) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    geo.setAttribute('aW', new THREE.BufferAttribute(g.aw, 4));
    geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  placeMesh(mesh, tile) {
    const [lon, lat] = tileCenter(this.Z, tile.x, tile.y);
    const p = toScene(lon, lat);
    mesh.position.set(p[0], p[1], 0);
    mesh.scale.setScalar(Q * (Math.cos((frame.lat * Math.PI) / 180) / Math.cos((lat * Math.PI) / 180)));
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  }

  build(tile, out) {
    tile.state = 'ready';
    tile.stats = out.stats;
    tile.parks = out.parks;
    tile.latC = out.latC;
    tile.bytes = out.bytes;
    this.bytes += out.bytes;
    const rise = { value: 0 };
    tile.rise = rise;
    tile.born = this.overlay.u.uTime.value;
    const buniforms = { ...this.buildingUniforms, uRise: rise };

    if (out.bldg.idx.length) {
      const geo = this.makeGeometry(out.bldg);
      const depth = new THREE.Mesh(
        geo,
        new THREE.ShaderMaterial({
          uniforms: buniforms,
          vertexShader: BUILDING_VERT,
          fragmentShader: DEPTH_FRAG,
          colorWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const glow = new THREE.Mesh(
        geo,
        new THREE.ShaderMaterial({
          uniforms: buniforms,
          vertexShader: BUILDING_VERT,
          fragmentShader: BUILDING_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthFunc: THREE.LessEqualDepth,
          side: THREE.DoubleSide,
        })
      );
      glow.renderOrder = 2;
      for (const m of [depth, glow]) {
        m.matrixAutoUpdate = false;
        this.placeMesh(m, tile);
        m.visible = this.visible.city;
        this.group.add(m);
      }
      tile.bldg = [depth, glow];
      tile.triangles = out.bldg.idx.length / 3;
      this.triangles += tile.triangles;
    }
    if (out.fence.idx.length) {
      const fence = new THREE.Mesh(
        this.makeGeometry(out.fence),
        new THREE.ShaderMaterial({
          uniforms: { ...this.fenceUniforms, uRise: rise },
          vertexShader: BUILDING_VERT,
          fragmentShader: FENCE_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      fence.renderOrder = 3;
      fence.matrixAutoUpdate = false;
      this.placeMesh(fence, tile);
      fence.visible = this.visible.green;
      this.group.add(fence);
      tile.fence = fence;
    }
    if (this.onTile) this.onTile(tile, out);
    this.statsDirty = true;
  }

  onOrigin() {
    for (const t of this.tiles.values()) {
      for (const m of [...(t.bldg || []), t.fence].filter(Boolean)) this.placeMesh(m, t);
    }
  }

  update(ctx) {
    const u = this.overlay.u;
    this.rangeU.value = this.range(ctx.zoom);
    // Turn decoded tiles into meshes a few milliseconds per frame, so a burst of arrivals
    // (the wide welcome-screen view loads ~50 at once) never stalls the animation.
    const t0 = performance.now();
    while (this.buildQueue.length && performance.now() - t0 < 4) {
      const [tile, out] = this.buildQueue.shift();
      if (this.tiles.get(tile.key) === tile) this.build(tile, out);
    }
    // Tiles rise out of the ground when they arrive.
    for (const t of this.tiles.values()) {
      if (t.rise && t.rise.value < 1) {
        const k = Math.min(1, (u.uTime.value - t.born) / 1.4);
        t.rise.value = 1 - Math.pow(1 - k, 3);
      }
    }
    if (this.grid) {
      const c = u.uCenter.value;
      const R = this.rangeU.value * 2.4;
      this.grid.position.set(c.x, c.y, 0.3);
      this.grid.scale.set(R, R, 1);
      this.grid.updateMatrixWorld(true);
    }
    if (this.statsDirty && this.onStats) {
      this.statsDirty = false;
      this.onStats(this.sectorStats(), this.parkGroups());
    }
  }

  // Aggregate statistics over the 3×3 block of tiles around the view centre.
  sectorStats() {
    const c = this.map.getCenter();
    const n = 2 ** this.Z;
    const tx = Math.floor(mercX(c.lng) * n), ty = Math.floor(mercY(c.lat) * n);
    const s = { tiles: 0, area: 0, built: 0, green: 0, water: 0, buildings: 0, footprint: 0, hA: 0, gfa: 0, maxH: 0, maxAt: null };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tiles.get(`${tx + dx}/${ty + dy}`);
        if (!t || t.state !== 'ready') continue;
        const st = t.stats;
        s.tiles++;
        s.area += st.areaM2;
        s.built += st.builtPct * st.areaM2;
        s.green += st.greenPct * st.areaM2;
        s.water += st.waterPct * st.areaM2;
        s.buildings += st.buildings;
        s.footprint += st.footprint;
        s.hA += st.meanH * st.footprint;
        s.gfa += st.gfa;
        if (st.maxH > s.maxH) {
          s.maxH = st.maxH;
          const [lon, lat] = tileCenter(this.Z, t.x, t.y);
          const k = Math.cos((lat * Math.PI) / 180);
          s.maxAt = [lon + (st.maxAt[0] / (111319.49 * k)), lat + st.maxAt[1] / 111319.49];
        }
      }
    }
    if (!s.tiles) return null;
    return {
      tiles: s.tiles,
      areaKm2: s.area / 1e6,
      builtPct: s.built / s.area,
      greenPct: s.green / s.area,
      waterPct: s.water / s.area,
      buildings: s.buildings,
      meanH: s.footprint ? s.hA / s.footprint : 0,
      gfaKm2: s.gfa / 1e6,
      maxH: s.maxH,
      maxAt: s.maxAt,
    };
  }

  // Re-join park pieces that were split across tile edges, then name and measure each park.
  parkGroups() {
    const pieces = [];
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || !t.parks) continue;
      const [lon, lat] = tileCenter(this.Z, t.x, t.y);
      const k = Math.cos((lat * Math.PI) / 180);
      for (const p of t.parks) {
        pieces.push({ ...p, lon: lon + p.cx / (111319.49 * k), lat: lat + p.cy / 111319.49 });
      }
    }
    const parent = pieces.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const byLine = new Map();
    pieces.forEach((p, i) => {
      for (let e = 0; e < p.edges.length; e += 4) {
        const key = `${p.edges[e]}:${p.edges[e + 1]}`;
        const list = byLine.get(key) || [];
        const a0 = p.edges[e + 2], a1 = p.edges[e + 3];
        for (const o of list) {
          if (o.i !== i && Math.min(a1, o.a1) - Math.max(a0, o.a0) > 1e-6) parent[find(i)] = find(o.i);
        }
        list.push({ i, a0, a1 });
        byLine.set(key, list);
      }
    });
    const groups = new Map();
    pieces.forEach((p, i) => {
      const r = find(i);
      const g = groups.get(r) || { name: '', rank: 0, area: 0, lon: 0, lat: 0, pieces: 0, cls: p.cls };
      g.area += p.area;
      g.lon += p.lon * p.area;
      g.lat += p.lat * p.area;
      g.pieces++;
      if (p.name && p.area > g.rank) { g.name = p.name; g.rank = p.area; }
      groups.set(r, g);
    });
    return [...groups.values()]
      .map((g) => ({ name: g.name, area: g.area, lon: g.lon / g.area, lat: g.lat / g.area, cls: g.cls }))
      .sort((a, b) => b.area - a.area);
  }

  counts() {
    let ready = 0, loading = 0;
    for (const t of this.tiles.values()) t.state === 'ready' ? ready++ : loading++;
    return { ready, loading, triangles: this.triangles, bytes: this.bytes };
  }
}
