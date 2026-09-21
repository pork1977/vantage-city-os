import earcut from 'https://cdn.jsdelivr.net/npm/earcut@3.0.1/+esm';
import { processTile } from './city-core.js';

self.onmessage = async (e) => {
  const { id, url, z, x, y, schema } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      throw new Error(`tile ${z}/${x}/${y} answered ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const t0 = performance.now();
    let out;
    try {
      out = processTile(buf, z, x, y, earcut, schema);
    } catch (err) {
      throw new Error(`tile ${z}/${x}/${y} could not be decoded: ${err.message}`);
    }
    out.ms = performance.now() - t0;
    out.bytes = buf.byteLength;
    const transfer = [out.bldg.pos.buffer, out.bldg.aw.buffer, out.bldg.idx.buffer, out.fence.pos.buffer, out.fence.aw.buffer, out.fence.idx.buffer];
    self.postMessage({ id, ok: true, out }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
