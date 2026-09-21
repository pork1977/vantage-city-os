// World-anchored holographic panels. Each panel is a real DOM element (crisp text, CSS styling)
// warped onto a rectangle standing in 3D space with a CSS matrix3d homography, so it tilts and
// foreshortens with the camera exactly like geometry would. A glowing stem ties it to the ground.
import * as THREE from 'three';
import { toScene } from './geo.js';

const MAX_STEMS = 48;

// Homography mapping the unit square onto a quad (Heckbert). Corners: TL, TR, BR, BL.
function squareToQuad(q) {
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0; g = 0; h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return [a, b, c, d, e, f, g, h];
}

export class Panels {
  constructor(overlay, root) {
    this.overlay = overlay;
    this.root = root;
    this.items = new Map();
    this.dismissed = new Map();
    this.onClose = null;
    this.enabled = true;
    this._p = [{}, {}, {}, {}, {}];

    const g = new THREE.BufferGeometry();
    this.stemPos = new Float32Array(MAX_STEMS * 2 * 3);
    this.stemAlpha = new Float32Array(MAX_STEMS * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.stemPos, 3));
    g.setAttribute('aA', new THREE.BufferAttribute(this.stemAlpha, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#7feaff') } },
      vertexShader: `attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA, 1.0); }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.stems = new THREE.LineSegments(g, mat);
    this.stems.frustumCulled = false;
    this.stems.renderOrder = 10;
    this.group = new THREE.Group();
    this.group.add(this.stems);

    // Ground markers under each panel.
    const pg = new THREE.BufferGeometry();
    this.dotPos = new Float32Array(MAX_STEMS * 3);
    pg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    pg.setDrawRange(0, 0);
    this.dots = new THREE.Points(
      pg,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#9ff4ff') }, uTime: overlay.u.uTime },
        vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 22.0; }`,
        fragmentShader: `uniform vec3 uColor; uniform float uTime; void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); float ring = 1.0 - smoothstep(0.0, 0.05, abs(r - (0.18 + 0.25 * fract(uTime * 0.6)))); float core = 1.0 - smoothstep(0.05, 0.11, r); float a = ring * (1.0 - fract(uTime * 0.6)) + core; if (a < 0.01) discard; gl_FragColor = vec4(uColor * a, 1.0); }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
    );
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 10;
    this.group.add(this.dots);
  }

  // spec: { lon, lat, base (m), lift (px), html, variant, width, key, force }
  // Many panels are re-set every frame, so closing one records its `key` (what it's about) and
  // keeps it closed until that subject changes. `force` (a deliberate click) always reopens.
  set(id, spec) {
    const subject = spec.key ?? '';
    if (spec.force) this.dismissed.delete(id);
    else if (this.dismissed.has(id)) {
      if (this.dismissed.get(id) === subject) return;
      this.dismissed.delete(id);
    }
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement('div');
      el.className = 'holo-panel';
      el.setAttribute('role', 'status');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'hp-close';
      close.setAttribute('aria-label', 'Close panel');
      close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
      close.addEventListener('click', (e) => { e.stopPropagation(); this.dismiss(id); });
      const body = document.createElement('div');
      body.className = 'hp-content';
      el.append(close, body);
      this.root.appendChild(el);
      it = { el, body, html: '' };
      this.items.set(id, it);
    }
    const prev = it.html;
    Object.assign(it, spec);
    it.el.className = 'holo-panel' + (spec.variant ? ' ' + spec.variant : '');
    if (spec.width && it.el.style.width !== spec.width + 'px') { it.el.style.width = spec.width + 'px'; it.w = 0; }
    if (spec.html !== prev) {
      it.body.innerHTML = spec.html;
      it.w = 0;
    }
    it.hidden = false;
  }

  dismiss(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.dismissed.set(id, it.key ?? '');
    it.hidden = true;
    if (this.onClose) this.onClose(id);
  }

  // Bring back everything that was closed.
  restore() {
    this.dismissed.clear();
  }

  hide(id) {
    const it = this.items.get(id);
    if (it) it.hidden = true;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    it.el.remove();
    this.items.delete(id);
  }

  has(id) {
    const it = this.items.get(id);
    return !!it && !it.hidden;
  }

  update(ctx) {
    const ov = this.overlay;
    const map = ov.map;
    const bearing = (map.getBearing() * Math.PI) / 180;
    const pitch = map.getPitch();
    // Shrink panels a little on narrow screens so they don't swallow the view.
    const mpp = ctx.mpp * Math.max(0.62, Math.min(1, ov.width / 1100));
    // Panel faces the camera horizontally and leans back so it stays legible from above.
    const Rx = Math.cos(bearing), Ry = -Math.sin(bearing);
    const Fx = Math.sin(bearing), Fy = Math.cos(bearing);
    const tau = ((90 - pitch) * 0.78 * Math.PI) / 180;
    const Uz = Math.cos(tau), Uf = Math.sin(tau);
    let stems = 0;
    const order = [];
    for (const [id, it] of this.items) {
      const el = it.el;
      // Panels describe streets and buildings; at regional scale they'd only pile up on London.
      if (!this.enabled || it.hidden || ctx.zoom < 10.5) { el.style.display = 'none'; continue; }
      el.style.display = '';
      if (!it.w) { it.w = el.offsetWidth; it.h = el.offsetHeight; }
      const a = toScene(it.lon, it.lat, it.base || 0);
      const lift = (it.lift || 110) * mpp + (it.base || 0);
      const W = it.w * mpp, H = it.h * mpp;
      const bx = a[0], by = a[1], bz = lift;
      const corners = [
        [bx - (Rx * W) / 2 + Fx * Uf * H, by - (Ry * W) / 2 + Fy * Uf * H, bz + Uz * H],
        [bx + (Rx * W) / 2 + Fx * Uf * H, by + (Ry * W) / 2 + Fy * Uf * H, bz + Uz * H],
        [bx + (Rx * W) / 2, by + (Ry * W) / 2, bz],
        [bx - (Rx * W) / 2, by - (Ry * W) / 2, bz],
      ];
      const q = [];
      let ok = true;
      for (let k = 0; k < 4; k++) {
        const p = ov.project(corners[k][0], corners[k][1], corners[k][2], this._p[k]);
        if (!p) { ok = false; break; }
        q.push([p.x, p.y]);
      }
      const g = ok && ov.project(a[0], a[1], it.base || 0, this._p[4]);
      const minX = ok ? Math.min(...q.map((v) => v[0])) : 0;
      const maxX = ok ? Math.max(...q.map((v) => v[0])) : 0;
      const minY = ok ? Math.min(...q.map((v) => v[1])) : 0;
      const maxY = ok ? Math.max(...q.map((v) => v[1])) : 0;
      const onScreen = ok && g && maxX > -40 && minX < ov.width + 40 && maxY > -40 && minY < ov.height + 40 && maxX - minX < ov.width * 1.5;
      if (!onScreen) { el.style.display = 'none'; continue; }
      const [A, B, C, D, E, F, G, Hh] = squareToQuad(q);
      const w = it.w, h = it.h;
      el.style.transform = `matrix3d(${A / w},${D / w},0,${G / w},${B / h},${E / h},0,${Hh / h},0,0,1,0,${C},${F},0,1)`;
      order.push([el, g.w]);
      if (stems < MAX_STEMS) {
        const s = stems * 6;
        this.stemPos.set([a[0], a[1], it.base || 0, bx, by, bz], s);
        this.stemAlpha[stems * 2] = 0.9;
        this.stemAlpha[stems * 2 + 1] = 0.25;
        this.dotPos.set([a[0], a[1], it.base || 0], stems * 3);
        stems++;
      }
    }
    // Nearer panels draw on top.
    order.sort((x, y) => y[1] - x[1]).forEach(([el], i) => (el.style.zIndex = String(10 + i)));
    this.stems.geometry.setDrawRange(0, stems * 2);
    this.stems.geometry.attributes.position.needsUpdate = true;
    this.stems.geometry.attributes.aA.needsUpdate = true;
    this.dots.geometry.setDrawRange(0, stems);
    this.dots.geometry.attributes.position.needsUpdate = true;
  }
}

// Flat screen-space tags for moving things (aircraft) and quick labels.
export class Tags {
  constructor(overlay, root) {
    this.overlay = overlay;
    this.root = root;
    this.items = new Map();
    this._p = {};
  }
  set(id, spec) {
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement('div');
      el.className = 'holo-tag';
      this.root.appendChild(el);
      it = { el, html: '' };
      this.items.set(id, it);
    }
    const prev = it.html;
    Object.assign(it, spec);
    it.el.className = 'holo-tag' + (spec.variant ? ' ' + spec.variant : '');
    if (spec.html !== prev) it.el.innerHTML = spec.html;
    it.seen = true;
  }
  // Remove tags not refreshed since the last sweep.
  sweep() {
    for (const [id, it] of this.items) {
      if (!it.seen) { it.el.remove(); this.items.delete(id); } else it.seen = false;
    }
  }
  clear(prefix) {
    for (const [id, it] of this.items) if (id.startsWith(prefix)) { it.el.remove(); this.items.delete(id); }
  }
  update() {
    const ov = this.overlay;
    for (const it of this.items.values()) {
      const p = it.scene && ov.project(it.scene[0], it.scene[1], it.scene[2], this._p);
      if (!p || p.x < -80 || p.y < -40 || p.x > ov.width + 80 || p.y > ov.height + 40) { it.el.style.display = 'none'; continue; }
      it.el.style.display = '';
      it.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }
  }
}
