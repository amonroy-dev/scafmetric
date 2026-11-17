// Minimal zero-dependency static file server for the built site in dist/.
// Replaces the previous `python3 -m http.server` step so `npm start` works on any
// machine with Node (no Python / Windows Store-alias surprises).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

async function resolveFile(urlPath) {
  // Strip query/hash and prevent path traversal out of ROOT.
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let full = join(ROOT, rel);
  // Guard against path traversal escaping ROOT (compare with a trailing separator).
  const rootWithSep = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
  if (full !== ROOT.replace(/[/\\]$/, '') && !full.startsWith(rootWithSep)) return null;
  try {
    const info = await stat(full);
    if (info.isDirectory()) full = join(full, 'index.html');
  } catch {
    return null;
  }
  return full;
}

const server = createServer(async (req, res) => {
  try {
    const target = await resolveFile(req.url || '/');
    if (!target) { res.writeHead(404); res.end('Not found'); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Scafmetric dev server: http://${HOST}:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
});
