// Spatial city soundscape, synthesised with Web Audio: no recordings, no downloads, no licences.
// Sounds are tied to the scene: traffic sits on the major roads in view, trains run along the rail
// lines on screen, jet noise follows live ADS-B aircraft, wind follows the live weather, and a crowd
// murmur rises as the camera drops to street level. The listener rides just in front of the camera.

const smooth = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);

export class CityAudio {
  constructor() {
    // Browsers only allow audio after a gesture, so sound always starts off and the controls say so.
    this.on = false;
    this.ctx = null;
    this.roads = [];
    this.rails = [];
    this.traffic = [];
    this.planes = new Map();
    this.train = null;
    this.nextTrain = 0;
    this.nextSyllable = 0;
  }

  // Must run inside a user gesture (the Enter click) so the browser lets audio start.
  start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!this.ctx) {
      this.ctx = new AC();
      this.build();
    }
    this.ctx.resume();
    this.setOn(this.on);
    return true;
  }

  setOn(on) {
    this.on = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? 0.85 : 0, t, 0.25);
    if (on) this.ctx.resume();
  }

  // Suspend while the tab is hidden; resume on return if sound is on.
  setHidden(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend();
    else if (this.on) this.ctx.resume();
  }

  // ---------- graph ----------
  noise(kind) {
    const ctx = this.ctx, len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else d[i] = w;
    }
    return buf;
  }

  filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  // A looping noise source through a filter chain into a gain; returns the parts for modulation.
  voice(buffer, filters, level, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = level;
    let node = src;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(gain).connect(dest);
    src.start(0, Math.random() * 3);
    return { src, filters, gain };
  }

  panner(ref, rolloff = 1) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 20000;
    p.connect(this.master);
    return p;
  }

  place(p, x, y, z) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else p.setPosition(x, y, z);
  }

  build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    this.white = this.noise('white');
    this.brown = this.noise('brown');
    this.pink = this.noise('pink');

    // Distant city bed: low rumble with a slow swell of traffic.
    this.bed = this.voice(this.brown, [this.filter('lowpass', 300)], 0.22, this.master);
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.06;
    const swellAmt = ctx.createGain();
    swellAmt.gain.value = 0.07;
    swell.connect(swellAmt).connect(this.bed.gain.gain);
    swell.start();
    this.hiss = this.voice(this.pink, [this.filter('bandpass', 1300, 0.6)], 0.03, this.master);

    // Wind, its colour wandering slowly.
    this.wind = this.voice(this.white, [this.filter('bandpass', 480, 0.9)], 0, this.master);
    const gust = ctx.createOscillator();
    gust.frequency.value = 0.11;
    const gustAmt = ctx.createGain();
    gustAmt.gain.value = 220;
    gust.connect(gustAmt).connect(this.wind.filters[0].frequency);
    gust.start();
    this.rain = this.voice(this.white, [this.filter('highpass', 3800)], 0, this.master);

    // Street-level murmur: formant-band noise with syllable-rate envelopes.
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.filter('lowpass', 3200)).connect(this.master);
    this.murmurBus = bus;
    this.murmur = [[420, 5], [1250, 6], [2400, 7], [700, 5]].map(([f, q]) => this.voice(this.white, [this.filter('bandpass', f, q)], 0, bus));

    // Traffic emitters, repositioned onto real roads as the camera moves.
    this.traffic = [0, 1, 2, 3].map(() => {
      const p = this.panner(70, 1.1);
      const v = this.voice(this.pink, [this.filter('bandpass', 700, 0.8)], 0.015, p);
      return { p, v, next: 0 };
    });
  }

  // ---------- scene inputs ----------
  setRoads(points) { this.roads = points.slice(0, 4); }
  setRails(paths) { this.rails = paths.filter((p) => p.length > 1); }

  // ---------- one-shots ----------
  ping() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain(), d = ctx.createDelay(), fb = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(620, t + 0.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    d.delayTime.value = 0.27;
    fb.gain.value = 0.32;
    o.connect(g);
    g.connect(this.master);
    g.connect(d).connect(fb).connect(d);
    fb.connect(this.master);
    o.start(t);
    o.stop(t + 1.2);
    setTimeout(() => { fb.disconnect(); d.disconnect(); }, 3000);
  }

  blip() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [[1760, 0], [2640, 0.05]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.06, t + dt + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.09);
      o.connect(g).connect(this.master);
      o.start(t + dt);
      o.stop(t + dt + 0.12);
    });
  }

  // The cinematic entry: a filtered air rush over a deep sub hit.
  whoosh() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = this.filter('bandpass', 250, 1.2);
    bp.frequency.setValueAtTime(220, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 1.3);
    bp.frequency.exponentialRampToValueAtTime(400, t + 3.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 3.6);
    const sub = ctx.createOscillator(), sg = ctx.createGain();
    sub.frequency.setValueAtTime(62, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 2.2);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    sub.connect(sg).connect(this.master);
    sub.start(t);
    sub.stop(t + 2.5);
  }

  // A wheel-on-rail clack at the train's position.
  clack(dest, t, level) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = this.filter('bandpass', 1700, 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(bp).connect(g).connect(dest);
    src.start(t, Math.random() * 3);
    src.stop(t + 0.08);
  }

  startTrain() {
    const path = this.rails[Math.floor(Math.random() * this.rails.length)];
    if (!path) return;
    const pts = Math.random() < 0.5 ? path : [...path].reverse();
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(l);
      total += l;
    }
    if (total < 150) return;
    const p = this.panner(90, 1);
    const rumble = this.voice(this.brown, [this.filter('lowpass', 170)], 0, p);
    const t = this.ctx.currentTime;
    rumble.gain.gain.setTargetAtTime(0.9, t, 1.5);
    this.train = { pts, seg, total, d: 0, speed: rand(14, 22), p, rumble, nextClack: t + 0.5, car: 0 };
  }

  endTrain() {
    const tr = this.train;
    this.train = null;
    const t = this.ctx.currentTime;
    tr.rumble.gain.gain.setTargetAtTime(0, t, 0.8);
    setTimeout(() => { tr.rumble.src.stop(); tr.p.disconnect(); }, 4000);
  }

  // ---------- per frame ----------
  update(dt, s) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime, L = ctx.listener;
    // Listener: just in front of the camera, facing where it looks.
    const ex = s.eye.x, ey = s.eye.y, ez = s.eye.z, cx = s.center.x, cy = s.center.y;
    const ear = [cx + (ex - cx) * 0.12, cy + (ey - cy) * 0.12, Math.max(20, ez * 0.12)];
    let fx = cx - ex, fy = cy - ey, fz = -ez;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const b = (s.bearing * Math.PI) / 180;
    const rx = Math.cos(b), ry = -Math.sin(b);
    const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
    if (L.positionX) {
      L.positionX.value = ear[0]; L.positionY.value = ear[1]; L.positionZ.value = ear[2];
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(...ear);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }

    const street = smooth(s.zoom, 14.2, 16.8);
    const high = 1 - smooth(s.zoom, 12.5, 15.5);
    const tc = 0.4;
    this.bed.gain.gain.setTargetAtTime(0.12 + 0.12 * (s.built ?? 0.3) + 0.08 * (1 - street), t, tc);
    this.hiss.gain.gain.setTargetAtTime(0.02 + 0.03 * street, t, tc);
    const wind = Math.min(18, s.wind ?? 3);
    this.wind.gain.gain.setTargetAtTime((0.012 + wind * 0.005) * (0.45 + 0.9 * high), t, 0.8);
    this.rain.gain.gain.setTargetAtTime(s.rain ? 0.05 : 0, t, 1.5);
    this.murmurBus.gain.setTargetAtTime(0.11 * smooth(s.zoom, 15.3, 17), t, 0.6);
    if (t > this.nextSyllable) {
      this.nextSyllable = t + rand(0.09, 0.22);
      for (const v of this.murmur) v.gain.gain.setTargetAtTime(Math.random() < 0.45 ? rand(0.2, 1) : 0.05, t, 0.04);
    }

    // Cars passing on the roads in view: a swell with a falling, Doppler-like filter sweep.
    this.traffic.forEach((e, i) => {
      const pt = this.roads[i];
      if (!pt) { e.v.gain.gain.setTargetAtTime(0, t, 0.5); return; }
      this.place(e.p, pt[0], pt[1], 1.5);
      if (t > e.next) {
        e.next = t + rand(0.7, 3.2);
        const f = e.v.filters[0].frequency, g = e.v.gain.gain;
        f.cancelScheduledValues(t);
        f.setValueAtTime(rand(950, 1300), t);
        f.exponentialRampToValueAtTime(rand(420, 600), t + 1.8);
        g.cancelScheduledValues(t);
        g.setTargetAtTime(rand(0.18, 0.4) * (0.5 + street), t, 0.3);
        g.setTargetAtTime(0.02, t + 0.9, 0.5);
      }
    });

    // Trains along real rail lines on screen, every minute or so.
    if (!this.train && this.rails.length && t > this.nextTrain) {
      this.nextTrain = t + rand(40, 85);
      this.startTrain();
    }
    const tr = this.train;
    if (tr) {
      tr.d += tr.speed * dt;
      if (tr.d >= tr.total) this.endTrain();
      else {
        let d = tr.d, i = 0;
        while (i < tr.seg.length - 1 && d > tr.seg[i]) d -= tr.seg[i++];
        const a = tr.pts[i], c = tr.pts[i + 1], k = tr.seg[i] ? d / tr.seg[i] : 0;
        this.place(tr.p, a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, 4);
        if (t > tr.nextClack) {
          // Bogie pairs: clack-clack, then a car length of rail.
          this.clack(tr.p, t, 0.5);
          this.clack(tr.p, t + 0.11, 0.42);
          tr.car++;
          tr.nextClack = t + (tr.car % 2 ? 2.6 / tr.speed : 17 / tr.speed);
        }
      }
    }

    // Jet noise follows the nearest live aircraft.
    const near = (s.planes || [])
      .map((a) => ({ a, d: Math.hypot(a.scene[0] - ear[0], a.scene[1] - ear[1], a.scene[2] - ear[2]) }))
      .filter((o) => o.d < 9000 && !o.a.ground)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3);
    const keep = new Set(near.map((o) => o.a.id));
    for (const [id, v] of this.planes) {
      if (keep.has(id)) continue;
      v.jet.gain.gain.setTargetAtTime(0, t, 1);
      setTimeout(() => { v.jet.src.stop(); v.p.disconnect(); }, 4000);
      this.planes.delete(id);
    }
    for (const { a } of near) {
      let v = this.planes.get(a.id);
      if (!v) {
        const p = this.panner(450, 1.1);
        const jet = this.voice(this.brown, [this.filter('lowpass', 850)], 0, p);
        jet.gain.gain.setTargetAtTime(1.6, t, 1.2);
        v = { p, jet };
        this.planes.set(a.id, v);
      }
      this.place(v.p, a.scene[0], a.scene[1], a.scene[2]);
    }
  }
}
