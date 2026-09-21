// Current weather from Open-Meteo, visualised as a drifting field of wind streaks (and falling
// rain streaks when it's actually raining) in the air above the city.
import * as THREE from 'three';
import { haversine } from '../geo.js';
import { fetchJSON } from '../util.js';

const COUNT = 3200;

const WIND_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute float aEnd;
uniform vec2 uCenter;
uniform float uBox;
uniform vec2 uFlow;
uniform float uTime;
uniform float uLen;
uniform float uRain;
varying float vA;
void main() {
  vec2 off = aSeed.xy * uBox + uFlow * uTime * 22.0;
  vec2 rel = mod(off - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec2 p = uCenter + rel;
  float spd = length(uFlow);
  vec2 dir = spd > 0.01 ? uFlow / spd : vec2(1.0, 0.0);
  float z = 50.0 + aSeed.z * 420.0;
  vec3 tail = vec3(dir * uLen, 0.0);
  if (uRain > 0.5) {
    float fall = fract(uTime * 0.35 + aSeed.w);
    z = 480.0 * (1.0 - fall);
    tail = vec3(dir * uLen * 0.25, -uLen * 1.4);
  }
  vec3 pos = vec3(p, z) - tail * (1.0 - aEnd);
  float edge = 1.0 - smoothstep(0.3, 0.5, max(abs(rel.x), abs(rel.y)) / uBox);
  float life = sin(fract(uTime * 0.12 + aSeed.w) * 3.14159);
  vA = aEnd * edge * (uRain > 0.5 ? 0.8 : life);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;

export class WeatherLayer {
  constructor(overlay, app) {
    this.overlay = overlay;
    this.app = app;
    this.group = new THREE.Group();
    this.data = null;
    this.flow = new THREE.Vector2(0, 0);

    const seeds = new Float32Array(COUNT * 2 * 4);
    const ends = new Float32Array(COUNT * 2);
    const pos = new Float32Array(COUNT * 2 * 3);
    for (let i = 0; i < COUNT; i++) {
      const s = [Math.random(), Math.random(), Math.random() ** 1.6, Math.random()];
      seeds.set(s, i * 8);
      seeds.set(s, i * 8 + 4);
      ends[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const u = overlay.u;
    this.uniforms = {
      uCenter: u.uCenter,
      uTime: u.uTime,
      uBox: { value: 6000 },
      uFlow: { value: this.flow },
      uLen: { value: 40 },
      uRain: { value: 0 },
      uColor: { value: new THREE.Color('#bdefff') },
    };
    this.streaks = new THREE.LineSegments(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: WIND_VERT,
        fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA * 0.55, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 5;
    this.group.add(this.streaks);
  }

  setVisible(on) { this.group.visible = on; }

  needsReload(lon, lat) {
    if (!this.at) return true;
    return haversine(lon, lat, this.at[0], this.at[1]) > 10000 || Date.now() - this.loadedAt > 10 * 60e3;
  }

  async load(lon, lat) {
    this.at = [lon, lat];
    this.loadedAt = Date.now();
    const vars = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
    const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${vars}&wind_speed_unit=ms&timezone=auto`);
    this.data = d.current;
    this.tz = d.timezone;
    const r = ((d.current.wind_direction_10m + 180) * Math.PI) / 180;
    this.flow.set(Math.sin(r) * d.current.wind_speed_10m, Math.cos(r) * d.current.wind_speed_10m);
    this.uniforms.uRain.value = d.current.precipitation > 0.05 ? 1 : 0;
    return this.data;
  }

  update(ctx) {
    this.uniforms.uBox.value = this.overlay.u.uRange.value * 2.2;
    const speed = this.data ? this.data.wind_speed_10m : 3;
    this.uniforms.uLen.value = Math.max(18, ctx.mpp * 16) * (0.6 + Math.min(speed, 15) / 8);
  }
}
