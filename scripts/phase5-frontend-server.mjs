import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mounts = [['/CRM/', resolve(root, 'tmp/phase5/frontend-dist')], ['/review-crm/', resolve(root, 'tmp/phase5/frontend-custom-dist')], ['/', resolve(root, 'tmp/phase5/frontend-root-dist')]];
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png' };
createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/health') { response.writeHead(200); response.end('local QA static server'); return; }
  const mount = mounts.find(([base]) => pathname.startsWith(base));
  if (!mount) { response.writeHead(404); response.end('Not in this Pages artifact'); return; }
  const [base, directory] = mount;
  let file = resolve(directory, pathname.slice(base.length) || 'index.html');
  if (file !== directory && !file.startsWith(`${directory}${sep}`)) { response.writeHead(403); response.end(); return; }
  let status = 200;
  try { if (!statSync(file).isFile()) throw new Error('Not a file'); }
  catch {
    if (extname(pathname)) { response.writeHead(404); response.end('Missing artifact'); return; }
    // Match the Pages index-as-404 workflow for direct SPA deep links.
    file = resolve(directory, '404.html'); status = 404;
  }
  const contentType = types[extname(file)] || 'application/octet-stream';
  let bytes = readFileSync(file);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': bytes.length };
  if (/text|javascript|json|svg/.test(contentType) && request.headers['accept-encoding']?.includes('gzip')) {
    bytes = gzipSync(bytes); headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = bytes.length;
  }
  response.writeHead(status, headers); response.end(bytes);
}).listen(5198, '127.0.0.1', () => console.log('Phase 5 static build QA: http://127.0.0.1:5198'));
