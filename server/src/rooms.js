// Lobby and rooms over WebSocket.
//
// A room collects players, then its host starts the game. The host's browser runs the
// authoritative Game (rules, bots, dice); everyone else runs a mirror:
//   host   --state-->  server  --state (other hands hidden)-->  mirrors
//   mirror --intent-->  server  --intent + seat-->              host
// The server keeps the last full state (and the hidden deck) so a refreshed page can
// resume, and hands the game to another player if the host leaves for good.
import { randomBytes, randomInt } from 'node:crypto';
import { publicUser } from './store.js';

export const VARIANTS = {
  classic: { name: 'Classic', min: 2, max: 4 },
  balanced: { name: 'Balanced', min: 2, max: 4 },
  extension: { name: '5-6 Extension', min: 2, max: 6 },
};
const SEAT_KEYS = ['red', 'blue', 'white', 'orange', 'green', 'brown'];
const BOT_LEVELS = ['easy', 'medium', 'hard'];
const RESOURCES = ['wood', 'brick', 'wool', 'grain', 'ore'];
const HOST_GRACE_MS = 15000;
const SEAT_GRACE_MS = 10000; // a player reloading or switching pages keeps their seat
const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export class Rooms {
  constructor(store) {
    this.store = store;
    this.rooms = new Map();
    this.clients = new Set(); // { ws, user, token, roomId, lobby }
    this.lobbyChat = [];
  }

  /* ---------------------------------------------------------------- connections */

  connect(ws, user) {
    const client = { ws, user, roomId: null, lobby: false, alive: true };
    this.clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { this.handle(client, msg); } catch (err) { console.error('ws handler', err); this.send(client, { t: 'error', text: 'Server error.' }); }
    });
    ws.on('close', () => this.disconnect(client));
    this.send(client, { t: 'hello', user: publicUser(user) });
  }

  disconnect(client) {
    this.clients.delete(client);
    const room = client.roomId && this.rooms.get(client.roomId);
    if (!room) return;
    if (room.status === 'waiting') this.leave(client);
    else if (room.status === 'playing') {
      const stillHere = this.membersOnline(room).some((c) => c.user.id === client.user.id);
      if (stillHere) return;
      const seat = this.seatOf(room, client.user.id);
      if (room.game.hostId === client.user.id) this.scheduleHostHandover(room);
      else if (seat) this.scheduleSeatHandover(room, seat, client.user);
    }
  }

  send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  /** Drops dead sockets; call periodically. */
  heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closed */ }
    }
  }

  /* ---------------------------------------------------------------- messages */

  handle(client, msg) {
    switch (msg.t) {
      case 'lobby': client.lobby = true; this.send(client, { t: 'rooms', rooms: this.list() }); this.send(client, { t: 'lobbyChat', lines: this.lobbyChat }); return;
      case 'create': return this.create(client, msg);
      case 'join': return this.join(client, msg.id);
      case 'leave': return this.leave(client);
      case 'config': return this.config(client, msg);
      case 'ready': return this.setReady(client, !!msg.ready);
      case 'start': return this.start(client);
      case 'chat': return this.chat(client, msg.text);
      case 'rejoin': return this.rejoin(client, msg.id);
      case 'state': return this.state(client, msg);
      case 'intent': return this.intent(client, msg);
      case 'result': return this.result(client, msg);
      default:
    }
  }

  /* ---------------------------------------------------------------- lobby */

  list() {
    return [...this.rooms.values()].filter((r) => !r.private || r.status !== 'waiting').map((r) => this.summary(r));
  }

  summary(r) {
    return {
      id: r.id, name: r.name, variant: r.variant, max: r.max, timer: r.timer, fill: r.fill, private: r.private,
      status: r.status, hostId: r.hostId,
      players: r.members.map((id) => { const u = this.store.data.users[id]; return { id, name: u ? u.username : '?', ready: r.ready.has(id), rating: u?.rating, guest: !!u?.guest }; }),
    };
  }

  broadcastRooms() {
    const rooms = this.list();
    for (const c of this.clients) if (c.lobby && !c.roomId) this.send(c, { t: 'rooms', rooms });
  }

  pushRoom(room) {
    const summary = this.summary(room);
    for (const c of this.membersOnline(room)) this.send(c, { t: 'room', room: summary, chat: room.chat });
    this.broadcastRooms();
  }

  membersOnline(room) {
    return [...this.clients].filter((c) => c.roomId === room.id);
  }

  /* ---------------------------------------------------------------- rooms */

  create(client, msg) {
    if (client.roomId) this.leave(client);
    const variant = VARIANTS[msg.variant] ? msg.variant : 'classic';
    const v = VARIANTS[variant];
    let id;
    do id = randomBytes(3).toString('hex').toUpperCase(); while (this.rooms.has(id));
    const room = {
      id, name: cleanText(msg.name, 40) || `${client.user.username}'s table`,
      hostId: client.user.id, variant, max: clampInt(msg.max, v.min, v.max, v.max),
      timer: clampInt(msg.timer, 0, 600, 90), fill: BOT_LEVELS.includes(msg.fill) ? msg.fill : 'medium',
      private: !!msg.private, members: [], ready: new Set(), status: 'waiting', chat: [], game: null,
      lastState: null, deck: null, created: Date.now(), hostTimer: null,
    };
    this.rooms.set(id, room);
    this.join(client, id);
  }

  join(client, id) {
    const room = this.rooms.get(String(id || '').toUpperCase());
    if (!room) return this.send(client, { t: 'error', text: 'That room no longer exists.' });
    if (room.status === 'playing' && this.seatOf(room, client.user.id)) return this.rejoin(client, room.id);
    if (room.status !== 'waiting') return this.send(client, { t: 'error', text: 'That game has already started.' });
    if (!room.members.includes(client.user.id) && room.members.length >= room.max) return this.send(client, { t: 'error', text: 'That room is full.' });
    if (client.roomId && client.roomId !== room.id) this.leave(client);
    client.roomId = room.id;
    if (!room.members.includes(client.user.id)) {
      room.members.push(client.user.id);
      this.roomChat(room, null, `${client.user.username} joined.`, false);
    }
    this.pushRoom(room);
  }

  leave(client) {
    const room = client.roomId && this.rooms.get(client.roomId);
    client.roomId = null;
    if (!room) return;
    if (room.status === 'waiting') {
      const others = [...this.clients].some((c) => c !== client && c.roomId === room.id && c.user.id === client.user.id);
      if (!others) {
        room.members = room.members.filter((m) => m !== client.user.id);
        room.ready.delete(client.user.id);
        this.roomChat(room, null, `${client.user.username} left.`, false);
      }
      if (!room.members.length) { this.rooms.delete(room.id); this.broadcastRooms(); return; }
      if (room.hostId === client.user.id) room.hostId = room.members[0];
      this.pushRoom(room);
    }
    this.send(client, { t: 'left' });
    this.broadcastRooms();
  }

  config(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.status !== 'waiting' || room.hostId !== client.user.id) return;
    if (msg.variant && VARIANTS[msg.variant]) room.variant = msg.variant;
    const v = VARIANTS[room.variant];
    room.max = clampInt(msg.max ?? room.max, Math.max(v.min, room.members.length), v.max, v.max);
    if (msg.timer !== undefined) room.timer = clampInt(msg.timer, 0, 600, 90);
    if (BOT_LEVELS.includes(msg.fill)) room.fill = msg.fill;
    if (msg.private !== undefined) room.private = !!msg.private;
    if (msg.name) room.name = cleanText(msg.name, 40) || room.name;
    this.pushRoom(room);
  }

  setReady(client, ready) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.status !== 'waiting') return;
    if (ready) room.ready.add(client.user.id); else room.ready.delete(client.user.id);
    this.pushRoom(room);
  }

  /** Host starts: humans take seats in join order, bots fill the rest up to `max`. */
  start(client) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.status !== 'waiting' || room.hostId !== client.user.id) return;
    const notReady = room.members.filter((m) => m !== room.hostId && !room.ready.has(m));
    if (notReady.length) return this.send(client, { t: 'error', text: 'Everyone must be ready first.' });
    const seats = [];
    for (let i = 0; i < room.max; i++) {
      const key = SEAT_KEYS[i];
      const userId = room.members[i];
      const u = userId && this.store.data.users[userId];
      seats.push(u
        ? { key, userId, name: u.username, controller: 'human', skin: u.owned.includes(u.skin) ? u.skin : 'village' }
        : { key, userId: null, name: `${room.fill[0].toUpperCase() + room.fill.slice(1)} bot ${i + 1}`, controller: room.fill, skin: 'village' });
    }
    room.game = { id: room.id, seed: randomInt(1, 1e6), variant: room.variant, seats, hostId: room.hostId, timer: room.timer, recorded: false };
    room.status = 'playing';
    room.lastState = null;
    room.deck = null;
    for (const c of this.membersOnline(room)) this.send(c, { t: 'start', game: room.game, you: this.seatOf(room, c.user.id)?.key || null });
    this.roomChat(room, null, 'The game has started. Good luck!');
    this.broadcastRooms();
  }

  seatOf(room, userId) {
    return room.game ? room.game.seats.find((s) => s.userId === userId) || null : null;
  }

  /** A player (re)opens the game page: resend the game and the latest state. */
  rejoin(client, id) {
    const room = this.rooms.get(String(id || '').toUpperCase());
    if (!room || !room.game) return this.send(client, { t: 'error', text: 'That game is not running.', fatal: true });
    const seat = this.seatOf(room, client.user.id);
    // The game page replaces any older connection of the same player (e.g. the lobby tab
    // that is still closing), so moves and host messages reach the page that plays.
    for (const c of this.clients) if (c !== client && c.user.id === client.user.id && c.roomId === room.id) c.roomId = null;
    client.roomId = room.id;
    const isHost = room.game.hostId === client.user.id;
    // A returning host gets the saved state with the game so it resumes instead of re-dealing.
    const resume = isHost && room.lastState ? { state: room.lastState, deck: room.deck, away: [...(room.away || [])] } : null;
    this.send(client, { t: 'start', game: room.game, you: seat ? seat.key : null, resume });
    this.send(client, { t: 'room', room: this.summary(room), chat: room.chat });
    if (isHost) {
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
    } else {
      if (room.lastState) this.send(client, { t: 'state', snap: this.redact(room.lastState, seat ? seat.key : null) });
      if (seat && room.seatTimers && room.seatTimers[seat.key]) { clearTimeout(room.seatTimers[seat.key]); delete room.seatTimers[seat.key]; }
      if (seat && room.away && room.away.delete(seat.key)) {
        this.toHost(room, { t: 'seatBack', seat: seat.key });
        this.roomChat(room, null, `${client.user.username} is back.`);
      }
    }
  }

  /** A seated player who stays away hands their seat to a bot (until they come back). */
  scheduleSeatHandover(room, seat, user) {
    room.seatTimers ||= {};
    clearTimeout(room.seatTimers[seat.key]);
    room.seatTimers[seat.key] = setTimeout(() => {
      delete room.seatTimers[seat.key];
      if (room.status !== 'playing' || this.membersOnline(room).some((c) => c.user.id === user.id)) return;
      room.away ||= new Set();
      room.away.add(seat.key);
      this.toHost(room, { t: 'seatLeft', seat: seat.key });
      this.roomChat(room, null, `${user.username} left; a bot plays for them until they return.`);
    }, SEAT_GRACE_MS);
  }

  scheduleHostHandover(room) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (room.status !== 'playing') return;
      const online = this.membersOnline(room);
      if (online.some((c) => c.user.id === room.game.hostId)) return;
      const next = online.find((c) => this.seatOf(room, c.user.id));
      if (!next) { room.status = 'finished'; this.broadcastRooms(); return; }
      const old = this.seatOf(room, room.game.hostId);
      room.game.hostId = next.user.id;
      room.hostId = next.user.id;
      room.away ||= new Set();
      if (old) room.away.add(old.key);
      this.send(next, { t: 'resume', state: room.lastState, deck: room.deck, promoted: true, away: [...room.away] });
      for (const c of online) if (c !== next) this.send(c, { t: 'host', hostId: next.user.id, name: next.user.username });
      this.roomChat(room, null, `${next.user.username} is now hosting the game.`);
    }, HOST_GRACE_MS);
  }

  /** The host's newest connection in the room. */
  hostClient(room) {
    return this.membersOnline(room).filter((c) => c.user.id === room.game.hostId).pop() || null;
  }

  toHost(room, msg) {
    const host = this.hostClient(room);
    if (host) this.send(host, msg);
  }

  /* ---------------------------------------------------------------- in-game relay */

  /** Hides the hands and development cards of every seat but `seatKey`. */
  redact(snap, seatKey) {
    if (!snap) return snap;
    const over = snap.phase === 'over';
    const zero = (o) => Object.fromEntries(Object.keys(o || {}).map((k) => [k, 0]));
    return {
      ...snap,
      players: snap.players.map((p) => {
        if (p.key === seatKey) return p;
        const handCount = RESOURCES.reduce((a, r) => a + (p.hand?.[r] || 0), 0);
        const devCount = Object.values(p.dev || {}).reduce((a, b) => a + b, 0);
        return { ...p, hand: zero(p.hand), dev: over ? p.dev : zero(p.dev), fresh: zero(p.fresh), handCount, devCount };
      }),
    };
  }

  state(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || !room.game || room.status === 'waiting' || room.game.hostId !== client.user.id || !msg.snap) return;
    room.lastState = msg.snap;
    if (Array.isArray(msg.deck)) room.deck = msg.deck;
    for (const c of this.membersOnline(room)) {
      if (c === client) continue;
      const seat = this.seatOf(room, c.user.id);
      this.send(c, { t: 'state', snap: this.redact(msg.snap, seat ? seat.key : null) });
    }
  }

  intent(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || room.status !== 'playing') return;
    const seat = this.seatOf(room, client.user.id);
    if (!seat || typeof msg.name !== 'string') return;
    this.toHost(room, { t: 'intent', seat: seat.key, name: msg.name, args: Array.isArray(msg.args) ? msg.args.slice(0, 6) : [] });
  }

  /** Host reports the final result; ratings update once per game. */
  result(client, msg) {
    const room = this.rooms.get(client.roomId);
    if (!room || !room.game || room.game.hostId !== client.user.id || room.game.recorded) return;
    const winnerKey = String(msg.winner || '');
    const vps = msg.vps || {};
    const results = room.game.seats.filter((s) => s.userId).map((s) => ({ userId: s.userId, won: s.key === winnerKey, vp: clampInt(vps[s.key], 0, 30, 0) }));
    this.store.recordResult(results);
    room.game.recorded = true;
    room.status = 'finished';
    const winner = room.game.seats.find((s) => s.key === winnerKey);
    this.roomChat(room, null, `${winner ? winner.name : 'Someone'} won the game.`);
    this.broadcastRooms();
    setTimeout(() => { if (this.membersOnline(room).length === 0) this.rooms.delete(room.id); }, 10 * 60 * 1000);
  }

  /* ---------------------------------------------------------------- chat */

  chat(client, text) {
    const clean = cleanText(text, 240);
    if (!clean) return;
    const room = client.roomId && this.rooms.get(client.roomId);
    if (room) {
      const seat = this.seatOf(room, client.user.id);
      return this.roomChat(room, { id: client.user.id, name: client.user.username, seat: seat ? seat.key : null }, clean);
    }
    const line = { from: { id: client.user.id, name: client.user.username }, text: clean, at: Date.now() };
    this.lobbyChat.push(line);
    if (this.lobbyChat.length > 60) this.lobbyChat.shift();
    for (const c of this.clients) if (c.lobby && !c.roomId) this.send(c, { t: 'chat', scope: 'lobby', ...line });
  }

  roomChat(room, from, text, push = true) {
    const line = { from, text, at: Date.now() };
    room.chat.push(line);
    if (room.chat.length > 100) room.chat.shift();
    if (!push) return;
    for (const c of this.membersOnline(room)) this.send(c, { t: 'chat', scope: 'room', ...line });
  }
}
