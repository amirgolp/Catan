// HTTP + WebSocket server: serves the web app, a small JSON API for accounts and the
// leaderboard, and the lobby / room protocol on /ws.
//
//   PORT       (default 8080)
//   WEB_ROOT   folder to serve (default ../web)
//   DATA_FILE  JSON store (default ./data/db.json)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store, publicUser } from './store.js';
import { Rooms, VARIANTS } from './rooms.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const WEB_ROOT = resolve(process.env.WEB_ROOT || join(here, '..', '..', 'web'));
const DATA_FILE = resolve(process.env.DATA_FILE || join(here, '..', 'data', 'db.json'));

const store = new Store(DATA_FILE);
const rooms = new Rooms(store);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

/* ---------------------------------------------------------------- helpers */

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Very small per-IP limiter for the auth endpoints.
const attempts = new Map();
function limited(req) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 20;
}

/* ---------------------------------------------------------------- API */

async function api(req, res, path) {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (path === '/api/health') return sendJson(res, 200, { ok: true, rooms: rooms.rooms.size, online: rooms.clients.size });
    if (path === '/api/variants') return sendJson(res, 200, VARIANTS);
    if (path === '/api/leaderboard') return sendJson(res, 200, store.leaderboard());

    if (req.method === 'POST' && (path === '/api/signup' || path === '/api/login' || path === '/api/guest')) {
      if (limited(req)) return sendJson(res, 429, { error: 'Too many attempts, wait a minute.' });
      const body = await readBody(req);
      let user;
      if (path === '/api/signup') user = store.createUser(String(body.username || '').trim(), body.password);
      else if (path === '/api/guest') {
        const base = String(body.name || 'Guest').replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) || 'Guest';
        let name;
        do name = `${base}_${Math.floor(Math.random() * 9000 + 1000)}`; while (store.findByName(name));
        user = store.createUser(name, null, { guest: true });
      } else {
        user = store.findByName(String(body.username || '').trim());
        if (!store.checkPassword(user, body.password)) return sendJson(res, 401, { error: 'Wrong username or password.' });
      }
      return sendJson(res, 200, { token: store.newSession(user), user: publicUser(user) });
    }

    const token = tokenOf(req);
    const user = store.userForToken(token);
    if (!user) return sendJson(res, 401, { error: 'Please log in.' });
    if (path === '/api/me' && req.method === 'GET') return sendJson(res, 200, publicUser(user));
    if (path === '/api/logout' && req.method === 'POST') { store.endSession(token); return sendJson(res, 200, { ok: true }); }
    if (path === '/api/me/skin' && req.method === 'POST') {
      const body = await readBody(req);
      if (!user.owned.includes(body.skin)) return sendJson(res, 403, { error: 'You do not own that skin yet.' });
      user.skin = body.skin;
      store.save();
      return sendJson(res, 200, publicUser(user));
    }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || 'Bad request.' });
  }
}

/* ---------------------------------------------------------------- static files */

async function serveStatic(req, res, path) {
  let rel = decodeURIComponent(path);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(WEB_ROOT, rel));
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) { res.writeHead(403); return res.end(); }
  try {
    const info = await stat(file);
    if (info.isDirectory()) return serveStatic(req, res, rel + '/');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/* ---------------------------------------------------------------- server */

const server = createServer((req, res) => {
  // The API may be called from a front end hosted elsewhere (e.g. GitHub Pages).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const user = url.pathname === '/ws' ? store.userForToken(url.searchParams.get('token')) : null;
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => rooms.connect(ws, user));
});

setInterval(() => rooms.heartbeat(), 30_000);
process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Catan server on http://localhost:${PORT}  (web: ${WEB_ROOT}, data: ${DATA_FILE})`);
});
