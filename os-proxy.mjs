// Ordnance Survey Data Hub integration. The API key never reaches the browser: every OS call is
// made here, cached, and counted so the HUD can show how much of the free allowance is in use.
//
//   OS Vector Tile API     MasterMap buildings with RelHMax heights (zoom 16+ = Premium data)
//   OS Names API           UK gazetteer search (OpenData)
//   OS NGD API – Features  Building attributes: age, material, floors, roof, heights (Premium)
//   OS Linked Identifiers  TOID → UPRN → USRN relationships (OpenData)
import fs from 'node:fs';
import path from 'node:path';
import { fromBNG, toBNG, gridRef } from './js/bng.js';

export function loadOsKey(root) {
  if (process.env.OS_API_KEY) return process.env.OS_API_KEY.trim();
  try {
    const txt = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const m = txt.match(/^\s*OS_API_KEY\s*=\s*["']?([^"'\r\n#]+?)["']?\s*$/m);
    if (m) return m[1].trim();
  } catch {}
  return '';
}

const BUILDING_FIELDS = [
  'description', 'buildinguse', 'buildinguse_oslandusetiera', 'physicalstate', 'buildingage_period', 'buildingage_year',
  'constructionmaterial', 'numberoffloors', 'basementpresence', 'connectivity', 'buildingpartcount', 'geometry_area_m2',
  'height_relativemax_m', 'height_relativeroofbase_m', 'height_absolutemax_m', 'height_absolutemin_m', 'height_confidencelevel',
  'roofmaterial_primarymaterial', 'roofmaterial_solarpanelpresence', 'roofmaterial_greenroofpresence', 'roofshapeaspect_shape',
  'roofshapeaspect_areatotal_m2', 'roofshapeaspect_areafacingsouth_m2', 'roofshapeaspect_areafacingsoutheast_m2',
  'roofshapeaspect_areafacingsouthwest_m2', 'buildinguse_addresscount_total', 'buildinguse_addresscount_residential',
  'buildinguse_addresscount_commercial', 'versiondate',
];
const PART_FIELDS = ['toid', 'description', 'height_relativemax_m', 'height_relativeroofbase_m', 'height_absolutemax_m', 'height_absolutemin_m', 'height_confidencelevel', 'geometry_area_m2'];

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const contains = (geom, pt) => {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some((p) => pointInRing(pt, p[0]) && !p.slice(1).some((h) => pointInRing(pt, h)));
};

export function createOs({ key, ua }) {
  const usage = { since: Date.now(), tiles: 0, premiumTiles: 0, cachedTiles: 0, names: 0, ngd: 0, links: 0, errors: 0, lastError: '' };
  const tiles = new Map();
  const inflight = new Map();
  const json = new Map();
  const collections = { building: 'bld-fts-building-4', part: 'bld-fts-buildingpart-2', resolved: false };

  const fail = (status, message) => Object.assign(new Error(message), { status });

  // OS explains refusals in the body (OWS XML for tiles, JSON elsewhere); keep that text, it's the useful part.
  async function refusal(res, api) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
    let msg = text.match(/<(?:ows:)?ExceptionText>(.*?)<\/(?:ows:)?ExceptionText>/)?.[1] || '';
    if (!msg) { try { const j = JSON.parse(text); msg = j.description || j.message || j.error?.message || ''; } catch {} }
    const code = /premium plan/i.test(msg) ? 'premium_required' : res.status === 401 && /given resource/i.test(msg) ? 'api_not_enabled' : 'key_rejected';
    const human =
      code === 'premium_required' ? `${api}: “${msg}”. Switch the Data Hub account to the Premium plan (it includes £1,000 of free premium use a month).`
      : code === 'api_not_enabled' ? `${api}: “${msg}”. Add ${api} to your Data Hub project (the NGD APIs also need the Premium plan).`
      : `${api}: OS rejected the API key (${res.status}${msg ? ` — ${msg}` : ''}).`;
    usage.errors++;
    usage.lastError = code;
    return Object.assign(fail(res.status, `[${code}] ${human}`), { code });
  }

  async function osFetch(url, accept = 'application/json', api = 'OS API') {
    if (!key) throw Object.assign(fail(503, '[no_key] OS_API_KEY is not set. Add it to .env and restart the server (on Vercel: add it under Project Settings → Environment Variables, then redeploy).'), { code: 'no_key' });
    const u = new URL(url);
    u.searchParams.set('key', key);
    const res = await fetch(u, { headers: { 'User-Agent': ua, Accept: accept }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) throw await refusal(res, api);
    if (res.status === 429) {
      usage.errors++;
      usage.lastError = 'rate limited';
      throw fail(429, 'OS rate limit reached. Wait a moment and try again.');
    }
    return res;
  }

  async function memo(k, ttl, fn) {
    const hit = json.get(k);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    json.set(k, { t: Date.now(), v });
    if (json.size > 500) json.delete(json.keys().next().value);
    return v;
  }

  // Basemap tiles (layer '') or an overlay such as 'boundaries'. Only basemap zoom 16+ is Premium data.
  async function tile(z, y, x, layer = '') {
    const k = `${layer}/${z}/${y}/${x}`;
    const hit = tiles.get(k);
    if (hit) {
      tiles.delete(k);
      tiles.set(k, hit);
      usage.cachedTiles++;
      return hit;
    }
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      const path = layer ? `vts/${layer}/tile` : 'vts/tile';
      const res = await osFetch(`https://api.os.uk/maps/vector/v1/${path}/${z}/${y}/${x}.pbf?srs=3857`, '*/*', 'OS Vector Tile API');
      usage.tiles++;
      if (!layer && z >= 16) usage.premiumTiles++;
      let body;
      if (res.status === 404 || res.status === 204) body = Buffer.alloc(0);
      else if (!res.ok) throw fail(502, `OS Vector Tile API answered ${res.status}`);
      else body = Buffer.from(await res.arrayBuffer());
      tiles.set(k, body);
      if (tiles.size > 1500) tiles.delete(tiles.keys().next().value);
      return body;
    })();
    inflight.set(k, p);
    try { return await p; } finally { inflight.delete(k); }
  }

  async function names(q) {
    return memo(`names:${q.toLowerCase()}`, 3600e3, async () => {
      const res = await osFetch(`https://api.os.uk/search/names/v1/find?query=${encodeURIComponent(q)}&maxresults=6`, 'application/json', 'OS Names API');
      usage.names++;
      if (!res.ok) throw fail(502, `OS Names API answered ${res.status}`);
      const d = await res.json();
      return (d.results || []).map(({ GAZETTEER_ENTRY: g }) => {
        const [lon, lat] = fromBNG(g.GEOMETRY_X, g.GEOMETRY_Y);
        return {
          id: g.ID,
          name: g.NAME1,
          type: g.TYPE,
          localType: g.LOCAL_TYPE,
          lon,
          lat,
          E: g.GEOMETRY_X,
          N: g.GEOMETRY_Y,
          place: g.POPULATED_PLACE || g.DISTRICT_BOROUGH || '',
          county: g.COUNTY_UNITARY || '',
          region: g.REGION || '',
          postcode: g.POSTCODE_DISTRICT || '',
        };
      });
    });
  }

  // Pick the newest version of each NGD building collection (the public catalogue needs no key).
  async function resolveCollections() {
    if (collections.resolved) return;
    try {
      const res = await fetch('https://api.os.uk/features/ngd/ofa/v1/collections', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
      const ids = (await res.json()).collections.map((c) => c.id);
      const latest = (prefix) =>
        ids.filter((id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))).sort((a, b) => a.slice(prefix.length) - b.slice(prefix.length)).pop();
      collections.building = latest('bld-fts-building-') || collections.building;
      collections.part = latest('bld-fts-buildingpart-') || collections.part;
      collections.resolved = true;
    } catch {}
  }

  async function ngdAt(collection, lon, lat) {
    const e = 0.000008;
    const crs = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
    const res = await osFetch(
      `https://api.os.uk/features/ngd/ofa/v1/collections/${collection}/items?bbox=${lon - e},${lat - e},${lon + e},${lat + e}&bbox-crs=${encodeURIComponent(crs)}&crs=${encodeURIComponent(crs)}&limit=5`,
      'application/geo+json, application/json',
      'OS NGD API – Features'
    );
    usage.ngd++;
    if (!res.ok) throw fail(502, `OS NGD API answered ${res.status} for ${collection}`);
    const fc = await res.json();
    const list = fc.features || [];
    return list.find((f) => contains(f.geometry, [lon, lat])) || list[0] || null;
  }

  async function links(id) {
    const res = await osFetch(`https://api.os.uk/search/links/v1/identifiers/${encodeURIComponent(id)}`, 'application/json', 'OS Linked Identifiers API');
    usage.links++;
    if (res.status === 404) return [];
    if (!res.ok) throw fail(502, `OS Linked Identifiers API answered ${res.status}`);
    return (await res.json()).linkedIdentifiers || [];
  }
  const correlated = (sets, type) => {
    const out = [];
    for (const s of sets) for (const c of s.correlations || []) if (c.correlatedIdentifierType === type) for (const i of c.correlatedIdentifiers || []) out.push(String(i.identifier));
    return [...new Set(out)];
  };

  async function building(lon, lat) {
    return memo(`bld:${lon.toFixed(5)},${lat.toFixed(5)}`, 3600e3, async () => {
      await resolveCollections();
      const [b, part] = await Promise.all([ngdAt(collections.building, lon, lat), ngdAt(collections.part, lon, lat).catch(() => null)]);
      if (!b && !part) return { found: false };
      const P = b?.properties || {}, Q = part?.properties || {};
      const toid = Q.toid || null;
      let uprns = [];
      const ref = P.uprnreference;
      if (Array.isArray(ref)) uprns = ref.map((r) => (r && typeof r === 'object' ? r.uprn ?? r.UPRN : r)).filter((v) => v != null).map(String);
      const notes = [];
      if (toid) {
        try { uprns = [...new Set([...correlated(await links(toid), 'UPRN'), ...uprns])]; } catch (e) { notes.push(e.message); }
      }
      let usrn = null;
      if (uprns[0]) {
        try { usrn = correlated(await links(uprns[0]), 'USRN')[0] || null; } catch (e) { notes.push(e.message); }
      }
      const [E, N] = toBNG(lon, lat);
      return {
        found: true,
        collections: { ...collections },
        osid: P.osid || Q.osid || null,
        toid,
        uprns: uprns.slice(0, 40),
        uprnCount: uprns.length,
        usrn,
        building: pick(P, BUILDING_FIELDS),
        part: pick(Q, PART_FIELDS),
        geometry: (b || part).geometry,
        bng: { E: Math.round(E), N: Math.round(N), ref: gridRef(E, N, 5) },
        notes,
      };
    });
  }

  // What this key can actually reach. Probed once (then every 10 minutes) so the client never
  // starts a layer the plan can't serve. A successful premium probe costs one tile or one feature.
  let caps = null, capsAt = 0, capsBusy = null;
  async function capabilities() {
    if (!key) return null;
    if (caps && Date.now() - capsAt < 10 * 60e3) return caps;
    if (capsBusy) return capsBusy;
    const probe = async (fn) => {
      try { await fn(); return { ok: true }; } catch (e) { return { ok: false, code: e.code || 'error', message: e.message.replace(/^\[[a-z_]+\] /, '') }; }
    };
    capsBusy = (async () => {
      await resolveCollections();
      const [premiumTiles, ngd, boundaries] = await Promise.all([
        probe(() => tile(16, 21793, 32746)),
        probe(() => ngdAt(collections.building, -0.12761, 51.50074)),
        probe(() => tile(12, 1362, 2046, 'boundaries')),
      ]);
      caps = { premiumTiles, ngd, boundaries };
      capsAt = Date.now();
      capsBusy = null;
      return caps;
    })();
    return capsBusy;
  }

  return {
    enabled: !!key,
    usage,
    status: async () => ({ enabled: !!key, usage, caps: await capabilities(), collections: { building: collections.building, part: collections.part } }),
    tile,
    names,
    building,
  };
}
