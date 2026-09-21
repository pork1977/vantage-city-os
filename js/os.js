// Browser side of the Ordnance Survey integration. All OS requests go through the local server,
// which holds the API key; see os-proxy.mjs.
import { fetchJSON, esc, fmt } from './util.js';
import { toBNG, gridRef, inGrid } from './bng.js';

export async function osStatus() {
  try {
    return await fetchJSON('/api/os/status', { timeout: 5000 });
  } catch {
    return { enabled: false, offline: true };
  }
}

export const osNames = (q) => fetchJSON(`/api/os/names?q=${encodeURIComponent(q)}`);
export const osBuilding = (lon, lat) => fetchJSON(`/api/os/building?lon=${lon.toFixed(7)}&lat=${lat.toFixed(7)}`, { timeout: 30000 });

// OS MasterMap zone radius (metres) at a map zoom.
export const osRange = (zoom) => Math.max(700, Math.min(1500, 1250 * 2 ** (15.5 - zoom)));
export const OS_MIN_ZOOM = 15.0;

export function bng(lon, lat) {
  const [E, N] = toBNG(lon, lat);
  if (!inGrid(E, N)) return null;
  return { E, N, ref: gridRef(E, N, 4), ref10: gridRef(E, N, 5) };
}

// Official OS logo and copyright statement (os-api-branding), only once OS data is on screen.
let branded = false;
export function initBranding() {
  if (branded || !window.os?.Branding) return;
  window.os.Branding.init({ div: 'os-brand', logo: 'os-logo-maps-white' });
  branded = true;
  document.body.classList.add('os-on');
}

const tidy = (v) => (v == null ? null : String(v).replace(/^Commercial Activity: |^Community Services: |^Residential Accommodation: /, ''));

export function osBuildingHtml(d) {
  const b = d.building || {}, p = d.part || {};
  const h = b.height_relativemax_m ?? p.height_relativemax_m;
  const roofBase = b.height_relativeroofbase_m ?? p.height_relativeroofbase_m;
  const conf = b.height_confidencelevel ?? p.height_confidencelevel;
  const age = b.buildingage_year ? `Built ${b.buildingage_year}` : b.buildingage_period ? `Built ${b.buildingage_period}` : null;
  const south = ['roofshapeaspect_areafacingsouth_m2', 'roofshapeaspect_areafacingsoutheast_m2', 'roofshapeaspect_areafacingsouthwest_m2']
    .map((k) => b[k]).filter((v) => v != null);
  const southArea = south.length ? south.reduce((s, v) => s + v, 0) : null;
  const floors = b.numberoffloors != null ? `${b.numberoffloors}${b.basementpresence === 'Present' ? ' + basement' : ''}` : null;
  // Roof extras: the things a planner or retrofit team would ask about first.
  const extras = [
    b.roofmaterial_solarpanelpresence === 'Present' ? 'Solar panels' : null,
    b.roofmaterial_greenroofpresence === 'Present' ? 'Green roof' : null,
    southArea ? `${fmt(southArea)} m² south-facing` : null,
  ].filter(Boolean).join(' · ') || null;
  const rows = [
    ['Use', tidy(b.buildinguse)],
    ['Material', b.constructionmaterial],
    ['Floors', floors],
    ['Roof', [b.roofshapeaspect_shape, b.roofmaterial_primarymaterial].filter((v) => v && v !== 'Unknown').join(' · ') || null],
    ['Roof extras', extras],
    ['UPRN', d.uprns?.length ? `${d.uprns[0]}${d.uprnCount > 1 ? ` +${d.uprnCount - 1}` : ''}` : null],
    ['USRN', d.usrn],
    ['Grid ref', d.bng?.ref],
  ].filter(([, v]) => v != null && v !== '' && v !== 'Unknown');
  const sub = [
    h != null ? `${fmt(h, 1)} m${roofBase != null ? ` · eaves ${fmt(roofBase, 1)}` : ''}` : null,
    age,
    b.physicalstate && b.physicalstate !== 'Built' ? b.physicalstate : null,
  ].filter(Boolean).join(' · ');
  return `<div class="hp-kicker">OS NGD${d.toid ? ` · TOID ${esc(d.toid)}` : ''}${conf ? ` · height ${esc(conf.toLowerCase())}` : ''}</div>
    <div class="hp-title">${esc(b.description || p.description || 'Structure')}</div>
    <div class="hp-sub">${esc(sub || 'OS MasterMap building')}</div>
    <dl class="hp-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}
