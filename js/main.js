import * as THREE from 'three';
import { setOrigin, frame, haversine, sunPosition, toScene, polygonAreaM2 } from './geo.js';
import { Overlay } from './overlay.js';
import { CityLayer } from './city.js';
import { Panels, Tags } from './panels.js';
import { AirLayer } from './layers/air.js';
import { WeatherLayer } from './layers/weather.js';
import { RouteLayer } from './layers/route.js';
import { TflLayer } from './layers/tfl.js';
import { BikesLayer } from './layers/bikes.js';
import { FlightsLayer } from './layers/flights.js';
import { buildStyle } from './style.js';
import { fetchJSON, esc, fmt, fmtDist, fmtDuration, ago, eaqiBand, WMO, compass } from './util.js';
import { osStatus, osNames, osBuilding, osRange, OS_MIN_ZOOM, bng, initBranding, osBuildingHtml } from './os.js';
import { parseGridRef, fromBNG, gridRef } from './bng.js';
import { CityAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Looking east along the Thames from Blackfriars: the City towers left, the Shard right.
const START = { center: [-0.0995, 51.5079], zoom: 14.85, pitch: 64, bearing: 74 };
// While the welcome screen is up the camera circles high over the same spot, then dives in.
const INTRO_VIEW = { center: START.center, zoom: 13.9, pitch: 56, bearing: 18 };
const SKIP_INTRO = /[?&#]enter\b/.test(location.search + location.hash);
const DEFAULT_ROUTE = [[-0.1131, 51.5031], [-0.0823, 51.5178]]; // Waterloo → Liverpool Street
const WAYPOINTS = [
  ['The City', [-0.0832, 51.5138], 15.7, 66, -35],
  ['Westminster', [-0.1257, 51.5003], 15.8, 62, 40],
  ['The Shard', [-0.0865, 51.5045], 16.1, 70, 205],
  ['Canary Wharf', [-0.0195, 51.5049], 15.5, 66, 290],
  ["King's Cross", [-0.1240, 51.5320], 15.7, 60, 160],
  ['Hyde Park', [-0.1655, 51.5073], 14.7, 56, 20],
  ['Olympic Park', [-0.0166, 51.5430], 15.0, 62, 230],
  ['Overview', [-0.1080, 51.5075], 12.9, 58, 20],
];

const state = { rerouted: false, parks: [], sector: null, picking: 0, orbit: false, introOrbit: !SKIP_INTRO, entered: false, lastInteract: 0, place: null };
const audio = new CityAudio();

// ---------- data feeds + event log ----------
const FEEDS = {
  tiles: { name: 'Vector tiles', src: 'OpenFreeMap · OSM' },
  air: { name: 'Air quality', src: 'Open-Meteo · CAMS' },
  weather: { name: 'Weather', src: 'Open-Meteo' },
  tube: { name: 'Rail network', src: 'TfL Unified API' },
  status: { name: 'Line status', src: 'TfL Unified API' },
  roads: { name: 'Road disruptions', src: 'TfL Unified API' },
  bikes: { name: 'Cycle docks', src: 'TfL BikePoint' },
  route: { name: 'Routing', src: 'OSRM · FOSSGIS' },
  flights: { name: 'Aircraft', src: 'ADS-B · adsb.lol' },
  osvts: { name: 'OS MasterMap', src: 'OS Vector Tile API' },
  osnames: { name: 'OS Names', src: 'OS Names API' },
  osngd: { name: 'OS building intel', src: 'OS NGD · Linked IDs' },
  osbnd: { name: 'OS boundaries', src: 'OS Boundary-Line' },
};
for (const f of Object.values(FEEDS)) Object.assign(f, { status: 'idle', detail: '', updated: 0 });

function feed(id, patch) {
  Object.assign(FEEDS[id], patch);
  if (patch.status === 'live') FEEDS[id].updated = Date.now();
  renderFeeds();
}

// Welcome-screen source list, each line lit by the live status of the feeds behind it.
const INTRO_ITEMS = [
  { feeds: ['osnames', 'osbnd', 'osvts', 'osngd'], name: 'Ordnance Survey', text: () => osIntroText() },
  { feeds: ['tiles'], name: 'OpenStreetMap', text: () => 'Every building, park and river in 3D, via OpenFreeMap vector tiles.' },
  { feeds: ['air', 'weather'], name: 'Open-Meteo', text: () => 'Live air quality from Copernicus CAMS, and the weather over the city.' },
  { feeds: ['tube', 'status', 'roads', 'bikes'], name: 'Transport for London', text: () => 'Tube, Elizabeth line and DLR status, road disruptions, every cycle dock.' },
  { feeds: ['flights'], name: 'ADS-B receivers', text: () => 'Aircraft overhead at their true altitude, from the adsb.lol network.' },
  { feeds: ['route'], name: 'OSRM routing', text: () => 'Routes re-scored on travel time, pollution exposure and disruptions.' },
];
function osIntroText() {
  const os = app.osState;
  if (!os || !os.enabled) return 'British National Grid throughout; add an OS key for Names, boundaries and MasterMap.';
  if (os.premium) return 'National Grid, OS Names, Boundary-Line, MasterMap 3D buildings and NGD building data.';
  return 'National Grid, OS Names and Boundary-Line boroughs and wards. MasterMap 3D and NGD arrive with Premium.';
}
function renderIntro() {
  const list = $('intro-list');
  if (!list) return;
  list.innerHTML = INTRO_ITEMS.map((it) => {
    const st = it.feeds.map((id) => FEEDS[id].status);
    const live = st.filter((x) => x === 'live').length;
    const cls = live === st.length ? 'st-live' : live ? 'st-part' : st.includes('loading') ? 'st-loading' : st.every((x) => x === 'error') ? 'st-error' : st.some((x) => x === 'off') && !live ? 'st-off' : 'st-loading';
    return `<li><span class="dot ${cls}"></span><b>${esc(it.name)}</b><span>${esc(it.text())}</span></li>`;
  }).join('');
  const all = Object.values(FEEDS).filter((f) => f.status !== 'off');
  const live = all.filter((f) => f.status === 'live').length;
  $('intro-count').textContent = `${live} / ${all.length} live`;
  $('intro-meter').style.width = `${all.length ? (live / all.length) * 100 : 0}%`;
}

function renderFeeds() {
  renderIntro();
  $('feeds').innerHTML = Object.values(FEEDS)
    .map(
      (f) => `<li><span class="feed-name">${esc(f.name)}</span><span class="feed-src">${esc(f.src)}</span>
      <span class="feed-state st-${f.status}"><b>${f.status === 'live' ? 'Live' : f.status === 'loading' ? 'Sync' : f.status === 'error' ? 'Error' : f.status === 'off' ? 'Off' : 'Idle'}</b>
      <small title="${esc(f.detail)}">${esc((f.detail || '').slice(0, 26))}${f.updated ? ' · ' + ago(f.updated) : ''}</small></span></li>`
    )
    .join('');
}

const logEl = $('log');
function log(tag, msg, level = 'info') {
  const li = document.createElement('li');
  li.className = level;
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  li.innerHTML = `<time>${t}</time><span class="tg">${esc(tag)}</span><span title="${esc(msg)}">${esc(msg)}</span>`;
  logEl.prepend(li);
  while (logEl.children.length > 6) logEl.lastChild.remove();
}

const bootLog = $('boot-log');
function boot(label, promise) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${esc(label)}</span><b class="wait">…</b>`;
  bootLog.appendChild(li);
  return Promise.resolve(promise).then(
    (v) => { li.querySelector('b').className = 'ok'; li.querySelector('b').textContent = 'OK'; return v; },
    (e) => { li.querySelector('b').className = e?.bootLabel ? 'wait' : 'err'; li.querySelector('b').textContent = e?.bootLabel || 'FAIL'; throw e; }
  );
}

async function run(id, fn, describe = () => '') {
  feed(id, { status: 'loading' });
  try {
    const r = await fn();
    feed(id, { status: 'live', detail: describe(r) });
    return r;
  } catch (e) {
    feed(id, { status: 'error', detail: e.message });
    log('ERR', `${FEEDS[id].name}: ${e.message}`, 'crit');
    throw e;
  }
}

const app = { state, feed, log };

// ---------- persisted toggles ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem('vantage.toggles') || '{}'); } catch { return {}; } })();
const persist = (obj) => { try { localStorage.setItem('vantage.toggles', JSON.stringify(obj)); } catch {} };

// ---------- map ----------
setOrigin(...START.center);
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: SKIP_INTRO ? START.center : INTRO_VIEW.center,
  zoom: SKIP_INTRO ? START.zoom : INTRO_VIEW.zoom,
  pitch: SKIP_INTRO ? START.pitch : INTRO_VIEW.pitch,
  bearing: SKIP_INTRO ? START.bearing : INTRO_VIEW.bearing,
  maxPitch: 78,
  antialias: true,
  attributionControl: false,
  fadeDuration: 150,
});
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution: 'Open-Meteo (CC BY 4.0) · Powered by TfL Open Data · Routing OSRM / FOSSGIS · ADS-B adsb.lol (ODbL) · Search Nominatim',
  }),
  'bottom-right'
);
map.on('error', (e) => console.warn('Map error:', e.error?.message || e));

// Start the overlay as soon as the style is parsed; tiles keep streaming in behind it.
const mapReady = new Promise((resolve) => (map.isStyleLoaded() ? resolve() : map.once('style.load', resolve)));
boot('Map core · MapLibre GL + three.js', mapReady);

// ---------- welcome screen ----------
const introEl = $('intro');
function syncSoundButtons() {
  // The welcome screen's controls are removed after entering, so look them up defensively.
  for (const id of ['snd', 'intro-sound']) $(id)?.setAttribute('aria-pressed', String(audio.on));
  const label = $('intro-sound-label');
  if (label) label.textContent = audio.on ? 'Sound on' : 'Sound off';
}
// No soundscape drifting out of a background tab.
document.addEventListener('visibilitychange', () => audio.setHidden(document.hidden));
syncSoundButtons();
// Sound defaults to on, but browsers only let audio start inside a gesture: begin on the first
// click, tap or key press anywhere (usually the Enter button). pointerdown fires before click, so
// a first click on a sound button still toggles from a running soundscape.
{
  const unlock = () => {
    for (const ev of ['pointerdown', 'keydown']) document.removeEventListener(ev, unlock, true);
    if (audio.on) audio.start();
  };
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlock, true);
  // Firefox can say up front whether audio may start without a gesture (e.g. autoplay allowed for this site).
  if (navigator.getAutoplayPolicy?.('audiocontext') === 'allowed') unlock();
}
renderIntro();
$('intro-sound').addEventListener('click', () => {
  audio.setOn(!audio.on);
  if (audio.on) audio.start();
  syncSoundButtons();
});
$('intro-enter').addEventListener('click', () => enterCity());
const introClock = setInterval(() => {
  $('intro-clock').textContent = `London · ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false })}`;
}, 500);
function enterCity(quiet = false) {
  if (state.entered) return;
  state.entered = true;
  state.introOrbit = false;
  clearInterval(introClock);
  document.body.classList.remove('in-intro');
  if (!quiet && audio.on && audio.start()) audio.whoosh();
  introEl.classList.add('leaving');
  setTimeout(() => introEl.remove(), 1900);
  const dur = reduceMotion || quiet ? 0 : 5600;
  map.flyTo({ center: START.center, zoom: START.zoom, pitch: START.pitch, bearing: START.bearing, duration: dur, curve: 1.3, essential: true });
  setTimeout(() => $('hud').classList.remove('hidden'), dur * 0.62);
  setTimeout(() => {
    app.overlay?.scan(...START.center);
    log('SYS', 'Welcome to Vantage City OS');
  }, dur + 100);
}
if (SKIP_INTRO) enterCity(true);

document.addEventListener('keydown', (e) => {
  if (!state.entered && (e.key === 'Enter' || e.key === ' ') && !e.target.closest?.('button')) {
    e.preventDefault();
    enterCity();
  }
});
function toggleSound() {
  audio.setOn(!audio.on);
  if (audio.on) audio.start();
  syncSoundButtons();
  app.log?.('SOUND', audio.on ? 'Soundscape on' : 'Muted');
}
$('snd').addEventListener('click', toggleSound);

mapReady.then(async () => {
  const overlay = new Overlay(map, $('fx'));
  const panels = new Panels(overlay, $('panels'));
  const tags = new Tags(overlay, $('tags'));
  Object.assign(app, { overlay, panels, tags });

  let tileFeedTimer = 0;
  const city = overlay.add(
    new CityLayer(overlay, {
      onStats: (s, parks) => { state.sector = s; state.parks = parks; renderSector(); },
      onTile: () => {
        clearTimeout(tileFeedTimer);
        tileFeedTimer = setTimeout(() => {
          const c = city.counts();
          feed('tiles', { status: 'live', detail: `${c.ready} tiles · ${(c.bytes / 1e6).toFixed(1)} MB` });
        }, 250);
      },
      // A failed tile is dropped and re-requested on the next camera refresh, so it's a warning, not an outage.
      onError: (e) => { feed('tiles', { detail: 'retrying a tile' }); log('TILES', `${e} · will retry`, 'warn'); },
    })
  );
  const air = overlay.add(new AirLayer(overlay, app));
  const weather = overlay.add(new WeatherLayer(overlay, app));
  const tfl = overlay.add(new TflLayer(overlay, app));
  const route = overlay.add(new RouteLayer(overlay, app, air, tfl));
  const bikes = overlay.add(new BikesLayer(overlay, app));
  const flights = overlay.add(new FlightsLayer(overlay, app));
  // ---------- Ordnance Survey ----------
  // With a key, OS MasterMap buildings (zoom 16, RelHMax heights) take over inside an inner zone
  // around the view centre and OSM buildings continue beyond it.
  const osInfo = await osStatus();
  const caps = osInfo.caps || {};
  // What the key can reach decides which OS layers start. keyBad kills everything; premium only
  // gates MasterMap buildings, ngd only gates building intelligence. Names and boundaries are OpenData.
  const osState = {
    enabled: !!osInfo.enabled,
    keyBad: caps.premiumTiles?.code === 'key_rejected' && caps.boundaries?.ok === false,
    premium: !!caps.premiumTiles?.ok,
    ngd: !!caps.ngd?.ok,
    boundaries: !!caps.boundaries?.ok,
  };
  osState.on = osState.premium;
  app.osState = osState;
  const planLabel = !osState.enabled ? 'NO KEY' : osState.keyBad ? 'KEY ERROR' : osState.premium ? 'PREMIUM' : 'OPEN DATA';
  boot('Ordnance Survey Data Hub', osState.enabled && !osState.keyBad && osState.premium ? Promise.resolve() : Promise.reject(Object.assign(new Error(planLabel), { bootLabel: planLabel }))).catch(() => {});
  if (osState.enabled && !osState.premium && caps.premiumTiles?.message) log('OS', caps.premiumTiles.message, 'warn');
  if (osState.enabled && !osState.ngd && caps.ngd?.message) log('OS', caps.ngd.message, 'warn');
  let osCity = null;
  if (osState.enabled && osState.premium) {
    let osFeedTimer = 0;
    osCity = overlay.add(
      new CityLayer(overlay, {
        z: 16,
        schema: 'os',
        template: '/api/os/tile?z={z}&y={y}&x={x}',
        ownRange: true,
        grid: false,
        workers: 2,
        maxTiles: 64,
        minZoom: OS_MIN_ZOOM,
        range: (z) => osRange(z) * THREE.MathUtils.smoothstep(z, OS_MIN_ZOOM, OS_MIN_ZOOM + 0.5),
        tint: { low: '#1a4f8a', high: '#a9d8ff', edge: '#8fd0ff' },
        onTile: () => {
          initBranding(); // the OS logo and statement appear once OS data is actually on screen
          clearTimeout(osFeedTimer);
          osFeedTimer = setTimeout(() => feed('osvts', { status: 'live', detail: `${osCity.counts().ready} tiles in zone` }), 250);
        },
        onError: (e) => {
          if (osState.keyBad || !osState.premium) return; // report once, not once per tile
          if (/key_rejected|no_key/.test(e)) {
            osState.keyBad = true;
            feed('osvts', { status: 'error', detail: 'key rejected' });
            log('OS', e.replace(/\[[a-z_]+\] /, ''), 'crit');
          } else if (/premium_required|api_not_enabled/.test(e)) {
            osState.premium = false;
            feed('osvts', { status: 'off', detail: 'Premium plan needed' });
            log('OS', e.replace(/\[[a-z_]+\] /, ''), 'warn');
          } else log('OS', `${e} · will retry`, 'warn');
        },
      })
    );
    overlay.add({
      update(ctx) {
        const active = osState.on && osState.premium && !osState.keyBad && on.city && ctx.zoom >= OS_MIN_ZOOM;
        osCity.setActive(active);
        overlay.u.uInner.value = active ? osCity.rangeU.value : 0;
      },
    });
    feed('osvts', { status: 'idle', detail: `zoom past ${OS_MIN_ZOOM}` });
  }
  if (!osState.enabled) {
    for (const id of ['osvts', 'osnames', 'osngd', 'osbnd']) feed(id, { status: 'off', detail: osInfo.offline ? 'server offline' : 'no OS key · see README' });
  } else {
    if (!osState.premium) feed('osvts', { status: 'off', detail: 'Premium plan needed' });
    feed('osnames', osState.keyBad ? { status: 'error', detail: 'key rejected' } : { status: 'idle', detail: 'search ready' });
    feed('osngd', osState.ngd ? { status: 'idle', detail: 'click a building' } : { status: 'off', detail: caps.ngd?.code === 'api_not_enabled' ? 'add NGD to project' : 'Premium plan needed' });
    if (osState.boundaries) addOsBoundaries();
    else feed('osbnd', { status: 'error', detail: caps.boundaries?.message || 'unavailable' });
  }

  // OS Boundary-Line (OpenData): borough and ward outlines, plus a live "where am I" readout.
  function addOsBoundaries() {
    const src = `${location.origin}/api/os/tile?layer=boundaries&z={z}&y={y}&x={x}`;
    map.addSource('os-bnd', { type: 'vector', tiles: [src], minzoom: 8, maxzoom: 15 });
    const before = 'road-labels';
    const BOROUGH = ['LBO', 'DIS', 'UTA', 'MTD'];
    const WARD = ['LBW', 'DIW', 'UTW', 'MTW'];
    const inCodes = (codes) => ['in', ['get', 'AREA_CODE'], ['literal', codes]];
    map.addLayer({ id: 'os-ward-line', type: 'line', source: 'os-bnd', 'source-layer': 'Boundary_line', minzoom: 12, filter: inCodes(WARD),
      paint: { 'line-color': '#b9a8ff', 'line-opacity': 0.32, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 17, 1.4], 'line-dasharray': [3, 3] } }, before);
    map.addLayer({ id: 'os-borough-glow', type: 'line', source: 'os-bnd', 'source-layer': 'Boundary_line', filter: inCodes(BOROUGH),
      paint: { 'line-color': '#9d84ff', 'line-opacity': 0.22, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 16, 14], 'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 2, 16, 8] } }, before);
    map.addLayer({ id: 'os-borough-line', type: 'line', source: 'os-bnd', 'source-layer': 'Boundary_line', filter: inCodes(BOROUGH),
      paint: { 'line-color': '#cdbfff', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 16, 2.4] } }, before);
    // Invisible fills make the polygons queryable at the view centre.
    map.addLayer({ id: 'os-bnd-fill', type: 'fill', source: 'os-bnd', 'source-layer': 'Boundary_line', filter: inCodes([...BOROUGH, ...WARD, 'WMC']), paint: { 'fill-opacity': 0 } }, before);
    let tilesSeen = false;
    map.on('sourcedata', (e) => {
      if (e.sourceId !== 'os-bnd' || !e.tile || tilesSeen) return;
      tilesSeen = true;
      initBranding(); // the OS logo and statement appear once OS data is actually on screen
      feed('osbnd', { status: 'live', detail: 'boroughs · wards' });
    });
    let placeTimer = 0;
    map.on('moveend', (e) => {
      if (e.vantageAdjust) return;
      clearTimeout(placeTimer);
      placeTimer = setTimeout(readPlace, 150);
    });
    map.once('idle', readPlace);
  }
  const tidyName = (n) => (n || '').replace(/ London Boro$/, '').replace(/ Boro Const$/, '').replace(/ Ward$/, '').replace(/ Co Const$/, '');
  let lastBorough = '';
  function readPlace() {
    if (!map.getLayer('os-bnd-fill')) return;
    const c = map.project(map.getCenter());
    const feats = map.queryRenderedFeatures(c, { layers: ['os-bnd-fill'] });
    const byCode = (codes) => feats.find((f) => codes.includes(f.properties.AREA_CODE))?.properties;
    const borough = byCode(['LBO', 'DIS', 'UTA', 'MTD']);
    const ward = byCode(['LBW', 'DIW', 'UTW', 'MTW']);
    const seat = byCode(['WMC']);
    state.place = borough || ward ? { borough: tidyName(borough?.NAME), boroughCode: borough?.CODE, ward: tidyName(ward?.NAME), wardCode: ward?.CODE, seat: tidyName(seat?.NAME) } : null;
    renderPlace();
    if (state.place?.borough && state.place.borough !== lastBorough) {
      lastBorough = state.place.borough;
      log('OS', `Entered ${state.place.borough}${state.place.ward ? ' · ' + state.place.ward + ' ward' : ''}`);
    }
  }
  function renderPlace() {
    const el = $('sector-place');
    const p = state.place;
    el.hidden = !p;
    if (!p) return;
    el.innerHTML = `<b>${esc(p.borough || 'Unknown borough')}</b><span>${esc([p.ward ? p.ward + ' ward' : '', p.wardCode, p.seat ? p.seat + ' constituency' : ''].filter(Boolean).join(' · '))}</span>`;
  }

  // Handy for exploring from the browser console.
  window.vantage = { map, overlay, city, osCity, air, weather, tfl, route, bikes, flights, panels, tags, audio };

  // Highlight for a clicked building.
  const highlight = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: new THREE.Color('#eaffff'), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })
  );
  highlight.frustumCulled = false;
  highlight.renderOrder = 9;
  overlay.scene.add(highlight);
  let highlightFeature = null;

  // ---------- layer toggles ----------
  let booted = false;
  let flightsAt = null;
  const LAYERS = [
    { key: 'city', label: 'Holo city', hot: '1', color: '#62e6ff', set: (on) => city.setVisible('city', on) },
    { key: 'green', label: 'Green space', hot: '2', color: '#45f5a1', set: (on) => { city.setVisible('green', on); if (!on) panels.hide('green'); } },
    { key: 'air', label: 'Air quality', hot: '3', color: '#ffb547', set: (on) => air.setVisible(on) },
    { key: 'route', label: 'Routing', hot: '4', color: '#ff2d55', set: (on) => route.setVisible(on) },
    { key: 'tube', label: 'Rail network', hot: '5', color: '#a37cff', set: (on) => tfl.setVisible('tube', on) },
    { key: 'bikes', label: 'Cycle docks', hot: '6', color: '#ff7a8a', set: (on) => bikes.setVisible(on) },
    { key: 'roads', label: 'Road disruptions', hot: '7', color: '#ff4d4d', set: (on) => tfl.setVisible('roads', on) },
    { key: 'flights', label: 'Aircraft', hot: '8', color: '#ffd27a', set: (v) => { flights.setVisible(v); if (!v) feed('flights', { status: 'off', detail: 'layer hidden' }); else if (booted) loadFlights().catch(() => {}); } },
    { key: 'wind', label: 'Wind field', hot: '9', color: '#bdefff', set: (on) => weather.setVisible(on) },
    { key: 'grid', label: 'Survey grid', hot: '0', color: '#4fd8ff', set: (on) => city.setVisible('grid', on) },
  ];
  const on = {};
  $('toggles').innerHTML = LAYERS.map(
    (l) => `<button type="button" class="toggle" id="tg-${l.key}" data-key="${l.key}" style="--c:${l.color}" aria-pressed="true"><span class="led"></span><span>${esc(l.label)}</span><kbd>${l.hot}</kbd></button>`
  ).join('');
  function setLayer(key, value, quiet) {
    const l = LAYERS.find((x) => x.key === key);
    on[key] = value;
    $(`tg-${key}`).setAttribute('aria-pressed', String(value));
    l.set(value);
    persist(on);
    if (!quiet) log('LAYER', `${l.label} ${value ? 'online' : 'offline'}`);
  }
  for (const l of LAYERS) setLayer(l.key, saved[l.key] ?? true, true);
  $('toggles').addEventListener('click', (e) => {
    const b = e.target.closest('.toggle');
    if (b) setLayer(b.dataset.key, !on[b.dataset.key]);
  });

  const fx = { imagery: false, bloom: true, orbit: false, panels: true, os: osState.on };
  const setFx = (k, v) => {
    if (k === 'os' && !osState.premium) {
      log('OS', osState.enabled ? 'OS MasterMap buildings need the OS Premium plan on your Data Hub account' : 'Add OS_API_KEY to .env and restart the server to enable OS layers', 'warn');
      return;
    }
    fx[k] = v;
    $(`t-${k}`).setAttribute('aria-pressed', String(v));
    if (k === 'os') { osState.on = v; log('OS', `MasterMap buildings ${v ? 'online' : 'offline'}`); }
    if (k === 'imagery') map.setLayoutProperty('imagery', 'visibility', v ? 'visible' : 'none');
    if (k === 'bloom') overlay.setBloom(v);
    if (k === 'orbit') state.orbit = v;
    if (k === 'panels') { panels.enabled = v; if (v) panels.restore(); }
  };
  for (const k of Object.keys(fx)) $(`t-${k}`).addEventListener('click', () => setFx(k, !fx[k]));
  $('t-os').setAttribute('aria-pressed', String(osState.on));
  if (!osState.premium) {
    $('t-os').setAttribute('aria-disabled', 'true');
    $('t-os').title = osState.enabled ? 'Needs the OS Premium plan (free allowance) on your Data Hub account' : 'Add OS_API_KEY to .env and restart the server';
  }

  // ---------- waypoints ----------
  $('waypoints').innerHTML = WAYPOINTS.map((w, i) => `<button type="button" data-i="${i}">${esc(w[0])}</button>`).join('');
  $('waypoints').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const [name, center, zoom, pitch, bearing] = WAYPOINTS[+b.dataset.i];
    flyTo(center, { zoom, pitch, bearing }, name);
  });

  function flyTo(center, opts = {}, label) {
    resetNorth(); // a fly-to sets its own camera; don't restore an older angle afterwards
    map.flyTo({ center, zoom: 15.6, pitch: 62, bearing: map.getBearing(), duration: reduceMotion ? 0 : 3600, curve: 1.5, essential: true, ...opts });
    if (label) log('NAV', `Vectoring to ${label}`);
    map.once('moveend', () => overlay.scan(center[0], center[1]));
  }

  // ---------- panel controls ----------
  panels.onClose = (id) => {
    if (id === 'bldg') { highlight.visible = false; highlightFeature = null; }
    if (id === 'bike') bikes.selected = null;
  };
  const dimInput = $('panel-dim');
  const applyDim = (v) => {
    document.documentElement.style.setProperty('--panel-dim', String(v / 100));
    dimInput.value = v;
    $('panel-dim-v').textContent = `${v}%`;
  };
  applyDim((() => { try { const v = +localStorage.getItem('vantage.panelDim'); return Number.isFinite(v) && localStorage.getItem('vantage.panelDim') !== null ? v : 70; } catch { return 70; } })());
  dimInput.addEventListener('input', () => {
    applyDim(+dimInput.value);
    try { localStorage.setItem('vantage.panelDim', dimInput.value); } catch {}
  });
  // Collapsible HUD cards, remembered per card.
  const collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem('vantage.collapsed') || '[]')); } catch { return new Set(); } })();
  document.querySelectorAll('.rail .card[id]').forEach((card) => {
    const h = card.querySelector('.card-h');
    const title = h.childNodes[0].textContent.trim();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-toggle';
    btn.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';
    const set = (c) => {
      card.classList.toggle('collapsed', c);
      btn.setAttribute('aria-expanded', String(!c));
      btn.setAttribute('aria-label', `${c ? 'Expand' : 'Collapse'} ${title}`);
    };
    set(collapsed.has(card.id));
    btn.addEventListener('click', () => {
      const c = !card.classList.contains('collapsed');
      set(c);
      c ? collapsed.add(card.id) : collapsed.delete(card.id);
      try { localStorage.setItem('vantage.collapsed', JSON.stringify([...collapsed])); } catch {}
    });
    const meta = h.querySelector('.card-meta');
    const right = document.createElement('span');
    right.className = 'card-h-right';
    if (meta) right.appendChild(meta);
    right.appendChild(btn);
    h.appendChild(right);
  });

  // ---------- soundscape ----------
  // Traffic on the major roads in view, trains on the rail lines on screen, jets on live aircraft.
  const scan0 = overlay.scan.bind(overlay);
  overlay.scan = (lon, lat) => { scan0(lon, lat); audio.ping(); };
  function sampleSoundscape() {
    // Street-level sources only mean something at city scale; zoomed out, don't query at all.
    if (map.getZoom() < 12) { audio.setRoads([]); audio.setRails([]); return; }
    const w = overlay.width, h = overlay.height;
    const roads = map.queryRenderedFeatures([[w * 0.2, h * 0.3], [w * 0.8, h * 0.9]], { layers: ['roads-major'] });
    const cand = [];
    for (const f of roads) {
      const g = f.geometry;
      const line = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates[0] : null;
      if (!line?.length) continue;
      const m = line[Math.floor(line.length / 2)];
      cand.push(toScene(m[0], m[1]));
    }
    const c = overlay.u.uCenter.value;
    cand.sort((a, b) => Math.hypot(a[0] - c.x, a[1] - c.y) - Math.hypot(b[0] - c.x, b[1] - c.y));
    const picked = [];
    for (const p of cand) {
      if (picked.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 180)) picked.push(p);
      if (picked.length === 4) break;
    }
    audio.setRoads(picked);
    const rails = [];
    for (const f of map.queryRenderedFeatures({ layers: ['rail'] })) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const l of lines) if (l.length > 3) rails.push(l.map(([lon, lat]) => toScene(lon, lat)));
    }
    rails.sort((a, b) => b.length - a.length);
    audio.setRails(rails.slice(0, 8));
  }
  let soundTimer = 0;
  map.on('moveend', (e) => {
    if (e.vantageAdjust) return;
    clearTimeout(soundTimer);
    soundTimer = setTimeout(sampleSoundscape, 250);
  });
  map.once('idle', sampleSoundscape);
  overlay.add({
    update(ctx) {
      audio.update(ctx.dt, {
        eye: overlay.u.uEye.value,
        center: overlay.u.uCenter.value,
        zoom: ctx.zoom,
        bearing: map.getBearing(),
        wind: weather.data?.wind_speed_10m,
        rain: (weather.data?.precipitation ?? 0) > 0.05,
        built: state.sector?.builtPct,
        planes: on.flights ? [...flights.aircraft.values()].filter((a) => a.scene) : [],
      });
    },
  });

  // ---------- panels driven from tile statistics ----------
  let panelClock = 0;
  overlay.add({
    update(ctx) {
      if (ctx.t - panelClock < 0.35) return;
      panelClock = ctx.t;
      const p = {};
      const onScreen = (lon, lat, z = 0, m = 70) => {
        const s = toScene(lon, lat);
        const pr = overlay.project(s[0], s[1], z, p);
        return pr && pr.x > m && pr.x < overlay.width - m && pr.y > m + 40 && pr.y < overlay.height - m;
      };
      // Largest named park in view.
      if (on.green) {
        let best = null;
        for (const g of state.parks) {
          if (!g.name || g.area < 6000) continue;
          if (!onScreen(g.lon, g.lat)) continue;
          if (!best || g.area > best.area) best = g;
        }
        if (best) {
          const s = state.sector;
          panels.set('green', {
            lon: best.lon, lat: best.lat, key: best.name, base: 14, lift: 90, variant: 'green', width: 250,
            html: `<div class="hp-kicker">OSM land cover · live tiles</div>
              <div class="hp-title">Green space data</div>
              <div class="hp-sub">${esc(best.name)}</div>
              <dl class="hp-rows">
                <dt>Area</dt><dd>${fmt(best.area / 1e4, 1)} ha</dd>
                <dt>Sector cover</dt><dd>${s ? fmt(s.greenPct * 100, 1) + '%' : '—'}</dd>
                <dt>Built cover</dt><dd>${s ? fmt(s.builtPct * 100, 1) + '%' : '—'}</dd>
              </dl>`,
          });
        } else panels.hide('green');
      }
      // Tallest structure in the sector, as floating text above its roof.
      const s = state.sector;
      if (on.city && s && s.maxAt && s.maxH > 40 && onScreen(s.maxAt[0], s.maxAt[1], s.maxH, 40)) {
        panels.set('peak', {
          lon: s.maxAt[0], lat: s.maxAt[1], key: String(s.maxAt), base: s.maxH, lift: 36, variant: 'ghost', width: 200,
          html: `<div class="hp-kicker">Sector peak · OSM height</div><div class="hp-title">${fmt(s.maxH)} m</div><div class="hp-sub">~${fmt(Math.round(s.maxH / 3.8))} floors est.</div>`,
        });
      } else panels.hide('peak');
    },
  });
  overlay.add({ group: panels.group, update: (ctx) => { panels.update(ctx); tags.sweep(); tags.update(); } });

  // ---------- data loading ----------
  const centerLL = () => { const c = map.getCenter(); return [c.lng, c.lat]; };
  let flightsBusy = null;
  function loadFlights() {
    if (!on.flights) return Promise.resolve();
    if (flightsBusy) return flightsBusy; // never stack polls (timers bunch up in background tabs)
    const [lon, lat] = centerLL();
    flightsAt = [lon, lat];
    flightsBusy = run('flights', () => flights.load(lon, lat), (r) => `${r.count} aircraft · ${r.source}`).finally(() => (flightsBusy = null));
    return flightsBusy;
  }
  async function loadAir() {
    const [lon, lat] = centerLL();
    const cells = await run('air', () => air.load(lon, lat), (c) => `${c.length} nodes`);
    renderAir();
    const worst = cells.reduce((a, b) => ((b.aqi ?? -1) > (a.aqi ?? -1) ? b : a));
    const [band] = eaqiBand(worst.aqi);
    log('AIR', `Grid synced · worst EAQI ${fmt(worst.aqi)} (${band.toLowerCase()})`, worst.aqi >= 60 ? 'crit' : worst.aqi >= 40 ? 'warn' : 'info');
    return cells;
  }
  async function loadWeather() {
    const [lon, lat] = centerLL();
    const d = await run('weather', () => weather.load(lon, lat), (w) => `${fmt(w.temperature_2m, 1)}°C · ${fmt(w.wind_speed_10m, 1)} m/s`);
    air.setWind(d.wind_direction_10m, d.wind_speed_10m);
    renderWeather();
    return d;
  }
  async function loadStatus() {
    const r = await run('status', () => tfl.loadStatus(), (x) => (x.disrupted ? `${x.disrupted} lines disrupted` : 'good service'));
    for (const c of r.changes) {
      if (c.severity === 10 || c.severity === 18 || c.severity === 19) continue;
      log('TFL', `${c.name}: ${c.text}`, 'warn');
    }
  }
  async function loadRoads() {
    const list = await run('roads', () => tfl.loadRoads(), (l) => `${l.length} active`);
    const serious = list.filter((d) => d.severity === 'Serious' || d.severity === 'Severe').length;
    log('ROADS', `${list.length} active disruptions · ${serious} serious`, serious ? 'warn' : 'info');
  }
  async function loadBikes() {
    const r = await run('bikes', () => bikes.load(), (x) => `${x.docks} docks · ${fmt(x.bikes)} bikes`);
    return r;
  }

  const initial = [
    boot('Vector tiles · OpenFreeMap', city.init().then(() => { feed('tiles', { status: 'loading' }); city.refresh(); })),
    boot('Air-quality grid · Open-Meteo CAMS', loadAir()),
    boot('Atmosphere · Open-Meteo', loadWeather()),
    boot('Rail network · TfL', run('tube', () => tfl.loadNetwork(), (r) => `${r.lines} lines · ${r.stations} stations`)),
    boot('Line status · TfL', loadStatus()),
    boot('Road disruptions · TfL', loadRoads()),
    boot('Cycle docks · TfL BikePoint', loadBikes()),
    boot('ADS-B aircraft · adsb.lol', loadFlights()),
  ];
  booted = true;
  log('SYS', 'Vantage online · streaming open data for London');

  // Route once the air grid and disruptions are in, so the first route is fully scored.
  Promise.allSettled([initial[1], initial[5]]).then(() => computeRoute(...DEFAULT_ROUTE));

  setInterval(() => loadStatus().catch(() => {}), 60e3);
  setInterval(() => loadRoads().catch(() => {}), 5 * 60e3);
  setInterval(() => loadBikes().catch(() => {}), 2 * 60e3);
  setInterval(() => loadFlights().catch(() => {}), 10e3);
  setInterval(() => {
    const [lon, lat] = centerLL();
    if (air.needsReload(lon, lat)) loadAir().catch(() => {});
    if (weather.needsReload(lon, lat)) loadWeather().catch(() => {});
  }, 60e3);

  // ---------- camera movement ----------
  let moveTimer = 0, lastRefresh = 0;
  map.on('move', () => {
    const now = performance.now();
    if (now - lastRefresh > 350) { lastRefresh = now; city.refresh(); osCity?.refresh(); }
  });
  map.on('moveend', (e) => {
    if (e.vantageAdjust) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      city.refresh();
      osCity?.refresh();
      city.statsDirty = true;
      const [lon, lat] = centerLL();
      if (haversine(lon, lat, frame.lon, frame.lat) > 30000) {
        setOrigin(lon, lat);
        city.onOrigin();
        osCity?.onOrigin();
        for (const l of [air, tfl, route, bikes, flights]) l.rebuild();
        if (highlightFeature) buildHighlight(highlightFeature);
      }
      if (air.needsReload(lon, lat)) loadAir().catch(() => {});
      if (weather.needsReload(lon, lat)) loadWeather().catch(() => {});
      if (flightsAt && haversine(lon, lat, flightsAt[0], flightsAt[1]) > 25000) loadFlights().catch(() => {});
    }, 250);
  });

  // Zooming out towards country scale turns the camera north-up and flattens it, so Britain reads
  // the right way round; zooming back in restores the view you had. If you rotate by hand while
  // zoomed out, your own bearing is kept.
  // The camera is never touched mid-zoom: jumpTo/easeTo cancel an in-progress wheel zoom, which
  // made zooming stall. Instead, each time a zoom settles the map eases to the angle for that
  // zoom level, and the next wheel movement simply takes over from the ease.
  // (MapLibre's wheel zoom events carry no originalEvent; app fly-tos are told apart by isEasing().)
  const NORTH_FULL = 9.5, NORTH_START = 11.5;
  let northFrom = null, rotatedByHand = false, northEase = false;
  var resetNorth = () => { northFrom = null; rotatedByHand = false; };
  map.on('rotate', () => {
    if (northEase || map.isEasing()) return;
    if (map.getZoom() < NORTH_START) { rotatedByHand = true; northFrom = null; }
  });
  map.on('zoom', () => {
    if (northEase || map.isEasing() || rotatedByHand) return;
    if (map.getZoom() < NORTH_START) northFrom ??= { bearing: map.getBearing(), pitch: map.getPitch() };
  });
  map.on('zoomend', () => {
    if (northEase || map.isEasing()) return;
    const z = map.getZoom();
    if (z >= NORTH_START) rotatedByHand = false;
    if (!northFrom) return;
    const k = THREE.MathUtils.smoothstep(z, NORTH_FULL, NORTH_START);
    const flat = Math.min(northFrom.pitch, 20);
    const bearing = northFrom.bearing * k, pitch = flat + (northFrom.pitch - flat) * k;
    if (z >= NORTH_START) northFrom = null; // back at city scale: this ease restores the original view
    if (Math.abs(bearing - map.getBearing()) < 0.5 && Math.abs(pitch - map.getPitch()) < 0.5) return;
    northEase = true;
    map.once('moveend', () => { northEase = false; }); // also fires if a wheel movement interrupts the ease
    map.easeTo({ bearing, pitch, duration: reduceMotion ? 0 : 650 }, { vantageAdjust: true });
  });

  // Orbit: a slow cinematic turn while nobody is touching the map.
  for (const ev of ['mousedown', 'wheel', 'touchstart']) map.getCanvas().addEventListener(ev, () => (state.lastInteract = performance.now()), { passive: true });
  let lastOrbit = performance.now();
  let introOrbit0 = null;
  (function orbit() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastOrbit) / 1000);
    lastOrbit = now;
    // The welcome-screen orbit is driven by elapsed time, so its speed stays constant even
    // if a frame is late (accumulating per-frame steps would stutter and then drag).
    if (state.introOrbit && !reduceMotion && !map.isEasing()) {
      introOrbit0 ??= { t: now, b: map.getBearing() };
      map.setBearing(introOrbit0.b + ((now - introOrbit0.t) / 1000) * 2.2);
    }
    else if (state.orbit && now - state.lastInteract > 2500 && !map.isEasing()) map.setBearing(map.getBearing() + dt * 3.5);
    requestAnimationFrame(orbit);
  })();

  // ---------- routing ----------
  async function computeRoute(o, d) {
    try {
      const routes = await route.setEndpoints(o, d);
      if (!routes) return;
      renderRoute();
      const b = route.best;
      log('ROUTE', `${routes.length} alternatives scored · ${fmtDist(b.distance)} in ${fmtDuration(b.duration)}${state.rerouted ? ' · rerouted for air/disruptions' : ''}`, state.rerouted ? 'warn' : 'info');
      overlay.scan(o[0], o[1]);
    } catch (e) {
      feed('route', { status: 'error', detail: e.message });
      log('ROUTE', e.message, 'crit');
    }
  }
  function renderRoute() {
    const f = route.fastest;
    $('route-alts').innerHTML = [...route.routes]
      .sort((a, b) => a.score - b.score)
      .map((r) => {
        const dt = f ? Math.round((r.duration - f.duration) / 60) : 0;
        return `<li class="${r.best ? 'best' : ''}"><span class="sw"></span><span>${fmtDist(r.distance)} · ${fmtDuration(r.duration)}</span>
          <span class="tagx">${r.best ? 'OPTIMAL' : r.fastest ? 'FASTEST' : dt > 0 ? '+' + dt + ' MIN' : ''}</span>
          <span class="meta">EAQI ${fmt(r.meanAqi, 1)} · NO₂ ${fmt(r.meanNo2, 1)} · ${r.hits.length} disruption${r.hits.length === 1 ? '' : 's'}</span></li>`;
      })
      .join('');
  }
  document.querySelector('.seg').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-profile]');
    if (!b) return;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    route.profile = b.dataset.profile;
    if (route.origin && route.dest) computeRoute(route.origin, route.dest);
  });
  const hint = $('picker-hint');
  function setPicking(n) {
    state.picking = n;
    document.body.classList.toggle('picking', n > 0);
    $('route-pick').setAttribute('aria-pressed', String(n > 0));
    hint.hidden = !n;
    hint.textContent = n === 1 ? 'Click the map to set the route origin · Esc to cancel' : n === 2 ? 'Now click the destination' : '';
  }
  $('route-pick').addEventListener('click', () => setPicking(state.picking ? 0 : 1));
  $('route-clear').addEventListener('click', () => { route.clear(); $('route-alts').innerHTML = ''; feed('route', { status: 'idle', detail: '' }); });

  let pickOrigin = null;
  map.on('contextmenu', (e) => {
    e.preventDefault();
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (e.originalEvent.shiftKey || !route.origin) { route.origin = p; log('ROUTE', 'Origin set'); if (route.dest) computeRoute(p, route.dest); }
    else computeRoute(route.origin, p);
  });

  // ---------- clicks ----------
  function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function buildHighlight(f) {
    const { ring, h, hmin } = f;
    const pos = [];
    for (let i = 0; i < ring.length - 1; i++) {
      if (!ring[i + 1]) break;
      const a = toScene(ring[i][0], ring[i][1]), b = toScene(ring[i + 1][0], ring[i + 1][1]);
      pos.push(a[0], a[1], h, b[0], b[1], h, a[0], a[1], hmin, b[0], b[1], hmin, a[0], a[1], hmin, a[0], a[1], h);
    }
    highlight.geometry.dispose();
    highlight.geometry = new THREE.BufferGeometry();
    highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    highlight.visible = true;
  }
  function clearSelection() {
    panels.remove('bldg');
    panels.hide('bike');
    panels.hide('disruption');
    bikes.selected = null;
    highlight.visible = false;
    highlightFeature = null;
  }
  function showBuilding(feature, lngLat) {
    const g = feature.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const pt = [lngLat.lng, lngLat.lat];
    const poly = polys.find((p) => pointInRing(pt, p[0])) || polys[0];
    if (!poly) return;
    const ring = poly[0];
    const h = +feature.properties.render_height || 6;
    const hmin = +feature.properties.render_min_height || 0;
    const area = polygonAreaM2(ring) - poly.slice(1).reduce((s, r) => s + polygonAreaM2(r), 0);
    const floors = Math.max(1, Math.round((h - hmin) / 3.6));
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const grid = bng(cx, cy);
    highlightFeature = { ring, h, hmin };
    buildHighlight(highlightFeature);
    panels.hide('bike');
    panels.hide('disruption');
    panels.set('bldg', {
      lon: cx, lat: cy, key: `${cx},${cy}`, force: true, base: h, lift: 46, width: 240,
      html: `<div class="hp-kicker">OSM structure · ${fmt(cy, 5)}, ${fmt(cx, 5)}</div>
        <div class="hp-title">Structure scan</div>
        <div class="hp-sub">${fmt(h, 1)} m · ~${fmt(floors)} floor${floors === 1 ? '' : 's'}</div>
        <dl class="hp-rows">
          <dt>Footprint</dt><dd>${fmt(area)} m²</dd>
          <dt>Volume</dt><dd>${fmt((area * (h - hmin)) / 1000, 1)}k m³</dd>
          <dt>Floor area</dt><dd>~${fmt(area * floors)} m²</dd>
          ${hmin > 0 ? `<dt>Base</dt><dd>${fmt(hmin, 1)} m</dd>` : ''}
          ${grid ? `<dt>Grid ref</dt><dd>${esc(grid.ref10)}</dd>` : ''}
        </dl>
        ${osState.ngd && !osState.keyBad && grid ? '<div class="hp-note">Querying OS NGD…</div>' : ''}`,
    });
    overlay.scan(cx, cy);
    log('SCAN', `Structure ${fmt(h, 1)} m · footprint ${fmt(area)} m²${grid ? ' · ' + grid.ref : ''}`);
    if (osState.ngd && !osState.keyBad && grid) lookupOsBuilding(pointInRing(pt, ring) ? pt : [cx, cy], { cx, cy, h });
  }

  // OS NGD building attributes + Linked Identifiers for the clicked structure.
  let osLookup = 0;
  async function lookupOsBuilding([lon, lat], anchor) {
    if (!osState.ngd || osState.keyBad) return;
    const token = ++osLookup;
    feed('osngd', { status: 'loading' });
    try {
      const d = await osBuilding(lon, lat);
      if (token !== osLookup || !panels.has('bldg')) return;
      if (!d.found) {
        feed('osngd', { status: 'live', detail: 'no OS building here' });
        return;
      }
      const hh = d.building?.height_relativemax_m ?? d.part?.height_relativemax_m ?? anchor.h;
      const g = d.geometry;
      const ring = g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (ring) { highlightFeature = { ring, h: hh, hmin: 0 }; buildHighlight(highlightFeature); }
      panels.set('bldg', { lon: anchor.cx, lat: anchor.cy, key: `${anchor.cx},${anchor.cy}`, base: hh, lift: 46, width: 290, variant: 'os', html: osBuildingHtml(d) });
      feed('osngd', { status: 'live', detail: d.toid ? `TOID …${d.toid.slice(-8)}` : 'building found' });
      const b = d.building || {};
      log('OS', `${b.description || 'Building'}${b.buildingage_period ? ' · ' + b.buildingage_period : ''}${d.uprnCount ? ` · ${d.uprnCount} UPRN${d.uprnCount > 1 ? 's' : ''}` : ''}`);
    } catch (e) {
      if (token !== osLookup) return;
      if (/key_rejected/.test(e.message)) osState.keyBad = true;
      if (/premium_required|api_not_enabled/.test(e.message)) osState.ngd = false;
      feed('osngd', { status: 'error', detail: e.message.replace(/\[[a-z_]+\] /, '') });
      log('OS', e.message, 'crit');
    }
  }

  map.on('click', (e) => {
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (state.picking === 1) { pickOrigin = p; setPicking(2); overlay.scan(p[0], p[1]); return; }
    if (state.picking === 2) { setPicking(0); computeRoute(pickOrigin, p); return; }
    const { x, y } = e.point;
    const bike = bikes.pick(x, y);
    if (bike) {
      clearSelection();
      bikes.select(bike, true);
      audio.blip();
      log('CYCLE', `${bike.name}: ${bike.bikes} bikes · ${bike.empty} free docks`, bike.bikes === 0 ? 'warn' : 'info');
      return;
    }
    const d = tfl.pickDisruption(x, y);
    if (d) {
      clearSelection();
      tfl.showDisruption(d);
      audio.blip();
      log('ROADS', `${d.severity}: ${d.location || d.category}`, 'warn');
      return;
    }
    const feats = on.city ? map.queryRenderedFeatures(e.point, { layers: ['bldg-3d'] }) : [];
    if (feats.length) { audio.blip(); return showBuilding(feats[0], e.lngLat); }
    clearSelection();
  });

  // ---------- search: grid references, OS Names (UK), Nominatim (worldwide) ----------
  const input = $('search-input'), results = $('search-results');
  let searchTimer = 0, searchToken = 0, active = -1, items = [];
  const renderResults = (list, note) => {
    items = list;
    active = -1;
    results.innerHTML = list.length
      ? list.map((x, i) => `<li role="option" data-i="${i}" aria-selected="false"><span class="src src-${x.src}">${esc(x.srcLabel)}</span>${esc(x.name)}<small>${esc(x.sub)}</small></li>`).join('')
      : `<li class="empty">${esc(note || 'No matching places')}</li>`;
    results.hidden = false;
  };
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    const en = parseGridRef(q);
    if (en) {
      const [lon, lat] = fromBNG(en[0], en[1]);
      renderResults([{ src: 'grid', srcLabel: 'Grid ref', name: gridRef(en[0], en[1], 5), sub: `E ${Math.round(en[0])} · N ${Math.round(en[1])} · British National Grid`, lon, lat }]);
      return;
    }
    if (q.length < 3) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const token = ++searchToken;
      const [osr, nom] = await Promise.allSettled([
        osState.enabled && !osState.keyBad ? osNames(q) : Promise.resolve([]),
        fetchJSON(`/api/geocode?q=${encodeURIComponent(q)}`),
      ]);
      if (token !== searchToken) return;
      const list = [];
      if (osr.status === 'fulfilled') {
        if (osState.enabled) feed('osnames', { status: 'live', detail: `${osr.value.length} for “${q.slice(0, 12)}”` });
        for (const r of osr.value.slice(0, 5)) {
          list.push({ src: 'os', srcLabel: 'OS Names', name: r.name, sub: [r.localType, r.place, r.county, r.postcode].filter(Boolean).join(' · '), lon: r.lon, lat: r.lat });
        }
      } else if (osState.enabled) {
        feed('osnames', { status: 'error', detail: osr.reason.message.replace(/\[[a-z_]+\] /, '') });
        if (/key_rejected/.test(osr.reason.message)) osState.keyBad = true;
      }
      if (nom.status === 'fulfilled') {
        for (const x of nom.value.slice(0, 6 - Math.min(3, list.length))) {
          list.push({ src: 'osm', srcLabel: 'OSM', name: x.name || x.display_name.split(',')[0], sub: x.display_name, lon: +x.lon, lat: +x.lat });
        }
      }
      const note = osr.status === 'rejected' && nom.status === 'rejected' ? `Search is unavailable: ${nom.reason.message}` : null;
      renderResults(list, note);
    }, 380);
  });
  const choose = (i) => {
    const x = items[i];
    if (!x) return;
    results.hidden = true;
    input.value = x.name;
    input.blur();
    flyTo([+x.lon, +x.lat], { zoom: x.src === 'grid' ? 16 : 15.6, pitch: 62 }, input.value);
  };
  results.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
  input.addEventListener('keydown', (e) => {
    const lis = [...results.querySelectorAll('li[data-i]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!lis.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    } else if (e.key === 'Enter') choose(active >= 0 ? active : 0);
    else if (e.key === 'Escape') { results.hidden = true; input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const layer = LAYERS.find((l) => l.hot === k);
    if (layer) return setLayer(layer.key, !on[layer.key]);
    if (k === '/') { e.preventDefault(); input.focus(); }
    else if (k === 'i') setFx('imagery', !fx.imagery);
    else if (k === 'b') setFx('bloom', !fx.bloom);
    else if (k === 'o') setFx('orbit', !fx.orbit);
    else if (k === 'm') setFx('os', !fx.os);
    else if (k === 'p') setFx('panels', !fx.panels);
    else if (k === 'h') $('hud').classList.toggle('hidden');
    else if (k === 'a') toggleSound();
    else if (k === 'r') setPicking(state.picking ? 0 : 1);
    else if (k === ' ') { e.preventDefault(); const c = map.getCenter(); overlay.scan(c.lng, c.lat); }
    else if (k === 'escape') { setPicking(0); clearSelection(); }
  });

  $('compass').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 900 }));
  for (const [btn, rail] of [['btn-left', 'left'], ['btn-right', 'right']]) {
    $(btn).addEventListener('click', () => {
      const open = !$(rail).classList.contains('open');
      document.querySelectorAll('.rail').forEach((r) => r.classList.remove('open'));
      document.querySelectorAll('.mobile-toggles button').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      $(rail).classList.toggle('open', open);
      $(btn).setAttribute('aria-expanded', String(open));
    });
  }

  // ---------- HUD readouts ----------
  function renderSector() {
    const s = state.sector;
    if (!s) return;
    $('sector-meta').textContent = `OSM · ${s.tiles} tiles · ${fmt(s.areaKm2, 1)} km²`;
    const bar = (label, v, c) => `<div class="bar" style="--c:${c}"><span>${label}</span><span class="bar-track"><span class="bar-fill" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="bar-v">${fmt(v * 100, 1)}%</span></div>`;
    $('sector-bars').innerHTML = bar('Built', s.builtPct, '#62e6ff') + bar('Green', s.greenPct, '#45f5a1') + bar('Water', s.waterPct, '#2b9fd0');
    $('sector-kv').innerHTML = `<dt>Structures</dt><dd>${fmt(s.buildings)}</dd><dt>Mean height</dt><dd>${fmt(s.meanH, 1)} m</dd>
      <dt>Sector peak</dt><dd>${fmt(s.maxH)} m</dd><dt>Floor area (est.)</dt><dd>${fmt(s.gfaKm2, 2)} km²</dd>`;
  }

  function renderAir() {
    const h = air.here;
    if (!h) return;
    const a = h.european_aqi;
    const [label, cls] = eaqiBand(a);
    $('air-big').textContent = fmt(a);
    $('air-band').textContent = label;
    $('air-band').className = `band ${cls}`;
    $('air-meta').textContent = `CAMS · ${(h.time || '').slice(11, 16)}`;
    $('air-kv').innerHTML = `<dt>PM2.5</dt><dd>${fmt(h.pm2_5, 1)}</dd><dt>PM10</dt><dd>${fmt(h.pm10, 1)}</dd><dt>NO₂</dt><dd>${fmt(h.nitrogen_dioxide, 1)}</dd><dt>O₃</dt><dd>${fmt(h.ozone, 0)}</dd>`;
    const vals = (h.hourly?.european_aqi || []).filter((v) => v != null);
    const svg = $('air-spark');
    if (vals.length < 2) { svg.innerHTML = ''; return; }
    const W = 260, H = 44, max = Math.max(60, ...vals) * 1.1;
    const xy = vals.map((v, i) => [(i / (vals.length - 1)) * (W - 30), H - 4 - (v / max) * (H - 10)]);
    const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const guides = [20, 40, 60].filter((g) => g < max).map((g) => { const y = H - 4 - (g / max) * (H - 10); return `<line x1="0" x2="${W - 30}" y1="${y}" y2="${y}" stroke="#62e6ff" stroke-opacity=".12" stroke-dasharray="2 3"/>`; }).join('');
    const last = xy[xy.length - 1], first = xy[0];
    svg.innerHTML = `<defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffb547" stop-opacity=".35"/><stop offset="1" stop-color="#ffb547" stop-opacity="0"/></linearGradient></defs>
      ${guides}<path d="${line}L${last[0]},${H}L0,${H}Z" fill="url(#sg)"/><path d="${line}" fill="none" stroke="#ffb547" stroke-width="1.4"/>
      <circle cx="${first[0]}" cy="${first[1]}" r="2.6" fill="#fff"/>
      <text x="${W - 26}" y="${last[1] + 3}" font-size="9" fill="#c9e6f0" font-family="IBM Plex Mono, monospace">${fmt(vals[vals.length - 1])}</text>
      <text x="0" y="9" font-size="8" fill="#6b93a5" font-family="IBM Plex Mono, monospace">NEXT 24 H</text>`;
  }

  function renderWeather() {
    const w = weather.data;
    if (!w) return;
    $('wx-temp').textContent = `${fmt(w.temperature_2m, 1)}°`;
    $('wx-cond').textContent = WMO[w.weather_code] || '—';
    $('wx-feels').textContent = `feels ${fmt(w.apparent_temperature, 1)}°C`;
    $('wx-meta').textContent = `Open-Meteo · ${(w.time || '').slice(11, 16)}`;
    $('wx-arrow').style.transform = `rotate(${w.wind_direction_10m + 180}deg)`;
    $('wx-wind-v').textContent = `${fmt(w.wind_speed_10m, 1)} m/s ${compass(w.wind_direction_10m)}`;
    $('wx-kv').innerHTML = `<dt>Humid</dt><dd>${fmt(w.relative_humidity_2m)}%</dd><dt>Cloud</dt><dd>${fmt(w.cloud_cover)}%</dd>
      <dt>Gusts</dt><dd>${fmt(w.wind_gusts_10m, 1)}</dd><dt>hPa</dt><dd>${fmt(w.pressure_msl)}</dd><dt>Rain</dt><dd>${fmt(w.precipitation, 1)} mm</dd><dt>Sun</dt><dd id="wx-sun">—</dd>`;
  }

  const londonTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const utcTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  function tick() {
    const now = new Date();
    $('clock-time').textContent = londonTime.format(now);
    $('clock-sub').textContent = `London · UTC ${utcTime.format(now)}`;
    const c = map.getCenter();
    const z = map.getZoom(), pitch = map.getPitch(), brg = (map.getBearing() + 360) % 360;
    const lat = `${Math.abs(c.lat).toFixed(4)} ${c.lat >= 0 ? 'N' : 'S'}`, lon = `${Math.abs(c.lng).toFixed(4)} ${c.lng >= 0 ? 'E' : 'W'}`;
    const grid = bng(c.lng, c.lat);
    $('brand-sub').textContent = grid ? `${lat} · ${lon} · ${grid.ref}` : `${lat} · ${lon}`;
    const sun = sunPosition(now, c.lat, c.lng);
    const sunEl = $('wx-sun');
    if (sunEl) sunEl.textContent = `${fmt(sun.alt, 0)}° ${compass(sun.az)}`;
    const cc = city.counts();
    const oc = osCity && osCity.active ? osCity.counts() : null;
    const tris = cc.triangles + (oc ? oc.triangles : 0);
    // Four fixed columns, row by row; .t-opt cells drop out on narrow screens.
    $('telemetry').innerHTML = `<span>Lat <b>${lat}</b></span><span>Zoom <b>${z.toFixed(2)}</b></span><span class="t-opt">Pitch <b>${pitch.toFixed(0)}°</b></span><span class="t-opt">FPS <b>${overlay.fps.toFixed(0)}</b></span>
      <span>Lon <b>${lon}</b></span><span>Tiles <b>${cc.ready}${cc.loading ? '+' + cc.loading : ''}${oc ? ` · OS ${oc.ready}` : ''}</b></span><span class="t-opt">Tris <b>${(tris / 1e6).toFixed(2)}M</b></span><span class="t-opt">Data <b>${(cc.bytes / 1e6).toFixed(1)} MB</b></span>
      ${grid ? `<span>BNG <b>${grid.ref}</b></span><span>E <b>${Math.round(grid.E)}</b></span><span class="t-opt">N <b>${Math.round(grid.N)}</b></span><span class="t-opt">${oc ? 'Zone <b>MasterMap</b>' : 'Datum <b>OSGB36</b>'}</span>` : ''}`;
    $('compass-rose').setAttribute('transform', `rotate(${-brg} 32 32)`);
    $('compass-deg').textContent = `${String(Math.round(brg) % 360).padStart(3, '0')}°`;
  }
  setInterval(tick, 250);
  setInterval(renderFeeds, 5000);
  // OS usage since the server started, so it's easy to keep an eye on the Premium allowance.
  if (osState.enabled) {
    setInterval(async () => {
      const s = await osStatus();
      const u = s.usage;
      if (!u) return;
      if (FEEDS.osvts.status !== 'error') feed('osvts', { detail: `${u.premiumTiles} premium · ${u.cachedTiles} cached` });
      if (u.ngd) FEEDS.osngd.detail = `${u.ngd} NGD · ${u.links} link calls`;
    }, 60000);
  }
  tick();
  renderFeeds();
});
