// Air quality from Open-Meteo (CAMS European model): a 6×6 sampling grid across the city,
// drawn as glowing contour lines of the pollution field hanging over the rooftops, plus
// measurement pylons whose height tracks the European AQI.
import * as THREE from 'three';
import { toScene, haversine } from '../geo.js';
import { GLSL_EAQI, eaqiColorJS, setGeometry } from '../overlay.js';
import { fetchJSON, fmt, eaqiBand, esc } from '../util.js';

const N = 6;
const SPAN_LAT = 0.17, SPAN_LON = 0.28; // ≈ 19 km × 19 km at London

const FIELD_FRAG = /* glsl */ `
uniform sampler2D uField;
uniform float uTime;
uniform vec2 uFlow;
uniform float uIntensity;
uniform vec3 uEye;
uniform vec2 uCenter;
uniform float uRange;
varying vec2 vUv;
varying vec3 vPos;
${GLSL_EAQI}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec2 drift = uFlow * uTime * 0.02;
  float n = fbm(vPos.xy / 1400.0 - drift / 1400.0);
  vec2 uv = clamp(vUv + (n - 0.5) * 0.035, 0.0, 1.0);
  vec2 tuv = (0.5 + uv * ${(N - 1).toFixed(1)}) / ${N.toFixed(1)};
  float aqi = texture2D(uField, tuv).r * 120.0;
  float lv = aqi / 2.0;
  float d = abs(fract(lv + 0.5) - 0.5);
  // Fade contours where they'd pack closer than a few pixels (far away, grazing angles).
  float fl = fwidth(lv);
  // Also drop contours where the field is flat (identical neighbouring readings): there the
  // "line" would otherwise flood a whole area.
  float line = (1.0 - smoothstep(0.0, fl * 1.3, d)) * (1.0 - smoothstep(0.08, 0.3, fl)) * smoothstep(1e-7, 1e-6, fl);
  float lvM = aqi / 10.0;
  float dM = abs(fract(lvM + 0.5) - 0.5);
  float flM = fwidth(lvM);
  float major = (1.0 - smoothstep(0.0, flM * 1.8, dM)) * (1.0 - smoothstep(0.05, 0.25, flM)) * smoothstep(1e-7, 1e-6, flM);
  float edge = smoothstep(0.0, 0.1, vUv.x) * smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.x) * smoothstep(1.0, 0.9, vUv.y);
  float haze = smoothstep(25.0, 100.0, aqi) * fbm(vPos.xy / 600.0 + drift / 600.0 + uTime * 0.01) * 0.06;
  vec3 col = eaqiColor(aqi) * (line * 0.22 + major * 0.5 + haze);
  // Keep the field local and drop it at grazing angles, where it would smear into a solid sheet.
  float graze = smoothstep(0.1, 0.4, abs(normalize(vPos - uEye).z));
  float near = 1.0 - smoothstep(uRange * 0.9, uRange * 2.4, length(vPos.xy - uCenter));
  gl_FragColor = vec4(col * edge * uIntensity * graze * near, 1.0);
}`;

export class AirLayer {
  constructor(overlay, app) {
    this.overlay = overlay;
    this.app = app;
    this.group = new THREE.Group();
    this.cells = [];
    this.visible = true;
    this.center = null;
    this.flow = new THREE.Vector2(0, 0);

    const data = new Uint8Array(N * N * 4);
    this.tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;

    this.field = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uField: { value: this.tex }, uTime: overlay.u.uTime, uFlow: { value: this.flow }, uIntensity: { value: 1 }, uEye: overlay.u.uEye, uCenter: overlay.u.uCenter, uRange: overlay.u.uRange },
        vertexShader: `varying vec2 vUv; varying vec3 vPos; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vPos = wp.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: FIELD_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.field.visible = false;
    this.field.renderOrder = 4;
    this.group.add(this.field);

    this.pylons = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        vertexShader: `attribute vec4 aC; varying vec4 vC; void main(){ vC = aC; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec4 vC; void main(){ gl_FragColor = vec4(vC.rgb * vC.a, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.pylons.frustumCulled = false;
    this.pylons.renderOrder = 4;
    this.group.add(this.pylons);

    this.heads = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: { uTime: overlay.u.uTime },
        vertexShader: `attribute vec3 aCol; varying vec3 vCol; void main(){ vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 14.0; }`,
        fragmentShader: `uniform float uTime; varying vec3 vCol; void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); float a = (1.0 - smoothstep(0.08, 0.16, r)) + (1.0 - smoothstep(0.0, 0.04, abs(r - 0.36))) * 0.7; if (a < 0.01) discard; gl_FragColor = vec4(vCol * a, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.heads.frustumCulled = false;
    this.heads.renderOrder = 4;
    this.group.add(this.heads);
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
    if (!on) { this.app.panels.hide('air'); this.app.tags.clear('aq:'); }
  }

  setWind(dirFrom, speed) {
    const r = ((dirFrom + 180) * Math.PI) / 180;
    this.flow.set(Math.sin(r) * speed, Math.cos(r) * speed);
  }

  needsReload(lon, lat) {
    if (!this.center) return true;
    return haversine(lon, lat, this.center[0], this.center[1]) > 7000 || Date.now() - this.loadedAt > 20 * 60e3;
  }

  async load(lon, lat) {
    this.center = [lon, lat];
    this.loadedAt = Date.now();
    const lats = [], lons = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        lats.push((lat - SPAN_LAT / 2 + (SPAN_LAT * j) / (N - 1)).toFixed(4));
        lons.push((lon - SPAN_LON / 2 + (SPAN_LON * i) / (N - 1)).toFixed(4));
      }
    }
    const vars = 'european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone';
    const [grid, fc] = await Promise.all([
      fetchJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}&longitude=${lons}&current=${vars}&timezone=auto`),
      fetchJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${vars}&hourly=european_aqi&forecast_hours=24&timezone=auto`),
    ]);
    const list = Array.isArray(grid) ? grid : [grid];
    this.cells = list.map((d, k) => ({
      lat: +lats[k],
      lon: +lons[k],
      aqi: d.current?.european_aqi ?? null,
      pm25: d.current?.pm2_5 ?? null,
      pm10: d.current?.pm10 ?? null,
      no2: d.current?.nitrogen_dioxide ?? null,
      o3: d.current?.ozone ?? null,
    }));
    this.time = list[0]?.current?.time;
    this.here = { ...fc.current, hourly: fc.hourly };
    this.build();
    return this.cells;
  }

  // Bilinear sample of the grid at a location (used to score route exposure).
  sample(lon, lat, key = 'aqi') {
    if (!this.cells.length) return null;
    const [clon, clat] = this.center;
    const fx = ((lon - (clon - SPAN_LON / 2)) / SPAN_LON) * (N - 1);
    const fy = ((lat - (clat - SPAN_LAT / 2)) / SPAN_LAT) * (N - 1);
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
    const v = (a, b) => this.cells[b * N + a]?.[key];
    const vals = [v(i, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1)];
    if (vals.some((x) => x == null)) return vals.find((x) => x != null) ?? null;
    return (vals[0] * (1 - tx) + vals[1] * tx) * (1 - ty) + (vals[2] * (1 - tx) + vals[3] * tx) * ty;
  }

  rebuild() { if (this.cells.length) this.build(); }

  build() {
    const data = this.tex.image.data;
    const known = this.cells.filter((c) => c.aqi != null);
    const mean = known.reduce((s, c) => s + c.aqi, 0) / Math.max(1, known.length);
    this.cells.forEach((c, k) => {
      data[k * 4] = Math.round(Math.min(255, ((c.aqi ?? mean) / 120) * 255));
      data[k * 4 + 3] = 255;
    });
    this.tex.needsUpdate = true;

    const [clon, clat] = this.center;
    const a = toScene(clon - SPAN_LON / 2, clat - SPAN_LAT / 2);
    const b = toScene(clon + SPAN_LON / 2, clat + SPAN_LAT / 2);
    this.field.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 75);
    this.field.scale.set(b[0] - a[0], b[1] - a[1], 1);
    this.field.updateMatrixWorld(true);
    this.field.visible = true;

    const pos = [], col = [], hp = [], hc = [];
    for (const c of this.cells) {
      if (c.aqi == null) continue;
      const p = toScene(c.lon, c.lat);
      const h = 60 + c.aqi * 7;
      const rgb = eaqiColorJS(c.aqi);
      pos.push(p[0], p[1], 0, p[0], p[1], h);
      col.push(...rgb, 0.15, ...rgb, 0.95);
      hp.push(p[0], p[1], h);
      hc.push(...rgb);
      c.scene = [p[0], p[1], h];
    }
    setGeometry(this.pylons, { position: [pos, 3], aC: [col, 4] });
    setGeometry(this.heads, { position: [hp, 3], aCol: [hc, 3] });
  }

  update(ctx) {
    if (!this.visible || !this.cells.length) return;
    // The numbered grid tags only read well at city scale.
    if (ctx.zoom < 11) { this.app.panels.hide('air'); return; }
    // Contours read best from altitude; fade them as the camera drops to street level.
    this.field.material.uniforms.uIntensity.value = 0.35 + 0.65 * (1 - THREE.MathUtils.smoothstep(ctx.zoom, 14.5, 16.5));
    const ov = this.overlay;
    let worst = null;
    const p = {};
    for (const c of this.cells) {
      if (!c.scene) continue;
      const s = ov.project(c.scene[0], c.scene[1], c.scene[2], p);
      const on = s && s.x > 0 && s.y > 0 && s.x < ov.width && s.y < ov.height;
      if (on) {
        this.app.tags.set(`aq:${c.lat},${c.lon}`, { scene: c.scene, variant: 'aq', html: `<b>${fmt(c.aqi)}</b><span>EAQI</span>` });
        if (!worst || c.aqi > worst.aqi) worst = c;
      }
    }
    if (worst) {
      const [label] = eaqiBand(worst.aqi);
      const warn = worst.aqi >= 40;
      const variant = worst.aqi >= 60 ? 'crit' : warn ? 'warn' : 'ok';
      this.app.panels.set('air', {
        lon: worst.lon,
        lat: worst.lat,
        key: `${worst.lat},${worst.lon}`,
        base: 0,
        lift: 150,
        variant,
        width: 260,
        html: `<div class="hp-kicker">Open-Meteo · CAMS Europe · ${esc((this.time || '').slice(11, 16))}</div>
          <div class="hp-title">${warn ? 'Air quality warning' : 'Air quality'}</div>
          <div class="hp-sub">EAQI ${fmt(worst.aqi)} · ${label}${warn && this.app.state.rerouted ? ' · rerouting active' : ''}</div>
          <dl class="hp-rows">
            <dt>PM2.5</dt><dd>${fmt(worst.pm25, 1)} µg/m³</dd>
            <dt>NO₂</dt><dd>${fmt(worst.no2, 1)} µg/m³</dd>
            <dt>O₃</dt><dd>${fmt(worst.o3, 0)} µg/m³</dd>
          </dl>`,
      });
    } else this.app.panels.hide('air');
  }
}
