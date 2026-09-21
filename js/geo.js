// Geographic helpers and the shared scene frame.
// The three.js scene works in metres around an origin (x east, y north, z up), which keeps
// float32 precision on the GPU. The origin moves when the camera travels far away.

export const EARTH_C = 40075016.68557849;
const RAD = Math.PI / 180;

export const mercX = (lon) => (180 + lon) / 360;
export const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
export const lonFromMercX = (x) => x * 360 - 180;
export const latFromMercY = (y) => (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

// Mercator units per metre at a latitude (MapLibre's meterInMercatorCoordinateUnits).
export const mercPerMeter = (lat) => 1 / (EARTH_C * Math.cos(lat * RAD));

// Metres per CSS pixel at a zoom level (MapLibre uses 512px tiles).
export const metersPerPixel = (lat, zoom) => (EARTH_C * Math.cos(lat * RAD)) / (512 * Math.pow(2, zoom));

export const frame = { lon: 0, lat: 0, ox: 0, oy: 0, s: 1, version: 0 };

export function setOrigin(lon, lat) {
  frame.lon = lon;
  frame.lat = lat;
  frame.ox = mercX(lon);
  frame.oy = mercY(lat);
  frame.s = mercPerMeter(lat);
  frame.version++;
}

export function toScene(lon, lat, alt = 0, out = [0, 0, 0]) {
  out[0] = (mercX(lon) - frame.ox) / frame.s;
  out[1] = -(mercY(lat) - frame.oy) / frame.s;
  out[2] = alt;
  return out;
}

export function fromScene(x, y) {
  return [lonFromMercX(frame.ox + x * frame.s), latFromMercY(frame.oy - y * frame.s)];
}

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

export function tileOf(lon, lat, z) {
  const n = 2 ** z;
  return [Math.floor(mercX(lon) * n), Math.floor(mercY(lat) * n)];
}

export function tileCenter(z, x, y) {
  const n = 2 ** z;
  return [lonFromMercX((x + 0.5) / n), latFromMercY((y + 0.5) / n)];
}

// Sun position (after SunCalc). Returns altitude and azimuth in degrees, azimuth from north.
export function sunPosition(date, lat, lon) {
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = lat * RAD;
  const H = RAD * (280.16 + 360.9856235 * d) + lon * RAD - ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { alt: alt / RAD, az: (az / RAD + 180 + 360) % 360 };
}

export function polygonAreaM2(ring) {
  // ring: [[lon,lat],...] — equirectangular approximation, fine at city scale.
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1] * RAD;
  const kx = 6371008.8 * Math.cos(lat0) * RAD;
  const ky = 6371008.8 * RAD;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(a / 2);
}
