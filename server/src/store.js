// Tiny JSON-file store for users and sessions. Writes are debounced and atomic
// (write to a temp file, then rename). Fine for a single server process; swap for a real
// database when the player count grows.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';

const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
export const STARTING_RATING = 1000;
export const FREE_SKINS = ['village'];

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: {}, sessions: {} };
    if (existsSync(file)) {
      try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { console.error('store: could not read', file, err.message); }
    }
    this.data.users ||= {};
    this.data.sessions ||= {};
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  /* ---------------------------------------------------------------- users */

  findByName(username) {
    const lower = String(username || '').toLowerCase();
    return Object.values(this.data.users).find((u) => u.username.toLowerCase() === lower) || null;
  }

  createUser(username, password, { guest = false } = {}) {
    if (!USERNAME.test(username || '')) throw new Error('Usernames are 3-16 letters, digits or _.');
    if (this.findByName(username)) throw new Error('That username is taken.');
    if (!guest && (typeof password !== 'string' || password.length < 6)) throw new Error('Passwords need at least 6 characters.');
    const id = randomUUID();
    const user = {
      id, username, guest, created: Date.now(),
      rating: STARTING_RATING, games: 0, wins: 0, vp: 0,
      owned: [...FREE_SKINS], skin: FREE_SKINS[0], coins: 0,
    };
    if (!guest) {
      const salt = randomBytes(16).toString('hex');
      user.salt = salt;
      user.hash = scryptSync(password, salt, 64).toString('hex');
    }
    this.data.users[id] = user;
    this.save();
    return user;
  }

  checkPassword(user, password) {
    if (!user || user.guest || typeof password !== 'string') return false;
    const hash = scryptSync(password, user.salt, 64);
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
  }

  /* ---------------------------------------------------------------- sessions */

  newSession(user) {
    const token = randomBytes(32).toString('hex');
    this.data.sessions[token] = { userId: user.id, created: Date.now() };
    this.save();
    return token;
  }

  userForToken(token) {
    const s = token && this.data.sessions[token];
    return s ? this.data.users[s.userId] || null : null;
  }

  endSession(token) {
    delete this.data.sessions[token];
    this.save();
  }

  /* ---------------------------------------------------------------- results */

  /**
   * Records a finished game. Ratings move only for registered players: the winner gains
   * more the more opponents there were; everyone else loses a little.
   */
  recordResult(results) {
    const n = results.length;
    for (const r of results) {
      const u = this.data.users[r.userId];
      if (!u) continue;
      u.games += 1;
      u.vp += r.vp || 0;
      if (r.won) { u.wins += 1; u.rating += 12 + 6 * (n - 1); u.coins += 50; }
      else { u.rating = Math.max(100, u.rating - 8); u.coins += 10; }
    }
    this.save();
  }

  leaderboard(limit = 50) {
    return Object.values(this.data.users)
      .filter((u) => !u.guest && u.games > 0)
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
      .slice(0, limit)
      .map((u, i) => ({ rank: i + 1, username: u.username, rating: u.rating, games: u.games, wins: u.wins, vp: u.vp }));
  }
}

/** What a client may see about a user. */
export function publicUser(u) {
  return u && { id: u.id, username: u.username, guest: !!u.guest, rating: u.rating, games: u.games, wins: u.wins, owned: u.owned, skin: u.skin, coins: u.coins };
}
