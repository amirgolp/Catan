// Client side of the online services: REST calls for accounts / leaderboard and a
// self-reconnecting WebSocket for the lobby, rooms and in-game relay.
//
// The server is the page's own origin by default. A front end hosted elsewhere (GitHub
// Pages, the iOS app) points at it with the catan-server meta tag, or a player can use
// ?server=https://my-catan-server.example once (remembered).

const AUTH_KEY = 'catan.auth';
const SERVER_KEY = 'catan.server';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function initialServer() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) store.set(SERVER_KEY, q.replace(/\/$/, ''));
  const saved = store.get(SERVER_KEY);
  if (saved) return saved;
  // A deployment (iOS app, static hosting) can name its server once in the page:
  // <meta name="catan-server" content="https://my-catan-server.example">
  const meta = document.querySelector('meta[name="catan-server"]');
  if (meta && meta.content) return meta.content.replace(/\/$/, '');
  return location.protocol.startsWith('http') ? location.origin : '';
}

export const SERVER = initialServer();

export function getAuth() {
  try { return JSON.parse(store.get(AUTH_KEY)) || null; } catch { return null; }
}

export function setAuth(auth) {
  store.set(AUTH_KEY, auth ? JSON.stringify(auth) : null);
}

/** JSON request to the server API; throws Error(message) on failure. */
export async function api(path, body, { method } = {}) {
  const auth = getAuth();
  const res = await fetch(SERVER + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `Server error ${res.status}`);
  return data;
}

/** True when the game server answers within a couple of seconds. */
export async function serverAvailable() {
  if (!SERVER) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(SERVER + '/api/health', { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * WebSocket that reconnects with backoff. `onMessage(msg)` receives parsed messages;
 * `onOpen()` runs after every (re)connect so callers can resubscribe.
 */
export function connect({ onMessage, onOpen, onClose }) {
  const auth = getAuth();
  if (!auth || !SERVER) return null;
  const wsUrl = SERVER.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(auth.token);
  let ws = null;
  let closed = false;
  let delay = 500;
  const queue = [];
  const open = () => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      delay = 500;
      if (onOpen) onOpen();
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        api.received[msg.t] = (api.received[msg.t] || 0) + 1;
        onMessage(msg);
      } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      if (onClose) onClose();
      if (closed) return;
      setTimeout(open, delay);
      delay = Math.min(8000, delay * 2);
    };
  };
  const api = {
    received: {}, // message counts by type (diagnostics)
    send(msg) {
      const data = JSON.stringify(msg);
      if (ws && ws.readyState === 1) ws.send(data);
      else queue.push(data);
    },
    close() { closed = true; if (ws) ws.close(); },
  };
  open();
  return api;
}
