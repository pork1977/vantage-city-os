// Vantage local server: serves the app and answers /api/* with the same handlers the Vercel
// functions use (lib/api.mjs). On Vercel, the files are served statically and api/ holds the functions.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, os } from './lib/api.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT) || rel.includes('node_modules') || path.basename(file).startsWith('.')) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    const body = await fs.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'Not found', 'text/plain');
    send(res, 500, 'Server error', 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log(`Vantage running at http://localhost:${PORT}`);
  console.log(os.enabled ? 'OS Data Hub: key loaded — OS layers enabled' : 'OS Data Hub: no key — set OS_API_KEY (or add it to .env) to enable OS layers');
});
