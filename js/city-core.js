// Turns one OpenMapTiles vector tile into holographic city geometry plus land statistics.
// Pure functions with no DOM or network access, so it runs in a worker (and in Node for tests).
//
// Output geometry is quantised to Int16 (0.05 m steps) to keep GPU memory low:
//   pos  Int16 x3  position in tile-metres (x east, y north, z up) / Q
//   aw   Int16 x4  (u along wall, wall length, roof height, seed) / Q; wall length -1 marks a roof
//   idx  Uint32    triangle indices

export const Q = 0.05;
const EARTH_C = 40075016.68557849;
const WANT = new Set(['building', 'landcover', 'landuse', 'water', 'poi']);
const GREEN_LANDCOVER = new Set(['grass', 'wood', 'wetland', 'farmland', 'scrub']);
const GREEN_LANDUSE = new Set(['cemetery', 'pitch', 'playground', 'park', 'garden', 'allotments']);
// Where each tile schema keeps its buildings. OS Vector Tile API (MasterMap Topography Layer,
// zoom 16+) marks 3D-capable buildings with _symbol 33 and carries height in RelHMax.
const SCHEMAS = {
  omt: {
    want: null,
    layer: 'building',
    accept: (p) => p.hide_3d !== true && p.hide_3d !== 'true',
    height: (p) => +p.render_height || 6,
    base: (p) => +p.render_min_height || 0,
  },
  os: {
    want: new Set(['TopographicArea_1']),
    layer: 'TopographicArea_1',
    accept: (p) => p._symbol == 33,
    height: (p) => +p.RelHMax || 5,
    base: () => 0,
  },
};
// Public open spaces get a holographic boundary fence. (OpenMapTiles files leisure=park under landcover.)
const PARK_SUBCLASS = new Set(['park', 'recreation_ground', 'village_green', 'common', 'nature_reserve']);
const G = 128; // statistics raster resolution per tile
const FENCE_H = 14;
const decoder = new TextDecoder();

// ---------- minimal protobuf / MVT reader ----------
class Pbf {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint() {
    const b = this.buf;
    let val = 0, shift = 0, byte;
    do {
      byte = b[this.pos++];
      if (shift < 28) val |= (byte & 0x7f) << shift;
      else val += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return val;
  }
  string() {
    const len = this.varint();
    const s = decoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  skip(wt) {
    if (wt === 0) while (this.buf[this.pos++] & 0x80);
    else if (wt === 1) this.pos += 8;
    else if (wt === 2) this.pos += this.varint();
    else if (wt === 5) this.pos += 4;
    else throw new Error('Unknown protobuf wire type ' + wt);
  }
}

const zigzag = (n) => (n >>> 1) ^ -(n & 1);

function readValue(p, end) {
  let v = null;
  while (p.pos < end) {
    const tag = p.varint(), f = tag >> 3;
    if (f === 1) v = p.string();
    else if (f === 2) { v = p.view.getFloat32(p.pos, true); p.pos += 4; }
    else if (f === 3) { v = p.view.getFloat64(p.pos, true); p.pos += 8; }
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) { const n = p.varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
    else if (f === 7) v = p.varint() === 1;
    else p.skip(tag & 7);
  }
  return v;
}

function readLayer(p, end, want) {
  const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
  while (p.pos < end) {
    const tag = p.varint(), f = tag >> 3;
    if (f === 1) {
      layer.name = p.string();
      if (!want.has(layer.name)) return null;
    } else if (f === 2) {
      const len = p.varint();
      layer.features.push(p.pos, p.pos + len);
      p.pos += len;
    } else if (f === 3) layer.keys.push(p.string());
    else if (f === 4) { const len = p.varint(); layer.values.push(readValue(p, p.pos + len)); }
    else if (f === 5) layer.extent = p.varint();
    else p.skip(tag & 7);
  }
  return layer;
}

export function readTile(buf, want = WANT) {
  const p = new Pbf(buf);
  const layers = {};
  while (p.pos < buf.length) {
    const tag = p.varint();
    if (tag >> 3 === 3 && (tag & 7) === 2) {
      const len = p.varint();
      const end = p.pos + len;
      const layer = readLayer(p, end, want);
      if (layer) layers[layer.name] = layer;
      p.pos = end;
    } else p.skip(tag & 7);
  }
  return { p, layers };
}

// Calls fn(props, rings) for every feature of a geometry type (1 point, 3 polygon) in a layer;
// rings are flat [x,y,x,y...] arrays in tile px.
function eachFeature(p, layer, fn, wantType = 3) {
  const fs = layer.features;
  for (let k = 0; k < fs.length; k += 2) {
    p.pos = fs[k];
    const end = fs[k + 1];
    let type = 0, gs = 0, ge = 0;
    const props = {};
    while (p.pos < end) {
      const tag = p.varint(), f = tag >> 3;
      if (f === 2) {
        // Read the length before taking p.pos: the varint itself advances the cursor.
        const len = p.varint();
        const e = p.pos + len;
        while (p.pos < e) {
          const key = layer.keys[p.varint()];
          props[key] = layer.values[p.varint()];
        }
      } else if (f === 3) type = p.varint();
      else if (f === 4) { const len = p.varint(); gs = p.pos; ge = gs + len; p.pos = ge; }
      else p.skip(tag & 7);
    }
    if (type !== wantType) continue;
    const rings = [];
    let x = 0, y = 0, ring = null, cmd = 0, count = 0;
    p.pos = gs;
    while (p.pos < ge) {
      if (count === 0) {
        const ci = p.varint();
        cmd = ci & 7;
        count = ci >> 3;
        if (cmd === 7) { count = 0; continue; }
      }
      count--;
      x += zigzag(p.varint());
      y += zigzag(p.varint());
      if (cmd === 1) { ring = []; rings.push(ring); }
      ring.push(x, y);
    }
    fn(props, rings);
  }
}

// ---------- polygon helpers ----------
function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}

// MVT: exterior rings have positive area in tile coordinates; holes follow their exterior.
// Some encoders wind the other way, so the first ring of each feature sets the convention.
function classify(rings) {
  const polys = [];
  let cur = null, sign = 0;
  for (const r of rings) {
    if (r.length < 6) continue;
    const a = ringArea(r);
    if (!a) continue;
    if (!sign) sign = Math.sign(a);
    if (a * sign > 0) { cur = [r]; polys.push(cur); }
    else if (cur) cur.push(r);
  }
  return polys;
}

// Sutherland–Hodgman clip of a ring to the tile square [0,E]². Boundary points land exactly on 0 or E.
function clipRing(r, E) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX >= 0 && minY >= 0 && maxX <= E && maxY <= E) return r;
  if (maxX <= 0 || maxY <= 0 || minX >= E || minY >= E) return null;
  let pts = r;
  for (let edge = 0; edge < 4 && pts.length; edge++) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i - 2 + n) % n;
      const ax = pts[j], ay = pts[j + 1], bx = pts[i], by = pts[i + 1];
      const ain = edge === 0 ? ax >= 0 : edge === 1 ? ax <= E : edge === 2 ? ay >= 0 : ay <= E;
      const bin = edge === 0 ? bx >= 0 : edge === 1 ? bx <= E : edge === 2 ? by >= 0 : by <= E;
      if (ain !== bin) {
        if (edge < 2) {
          const cx = edge === 0 ? 0 : E;
          out.push(cx, ay + ((cx - ax) / (bx - ax)) * (by - ay));
        } else {
          const cy = edge === 2 ? 0 : E;
          out.push(ax + ((cy - ay) / (by - ay)) * (bx - ax), cy);
        }
      }
      if (bin) out.push(bx, by);
    }
    pts = out;
  }
  return pts.length >= 6 ? pts : null;
}

function clipPoly(poly, E) {
  const outer = clipRing(poly[0], E);
  if (!outer) return null;
  const out = [outer];
  for (let i = 1; i < poly.length; i++) {
    const h = clipRing(poly[i], E);
    if (h) out.push(h);
  }
  return out;
}

const onBoundary = (ax, ay, bx, by, E) =>
  (ax === bx && (ax <= 0 || ax >= E)) || (ay === by && (ay <= 0 || ay >= E));

// ---------- geometry writer ----------
class GeoWriter {
  constructor(cap = 16384) {
    this.pos = new Int16Array(cap * 3);
    this.aw = new Int16Array(cap * 4);
    this.idx = new Uint32Array(cap * 2);
    this.nv = 0;
    this.ni = 0;
  }
  reserve(nv, ni) {
    if ((this.nv + nv) * 3 > this.pos.length) {
      const cap = Math.max((this.nv + nv) * 2, this.pos.length / 3 * 2);
      const p = new Int16Array(cap * 3); p.set(this.pos); this.pos = p;
      const a = new Int16Array(cap * 4); a.set(this.aw); this.aw = a;
    }
    if (this.ni + ni > this.idx.length) {
      const i = new Uint32Array(Math.max((this.ni + ni) * 2, this.idx.length * 2)); i.set(this.idx); this.idx = i;
    }
  }
  vert(x, y, z, u, len, top, seed) {
    const v = this.nv++;
    const q = (n) => Math.max(-32767, Math.min(32767, Math.round(n / Q)));
    this.pos[v * 3] = q(x); this.pos[v * 3 + 1] = q(y); this.pos[v * 3 + 2] = q(z);
    this.aw[v * 4] = q(u); this.aw[v * 4 + 1] = len < 0 ? -1 : q(len); this.aw[v * 4 + 2] = q(top); this.aw[v * 4 + 3] = seed;
    return v;
  }
  tri(a, b, c) { this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c; }
  finish() {
    return {
      pos: this.pos.slice(0, this.nv * 3),
      aw: this.aw.slice(0, this.nv * 4),
      idx: this.idx.slice(0, this.ni),
    };
  }
}

// Vertical wall quads for every ring edge that isn't a tile clip edge.
function addWalls(g, rings, E, tm, half, zBase, zTop, seed) {
  for (const r of rings) {
    const n = r.length;
    g.reserve(n * 2, n * 3);
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const ax = r[i], ay = r[i + 1], bx = r[j], by = r[j + 1];
      if (onBoundary(ax, ay, bx, by, E)) continue;
      const Ax = (ax - half) * tm, Ay = (half - ay) * tm, Bx = (bx - half) * tm, By = (half - by) * tm;
      const len = Math.hypot(Bx - Ax, By - Ay);
      if (len < 0.25) continue;
      const v0 = g.vert(Ax, Ay, zBase, 0, len, zTop, seed);
      const v1 = g.vert(Bx, By, zBase, len, len, zTop, seed);
      const v2 = g.vert(Bx, By, zTop, len, len, zTop, seed);
      const v3 = g.vert(Ax, Ay, zTop, 0, len, zTop, seed);
      g.tri(v0, v1, v2);
      g.tri(v0, v2, v3);
    }
  }
}

function addRoof(g, rings, tm, half, z, seed, earcut) {
  const flat = [];
  const holes = [];
  for (let k = 0; k < rings.length; k++) {
    if (k > 0) holes.push(flat.length / 2);
    const r = rings[k];
    for (let i = 0; i < r.length; i += 2) flat.push((r[i] - half) * tm, (half - r[i + 1]) * tm);
  }
  const tris = earcut(flat, holes.length ? holes : null, 2);
  if (!tris.length) return;
  const nv = flat.length / 2;
  g.reserve(nv, tris.length);
  const base = g.nv;
  for (let i = 0; i < nv; i++) g.vert(flat[i * 2], flat[i * 2 + 1], z, 0, -1, z, seed);
  for (let i = 0; i < tris.length; i += 3) g.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
}

// Scanline-fill a polygon into a G×G coverage mask.
function fillMask(mask, rings, E) {
  const cell = E / G;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < rings[0].length; i += 2) {
    const y = rings[0][i];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const j0 = Math.max(0, Math.ceil(minY / cell - 0.5));
  const j1 = Math.min(G - 1, Math.floor(maxY / cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const yc = (j + 0.5) * cell;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length;
      for (let i = 0, k = n - 2; i < n; k = i, i += 2) {
        const y1 = r[k + 1], y2 = r[i + 1];
        if (y1 > yc !== y2 > yc) xs.push(r[k] + ((yc - y1) / (y2 - y1)) * (r[i] - r[k]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil(xs[q] / cell - 0.5));
      const i1 = Math.min(G - 1, Math.floor(xs[q + 1] / cell - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * G + i] = 1;
    }
  }
}

function pointInRing(px, py, r) {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const f = r[j] * r[i + 1] - r[i] * r[j + 1];
    a += f;
    cx += (r[j] + r[i]) * f;
    cy += (r[j + 1] + r[i + 1]) * f;
  }
  if (a === 0) return [r[0], r[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

const hash = (n) => {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) & 0x7fff;
};

// ---------- main entry ----------
export function processTile(buf, z, x, y, earcut, schema = 'omt') {
  const S = SCHEMAS[schema] || SCHEMAS.omt;
  const n = 2 ** z;
  const latC = (360 / Math.PI) * Math.atan(Math.exp(((180 - ((y + 0.5) / n) * 360) * Math.PI) / 180)) - 90;
  const tileMeters = (EARTH_C * Math.cos((latC * Math.PI) / 180)) / n;
  const { p, layers } = readTile(buf, S.want || WANT);

  const bldg = new GeoWriter(32768);
  const fence = new GeoWriter(4096);
  const built = new Uint8Array(G * G), green = new Uint8Array(G * G), water = new Uint8Array(G * G);
  const stats = { buildings: 0, footprint: 0, heightArea: 0, gfa: 0, maxH: 0, maxAt: [0, 0] };
  const parks = [];

  const L = layers[S.layer];
  if (L) {
    const E = L.extent, half = E / 2, tm = tileMeters / E;
    let bi = 0;
    eachFeature(p, L, (props, rings) => {
      if (!S.accept(props)) return;
      const h = Math.min(1000, Math.max(2, S.height(props)));
      const hmin = Math.min(h, Math.max(0, S.base(props)));
      for (const poly of classify(rings)) {
        const first = poly[0];
        const counts = first[0] >= 0 && first[0] < E && first[1] >= 0 && first[1] < E;
        const c = clipPoly(poly, E);
        if (!c) continue;
        const seed = hash(++bi + x * 7919 + y * 104729);
        let area = Math.abs(ringArea(c[0]));
        for (let k = 1; k < c.length; k++) area -= Math.abs(ringArea(c[k]));
        area *= tm * tm;
        if (counts) stats.buildings++;
        stats.footprint += area;
        stats.heightArea += area * h;
        stats.gfa += area * Math.max(1, Math.round((h - hmin) / 3.5));
        if (h > stats.maxH) {
          const cc = centroid(c[0]);
          stats.maxH = h;
          stats.maxAt = [(cc[0] - half) * tm, (half - cc[1]) * tm];
        }
        fillMask(built, c, E);
        if (h - hmin >= 0.5) addWalls(bldg, c, E, tm, half, hmin, h, seed);
        addRoof(bldg, c, tm, half, h, seed, earcut);
      }
    });
  }

  const greenLayer = (name, test) => {
    const Lg = layers[name];
    if (!Lg) return;
    const E = Lg.extent;
    eachFeature(p, Lg, (props, rings) => {
      if (!test(props)) return;
      for (const poly of classify(rings)) {
        const c = clipPoly(poly, E);
        if (c) fillMask(green, c, E);
      }
    });
  };
  greenLayer('landcover', (pr) => GREEN_LANDCOVER.has(pr.class));
  greenLayer('landuse', (pr) => GREEN_LANDUSE.has(pr.class));

  // Park names live on POI points; they're matched to polygons by containment (normalised 0..1 coords).
  const parkPois = [];
  if (layers.poi) {
    const E = layers.poi.extent;
    eachFeature(p, layers.poi, (props, pts) => {
      if (props.class !== 'park' || !props.name) return;
      for (const pt of pts) parkPois.push({ x: pt[0] / E, y: pt[1] / E, name: props.name_en || props.name, rank: +props.rank || 99 });
    }, 1);
  }
  const LC = layers.landcover;
  if (LC) {
    const E = LC.extent, half = E / 2, tm = tileMeters / E;
    let pi = 0;
    eachFeature(p, LC, (props, rings) => {
      if (!PARK_SUBCLASS.has(props.subclass)) return;
      for (const poly of classify(rings)) {
        const c = clipPoly(poly, E);
        if (!c) continue;
        let area = Math.abs(ringArea(c[0]));
        for (let k = 1; k < c.length; k++) area -= Math.abs(ringArea(c[k]));
        area *= tm * tm;
        if (area < 2500) continue;
        let name = '', rank = 1e9;
        for (const poi of parkPois) {
          if (poi.rank < rank && pointInRing(poi.x * E, poi.y * E, poly[0])) { name = poi.name; rank = poi.rank; }
        }
        // Edges on the tile boundary, in global tile units, so pieces of one park can be re-joined across tiles.
        const edges = [];
        const r = c[0];
        for (let i = 0, n = r.length; i < n; i += 2) {
          const j = (i + 2) % n;
          const ax = r[i], ay = r[i + 1], bx = r[j], by = r[j + 1];
          if (ax === bx && (ax <= 0 || ax >= E)) edges.push(0, x + (ax >= E ? 1 : 0), y + Math.min(ay, by) / E, y + Math.max(ay, by) / E);
          else if (ay === by && (ay <= 0 || ay >= E)) edges.push(1, y + (ay >= E ? 1 : 0), x + Math.min(ax, bx) / E, x + Math.max(ax, bx) / E);
        }
        const cc = centroid(r);
        parks.push({ name, cls: props.subclass, area, cx: (cc[0] - half) * tm, cy: (half - cc[1]) * tm, edges });
        addWalls(fence, c, E, tm, half, 0, FENCE_H, hash(++pi));
      }
    });
  }

  const W = layers.water;
  if (W) {
    const E = W.extent;
    eachFeature(p, W, (props, rings) => {
      if (props.brunnel === 'tunnel') return;
      for (const poly of classify(rings)) {
        const c = clipPoly(poly, E);
        if (c) fillMask(water, c, E);
      }
    });
  }

  let nb = 0, ng = 0, nw = 0;
  for (let i = 0; i < G * G; i++) {
    nb += built[i];
    ng += green[i] & (built[i] ^ 1);
    nw += water[i] & (built[i] ^ 1) & (green[i] ^ 1);
  }
  const cells = G * G;

  return {
    tileMeters,
    latC,
    bldg: bldg.finish(),
    fence: fence.finish(),
    parks,
    stats: {
      buildings: stats.buildings,
      footprint: stats.footprint,
      meanH: stats.footprint ? stats.heightArea / stats.footprint : 0,
      gfa: stats.gfa,
      maxH: stats.maxH,
      maxAt: stats.maxAt,
      builtPct: nb / cells,
      greenPct: ng / cells,
      waterPct: nw / cells,
      areaM2: tileMeters * tileMeters,
    },
  };
}
