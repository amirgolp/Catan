// Game loop for 2-6 players: opening placement, dice, resource production, build costs,
// placement rules, robber on a 7, bank / harbour / player trading, development cards,
// longest road, largest army, victory points, turn clock, log, statistics and chat.
//
// Seats are controlled by 'human' (this device), 'remote' (a human on another device in an
// online room) or a bot level. In an online room one device (the host) runs the Game; the
// others run a mirror that renders snapshots and sends their moves as intents.
import { PLAYER_COLORS, PLAYER_KEYS } from './pieces.js';
import { RESOURCES, RESOURCE_OF, RESOURCE_ICON, COSTS, WIN_VP, handSize, DEV, DEV_COST, DEV_DECK, DEV_ICON } from './rules.js';
import { makeBot, BOT_LEVELS } from './bots.js';
import { avatarSvg, ICONS, dieHtml } from './avatars.js';

export { RESOURCES, COSTS };

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const emptyHand = () => Object.fromEntries(RESOURCES.map((r) => [r, 0]));
const emptyDev = () => Object.fromEntries(Object.keys(DEV).map((k) => [k, 0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (key) => '#' + PLAYER_COLORS[key].toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Canned lines bots use in chat. */
const BOT_LINES = {
  robbed: ['Hey! That was mine.', 'Really? Again?', 'I will remember that.', 'Rude.'],
  robber: ['Sorry, nothing personal.', 'The robber goes where the ore is.', 'Just business.'],
  build: ['Nice spot.', 'Coming along nicely.', 'Expansion time.'],
  trade: ['Pleasure doing business.', 'Deal.', 'Fair trade.'],
  win: ['GG!', 'Well played everyone.', 'That was close.'],
  lose: ['GG, well played.', 'Next time...', 'Rematch?'],
};

export class Game {
  /**
   * @param {object} opts
   *   board, pieces, rand, ui
   *   seats      – number of players (2-6), or playerKeys to pick colours explicitly
   *   controllers – { key: 'human' | 'remote' | 'easy' | 'medium' | 'hard' }
   *   names      – { key: display name }
   *   turnSeconds – turn clock (0 = off)
   *   mirror     – true on non-host devices of an online room (state comes from snapshots)
   */
  constructor({ board, pieces, rand, ui, controllers, names, seats = 4, playerKeys, turnSeconds = 90, mirror = false }) {
    this.board = board;
    this.pieces = pieces;
    this.graph = board.graph;
    this.rand = rand;
    this.ui = ui;
    this.mirror = mirror;
    const keys = playerKeys || PLAYER_KEYS.slice(0, Math.max(2, Math.min(6, seats)));
    this.players = keys.map((key) => ({
      key, name: (names && names[key]) || cap(key), hand: emptyHand(), vp: 0, longest: false, roadLength: 0,
      dev: emptyDev(), fresh: emptyDev(), knights: 0, army: false, // fresh = bought this turn, not playable yet
    }));
    this.deck = rand.shuffle(DEV_DECK.slice());
    this.devPlayed = false; // one development card per turn
    this.freeRoads = 0; // road-building card in progress
    this.chooser = null; // { kind: 'plenty' | 'monopoly', left } while a human picks resources
    this.returnPhase = 'build'; // phase to go back to after a robber move / free roads / chooser
    const defaults = { red: 'human', blue: 'easy', white: 'medium', orange: 'hard', green: 'medium', brown: 'hard' };
    this.controllers = Object.fromEntries(keys.map((k) => [k, (controllers && controllers[k]) || defaults[k]]));
    this.me = null; // online: the seat this device plays
    this.bots = {};
    // Pacing (ms). botDelay is the base "thinking" time; tests set everything to 0.
    this.botDelay = 650;
    this.rollDelay = 1250; // dice in the air before production is paid out
    this.speed = 1; // bot speed multiplier from the settings panel
    this.turnToken = 0; // bumped whenever a bot turn must stop (turn ended, seat changed)
    this.botRunning = false;
    this.rollTimer = null;
    this.offer = null; // pending player-to-player trade
    this.current = 0;
    this.turn = 1;
    this.phase = 'roll'; // 'roll' | 'rolling' | 'build' | 'robber' | 'freeroad' | 'choose' | 'over'
    this.lastRoll = null;
    this.message = '';
    this.winner = null;
    this.turnSeconds = turnSeconds; // 0 = no turn clock
    this.turnEndsAt = null; // performance.now() deadline of the current turn
    this.pausedAt = 0;
    this.seatHtml = {}; // last rendered markup per seat, to skip needless DOM rewrites
    this.listeners = [];
    this.log = []; // { n: turn, key, kind, text }
    this.events = []; // events since the last snapshot (host) for mirrors to replay
    this.seq = 0;
    this.stats = {
      rolls: Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, 0])),
      players: Object.fromEntries(keys.map((k) => [k, { gained: 0, stolen: 0, lost: 0, trades: 0, roads: 0, settlements: 0, cities: 0, cards: 0, knights: 0, discarded: 0 }])),
    };
    pieces.onPick = (hit, button) => this.onPick(hit, button);
    pieces.pickKinds = new Set(['vertex', 'edge']);
    // Harbours: each dock sits on the midpoint of a coastal edge; its two corners get the ratio.
    this.portOfVertex = new Map(); // vertex id -> '3:1' | resource key
    for (const port of board.ports || []) {
      let best = null, bestD = Infinity;
      for (const e of this.graph.edges) {
        const d = Math.hypot(e.x - port.x, e.z - port.z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best && bestD < 0.2) {
        this.portOfVertex.set(best.a, port.type);
        this.portOfVertex.set(best.b, port.type);
        port.vertices = [best.a, best.b];
      }
    }
  }

  get player() { return this.players[this.current]; }

  playerOf(key) { return this.players.find((p) => p.key === key); }

  score(p) { return p.vp + (p.longest ? 2 : 0) + (p.army ? 2 : 0) + p.dev.vp; }

  /** Points everyone can see (victory point cards stay hidden until they win). */
  publicScore(p) { return p.vp + (p.longest ? 2 : 0) + (p.army ? 2 : 0); }

  /* ---------------------------------------------------------------- events, log, chat */

  /** Subscribe to game events: fn({ type, key, ...data }). */
  on(fn) { this.listeners.push(fn); }

  /** Emits an event to listeners, records it for mirrors and optionally writes a log line. */
  emit(type, data = {}, text = null) {
    const ev = { type, ...data };
    if (text) this.logLine(data.key || null, text, type);
    if (!this.mirror) this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
  }

  logLine(key, text, kind = 'info') {
    this.log.push({ n: this.turn, key, kind, text });
    if (this.log.length > 400) this.log.shift();
  }

  /** A chat line from a seat (or null for the system). */
  chat(key, text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    const who = key ? this.playerOf(key) : null;
    this.emit('chat', { key, text: clean }, `${who ? who.name : 'Game'}: ${clean}`);
    this.render();
  }

  /** Occasionally lets a bot comment on something that happened to it. */
  botSay(p, mood, chance = 0.35) {
    if (!p || !this.botOf(p) || this.mirror || Math.random() > chance) return;
    const lines = BOT_LINES[mood];
    if (!lines) return;
    const line = lines[Math.floor(Math.random() * lines.length)];
    setTimeout(() => { if (this.phase !== undefined) this.chat(p.key, line); }, 500 + Math.random() * 900);
  }

  pstat(key) { return this.stats.players[key]; }

  /* ---------------------------------------------------------------- seats */

  botOf(p) {
    const level = this.controllers[p.key];
    if (!(level in BOT_LEVELS)) return null;
    if (!this.bots[p.key] || this.bots[p.key].level !== level) this.bots[p.key] = makeBot(level);
    return this.bots[p.key];
  }

  /** Seat played by a person (on this device or remotely). */
  isHuman(p) { const c = this.controllers[p.key]; return c === 'human' || c === 'remote'; }

  /** Seat played by a person on this device. */
  isLocal(p) {
    if (this.me) return p.key === this.me;
    return this.controllers[p.key] === 'human';
  }

  get isHumanTurn() { return this.isHuman(this.player); }

  /** It is this device's turn to act. */
  get isMyTurn() { return this.isLocal(this.player) && this.isHuman(this.player); }

  setController(key, level) {
    if (!(level === 'human' || level in BOT_LEVELS)) return;
    this.controllers[key] = level;
    this.turnToken++; // stop a bot mid-turn if its seat changed hands
    this.botRunning = false;
    if (this.offer) this.resolveOffer();
    this.render();
    this.maybeRunBot();
  }

  /** Bot pacing: `f` units of thinking time, scaled by the speed setting. */
  pace(f = 1) { return this.botDelay * f * this.speed; }

  /* ---------------------------------------------------------------- opening placement (snake draft) */

  /**
   * Opening placement as in the real game: in turn order each player places a hut
   * (settlement) and a road touching it, then in reverse order a second pair, a snake draft
   * 1-2-3-4-4-3-2-1. The second hut pays out one card for each resource tile around it.
   */
  setup() {
    const n = this.players.length;
    this.setupOrder = [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n }, (_, i) => n - 1 - i)];
    this.setupIndex = 0;
    this.phase = 'setup';
    this.current = this.setupOrder[0];
    this.logLine(null, 'Opening: everyone places a hut and a road, then a second pair in reverse order.', 'turn');
    this.beginSetupTurn();
  }

  get setupRound() { return this.setupIndex < this.players.length ? 1 : 2; }

  /** Legal corners for an opening hut: free and two steps from any other building. */
  setupSpots() { return this.graph.verts.filter((v) => this.settlementSpotFree(v.id)).map((v) => v.id); }

  /** Legal edges for the opening road: free edges touching the hut just placed. */
  setupRoads() {
    if (this.setupVertex == null) return [];
    return this.pieces.edgesOfVertex(this.setupVertex).filter((e) => !this.pieces.edgeState.has(e.id)).map((e) => e.id);
  }

  beginSetupTurn() {
    const p = this.player;
    this.setupStep = 'settlement';
    this.setupVertex = null;
    this.pieces.pickKinds = new Set(['vertex']);
    const nth = this.setupRound === 1 ? 'first' : 'second';
    this.message = this.isMyTurn
      ? `${p.name}: place your ${nth} hut on a glowing corner${this.setupRound === 2 ? ' (it pays out the tiles around it)' : ''}.`
      : `${p.name} is placing their ${nth} hut...`;
    this.emit('turn', { key: p.key, setup: this.setupRound }, `Opening: ${p.name}, ${nth} hut`);
    this.startClock();
    this.render();
    this.maybeRunBot();
  }

  /** A pick during the opening: the hut first, then a road from it. */
  setupPick(hit) {
    const p = this.player;
    if (this.setupStep === 'settlement') {
      if (hit.kind !== 'vertex') return this.fail('Place your hut on a corner first.');
      if (!this.settlementSpotFree(hit.id)) return this.fail('Huts need a free corner at least two roads away from any other building.');
      this.pieces.placeSettlement(hit.id, p.key);
      p.vp += 1;
      this.pstat(p.key).settlements++;
      let gains = '';
      if (this.setupRound === 2) {
        const got = [];
        for (const t of this.graph.verts[hit.id].tiles) {
          const r = RESOURCE_OF[t.type];
          if (r) { p.hand[r] += 1; this.pstat(p.key).gained++; got.push(RESOURCE_ICON[r]); }
        }
        if (got.length) gains = ` and collected ${got.join(' ')}`;
      }
      this.setupVertex = hit.id;
      this.setupStep = 'road';
      this.pieces.pickKinds = new Set(['edge']);
      this.message = this.isMyTurn ? `Hut placed${gains}. Now a road touching it.` : `${p.name} placed a hut${gains}.`;
      this.emit('build', { key: p.key, kind: 'settlement', id: hit.id }, `${p.name} placed a hut${gains}.`);
      if (!this.setupRoads().length) return this.advanceSetup();
      return this.render();
    }
    if (hit.kind !== 'edge') return this.fail('Now place a road next to your new hut.');
    if (!this.setupRoads().includes(hit.id)) return this.fail('The road must touch the hut you just placed.');
    this.pieces.placeRoad(hit.id, p.key);
    this.pstat(p.key).roads++;
    this.emit('build', { key: p.key, kind: 'road', id: hit.id }, `${p.name} placed a road.`);
    this.advanceSetup();
  }

  advanceSetup() {
    this.turnToken++; // the bot that placed this pair is done
    this.botRunning = false;
    this.setupIndex++;
    if (this.setupIndex < this.setupOrder.length) {
      this.current = this.setupOrder[this.setupIndex];
      this.beginSetupTurn();
      return;
    }
    this.updateLongestRoad(); // fills in every player's road length
    this.setupVertex = null;
    this.current = 0;
    this.turn = 1;
    this.phase = 'roll';
    this.pieces.pickKinds = new Set(['vertex', 'edge']);
    this.logLine(null, 'Opening placement done. Let the game begin!', 'turn');
    this.message = `${this.player.name} starts. ${this.isMyTurn ? 'Roll the dice.' : ''}`;
    this.emit('turn', { key: this.player.key }, `Turn 1: ${this.player.name}`);
    this.startClock();
    this.render();
    this.maybeRunBot();
  }

  /** Candidate corners a bot (or the time-out helper) considers for an opening hut. */
  setupCandidates() {
    const free = this.setupSpots();
    const productive = free.filter((id) => this.graph.verts[id].tiles.filter((t) => t.number).length >= 2);
    return productive.length ? productive : free;
  }

  /** Places the current player's hut and/or road the way their bot (or a medium bot) would. */
  autoSetupStep() {
    const p = this.player;
    const helper = this.botOf(p) || makeBot('medium');
    if (this.phase === 'setup' && this.setupStep === 'settlement') {
      this.setupPick({ kind: 'vertex', id: helper.chooseSetupVertex(this, p, this.setupCandidates()) });
    }
    if (this.phase === 'setup' && this.setupStep === 'road' && this.player === p) {
      const roads = this.setupRoads().map((id) => this.graph.edges[id]);
      this.setupPick({ kind: 'edge', id: helper.chooseSetupRoad(this, p, this.setupVertex, roads).id });
    }
  }

  /** Runs the whole opening at once (automated tests, ?setup=auto). */
  autoSetup() {
    const run = this.maybeRunBot;
    this.maybeRunBot = () => {};
    if (this.phase !== 'setup') this.setup();
    for (let guard = 0; this.phase === 'setup' && guard < 60; guard++) this.autoSetupStep();
    this.maybeRunBot = run;
    this.maybeRunBot();
  }

  /* ---------------------------------------------------------------- rules */

  settlementSpotFree(vid) {
    if (this.pieces.vertexState.has(vid)) return false;
    for (const n of this.pieces.vertexNeighbors(vid)) if (this.pieces.vertexState.has(n)) return false;
    return true;
  }

  canPlaceSettlement(vid, key) {
    if (!this.settlementSpotFree(vid)) return false;
    return this.pieces.edgesOfVertex(vid).some((e) => this.pieces.edgeState.get(e.id)?.owner === key);
  }

  canPlaceRoad(eid, key) {
    if (this.pieces.edgeState.has(eid)) return false;
    const e = this.graph.edges[eid];
    for (const vid of [e.a, e.b]) {
      const vs = this.pieces.vertexState.get(vid);
      if (vs && vs.owner === key) return true;
      if (vs && vs.owner !== key) continue; // an opponent's settlement blocks the road through it
      if (this.pieces.edgesOfVertex(vid).some((o) => o.id !== eid && this.pieces.edgeState.get(o.id)?.owner === key)) return true;
    }
    return false;
  }

  canAfford(cost, p = this.player) {
    return Object.entries(cost).every(([r, n]) => p.hand[r] >= n);
  }

  pay(cost, p = this.player) {
    for (const [r, n] of Object.entries(cost)) p.hand[r] -= n;
  }

  /* ---------------------------------------------------------------- bank trading */

  /** Harbour types the player has settled next to. */
  portsOf(key) {
    const out = new Set();
    for (const [vid, s] of this.pieces.vertexState) {
      const t = this.portOfVertex.get(vid);
      if (t && s.owner === key) out.add(t);
    }
    return out;
  }

  /** How many of `resource` the player must give the bank for one card: 4, 3 or 2. */
  tradeRatio(resource, p = this.player) {
    const ports = this.portsOf(p.key);
    if (ports.has(resource)) return 2;
    if (ports.has('3:1')) return 3;
    return 4;
  }

  trade(give, get) {
    if (this.phase !== 'build') return this.fail('Trade after rolling, before ending your turn.');
    if (give === get) return this.fail('Pick two different resources.');
    const p = this.player;
    const ratio = this.tradeRatio(give, p);
    if (p.hand[give] < ratio) return this.fail(`${ratio}:1 trade needs ${ratio} ${give}.`);
    p.hand[give] -= ratio;
    p.hand[get] += 1;
    this.pstat(p.key).trades++;
    this.message = `${p.name} traded ${ratio} ${RESOURCE_ICON[give]} for 1 ${RESOURCE_ICON[get]} with the bank.`;
    this.emit('trade', { key: p.key, bank: true }, this.message);
    this.render();
  }

  /* ---------------------------------------------------------------- player trading */

  /**
   * The current player offers giveN x give for getN x get to everyone else. Bots answer
   * at once; humans get Accept / Decline buttons. The first acceptance closes the deal.
   * Resolves with the accepting player, or null.
   */
  proposeOffer(from, give, giveN, get, getN) {
    if (this.phase !== 'build' || from !== this.player) { this.fail('Offer trades after rolling, on your own turn.'); return Promise.resolve(null); }
    if (this.offer) { this.fail('An offer is already on the table.'); return Promise.resolve(null); }
    if (give === get) { this.fail('Pick two different resources.'); return Promise.resolve(null); }
    if (from.hand[give] < giveN) { this.fail(`You only have ${from.hand[give]} ${give}.`); return Promise.resolve(null); }
    return new Promise((resolve) => {
      const offer = { from, give, giveN, get, getN, responses: new Map(), resolve, timer: null };
      this.offer = offer;
      for (const q of this.players) {
        if (q === from) continue;
        const bot = this.botOf(q);
        if (q.hand[get] < getN) offer.responses.set(q.key, 'unable');
        else if (bot) offer.responses.set(q.key, bot.evaluateOffer(this, q, offer) ? 'accepted' : 'declined');
        else offer.responses.set(q.key, 'pending');
      }
      this.message = `${from.name} offers ${giveN} ${RESOURCE_ICON[give]} for ${getN} ${RESOURCE_ICON[get]}.`;
      this.logLine(from.key, this.message, 'offer');
      this.resolveOffer();
    });
  }

  respondOffer(key, accept) {
    const offer = this.offer;
    if (!offer || offer.responses.get(key) !== 'pending') return;
    offer.responses.set(key, accept ? 'accepted' : 'declined');
    this.resolveOffer();
  }

  withdrawOffer() {
    const offer = this.offer;
    if (!offer) return;
    for (const [k, r] of offer.responses) if (r === 'pending') offer.responses.set(k, 'declined');
    this.finishOffer(null, `${offer.from.name} withdrew the offer.`);
  }

  resolveOffer() {
    const offer = this.offer;
    if (!offer) return;
    const taker = this.players.find((q) => offer.responses.get(q.key) === 'accepted');
    if (taker) {
      offer.from.hand[offer.give] -= offer.giveN;
      offer.from.hand[offer.get] += offer.getN;
      taker.hand[offer.get] -= offer.getN;
      taker.hand[offer.give] += offer.giveN;
      this.pstat(offer.from.key).trades++;
      this.pstat(taker.key).trades++;
      this.botSay(taker, 'trade', 0.3);
      return this.finishOffer(taker, `${taker.name} accepted: ${offer.from.name} gave ${offer.giveN} ${RESOURCE_ICON[offer.give]} for ${offer.getN} ${RESOURCE_ICON[offer.get]}.`, true);
    }
    const pending = [...offer.responses.values()].includes('pending');
    if (!pending) return this.finishOffer(null, `Nobody took ${offer.from.name}'s offer.`);
    // A bot waits a limited time for a human's answer.
    if (this.botOf(offer.from) && !offer.timer) {
      offer.timer = setTimeout(() => {
        if (this.offer !== offer) return;
        for (const [k, r] of offer.responses) if (r === 'pending') offer.responses.set(k, 'declined');
        this.resolveOffer();
      }, Math.max(8000, this.botDelay * 16));
    }
    this.render();
  }

  finishOffer(taker, msg, traded = false) {
    const offer = this.offer;
    if (offer.timer) clearTimeout(offer.timer);
    this.offer = null;
    this.message = msg;
    if (traded) this.emit('trade', { key: offer.from.key, with: taker.key }, msg);
    else this.logLine(offer.from.key, msg, 'offer');
    this.render();
    offer.resolve(taker);
  }

  /* ---------------------------------------------------------------- longest road */

  /** Longest continuous road of one player; an opponent's settlement breaks the chain. */
  longestRoadFor(key) {
    const adj = new Map();
    for (const e of this.graph.edges) {
      if (this.pieces.edgeState.get(e.id)?.owner !== key) continue;
      for (const v of [e.a, e.b]) {
        if (!adj.has(v)) adj.set(v, []);
        adj.get(v).push(e);
      }
    }
    if (!adj.size) return 0;
    const blocked = (vid) => { const s = this.pieces.vertexState.get(vid); return !!s && s.owner !== key; };
    const used = new Set();
    let best = 0;
    const dfs = (vid, len) => {
      if (len > best) best = len;
      if (len > 0 && blocked(vid)) return;
      for (const e of adj.get(vid)) {
        if (used.has(e.id)) continue;
        used.add(e.id);
        dfs(e.a === vid ? e.b : e.a, len + 1);
        used.delete(e.id);
      }
    };
    for (const vid of adj.keys()) dfs(vid, 0);
    return best;
  }

  /** Re-evaluates the 2 VP longest-road bonus; returns a note when it changes hands. */
  updateLongestRoad() {
    for (const p of this.players) p.roadLength = this.longestRoadFor(p.key);
    const max = Math.max(...this.players.map((p) => p.roadLength));
    const holder = this.players.find((p) => p.longest) || null;
    const candidates = max >= 5 ? this.players.filter((p) => p.roadLength === max) : [];
    let next = holder;
    if (!holder || !candidates.includes(holder)) next = candidates.length === 1 ? candidates[0] : null;
    if (next === holder) return '';
    for (const p of this.players) p.longest = p === next;
    const note = next ? ` ${next.name} takes the longest road (${next.roadLength}).` : ` Nobody holds the longest road now.`;
    this.emit('award', { key: next ? next.key : null, award: 'road' }, note.trim());
    return note;
  }

  /* ---------------------------------------------------------------- turn flow */

  /** Throws the dice; production is paid out when they land (after rollDelay). */
  roll() {
    if (this.phase !== 'roll') return;
    const d1 = this.rand.int(6) + 1, d2 = this.rand.int(6) + 1;
    this.lastRoll = [d1, d2];
    this.phase = 'rolling';
    this.message = `${this.player.name} rolls...`;
    this.emit('roll', { key: this.player.key, d: [d1, d2] });
    if (this.rollDelay > 0) {
      const token = this.turnToken;
      this.render();
      this.rollTimer = setTimeout(() => { this.rollTimer = null; if (token === this.turnToken && this.phase === 'rolling') this.resolveRoll(); }, this.rollDelay);
    } else this.resolveRoll();
  }

  resolveRoll() {
    if (this.phase !== 'rolling') return;
    if (this.rollTimer) { clearTimeout(this.rollTimer); this.rollTimer = null; }
    const [d1, d2] = this.lastRoll;
    const total = d1 + d2;
    this.stats.rolls[total]++;
    const p = this.player;
    if (total === 7) {
      const discards = [];
      for (const q of this.players) {
        const n = handSize(q);
        if (n > 7) {
          let toDrop = Math.floor(n / 2);
          discards.push(`${q.name} -${toDrop}`);
          this.pstat(q.key).discarded += toDrop;
          const bot = this.botOf(q);
          while (toDrop > 0) {
            const r = bot ? bot.chooseDiscard(this, q) : this.rand.pick(RESOURCES.filter((k) => q.hand[k] > 0));
            q.hand[r] -= 1;
            toDrop--;
          }
        }
      }
      this.phase = 'robber';
      this.returnPhase = 'build';
      this.pieces.pickKinds = new Set(['tile']);
      this.message = `Rolled 7. ${discards.length ? discards.join(', ') + ' cards. ' : ''}${p.name}: ${this.isHumanTurn ? 'click a tile to move the robber.' : 'moving the robber...'}`;
      this.emit('rolled', { key: p.key, total }, `${p.name} rolled 7${discards.length ? ' (' + discards.join(', ') + ')' : ''}.`);
    } else {
      const gains = this.produce(total);
      this.phase = 'build';
      this.message = `Rolled ${total}. ${gains || 'Nothing produced.'} ${p.name} may build.`;
      this.emit('rolled', { key: p.key, total }, `${p.name} rolled ${total}. ${gains || 'Nothing produced.'}`);
    }
    this.render();
  }

  produce(number) {
    const gained = {};
    for (const [vid, state] of this.pieces.vertexState) {
      const v = this.graph.verts[vid];
      for (const t of v.tiles) {
        if (t.number !== number || t === this.board.robber.tile) continue;
        const r = RESOURCE_OF[t.type];
        if (!r) continue;
        const p = this.playerOf(state.owner);
        p.hand[r] += state.level;
        this.pstat(p.key).gained += state.level;
        gained[p.name] = (gained[p.name] || 0) + state.level;
      }
    }
    return Object.entries(gained).map(([n, c]) => `${n} +${c}`).join(', ');
  }

  moveRobber(tileIndex) {
    const info = this.board.tiles[tileIndex];
    if (!info || this.phase !== 'robber') return;
    if (info === this.board.robber.tile) return this.fail('The robber must move to a different tile.');
    this.board.robber.moveTo(tileIndex);
    const p = this.player;
    this.emit('robber', { key: p.key, tile: tileIndex });
    // steal one random card from a player with a piece on that tile
    const victims = new Set();
    for (const [vid, state] of this.pieces.vertexState) {
      if (state.owner !== p.key && this.graph.verts[vid].tiles.includes(info)) victims.add(state.owner);
    }
    let stolen = '';
    let logText = `${p.name} moved the robber.`;
    if (victims.size) {
      const victimKey = this.rand.pick([...victims]);
      const victim = this.playerOf(victimKey);
      const options = RESOURCES.filter((r) => victim.hand[r] > 0);
      if (options.length) {
        const r = this.rand.pick(options);
        victim.hand[r] -= 1;
        p.hand[r] += 1;
        this.pstat(p.key).stolen++;
        this.pstat(victim.key).lost++;
        stolen = ` Stole ${this.isLocal(p) || this.isLocal(victim) ? RESOURCE_ICON[r] + ' ' : 'a card '}from ${victim.name}.`;
        logText = `${p.name} moved the robber and stole a card from ${victim.name}.`;
        this.emit('steal', { key: p.key, from: victim.key });
        this.botSay(victim, 'robbed', 0.5);
        this.botSay(p, 'robber', 0.2);
      }
    }
    this.phase = this.returnPhase;
    this.pieces.pickKinds = new Set(['vertex', 'edge']);
    this.message = `Robber moved.${stolen} ${p.name} may ${this.phase === 'roll' ? 'roll' : 'build'}.`;
    this.logLine(p.key, logText, 'robber');
    this.render();
  }

  endTurn() {
    if (this.phase !== 'build') return;
    if (this.offer) this.withdrawOffer();
    this.turnToken++;
    this.botRunning = false;
    for (const k of Object.keys(DEV)) this.player.fresh[k] = 0; // cards bought this turn become playable
    this.devPlayed = false;
    this.current = (this.current + 1) % this.players.length;
    if (this.current === 0) this.turn++;
    this.phase = 'roll';
    this.lastRoll = null;
    this.message = `${this.player.name}'s turn. ${this.isMyTurn ? 'Roll the dice.' : ''}`;
    if (this.checkWin()) return; // e.g. longest road taken on someone else's turn
    this.emit('turn', { key: this.player.key }, `Turn ${this.turn}: ${this.player.name}`);
    this.startClock();
    this.render();
    this.maybeRunBot();
  }

  /* ---------------------------------------------------------------- development cards */

  buyDev() {
    if (this.phase !== 'build') return this.fail('Buy cards after rolling.');
    if (this.offer) return this.fail('Settle the trade offer first.');
    if (!this.deck.length) return this.fail('The development deck is empty.');
    const p = this.player;
    if (!this.canAfford(DEV_COST)) return this.fail('A development card costs ore + wool + grain.');
    this.pay(DEV_COST);
    const card = this.deck.pop();
    p.dev[card]++;
    p.fresh[card]++;
    this.pstat(p.key).cards++;
    this.message = `${p.name} bought a development card${this.isLocal(p) ? `: ${DEV_ICON[card]} ${DEV[card]}` : ''}.`;
    this.emit('buy', { key: p.key }, `${p.name} bought a development card.`);
    if (this.checkWin()) return;
    this.render();
  }

  canPlayDev(type, p = this.player) {
    if (type === 'vp' || !(type in DEV)) return false;
    if (!(this.phase === 'roll' || this.phase === 'build') || this.devPlayed || this.offer) return false;
    return p.dev[type] - p.fresh[type] > 0;
  }

  /**
   * Plays a card. `choice` lets bots pass their resource picks ([a, b] for year of plenty,
   * a resource key for monopoly); without it a human gets the chooser buttons.
   */
  playDev(type, choice) {
    if (!this.canPlayDev(type)) return this.fail(this.devPlayed ? 'Only one development card per turn.' : `You cannot play ${DEV[type] || type} now.`);
    const p = this.player;
    p.dev[type]--;
    this.devPlayed = true;
    this.returnPhase = this.phase;
    if (type === 'knight') {
      p.knights++;
      this.pstat(p.key).knights++;
      const note = this.updateLargestArmy();
      this.phase = 'robber';
      this.pieces.pickKinds = new Set(['tile']);
      this.message = `${p.name} played a knight (${p.knights}).${note} ${this.isMyTurn ? 'Click a tile to move the robber.' : ''}`;
    } else if (type === 'roads') {
      this.freeRoads = 2;
      if (!this.graph.edges.some((e) => this.canPlaceRoad(e.id, p.key))) {
        this.freeRoads = 0;
        this.message = `${p.name} played road building but has nowhere to build.`;
      } else {
        this.phase = 'freeroad';
        this.pieces.pickKinds = new Set(['edge']);
        this.message = `${p.name} played road building: place 2 free roads.`;
      }
    } else if (type === 'plenty') {
      if (choice) {
        for (const r of choice) p.hand[r] += 1;
        this.message = `${p.name} played year of plenty and took ${choice.map((r) => RESOURCE_ICON[r]).join(' ')}.`;
      } else {
        this.chooser = { kind: 'plenty', left: 2, taken: [] };
        this.phase = 'choose';
        this.message = `Year of plenty: pick 2 resources from the bank.`;
      }
    } else if (type === 'monopoly') {
      if (choice) this.monopolize(choice);
      else {
        this.chooser = { kind: 'monopoly' };
        this.phase = 'choose';
        this.message = `Monopoly: name a resource; everyone hands you all of theirs.`;
      }
    }
    this.emit(type === 'knight' ? 'knight' : 'card', { key: p.key, card: type }, `${p.name} played ${DEV[type].toLowerCase()}.`);
    if (this.checkWin()) return;
    this.render();
  }

  monopolize(r) {
    const p = this.player;
    let total = 0;
    for (const q of this.players) if (q !== p) { total += q.hand[r]; p.hand[r] += q.hand[r]; q.hand[r] = 0; }
    this.message = `${p.name} played monopoly on ${RESOURCE_ICON[r]} ${r} and collected ${total}.`;
    this.logLine(p.key, this.message, 'card');
  }

  /** Human resource pick for year of plenty / monopoly. */
  chooseResource(r) {
    if (this.phase !== 'choose' || !this.chooser || !RESOURCES.includes(r)) return;
    const c = this.chooser;
    if (c.kind === 'plenty') {
      this.player.hand[r] += 1;
      c.taken.push(r);
      if (--c.left > 0) { this.message = `Year of plenty: took ${RESOURCE_ICON[r]}, pick 1 more.`; return this.render(); }
      this.message = `${this.player.name} took ${c.taken.map((k) => RESOURCE_ICON[k]).join(' ')} from the bank.`;
      this.logLine(this.player.key, this.message, 'card');
    } else this.monopolize(r);
    this.chooser = null;
    this.phase = this.returnPhase;
    this.render();
  }

  skipFreeRoads() {
    if (this.phase !== 'freeroad') return;
    this.freeRoads = 0;
    this.phase = this.returnPhase;
    this.pieces.pickKinds = new Set(['vertex', 'edge']);
    this.render();
  }

  updateLargestArmy() {
    const max = Math.max(...this.players.map((p) => p.knights));
    const holder = this.players.find((p) => p.army) || null;
    if (max < 3) return '';
    const leaders = this.players.filter((p) => p.knights === max);
    if (holder && leaders.includes(holder)) return '';
    if (leaders.length !== 1) return '';
    for (const p of this.players) p.army = p === leaders[0];
    const note = ` ${leaders[0].name} takes the largest army (${max}).`;
    this.emit('award', { key: leaders[0].key, award: 'army' }, note.trim());
    return note;
  }

  /** Ends the game if the current player has reached the target; returns true when over. */
  checkWin() {
    const q = this.player;
    if (this.score(q) < WIN_VP) return false;
    this.phase = 'over';
    this.winner = q.key;
    this.turnToken++;
    this.turnEndsAt = null;
    this.offer = null;
    this.chooser = null;
    this.pieces.pickKinds = new Set();
    const hidden = q.dev.vp ? ` (${q.dev.vp} hidden victory point card${q.dev.vp > 1 ? 's' : ''})` : '';
    this.message = `${q.name} wins with ${this.score(q)} victory points${hidden}!`;
    this.emit('win', { key: q.key }, this.message);
    this.botSay(q, 'win', 0.9);
    for (const p of this.players) if (p !== q) this.botSay(p, 'lose', 0.4);
    this.render();
    return true;
  }

  /* ---------------------------------------------------------------- turn clock */

  startClock() {
    // clockHold: an online host waits until every player has loaded the board
    this.turnEndsAt = this.turnSeconds > 0 && this.phase !== 'over' && !this.clockHold ? performance.now() + this.turnSeconds * 1000 : null;
  }

  setTurnSeconds(sec) {
    this.turnSeconds = Math.max(0, sec | 0);
    this.startClock();
    this.renderClock(performance.now());
  }

  /** Stops the countdown while the page is hidden (app in background, tab switched). */
  pauseClock(paused) {
    const now = performance.now();
    if (paused) this.pausedAt = this.pausedAt || now;
    else if (this.pausedAt) {
      if (this.turnEndsAt) this.turnEndsAt += now - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  /** Called every frame: runs the countdown and finishes the turn when time is up. */
  tick(now = performance.now()) {
    if (this.pausedAt) return;
    this.renderClock(now);
    if (this.mirror) return; // the host decides when time is up
    if (this.turnEndsAt && now >= this.turnEndsAt) {
      this.turnEndsAt = null;
      this.timeUp();
    }
  }

  /** Out of time: finish whatever is pending with sensible defaults and pass the turn. */
  timeUp() {
    if (this.phase === 'over') return;
    const p = this.player;
    this.turnToken++; // stop a bot that is still thinking
    this.botRunning = false;
    if (this.offer) this.withdrawOffer();
    if (this.phase === 'setup') {
      this.logLine(p.key, `${p.name} ran out of time; their opening pieces were placed for them.`, 'timeout');
      this.autoSetupStep();
      return;
    }
    const helper = this.botOf(p) || makeBot('medium');
    for (let i = 0; i < 8 && this.phase !== 'build' && this.phase !== 'over'; i++) {
      if (this.phase === 'roll') { const d = this.rollDelay; this.rollDelay = 0; this.roll(); this.rollDelay = d; }
      else if (this.phase === 'rolling') this.resolveRoll();
      else if (this.phase === 'robber') this.moveRobber(helper.chooseRobber(this, p));
      else if (this.phase === 'choose') this.chooseResource(this.rand.pick(RESOURCES));
      else if (this.phase === 'freeroad') this.skipFreeRoads();
    }
    if (this.phase !== 'build') return;
    const note = `${p.name} ran out of time.`;
    this.logLine(p.key, note, 'timeout');
    this.endTurn();
    if (this.phase === 'over') return;
    this.message = `${note} ${this.message}`;
    this.render();
  }

  /** The active seat's countdown: a number plus an outline that shrinks around its panel. */
  renderClock(now) {
    const seats = this.ui && this.ui.seats;
    if (!seats) return;
    const left = this.turnEndsAt ? Math.max(0, this.turnEndsAt - now) : null;
    for (const p of this.players) {
      const el = seats[p.key];
      if (!el) continue;
      const rect = el.querySelector('.ring rect');
      const ring = el.querySelector('.ring');
      const clock = el.querySelector('.clock');
      if (p !== this.player || left === null) {
        if (rect.style.visibility !== 'hidden') rect.style.visibility = 'hidden';
        if (clock.textContent) clock.textContent = '';
        continue;
      }
      const w = el.offsetWidth, h = el.offsetHeight, r = 16;
      if (el._w !== w || el._h !== h) {
        el._w = w; el._h = h;
        rect.setAttribute('x', '1.5'); rect.setAttribute('y', '1.5');
        rect.setAttribute('width', String(Math.max(0, w - 1))); rect.setAttribute('height', String(Math.max(0, h - 1)));
        rect.setAttribute('rx', String(r)); rect.setAttribute('ry', String(r));
        el._perimeter = 2 * (w - 1 + h - 1) - 8 * r + 2 * Math.PI * r;
        rect.style.strokeDasharray = `${el._perimeter} ${el._perimeter}`;
      }
      rect.style.visibility = 'visible';
      rect.style.stroke = hex(p.key);
      const frac = left / (this.turnSeconds * 1000);
      rect.style.strokeDashoffset = String(el._perimeter * (1 - frac));
      const secs = Math.ceil(left / 1000);
      const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (clock.textContent !== text) {
        clock.textContent = text;
        if (secs <= 5 && secs > 0 && this.isMyTurn) this.emit('tick', {});
      }
      const low = secs <= 10;
      ring.classList.toggle('low', low);
      clock.classList.toggle('low', low);
    }
  }

  /* ---------------------------------------------------------------- bot turns */

  maybeRunBot() {
    if (this.mirror || this.phase === 'over' || this.botRunning || !this.botOf(this.player)) return;
    setTimeout(() => this.runBotTurn(), 0);
  }

  /**
   * One bot turn, paced so people can follow it: a pause when the turn starts, thinking
   * time before each action, a beat after it, and the dice landing before the robber.
   */
  async runBotTurn() {
    const p = this.player;
    const bot = this.botOf(p);
    if (!bot || this.botRunning || this.phase === 'over') return;
    this.botRunning = true;
    const token = ++this.turnToken;
    const alive = () => token === this.turnToken && this.player === p && this.phase !== 'over';
    const wait = (f = 1) => sleep(this.pace(f) * (0.8 + Math.random() * 0.4));
    const waitRoll = async () => { while (alive() && this.phase === 'rolling') await sleep(Math.max(30, this.rollDelay / 5)); };
    try {
      bot.startTurn();
      if (this.phase === 'setup') {
        await wait(1.3);
        if (!alive() || this.phase !== 'setup') return;
        this.setupPick({ kind: 'vertex', id: bot.chooseSetupVertex(this, p, this.setupCandidates()) });
        await wait(1.0);
        if (!alive() || this.phase !== 'setup' || this.setupStep !== 'road') return;
        const roads = this.setupRoads().map((id) => this.graph.edges[id]);
        this.setupPick({ kind: 'edge', id: bot.chooseSetupRoad(this, p, this.setupVertex, roads).id });
        return;
      }
      await wait(1.4); // turn change pause
      if (!alive()) return;
      if (this.phase === 'roll') { bot.preRoll(this, p); await waitRoll(); } // e.g. a knight to unblock its own tile
      if (!alive()) return;
      if (this.phase === 'roll') { this.roll(); await waitRoll(); }
      if (!alive()) return;
      if (this.phase === 'robber') {
        await wait(1.2);
        if (!alive()) return;
        this.moveRobber(bot.chooseRobber(this, p));
      }
      for (let n = 0; n < 12 && alive() && this.phase === 'build'; n++) {
        await wait(1.2); // thinking
        if (!alive()) break;
        const acted = await bot.act(this, p);
        if (!acted) break;
        await wait(0.5); // let the move sink in
      }
      if (alive() && this.phase === 'build') {
        await wait(0.8);
        if (alive()) { this.botRunning = false; this.endTurn(); }
      }
    } finally {
      if (token === this.turnToken) this.botRunning = false;
    }
  }

  /* ---------------------------------------------------------------- building */

  onPick(hit, button) {
    if (button === 2 || !hit) return;
    if (this.phase === 'setup') return this.setupPick(hit);
    if (this.phase === 'robber' && hit.kind === 'tile') return this.moveRobber(hit.id);
    if (this.phase === 'freeroad') {
      if (hit.kind !== 'edge') return this.fail('Place your free road on an edge.');
      if (!this.canPlaceRoad(hit.id, this.player.key)) return this.fail('Roads must connect to your roads or settlements.');
      this.pieces.placeRoad(hit.id, this.player.key);
      this.pstat(this.player.key).roads++;
      this.emit('build', { key: this.player.key, kind: 'road', id: hit.id }, `${this.player.name} placed a free road.`);
      const note = this.updateLongestRoad();
      this.freeRoads--;
      const more = this.freeRoads > 0 && this.graph.edges.some((e) => this.canPlaceRoad(e.id, this.player.key));
      this.message = `${this.player.name} placed a free road.${note}${more ? ' One more.' : ''}`;
      if (!more) { this.freeRoads = 0; this.phase = this.returnPhase; this.pieces.pickKinds = new Set(['vertex', 'edge']); }
      if (this.checkWin()) return;
      return this.render();
    }
    if (this.phase !== 'build') {
      if (this.phase === 'roll') this.fail('Roll the dice first.');
      return;
    }
    const p = this.player;
    if (hit.kind === 'vertex') {
      const state = this.pieces.vertexState.get(hit.id);
      if (state && state.owner === p.key && state.level === 1) {
        if (!this.canAfford(COSTS.city)) return this.fail('A city costs 3 ore + 2 grain.');
        this.pay(COSTS.city);
        this.pieces.placeCity(hit.id, p.key);
        p.vp += 1;
        this.pstat(p.key).cities++;
        this.message = `${p.name} built a city.`;
        this.emit('build', { key: p.key, kind: 'city', id: hit.id }, this.message);
        this.botSay(p, 'build', 0.15);
      } else if (!state) {
        if (!this.canPlaceSettlement(hit.id, p.key)) return this.fail('Settlements need a free corner two steps from others, on your road.');
        if (!this.canAfford(COSTS.settlement)) return this.fail('A settlement costs wood + brick + wool + grain.');
        this.pay(COSTS.settlement);
        this.pieces.placeSettlement(hit.id, p.key);
        p.vp += 1;
        this.pstat(p.key).settlements++;
        const port = this.portOfVertex.get(hit.id);
        this.message = `${p.name} built a settlement${port ? ` at a ${port === '3:1' ? '3:1' : '2:1 ' + port} harbour` : ''}.`;
        this.emit('build', { key: p.key, kind: 'settlement', id: hit.id }, this.message);
        this.message += this.updateLongestRoad(); // a settlement can cut an opponent's road
      } else return this.fail('That corner is taken.');
    } else if (hit.kind === 'edge') {
      if (!this.canPlaceRoad(hit.id, p.key)) return this.fail('Roads must connect to your roads or settlements.');
      if (!this.canAfford(COSTS.road)) return this.fail('A road costs wood + brick.');
      this.pay(COSTS.road);
      this.pieces.placeRoad(hit.id, p.key);
      this.pstat(p.key).roads++;
      this.message = `${p.name} built a road.`;
      this.emit('build', { key: p.key, kind: 'road', id: hit.id }, this.message);
      this.message += this.updateLongestRoad();
    }
    if (this.checkWin()) return;
    this.render();
  }

  fail(msg) {
    this.message = msg;
    for (const fn of this.listeners) fn({ type: 'error', text: msg });
    this.render();
  }

  /* ---------------------------------------------------------------- online: snapshots and intents */

  /** Full public state for mirrors (the server hides other seats' hands before relaying). */
  snapshot() {
    const o = this.offer;
    const snap = {
      seq: ++this.seq,
      players: this.players.map((p) => ({ key: p.key, name: p.name, hand: { ...p.hand }, vp: p.vp, longest: p.longest, roadLength: p.roadLength, dev: { ...p.dev }, fresh: { ...p.fresh }, knights: p.knights, army: p.army })),
      controllers: { ...this.controllers },
      current: this.current, turn: this.turn, phase: this.phase, returnPhase: this.returnPhase, lastRoll: this.lastRoll,
      message: this.message, deckCount: this.deck.length, devPlayed: this.devPlayed, freeRoads: this.freeRoads,
      chooser: this.chooser, winner: this.winner,
      setupOrder: this.setupOrder, setupIndex: this.setupIndex, setupStep: this.setupStep, setupVertex: this.setupVertex,
      offer: o ? { from: o.from.key, give: o.give, giveN: o.giveN, get: o.get, getN: o.getN, responses: [...o.responses] } : null,
      robber: this.board.tiles.indexOf(this.board.robber.tile),
      vertices: [...this.pieces.vertexState].map(([id, s]) => [id, s.owner, s.level]),
      edges: [...this.pieces.edgeState].map(([id, s]) => [id, s.owner]),
      turnLeft: this.turnEndsAt ? Math.max(0, this.turnEndsAt - performance.now()) : null,
      turnSeconds: this.turnSeconds,
      log: this.log.slice(-150), stats: this.stats,
      events: this.events,
    };
    this.events = [];
    return snap;
  }

  /** Mirror side: adopts a snapshot from the host, updating the board and replaying events. */
  applySnapshot(s) {
    if (!this.mirror || !s || s.seq <= this.seq) return;
    this.seq = s.seq;
    for (const sp of s.players) {
      const p = this.playerOf(sp.key);
      if (!p) continue;
      Object.assign(p, { name: sp.name, hand: sp.hand, vp: sp.vp, longest: sp.longest, roadLength: sp.roadLength, dev: sp.dev, fresh: sp.fresh, knights: sp.knights, army: sp.army, handCount: sp.handCount, devCount: sp.devCount });
    }
    Object.assign(this.controllers, s.controllers);
    Object.assign(this, { current: s.current, turn: s.turn, phase: s.phase, returnPhase: s.returnPhase, lastRoll: s.lastRoll, message: s.message, devPlayed: s.devPlayed, freeRoads: s.freeRoads, chooser: s.chooser, winner: s.winner, turnSeconds: s.turnSeconds });
    Object.assign(this, { setupOrder: s.setupOrder, setupIndex: s.setupIndex, setupStep: s.setupStep, setupVertex: s.setupVertex });
    this.deck = new Array(s.deckCount).fill('?');
    this.offer = s.offer ? { ...s.offer, from: this.playerOf(s.offer.from), responses: new Map(s.offer.responses) } : null;
    this.turnEndsAt = s.turnLeft == null ? null : performance.now() + s.turnLeft;
    // board pieces
    const pc = this.pieces;
    const verts = new Map(s.vertices.map(([id, owner, level]) => [id, { owner, level }]));
    for (const [id] of [...pc.vertexState]) if (!verts.has(id)) pc.removeVertex(id);
    for (const [id, v] of verts) {
      const cur = pc.vertexState.get(id);
      if (!cur || cur.owner !== v.owner || cur.level !== v.level) (v.level === 2 ? pc.placeCity(id, v.owner) : pc.placeSettlement(id, v.owner));
    }
    const edges = new Map(s.edges);
    for (const [id] of [...pc.edgeState]) if (!edges.has(id)) pc.removeEdge(id);
    for (const [id, owner] of edges) if (pc.edgeState.get(id)?.owner !== owner) pc.placeRoad(id, owner);
    if (s.robber >= 0 && this.board.tiles[s.robber] !== this.board.robber.tile) this.board.robber.moveTo(s.robber);
    pc.pickKinds = new Set(this.phase === 'robber' ? ['tile'] : this.phase === 'freeroad' ? ['edge']
      : this.phase === 'setup' ? [this.setupStep === 'road' ? 'edge' : 'vertex'] : ['vertex', 'edge']);
    this.log = s.log;
    this.stats = s.stats;
    for (const ev of s.events || []) for (const fn of this.listeners) fn(ev);
    this.render();
  }

  /**
   * Takes over as the authority from a full host snapshot (a host reloading the page, or
   * another player promoted after the host left). `deck` is the hidden card order.
   */
  restore(s, deck) {
    this.mirror = true;
    this.seq = (s.seq || 1) - 1; // keep counting from the saved snapshot so mirrors accept ours
    this.applySnapshot({ ...s, seq: s.seq || 1, events: [] });
    this.mirror = false;
    this.deck = Array.isArray(deck) && deck.length === s.deckCount ? deck.slice() : this.rand.shuffle(DEV_DECK.slice()).slice(0, s.deckCount);
    this.stats = s.stats;
    this.log = s.log;
    if (this.phase === 'rolling') this.resolveRoll();
    if (this.phase === 'setup') this.pieces.pickKinds = new Set([this.setupStep === 'road' ? 'edge' : 'vertex']);
    if (this.offer) { this.offer.resolve = () => {}; this.withdrawOffer(); }
    this.startClock();
    if (s.turnLeft != null) this.turnEndsAt = performance.now() + s.turnLeft;
    this.render();
    this.maybeRunBot();
  }

  /** Host side: applies a move sent by a remote seat, after checking it is theirs to make. */
  applyIntent(seat, name, args = []) {
    const p = this.playerOf(seat);
    if (!p || this.controllers[seat] !== 'remote' || this.phase === 'over') return;
    if (name === 'chat') return this.chat(seat, args[0]);
    if (name === 'loaded') return this.onLoaded && this.onLoaded(seat);
    if (name === 'respondOffer') return this.respondOffer(seat, !!args[1]);
    if (this.player !== p) return; // everything else happens on your own turn
    switch (name) {
      case 'roll': return this.roll();
      case 'endTurn': return this.endTurn();
      case 'trade': return this.trade(args[0], args[1]);
      case 'proposeOffer': return this.proposeOffer(p, args[0], +args[1] || 1, args[2], +args[3] || 1);
      case 'withdrawOffer': return this.withdrawOffer();
      case 'buyDev': return this.buyDev();
      case 'playDev': return this.playDev(args[0]);
      case 'chooseResource': return this.chooseResource(args[0]);
      case 'skipFreeRoads': return this.skipFreeRoads();
      case 'onPick': return this.onPick(args[0], 0);
      default:
    }
  }

  /* ---------------------------------------------------------------- UI */

  /** The seat whose hand the dock shows. */
  get viewer() {
    if (this.me) return this.playerOf(this.me);
    if (this.isMyTurn) return this.player;
    return this.players.find((p) => this.controllers[p.key] === 'human') || null;
  }

  seatBodyHtml(p) {
    const color = hex(p.key);
    const level = this.controllers[p.key];
    const online = !!this.me || this.mirror;
    const seatOptions = ['human', ...Object.keys(BOT_LEVELS)]
      .map((l) => `<option value="${l}"${level === l ? ' selected' : ''}>${l === 'human' ? 'Human' : BOT_LEVELS[l]}</option>`).join('');
    const ports = [...this.portsOf(p.key)].map((t) => (t === '3:1' ? '3:1' : `2:1 ${t}`));
    const cards = p.handCount ?? handSize(p);
    const devCount = p.devCount ?? Object.values(p.dev).reduce((a, b) => a + b, 0);
    const shown = this.phase === 'over' ? this.score(p) : this.publicScore(p);
    const stats = [
      `<span title="Resource cards">${ICONS.cards}${cards}</span>`,
      `<span title="Development cards">${ICONS.dev}${devCount}</span>`,
      `<span class="${p.longest ? 'award' : ''}" title="Road length${p.longest ? ': longest road (+2)' : ''}">${ICONS.road}${p.roadLength}</span>`,
      p.knights || p.army ? `<span class="${p.army ? 'award' : ''}" title="Knights played${p.army ? ': largest army (+2)' : ''}">${ICONS.shield}${p.knights}</span>` : '',
      ports.length ? `<span title="Harbours: ${ports.join(', ')}">${ICONS.anchor}${ports.length}</span>` : '',
    ].join('');
    const role = online
      ? `<div class="ctrl-label">${level === 'remote' || level === 'human' ? (p.key === this.me ? 'You' : 'Player') : BOT_LEVELS[level]}</div>`
      : `<select class="ctrl" data-key="${p.key}" title="Who plays ${esc(p.name)}">${seatOptions}</select>`;
    return `<div class="seat-top">
        <div class="avatar" style="--pc:${color}">${avatarSvg(p.key, PLAYER_COLORS[p.key])}${level in BOT_LEVELS ? '<span class="bot">BOT</span>' : ''}</div>
        <div class="who"><div class="name">${esc(p.name)}</div>${role}</div>
        <div class="vp" title="Victory points"><b>${shown}</b><small>VP</small></div>
      </div>
      <div class="stats">${stats}</div>`;
  }

  render() {
    if (this.onState && !this.mirror) this.onState();
    if (!this.ui) return;
    const { seats, hand, dice, message, rollBtn, endBtn, giveSel, getSel, tradeBtn, offerBox, offerBtn, giveN, getN, buyBtn, cards, chooser, cardCount } = this.ui;
    if (seats) {
      for (const p of this.players) {
        const el = seats[p.key];
        if (!el) continue;
        el.classList.toggle('current', p === this.player && this.phase !== 'over');
        el.classList.toggle('winner', this.winner === p.key);
        const html = this.seatBodyHtml(p);
        if (this.seatHtml[p.key] !== html) {
          this.seatHtml[p.key] = html;
          el.querySelector('.seat-body').innerHTML = html;
        }
      }
    }
    if (hand) {
      const v = this.viewer;
      const RC = { wood: '#3f7a3a', brick: '#b3522f', wool: '#8fbf5a', grain: '#d9a936', ore: '#7c8791' };
      const html = v
        ? `<span class="whose" style="--pc:${hex(v.key)}"><i></i>${esc(v.name)}</span>` +
          RESOURCES.map((r) => `<span class="rc${v.hand[r] ? '' : ' zero'}" style="--rc:${RC[r]}" title="${r}">${RESOURCE_ICON[r]}<b>${v.hand[r]}</b></span>`).join('')
        : '';
      if (hand.innerHTML !== html) hand.innerHTML = html;
    }
    if (dice) {
      const landed = this.lastRoll && this.phase !== 'rolling';
      const key = this.lastRoll ? this.lastRoll.join('+') + ':' + this.current + ':' + (landed ? 'l' : 'r') : '';
      if (dice.dataset.key !== key) {
        dice.dataset.key = key;
        dice.innerHTML = landed ? dieHtml(this.lastRoll[0]) + dieHtml(this.lastRoll[1]) : dieHtml(0) + dieHtml(0);
        dice.classList.toggle('rolling', !!this.lastRoll && !landed);
        dice.classList.remove('rolled');
        if (landed) { void dice.offsetWidth; dice.classList.add('rolled'); }
        dice.title = landed ? `Rolled ${this.lastRoll[0] + this.lastRoll[1]}` : 'Not rolled yet';
      }
    }
    message.textContent = this.message;
    const mine = this.isMyTurn;
    rollBtn.disabled = !mine || this.phase !== 'roll' || !!this.offer;
    endBtn.disabled = !mine || this.phase !== 'build' || !!this.offer;
    if (giveSel && getSel && tradeBtn) {
      const p = this.viewer || this.player;
      const keepGive = giveSel.value || 'wood', keepGet = getSel.value || 'brick';
      const giveHtml = RESOURCES.map((r) => `<option value="${r}" title="${r}">${RESOURCE_ICON[r]} ${r} · ${this.tradeRatio(r, p)}:1</option>`).join('');
      if (giveSel.dataset.html !== giveHtml) { giveSel.innerHTML = giveHtml; giveSel.dataset.html = giveHtml; giveSel.value = keepGive; }
      if (!getSel.options.length) { getSel.innerHTML = RESOURCES.map((r) => `<option value="${r}">${RESOURCE_ICON[r]} ${r}</option>`).join(''); getSel.value = keepGet; }
      const ratio = this.tradeRatio(giveSel.value, p);
      tradeBtn.textContent = `Bank ${ratio}:1`;
      tradeBtn.disabled = !mine || this.phase !== 'build' || !!this.offer || giveSel.value === getSel.value || p.hand[giveSel.value] < ratio;
      if (offerBtn) {
        const gn = Math.max(1, +giveN.value || 1);
        offerBtn.disabled = !mine || this.phase !== 'build' || !!this.offer || giveSel.value === getSel.value || p.hand[giveSel.value] < gn;
      }
    }
    if (offerBox) { const h = this.offerHtml(); if (offerBox.innerHTML !== h) offerBox.innerHTML = h; }
    if (buyBtn) {
      buyBtn.textContent = `Buy card ⛰️🐑🌾 · ${this.deck.length} left`;
      buyBtn.disabled = !mine || this.phase !== 'build' || !!this.offer || !this.deck.length || !this.canAfford(DEV_COST);
    }
    if (cards) { const h = this.cardsHtml(); if (cards.innerHTML !== h) cards.innerHTML = h; }
    if (cardCount) {
      const v = this.viewer;
      cardCount.textContent = v ? String(Object.values(v.dev).reduce((a, b) => a + b, 0)) : '0';
    }
    if (chooser) { const h = this.chooserHtml(); if (chooser.innerHTML !== h) chooser.innerHTML = h; }
    this.pieces.setHints(this.hintSpots(), hex(this.player.key));
    if (this.ui.onRender) this.ui.onRender(this);
    this.renderClock(performance.now());
  }

  /** Corners / edges to highlight for the player on this device (opening and free roads). */
  hintSpots() {
    if (!this.isMyTurn) return { vertices: [], edges: [] };
    if (this.phase === 'setup') {
      return this.setupStep === 'settlement' ? { vertices: this.setupSpots(), edges: [] } : { vertices: [], edges: this.setupRoads() };
    }
    if (this.phase === 'freeroad') return { vertices: [], edges: this.graph.edges.filter((e) => this.canPlaceRoad(e.id, this.player.key)).map((e) => e.id) };
    return { vertices: [], edges: [] };
  }

  /** The viewer's development cards as play buttons. */
  cardsHtml() {
    const p = this.viewer;
    if (!p) return '';
    const mine = this.isMyTurn && p === this.player;
    const parts = [];
    for (const k of ['knight', 'roads', 'plenty', 'monopoly']) {
      if (!p.dev[k]) continue;
      const fresh = p.fresh[k] ? ` <small>(${p.fresh[k]} new)</small>` : '';
      parts.push(`<button class="btn" data-play="${k}"${mine && this.canPlayDev(k) ? '' : ' disabled'} title="${DEV[k]}">${DEV_ICON[k]} ${DEV[k]} ×${p.dev[k]}${fresh}</button>`);
    }
    if (p.dev.vp) parts.push(`<span class="vpcards" title="Hidden victory points">${DEV_ICON.vp} Victory point ×${p.dev.vp}</span>`);
    return parts.join('');
  }

  chooserHtml() {
    if (this.phase !== 'choose' || !this.chooser || !this.isMyTurn) return '';
    const title = this.chooser.kind === 'plenty' ? `Take ${this.chooser.left} from the bank` : 'Monopoly: choose a resource';
    const picks = RESOURCES.map((r) => `<button class="btn" data-res="${r}" title="${r}">${RESOURCE_ICON[r]}</button>`).join('');
    return `<div>${title}</div><div class="pick">${picks}</div>`;
  }

  offerHtml() {
    const o = this.offer;
    if (!o) return '';
    const rows = this.players.filter((q) => q !== o.from).map((q) => {
      const r = o.responses.get(q.key);
      const label = { accepted: 'accepted', declined: 'declined', unable: `has no ${RESOURCE_ICON[o.get]}`, pending: 'thinking...' }[r];
      const buttons = r === 'pending' && this.isLocal(q)
        ? `<button class="btn primary" data-respond="${q.key}" data-accept="1">Accept</button><button class="btn" data-respond="${q.key}" data-accept="0">Decline</button>`
        : `<span class="reply">${label}</span>`;
      return `<div class="offer-row"><span>${esc(q.name)}</span>${buttons}</div>`;
    });
    const withdraw = this.isLocal(o.from) && this.isHuman(o.from) ? '<button class="btn" data-withdraw="1">Withdraw</button>' : '';
    return `<div class="offer-title">${esc(o.from.name)} offers ${o.giveN} ${RESOURCE_ICON[o.give]} for ${o.getN} ${RESOURCE_ICON[o.get]}</div>${rows.join('')}${withdraw}`;
  }
}
