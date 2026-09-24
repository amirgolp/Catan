// Four-player game loop: opening placement, dice, resource production, build costs,
// placement rules, robber on a 7, bank / harbour / player trading, longest road,
// victory points. Any seat can be a human or an AI bot. Rendering is delegated to Pieces.
import { PLAYER_COLORS } from './pieces.js';
import { RESOURCES, RESOURCE_OF, RESOURCE_ICON, COSTS, WIN_VP, handSize, DEV, DEV_COST, DEV_DECK, DEV_ICON } from './rules.js';
import { makeBot, BOT_LEVELS } from './bots.js';
import { avatarSvg, ICONS, dieHtml } from './avatars.js';

export { RESOURCES, COSTS };

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const emptyHand = () => Object.fromEntries(RESOURCES.map((r) => [r, 0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Game {
  constructor({ board, pieces, rand, ui, controllers, turnSeconds = 90 }) {
    this.board = board;
    this.pieces = pieces;
    this.graph = board.graph;
    this.rand = rand;
    this.ui = ui;
    const emptyDev = () => Object.fromEntries(Object.keys(DEV).map((k) => [k, 0]));
    this.players = Object.keys(PLAYER_COLORS).map((key) => ({
      key, name: cap(key), hand: emptyHand(), vp: 0, longest: false, roadLength: 0,
      dev: emptyDev(), fresh: emptyDev(), knights: 0, army: false, // fresh = bought this turn, not playable yet
    }));
    this.deck = rand.shuffle(DEV_DECK.slice());
    this.devPlayed = false; // one development card per turn
    this.freeRoads = 0; // road-building card in progress
    this.chooser = null; // { kind: 'plenty' | 'monopoly', left } while a human picks resources
    this.returnPhase = 'build'; // phase to go back to after a robber move / free roads / chooser
    this.controllers = { red: 'human', blue: 'easy', white: 'medium', orange: 'hard', ...(controllers || {}) };
    this.bots = {};
    this.botDelay = 500; // ms between bot actions so a human can follow along
    this.turnToken = 0; // bumped whenever a bot turn must stop (turn ended, seat changed)
    this.botRunning = false;
    this.offer = null; // pending player-to-player trade
    this.current = 0;
    this.phase = 'roll'; // 'roll' | 'build' | 'robber' | 'over'
    this.lastRoll = null;
    this.message = '';
    this.turnSeconds = turnSeconds; // 0 = no turn clock
    this.turnEndsAt = null; // performance.now() deadline of the current turn
    this.pausedAt = 0;
    this.seatHtml = {}; // last rendered markup per seat, to skip needless DOM rewrites
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

  score(p) { return p.vp + (p.longest ? 2 : 0) + (p.army ? 2 : 0) + p.dev.vp; }

  /** Points everyone can see (victory point cards stay hidden until they win). */
  publicScore(p) { return p.vp + (p.longest ? 2 : 0) + (p.army ? 2 : 0); }

  /* ---------------------------------------------------------------- seats */

  botOf(p) {
    const level = this.controllers[p.key];
    if (level === 'human') return null;
    if (!this.bots[p.key] || this.bots[p.key].level !== level) this.bots[p.key] = makeBot(level);
    return this.bots[p.key];
  }

  get isHumanTurn() { return !this.botOf(this.player); }

  setController(key, level) {
    if (!(level === 'human' || level in BOT_LEVELS)) return;
    this.controllers[key] = level;
    this.turnToken++; // stop a bot mid-turn if its seat changed hands
    this.botRunning = false;
    if (this.offer) this.resolveOffer();
    this.render();
    this.maybeRunBot();
  }

  /* ---------------------------------------------------------------- setup */

  /** Opening placement: two settlements and two roads each; the second settlement pays out. */
  setup() {
    const g = this.graph;
    const order = [...this.players, ...this.players.slice().reverse()];
    const chooser = (p) => this.botOf(p) || makeBot('medium'); // humans get a sensible auto-placement
    order.forEach((p, i) => {
      const free = g.verts.filter((v) => v.tiles.length >= 2 && this.settlementSpotFree(v.id));
      const productive = free.filter((v) => v.tiles.filter((t) => t.number).length >= 2);
      const candidates = (productive.length ? productive : free).map((v) => v.id);
      if (!candidates.length) return;
      const vid = chooser(p).chooseSetupVertex(this, p, candidates);
      this.pieces.placeSettlement(vid, p.key);
      p.vp += 1;
      const roads = this.pieces.edgesOfVertex(vid).filter((e) => !this.pieces.edgeState.has(e.id));
      if (roads.length) this.pieces.placeRoad(chooser(p).chooseSetupRoad(this, p, vid, roads).id, p.key);
      if (i >= this.players.length) {
        for (const t of g.verts[vid].tiles) {
          const r = RESOURCE_OF[t.type];
          if (r) p.hand[r] += 1;
        }
      }
    });
    this.updateLongestRoad(); // fills in every player's road length
    this.message = `${this.player.name} starts. Roll the dice.`;
    this.startClock();
    this.render();
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
    this.message = `${p.name} traded ${ratio} ${RESOURCE_ICON[give]} for 1 ${RESOURCE_ICON[get]} with the bank.`;
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
      return this.finishOffer(taker, `${taker.name} accepted: ${offer.from.name} gave ${offer.giveN} ${RESOURCE_ICON[offer.give]} for ${offer.getN} ${RESOURCE_ICON[offer.get]}.`);
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

  finishOffer(taker, msg) {
    const offer = this.offer;
    if (offer.timer) clearTimeout(offer.timer);
    this.offer = null;
    this.message = msg;
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
    return next ? ` ${next.name} takes the longest road (${next.roadLength}).` : ` Nobody holds the longest road now.`;
  }

  /* ---------------------------------------------------------------- turn flow */

  roll() {
    if (this.phase !== 'roll') return;
    const d1 = this.rand.int(6) + 1, d2 = this.rand.int(6) + 1;
    const total = d1 + d2;
    this.lastRoll = [d1, d2];
    if (total === 7) {
      const discards = [];
      for (const p of this.players) {
        const n = handSize(p);
        if (n > 7) {
          let toDrop = Math.floor(n / 2);
          discards.push(`${p.name} -${toDrop}`);
          const bot = this.botOf(p);
          while (toDrop > 0) {
            const r = bot ? bot.chooseDiscard(this, p) : this.rand.pick(RESOURCES.filter((k) => p.hand[k] > 0));
            p.hand[r] -= 1;
            toDrop--;
          }
        }
      }
      this.phase = 'robber';
      this.returnPhase = 'build';
      this.pieces.pickKinds = new Set(['tile']);
      this.message = `Rolled 7. ${discards.length ? discards.join(', ') + ' cards. ' : ''}${this.player.name}: ${this.isHumanTurn ? 'click a tile to move the robber.' : 'moving the robber...'}`;
    } else {
      const gains = this.produce(total);
      this.phase = 'build';
      this.message = `Rolled ${total}. ${gains || 'Nothing produced.'} ${this.player.name} may build.`;
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
        const p = this.players.find((pl) => pl.key === state.owner);
        p.hand[r] += state.level;
        gained[p.name] = (gained[p.name] || 0) + state.level;
      }
    }
    return Object.entries(gained).map(([n, c]) => `${n} +${c}`).join(', ');
  }

  moveRobber(tileIndex) {
    const info = this.board.tiles[tileIndex];
    if (info === this.board.robber.tile) {
      this.message = 'The robber must move to a different tile.';
      this.render();
      return;
    }
    this.board.robber.moveTo(tileIndex);
    // steal one random card from a player with a piece on that tile
    const victims = new Set();
    for (const [vid, state] of this.pieces.vertexState) {
      if (state.owner !== this.player.key && this.graph.verts[vid].tiles.includes(info)) victims.add(state.owner);
    }
    let stolen = '';
    if (victims.size) {
      const victimKey = this.rand.pick([...victims]);
      const victim = this.players.find((p) => p.key === victimKey);
      const options = RESOURCES.filter((r) => victim.hand[r] > 0);
      if (options.length) {
        const r = this.rand.pick(options);
        victim.hand[r] -= 1;
        this.player.hand[r] += 1;
        stolen = ` Stole ${RESOURCE_ICON[r]} from ${victim.name}.`;
      }
    }
    this.phase = this.returnPhase;
    this.pieces.pickKinds = new Set(['vertex', 'edge']);
    this.message = `Robber moved.${stolen} ${this.player.name} may ${this.phase === 'roll' ? 'roll' : 'build'}.`;
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
    this.phase = 'roll';
    this.lastRoll = null;
    this.message = `${this.player.name}'s turn. ${this.isHumanTurn ? 'Roll the dice.' : ''}`;
    if (this.checkWin()) return; // e.g. longest road taken on someone else's turn
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
    this.message = `${p.name} bought a development card${this.isHumanTurn ? `: ${DEV_ICON[card]} ${DEV[card]}` : ''}.`;
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
      const note = this.updateLargestArmy();
      this.phase = 'robber';
      this.pieces.pickKinds = new Set(['tile']);
      this.message = `${p.name} played a knight (${p.knights}).${note} ${this.isHumanTurn ? 'Click a tile to move the robber.' : ''}`;
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
    if (this.checkWin()) return;
    this.render();
  }

  monopolize(r) {
    const p = this.player;
    let total = 0;
    for (const q of this.players) if (q !== p) { total += q.hand[r]; p.hand[r] += q.hand[r]; q.hand[r] = 0; }
    this.message = `${p.name} played monopoly on ${RESOURCE_ICON[r]} ${r} and collected ${total}.`;
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
    return ` ${leaders[0].name} takes the largest army (${max}).`;
  }

  /** Ends the game if the current player has reached the target; returns true when over. */
  checkWin() {
    const q = this.player;
    if (this.score(q) < WIN_VP) return false;
    this.phase = 'over';
    this.turnToken++;
    this.turnEndsAt = null;
    this.offer = null;
    this.chooser = null;
    this.pieces.pickKinds = new Set();
    const hidden = q.dev.vp ? ` (${q.dev.vp} hidden victory point card${q.dev.vp > 1 ? 's' : ''})` : '';
    this.message = `${q.name} wins with ${this.score(q)} victory points${hidden}!`;
    this.render();
    return true;
  }

  /* ---------------------------------------------------------------- turn clock */

  startClock() {
    this.turnEndsAt = this.turnSeconds > 0 && this.phase !== 'over' ? performance.now() + this.turnSeconds * 1000 : null;
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
    const helper = this.botOf(p) || makeBot('medium');
    for (let i = 0; i < 8 && this.phase !== 'build' && this.phase !== 'over'; i++) {
      if (this.phase === 'roll') this.roll();
      else if (this.phase === 'robber') this.moveRobber(helper.chooseRobber(this, p));
      else if (this.phase === 'choose') this.chooseResource(this.rand.pick(RESOURCES));
      else if (this.phase === 'freeroad') this.skipFreeRoads();
    }
    if (this.phase !== 'build') return;
    const note = `${p.name} ran out of time.`;
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
      rect.style.stroke = '#' + PLAYER_COLORS[p.key].toString(16).padStart(6, '0');
      const frac = left / (this.turnSeconds * 1000);
      rect.style.strokeDashoffset = String(el._perimeter * (1 - frac));
      const secs = Math.ceil(left / 1000);
      const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (clock.textContent !== text) clock.textContent = text;
      const low = secs <= 10;
      ring.classList.toggle('low', low);
      clock.classList.toggle('low', low);
    }
  }

  /* ---------------------------------------------------------------- bot turns */

  maybeRunBot() {
    if (this.phase === 'over' || this.botRunning || !this.botOf(this.player)) return;
    setTimeout(() => this.runBotTurn(), 0);
  }

  async runBotTurn() {
    const p = this.player;
    const bot = this.botOf(p);
    if (!bot || this.botRunning || this.phase === 'over') return;
    this.botRunning = true;
    const token = ++this.turnToken;
    const alive = () => token === this.turnToken && this.player === p && this.phase !== 'over';
    const wait = (f = 1) => sleep(this.botDelay * f);
    try {
      bot.startTurn();
      await wait();
      if (!alive()) return;
      if (this.phase === 'roll') bot.preRoll(this, p); // e.g. a knight to unblock its own tile
      if (this.phase === 'roll') this.roll();
      if (this.phase === 'robber') {
        await wait();
        if (!alive()) return;
        this.moveRobber(bot.chooseRobber(this, p));
      }
      for (let n = 0; n < 12 && alive() && this.phase === 'build'; n++) {
        await wait(0.8);
        if (!alive()) break;
        const acted = await bot.act(this, p);
        if (!acted) break;
      }
      if (alive() && this.phase === 'build') {
        await wait();
        if (alive()) { this.botRunning = false; this.endTurn(); }
      }
    } finally {
      if (token === this.turnToken) this.botRunning = false;
    }
  }

  /* ---------------------------------------------------------------- building */

  onPick(hit, button) {
    if (button === 2) return;
    if (this.phase === 'robber' && hit.kind === 'tile') return this.moveRobber(hit.id);
    if (this.phase === 'freeroad') {
      if (hit.kind !== 'edge') return this.fail('Place your free road on an edge.');
      if (!this.canPlaceRoad(hit.id, this.player.key)) return this.fail('Roads must connect to your roads or settlements.');
      this.pieces.placeRoad(hit.id, this.player.key);
      const note = this.updateLongestRoad();
      this.freeRoads--;
      const more = this.freeRoads > 0 && this.graph.edges.some((e) => this.canPlaceRoad(e.id, this.player.key));
      this.message = `${this.player.name} placed a free road.${note}${more ? ' One more.' : ''}`;
      if (!more) { this.freeRoads = 0; this.phase = this.returnPhase; this.pieces.pickKinds = new Set(['vertex', 'edge']); }
      if (this.checkWin()) return;
      return this.render();
    }
    if (this.phase !== 'build') {
      this.message = this.phase === 'roll' ? 'Roll the dice first.' : this.message;
      this.render();
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
        this.message = `${p.name} built a city.`;
      } else if (!state) {
        if (!this.canPlaceSettlement(hit.id, p.key)) return this.fail('Settlements need a free corner two steps from others, on your road.');
        if (!this.canAfford(COSTS.settlement)) return this.fail('A settlement costs wood + brick + wool + grain.');
        this.pay(COSTS.settlement);
        this.pieces.placeSettlement(hit.id, p.key);
        p.vp += 1;
        const port = this.portOfVertex.get(hit.id);
        this.message = `${p.name} built a settlement${port ? ` at a ${port === '3:1' ? '3:1' : '2:1 ' + port} harbour` : ''}.`;
        this.message += this.updateLongestRoad(); // a settlement can cut an opponent's road
      } else return this.fail('That corner is taken.');
    } else if (hit.kind === 'edge') {
      if (!this.canPlaceRoad(hit.id, p.key)) return this.fail('Roads must connect to your roads or settlements.');
      if (!this.canAfford(COSTS.road)) return this.fail('A road costs wood + brick.');
      this.pay(COSTS.road);
      this.pieces.placeRoad(hit.id, p.key);
      this.message = `${p.name} built a road.` + this.updateLongestRoad();
    }
    if (this.checkWin()) return;
    this.render();
  }

  fail(msg) {
    this.message = msg;
    this.render();
  }

  /* ---------------------------------------------------------------- UI */

  /** The seat whose hand the dock shows: the current player if human, else the first human seat. */
  get viewer() {
    if (this.isHumanTurn) return this.player;
    return this.players.find((p) => this.controllers[p.key] === 'human') || null;
  }

  seatBodyHtml(p) {
    const color = '#' + PLAYER_COLORS[p.key].toString(16).padStart(6, '0');
    const level = this.controllers[p.key];
    const seatOptions = ['human', ...Object.keys(BOT_LEVELS)]
      .map((l) => `<option value="${l}"${level === l ? ' selected' : ''}>${l === 'human' ? 'Human' : BOT_LEVELS[l]}</option>`).join('');
    const ports = [...this.portsOf(p.key)].map((t) => (t === '3:1' ? '3:1' : `2:1 ${t}`));
    const devCount = Object.values(p.dev).reduce((a, b) => a + b, 0);
    const shown = this.phase === 'over' ? this.score(p) : this.publicScore(p);
    const stats = [
      `<span title="Resource cards">${ICONS.cards}${handSize(p)}</span>`,
      `<span title="Development cards">${ICONS.dev}${devCount}</span>`,
      `<span class="${p.longest ? 'award' : ''}" title="Road length${p.longest ? ': longest road (+2)' : ''}">${ICONS.road}${p.roadLength}</span>`,
      p.knights || p.army ? `<span class="${p.army ? 'award' : ''}" title="Knights played${p.army ? ': largest army (+2)' : ''}">${ICONS.shield}${p.knights}</span>` : '',
      ports.length ? `<span title="Harbours: ${ports.join(', ')}">${ICONS.anchor}${ports.length}</span>` : '',
    ].join('');
    return `<div class="seat-top">
        <div class="avatar" style="--pc:${color}">${avatarSvg(p.key, PLAYER_COLORS[p.key])}${level !== 'human' ? '<span class="bot">BOT</span>' : ''}</div>
        <div class="who"><div class="name">${p.name}</div><select class="ctrl" data-key="${p.key}" title="Who plays ${p.name}">${seatOptions}</select></div>
        <div class="vp" title="Victory points"><b>${shown}</b><small>VP</small></div>
      </div>
      <div class="stats">${stats}</div>`;
  }

  render() {
    if (!this.ui) return;
    const { seats, hand, dice, message, rollBtn, endBtn, giveSel, getSel, tradeBtn, offerBox, offerBtn, giveN, getN, buyBtn, cards, chooser, cardCount } = this.ui;
    if (seats) {
      for (const p of this.players) {
        const el = seats[p.key];
        if (!el) continue;
        el.classList.toggle('current', p === this.player && this.phase !== 'over');
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
        ? `<span class="whose" style="--pc:#${PLAYER_COLORS[v.key].toString(16).padStart(6, '0')}"><i></i>${v.name}</span>` +
          RESOURCES.map((r) => `<span class="rc${v.hand[r] ? '' : ' zero'}" style="--rc:${RC[r]}" title="${r}">${RESOURCE_ICON[r]}<b>${v.hand[r]}</b></span>`).join('')
        : '';
      if (hand.innerHTML !== html) hand.innerHTML = html;
    }
    if (dice) {
      const key = this.lastRoll ? this.lastRoll.join('+') + ':' + this.current : '';
      if (dice.dataset.key !== key) {
        dice.dataset.key = key;
        dice.innerHTML = this.lastRoll ? dieHtml(this.lastRoll[0]) + dieHtml(this.lastRoll[1]) : dieHtml(0) + dieHtml(0);
        dice.classList.remove('rolled');
        if (this.lastRoll) { void dice.offsetWidth; dice.classList.add('rolled'); }
        dice.title = this.lastRoll ? `Rolled ${this.lastRoll[0] + this.lastRoll[1]}` : 'Not rolled yet';
      }
    }
    message.textContent = this.message;
    const human = this.isHumanTurn;
    rollBtn.disabled = !human || this.phase !== 'roll' || !!this.offer;
    endBtn.disabled = !human || this.phase !== 'build' || !!this.offer;
    if (giveSel && getSel && tradeBtn) {
      const p = this.player;
      const keepGive = giveSel.value || 'wood', keepGet = getSel.value || 'brick';
      giveSel.innerHTML = RESOURCES.map((r) => `<option value="${r}" title="${r}">${RESOURCE_ICON[r]} ${r} · ${this.tradeRatio(r, p)}:1</option>`).join('');
      getSel.innerHTML = RESOURCES.map((r) => `<option value="${r}">${RESOURCE_ICON[r]} ${r}</option>`).join('');
      giveSel.value = keepGive;
      getSel.value = keepGet;
      const ratio = this.tradeRatio(giveSel.value, p);
      tradeBtn.textContent = `Bank ${ratio}:1`;
      tradeBtn.disabled = !human || this.phase !== 'build' || !!this.offer || giveSel.value === getSel.value || p.hand[giveSel.value] < ratio;
      if (offerBtn) {
        const gn = Math.max(1, +giveN.value || 1);
        offerBtn.disabled = !human || this.phase !== 'build' || !!this.offer || giveSel.value === getSel.value || p.hand[giveSel.value] < gn;
      }
    }
    if (offerBox) offerBox.innerHTML = this.offerHtml();
    if (buyBtn) {
      buyBtn.textContent = `Buy card ⛰️🐑🌾 · ${this.deck.length} left`;
      buyBtn.disabled = !human || this.phase !== 'build' || !!this.offer || !this.deck.length || !this.canAfford(DEV_COST);
    }
    if (cards) cards.innerHTML = this.cardsHtml();
    if (cardCount) {
      const v = this.viewer;
      cardCount.textContent = v ? String(Object.values(v.dev).reduce((a, b) => a + b, 0)) : '0';
    }
    if (chooser) chooser.innerHTML = this.chooserHtml();
    this.renderClock(performance.now());
  }

  /** The current human's development cards as play buttons. */
  cardsHtml() {
    const p = this.player;
    if (!this.isHumanTurn) return '';
    const parts = [];
    for (const k of ['knight', 'roads', 'plenty', 'monopoly']) {
      if (!p.dev[k]) continue;
      const fresh = p.fresh[k] ? ` <small>(${p.fresh[k]} new)</small>` : '';
      parts.push(`<button class="btn" data-play="${k}"${this.canPlayDev(k) ? '' : ' disabled'} title="${DEV[k]}">${DEV_ICON[k]} ${DEV[k]} ×${p.dev[k]}${fresh}</button>`);
    }
    if (p.dev.vp) parts.push(`<span class="vpcards" title="Hidden victory points">${DEV_ICON.vp} Victory point ×${p.dev.vp}</span>`);
    return parts.join('');
  }

  chooserHtml() {
    if (this.phase !== 'choose' || !this.chooser || !this.isHumanTurn) return '';
    const title = this.chooser.kind === 'plenty' ? `Take ${this.chooser.left} from the bank` : 'Monopoly: choose a resource';
    const picks = RESOURCES.map((r) => `<button class="btn" data-res="${r}" title="${r}">${RESOURCE_ICON[r]}</button>`).join('');
    return `<div>${title}</div><div class="pick">${picks}</div>`;
  }

  offerHtml() {
    const o = this.offer;
    if (!o) return '';
    const rows = this.players.filter((q) => q !== o.from).map((q) => {
      const r = o.responses.get(q.key);
      const label = { accepted: 'accepted', declined: 'declined', unable: `has no ${RESOURCE_ICON[o.get]}` }[r];
      const buttons = r === 'pending'
        ? `<button class="btn primary" data-respond="${q.key}" data-accept="1">Accept</button><button class="btn" data-respond="${q.key}" data-accept="0">Decline</button>`
        : `<span class="reply">${label}</span>`;
      return `<div class="offer-row"><span>${q.name}</span>${buttons}</div>`;
    });
    const withdraw = this.botOf(o.from) ? '' : '<button class="btn" data-withdraw="1">Withdraw</button>';
    return `<div class="offer-title">${o.from.name} offers ${o.giveN} ${RESOURCE_ICON[o.give]} for ${o.getN} ${RESOURCE_ICON[o.get]}</div>${rows.join('')}${withdraw}`;
  }
}
