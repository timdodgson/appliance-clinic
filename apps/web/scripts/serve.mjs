// Local development server: builds the site, serves dist/ and forwards /api/* to an Appliance Clinic API.
//
//   npm run serve                               http://localhost:8080, API https://applianceclinic.ai/api
//   API_ORIGIN=https://<host> PORT=9000 npm run serve
//
// The browser only ever talks to localhost; /api is forwarded unchanged, so the admin session cookie (Secure,
// SameSite=Lax, no Domain) is kept for localhost as it is for the live site. Production traffic is real: use obvious
// test wording, and an admin account in the AC Cognito pool, when pointing at the live API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { build } from './build.mjs';
import { cachePolicy } from './site-files.mjs';

const PORT = Number(process.env.PORT || 8080);
const API_ORIGIN = (process.env.API_ORIGIN || 'https://applianceclinic.ai').replace(/\/$/, '');
const OUT = join(new URL('..', import.meta.url).pathname, 'dist');

build();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res, url);
  let key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (key === '' || key.endsWith('/')) key += 'index.html';
  const file = normalize(join(OUT, key));
  if (!file.startsWith(OUT)) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': cachePolicy(key).contentType, 'cache-control': 'no-store' }).end(body);
  } catch {
    try { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(join(OUT, '404.html'))); }
    catch { res.writeHead(404).end('not found'); }
  }
});

async function proxy(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length']; delete headers.connection;
  try {
    const r = await fetch(API_ORIGIN + url.pathname + url.search, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual',
    });
    const out = {};
    r.headers.forEach((v, k) => { if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v; });
    const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `API unreachable: ${e.message}` }));
  }
}

server.listen(PORT, () => console.log(`Appliance Clinic web on http://localhost:${PORT} (API ${API_ORIGIN}/api)`));
