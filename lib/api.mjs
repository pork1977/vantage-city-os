// Vantage's server-side half: proxies for the few free APIs that block browser requests (no CORS
// headers, or a User-Agent the browser can't set), plus the Ordnance Survey proxy that keeps the API
// key off the client. Shared by the local server (server.mjs) and the Vercel functions in api/.
// Every response is cached, in memory and (with Cache-Control) at the CDN, so we stay well inside
// each provider's fair-use limits.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOs, loadOsKey } from '../os-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'VantageCityOS/0.1 (+https://github.com/pork1977/vantage-city-os)';
export const os = createOs({ key: loadOsKey(ROOT), ua: UA });

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return v;
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

// Nominatim's usage policy allows one request per second.
let nominatimChain = Promise.resolve();
let nominatimLast = 0;
function nominatim(fn) {
  const run = nominatimChain.then(async () => {
    const wait = 1100 - (Date.now() - nominatimLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nominatimLast = Date.now();
    return fn();
  });
  nominatimChain = run.catch(() => {});
  return run;
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const DAY = 'public, max-age=3600, s-maxage=86400';

// path → [Cache-Control for successful answers, handler(query)]
const routes = {
  // Live aircraft (ADS-B). adsb.lol first, adsb.fi as fallback; both are free and open.
  '/api/flights': ['public, max-age=5, s-maxage=8, stale-while-revalidate=20', async (q) => {
    const lat = Number(q.get('lat')).toFixed(2);
    const lon = Number(q.get('lon')).toFixed(2);
    const dist = Math.round(Math.min(120, Math.max(5, Number(q.get('dist')) || 40)));
    if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) throw badRequest('lat and lon are required');
    return cached(`flights:${lat},${lon},${dist}`, 8000, async () => {
      const sources = [
        ['adsb.lol', `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`],
        ['adsb.fi', `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`],
      ];
      let lastErr;
      for (const [source, url] of sources) {
        try {
          const d = await getJSON(url);
          return { source, now: d.now, ac: d.ac || d.aircraft || [] };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    });
  }],

  // Ordnance Survey (see os-proxy.mjs). Status needs no key; the rest report a clear error without one.
  // Short CDN cache: every open page polls this, and on Vercel each instance counts usage separately anyway.
  '/api/os/status': ['public, max-age=15, s-maxage=30', async () => os.status()],
  '/api/os/names': [DAY, async (q) => {
    const text = (q.get('q') || '').trim().slice(0, 120);
    return text.length < 2 ? [] : os.names(text);
  }],
  '/api/os/building': [DAY, async (q) => {
    const lon = Number(q.get('lon')), lat = Number(q.get('lat'));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw badRequest('lon and lat are required');
    return os.building(lon, lat);
  }],

  // Place search. Browsers can't set the User-Agent Nominatim asks for, so it goes through here.
  '/api/geocode': [DAY, async (q) => {
    const text = (q.get('q') || '').trim().slice(0, 200);
    if (!text) return [];
    return cached(`geo:${text.toLowerCase()}`, 3600e3, () =>
      nominatim(() =>
        getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(text)}`)
      )
    );
  }],
};

// OS vector tiles: /api/os/tile?z=&y=&x= (basemap) or &layer=boundaries.
const OS_LAYERS = new Set(['', 'boundaries']);
async function osTile(q) {
  const layer = q.get('layer') || '';
  const [z, y, x] = ['z', 'y', 'x'].map((k) => Number(q.get(k)));
  if (!OS_LAYERS.has(layer) || ![z, y, x].every(Number.isInteger) || z < 0 || z > 20 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw badRequest('layer, z, y and x must describe a valid tile');
  }
  return os.tile(z, y, x, layer);
}

function send(res, status, body, type, cacheControl) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cacheControl });
  res.end(body);
}

// Answers an /api/* request. Returns false for any other path so the caller can serve files.
export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[url.pathname];
  if (!route && url.pathname !== '/api/os/tile') return false;
  try {
    if (!route) {
      send(res, 200, await osTile(url.searchParams), 'application/x-protobuf', DAY);
    } else {
      const data = await route[1](url.searchParams);
      send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8', route[0]);
    }
  } catch (e) {
    send(res, e.status || 502, JSON.stringify({ error: e.message, code: e.code }), 'application/json; charset=utf-8', 'no-store');
  }
  return true;
}

// Vercel function entry point (api/*.js). A path no route knows still gets an answer instead of hanging.
export async function vercelHandler(req, res) {
  if (!(await handleApi(req, res))) send(res, 404, JSON.stringify({ error: 'Not found' }), 'application/json; charset=utf-8', 'no-store');
}
