// British National Grid (EPSG:27700) conversions, following OS's "A Guide to Coordinate Systems
// in Great Britain": WGS84 ⇄ OSGB36 by 7-parameter Helmert transform, then the National Grid
// Transverse Mercator projection on the Airy 1830 ellipsoid. Helmert is good to roughly ±5 m;
// OSTN15 would be needed for centimetre accuracy. Shared by the browser and the Node server.

const RAD = Math.PI / 180;
const WGS84 = { a: 6378137, b: 6356752.314245 };
const AIRY = { a: 6377563.396, b: 6356256.909 };
const F0 = 0.9996012717;
const PHI0 = 49 * RAD, LAM0 = -2 * RAD, E0 = 400000, N0 = -100000;
// WGS84 → OSGB36 Helmert parameters (metres, ppm, arc-seconds).
const H = { tx: -446.448, ty: 125.157, tz: -542.06, s: 20.4894, rx: -0.1502, ry: -0.247, rz: -0.8421 };

function toCartesian(phi, lam, { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [nu * Math.cos(phi) * Math.cos(lam), nu * Math.cos(phi) * Math.sin(lam), (1 - e2) * nu * Math.sin(phi)];
}

function fromCartesian([x, y, z], { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const next = Math.atan2(z + e2 * nu * Math.sin(phi), p);
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  return [phi, Math.atan2(y, x)];
}

function helmert([x, y, z], sign) {
  const tx = sign * H.tx, ty = sign * H.ty, tz = sign * H.tz;
  const s = 1 + (sign * H.s) / 1e6;
  const rx = (sign * H.rx / 3600) * RAD, ry = (sign * H.ry / 3600) * RAD, rz = (sign * H.rz / 3600) * RAD;
  return [tx + s * x - rz * y + ry * z, ty + rz * x + s * y - rx * z, tz - ry * x + rx * y + s * z];
}

function meridional(phi) {
  const { a, b } = AIRY;
  const n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;
  const dp = phi - PHI0, sp = phi + PHI0;
  return b * F0 * (
    (1 + n + 1.25 * n2 + 1.25 * n3) * dp -
    (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dp) * Math.cos(sp) +
    ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dp) * Math.cos(2 * sp) -
    (35 / 24) * n3 * Math.sin(3 * dp) * Math.cos(3 * sp)
  );
}

// OSGB36 latitude/longitude (radians) → National Grid eastings/northings.
export function projectOSGB36(phi, lam) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const t2 = tan * tan, t4 = t2 * t2;
  const I = meridional(phi) + N0;
  const II = (nu / 2) * sin * cos;
  const III = (nu / 24) * sin * cos ** 3 * (5 - t2 + 9 * eta2);
  const IIIA = (nu / 720) * sin * cos ** 5 * (61 - 58 * t2 + t4);
  const IV = nu * cos;
  const V = (nu / 6) * cos ** 3 * (nu / rho - t2);
  const VI = (nu / 120) * cos ** 5 * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2);
  const dl = lam - LAM0;
  return [E0 + IV * dl + V * dl ** 3 + VI * dl ** 5, I + II * dl ** 2 + III * dl ** 4 + IIIA * dl ** 6];
}

// National Grid eastings/northings → OSGB36 latitude/longitude (radians).
export function unprojectOSGB36(E, N) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  let phi = (N - N0) / (a * F0) + PHI0;
  let M = meridional(phi);
  for (let i = 0; i < 20 && Math.abs(N - N0 - M) >= 1e-5; i++) {
    phi += (N - N0 - M) / (a * F0);
    M = meridional(phi);
  }
  const sin = Math.sin(phi), tan = Math.tan(phi), sec = 1 / Math.cos(phi);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const t2 = tan * tan, t4 = t2 * t2, t6 = t4 * t2;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - E0;
  return [phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6, LAM0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7];
}

// WGS84 lon/lat (degrees) → [easting, northing] in metres.
export function toBNG(lon, lat) {
  const osgb = fromCartesian(helmert(toCartesian(lat * RAD, lon * RAD, WGS84), 1), AIRY);
  return projectOSGB36(osgb[0], osgb[1]);
}

// [easting, northing] → WGS84 [lon, lat] in degrees.
export function fromBNG(E, N) {
  const [phi, lam] = unprojectOSGB36(E, N);
  const [lat, lon] = fromCartesian(helmert(toCartesian(phi, lam, AIRY), -1), WGS84);
  return [lon / RAD, lat / RAD];
}

// Is a point inside the National Grid's extent (Great Britain and its waters)?
export const inGrid = (E, N) => E >= 0 && E < 700000 && N >= 0 && N < 1300000;

// Eastings/northings → grid reference such as "TQ 3004 7963" (digits per axis: 2–5).
export function gridRef(E, N, digits = 4) {
  if (!inGrid(E, N)) return null;
  const e100k = Math.floor(E / 100000), n100k = Math.floor(N / 100000);
  let l1 = 19 - n100k - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  let l2 = ((19 - n100k) * 5) % 25 + (e100k % 5);
  if (l1 > 7) l1++;
  if (l2 > 7) l2++;
  const letters = String.fromCharCode(65 + l1) + String.fromCharCode(65 + l2);
  const div = 10 ** (5 - digits);
  const e = String(Math.floor((E % 100000) / div)).padStart(digits, '0');
  const n = String(Math.floor((N % 100000) / div)).padStart(digits, '0');
  return `${letters} ${e} ${n}`;
}

// Parse "TQ 30 80", "TQ3004079630" or "530040, 179630" into [E, N] (square centre), or null.
export function parseGridRef(text) {
  const t = text.trim().toUpperCase();
  const en = t.match(/^(\d{5,6}(?:\.\d+)?)\s*[, ]\s*(\d{5,7}(?:\.\d+)?)$/);
  if (en) {
    const E = +en[1], N = +en[2];
    return inGrid(E, N) ? [E, N] : null;
  }
  const m = t.replace(/\s+/g, '').match(/^([A-HJ-Z])([A-HJ-Z])(\d*)$/);
  if (!m || m[3].length % 2 || m[3].length > 10) return null;
  let l1 = m[1].charCodeAt(0) - 65, l2 = m[2].charCodeAt(0) - 65;
  if (l1 > 7) l1--;
  if (l2 > 7) l2--;
  const e100k = ((l1 - 2) % 5) * 5 + (l2 % 5);
  const n100k = 19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5);
  if (e100k < 0 || e100k > 6 || n100k < 0 || n100k > 12) return null;
  const half = m[3].length / 2;
  const size = half ? 10 ** (5 - half) : 100000;
  const e = half ? +m[3].slice(0, half) * size : 0;
  const n = half ? +m[3].slice(half) * size : 0;
  return [e100k * 100000 + e + size / 2, n100k * 100000 + n + size / 2];
}
