// AI opponents at three levels. Bots act only through the public Game API (roll, onPick,
// trade, proposeOffer, moveRobber), so they follow exactly the same rules as a human.
//
//   easy   – random legal moves, no planning, accepts trades on a coin flip.
//   medium – values corners by dice pips, builds settlement > city > road, trades with the
//            bank to finish a build, accepts trades it needs.
//   hard   – weights corners by resources it lacks and by harbours, plans roads toward
//            the best reachable corner, offers 1:1 trades before paying the bank, uses its
//            harbour ratios, targets the leader with the robber and refuses to feed them.
import { RESOURCES, COSTS, RESOURCE_OF, PIPS, DEV_COST, handSize, missing } from './rules.js';

export const BOT_LEVELS = { easy: 'Easy bot', medium: 'Medium bot', hard: 'Hard bot' };

export function makeBot(level) {
  return new Bot(level);
}

const pips = (tile) => (tile.number ? PIPS[tile.number] : 0);

export class Bot {
  constructor(level) {
    this.level = level;
    this.offersThisTurn = 0;
  }

  startTurn() {
    this.offersThisTurn = 0;
  }

  /* ---------------------------------------------------------------- evaluation */

  /** Pips produced per resource by the player's current pieces. */
  producedBy(game, p) {
    const out = {};
    for (const [vid, s] of game.pieces.vertexState) {
      if (s.owner !== p.key) continue;
      for (const t of game.graph.verts[vid].tiles) {
        const r = RESOURCE_OF[t.type];
        if (r && t.number) out[r] = (out[r] || 0) + pips(t) * s.level;
      }
    }
    return out;
  }

  /** How attractive a corner is for this player. */
  vertexValue(game, p, vid) {
    const v = game.graph.verts[vid];
    const have = this.level === 'hard' ? this.producedBy(game, p) : {};
    let val = 0;
    const kinds = new Set();
    for (const t of v.tiles) {
      const r = RESOURCE_OF[t.type];
      if (!r || !t.number) continue;
      const w = this.level === 'hard' ? 1 + 1 / (1 + (have[r] || 0)) : 1;
      val += pips(t) * w;
      kinds.add(r);
    }
    if (this.level === 'hard') {
      val += kinds.size * 0.8;
      const port = game.portOfVertex.get(vid);
      if (port) val += port === '3:1' ? 1.2 : have[port] ? 2.5 : 1;
    } else if (this.level === 'medium') val += kinds.size * 0.4;
    return val;
  }

  /** Weight of each resource by how much the next build wants it. */
  needs(game, p) {
    const w = {};
    const plan = this.plan(game, p);
    for (const [r, n] of Object.entries(plan.cost)) if (p.hand[r] < n) w[r] = 1 + (n - p.hand[r]) * 0.5;
    for (const r of RESOURCES) if (!(r in w)) w[r] = p.hand[r] >= 3 ? 0.15 : 0.5;
    return w;
  }

  /* ---------------------------------------------------------------- setup */

  chooseSetupVertex(game, p, candidates) {
    if (this.level === 'easy') return game.rand.pick(candidates);
    let best = null, bestV = -1;
    for (const vid of candidates) {
      const v = this.vertexValue(game, p, vid) + game.rand() * 0.01;
      if (v > bestV) { bestV = v; best = vid; }
    }
    return best;
  }

  /** Road pointing toward the best free corner two steps away. */
  chooseSetupRoad(game, p, vid, edges) {
    if (this.level === 'easy') return game.rand.pick(edges);
    let best = edges[0], bestV = -1;
    for (const e of edges) {
      const other = e.a === vid ? e.b : e.a;
      let v = 0;
      for (const e2 of game.pieces.edgesOfVertex(other)) {
        const far = e2.a === other ? e2.b : e2.a;
        if (far !== vid && game.settlementSpotFree(far)) v = Math.max(v, this.vertexValue(game, p, far));
      }
      if (v > bestV) { bestV = v; best = e; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- robber & discards */

  chooseRobber(game, p) {
    const tiles = game.board.tiles;
    const options = tiles.map((_, i) => i).filter((i) => tiles[i] !== game.board.robber.tile);
    if (this.level === 'easy') return game.rand.pick(options);
    const others = game.players.filter((q) => q !== p);
    const leader = others.slice().sort((a, b) => game.score(b) - game.score(a))[0];
    let best = options[0], bestV = -Infinity;
    for (const i of options) {
      const t = tiles[i];
      let v = t.type === 'desert' ? -1 : 0;
      let mine = false;
      for (const [vid, s] of game.pieces.vertexState) {
        if (!game.graph.verts[vid].tiles.includes(t)) continue;
        if (s.owner === p.key) { mine = true; continue; }
        const q = game.players.find((x) => x.key === s.owner);
        let w = pips(t) * s.level;
        if (this.level === 'hard') w *= (q === leader ? 1.6 : 1) * (handSize(q) ? 1.2 : 0.7);
        v += w;
      }
      if (mine) v -= this.level === 'hard' ? 6 : 100;
      if (v > bestV) { bestV = v; best = i; }
    }
    return best;
  }

  /** Resource to throw away on a 7: the one the plan wants least. */
  chooseDiscard(game, p) {
    const held = RESOURCES.filter((r) => p.hand[r] > 0);
    if (this.level === 'easy') return game.rand.pick(held);
    const w = this.needs(game, p);
    return held.sort((a, b) => w[a] - w[b] || p.hand[b] - p.hand[a])[0];
  }

  /* ---------------------------------------------------------------- trade offers */

  /** offer.from gives `give` x giveN and wants `get` x getN from this player. */
  evaluateOffer(game, p, offer) {
    if (p.hand[offer.get] < offer.getN) return false;
    if (this.level === 'easy') return offer.giveN > offer.getN || game.rand() < 0.5;
    const need = this.needs(game, p);
    const gain = (need[offer.give] || 0.3) * offer.giveN;
    const loss = (need[offer.get] || 0.3) * offer.getN + (p.hand[offer.get] - offer.getN < 1 ? 0.3 : 0);
    if (this.level === 'hard') {
      if (game.score(offer.from) >= 8) return false; // never help someone about to win
      if (game.score(offer.from) >= game.score(p) + 2) return gain > loss * 1.8;
    }
    return gain > loss;
  }

  /* ---------------------------------------------------------------- planning */

  bestSettlement(game, p) {
    let best = null;
    for (const v of game.graph.verts) {
      if (!game.canPlaceSettlement(v.id, p.key)) continue;
      const value = this.vertexValue(game, p, v.id);
      if (!best || value > best.value) best = { vid: v.id, value };
    }
    return best;
  }

  bestCity(game, p) {
    let best = null;
    for (const [vid, s] of game.pieces.vertexState) {
      if (s.owner !== p.key || s.level !== 1) continue;
      const value = game.graph.verts[vid].tiles.reduce((a, t) => a + (RESOURCE_OF[t.type] ? pips(t) : 0), 0);
      if (!best || value > best.value) best = { vid, value };
    }
    return best;
  }

  /**
   * Next road to build: the first free edge on the cheapest path from the player's network
   * to a free legal corner (hard weighs corner value against distance). Falls back to any
   * legal edge that extends the road outward.
   */
  bestRoad(game, p) {
    const g = game.graph, pc = game.pieces;
    const dist = new Map(), first = new Map();
    const queue = [];
    const seed = (vid) => { if (!dist.has(vid)) { dist.set(vid, 0); first.set(vid, null); queue.push(vid); } };
    for (const [vid, s] of pc.vertexState) if (s.owner === p.key) seed(vid);
    for (const [eid, s] of pc.edgeState) if (s.owner === p.key) { seed(g.edges[eid].a); seed(g.edges[eid].b); }
    const done = new Set();
    while (queue.length) {
      queue.sort((a, b) => dist.get(a) - dist.get(b));
      const v = queue.shift();
      if (done.has(v)) continue;
      done.add(v);
      const vs = pc.vertexState.get(v);
      if (vs && vs.owner !== p.key) continue; // an opponent's settlement blocks the path
      for (const e of pc.edgesOfVertex(v)) {
        const es = pc.edgeState.get(e.id);
        if (es && es.owner !== p.key) continue;
        const o = e.a === v ? e.b : e.a;
        const nd = dist.get(v) + (es ? 0 : 1);
        if (nd < (dist.has(o) ? dist.get(o) : Infinity)) {
          dist.set(o, nd);
          first.set(o, es ? first.get(v) : first.get(v) ?? e.id);
          queue.push(o);
        }
      }
    }
    let best = null, bestS = -Infinity;
    for (const [vid, d] of dist) {
      if (d === 0 || first.get(vid) == null || !game.settlementSpotFree(vid)) continue;
      const val = this.vertexValue(game, p, vid);
      const s = this.level === 'hard' ? val / (d + 0.5) : -d + val * 0.01;
      if (s > bestS) { bestS = s; best = { eid: first.get(vid), vid, steps: d }; }
    }
    if (best && game.canPlaceRoad(best.eid, p.key)) return best;
    const legal = g.edges.filter((e) => game.canPlaceRoad(e.id, p.key));
    if (!legal.length) return null;
    if (this.level === 'easy') return { eid: game.rand.pick(legal).id, vid: null, steps: 1 };
    // extend outward: prefer an edge whose far end has none of our roads yet
    const outward = legal.filter((e) => [e.a, e.b].some((v) => !pc.edgesOfVertex(v).some((o) => o.id !== e.id && pc.edgeState.get(o.id)?.owner === p.key)));
    return { eid: game.rand.pick(outward.length ? outward : legal).id, vid: null, steps: 1 };
  }

  /** What to build next: { kind, cost, target }. */
  plan(game, p) {
    const settle = this.bestSettlement(game, p);
    const city = this.bestCity(game, p);
    if (settle && (!city || this.level !== 'hard' || settle.value >= city.value * 0.8)) return { kind: 'settlement', cost: COSTS.settlement, target: settle.vid };
    if (city) return { kind: 'city', cost: COSTS.city, target: city.vid };
    const road = this.bestRoad(game, p);
    return { kind: 'road', cost: COSTS.road, target: road ? road.eid : null };
  }

  altPlan(game, p, kind) {
    if (kind === 'settlement') { const s = this.bestSettlement(game, p); return s && { kind, cost: COSTS.settlement, target: s.vid }; }
    if (kind === 'city') { const c = this.bestCity(game, p); return c && { kind, cost: COSTS.city, target: c.vid }; }
    const r = this.bestRoad(game, p);
    return r && { kind, cost: COSTS.road, target: r.eid };
  }

  execute(game, plan) {
    game.onPick({ kind: plan.kind === 'road' ? 'edge' : 'vertex', id: plan.target }, 0);
  }

  /** Resources held beyond what the plan needs, best trade fodder first. */
  spare(game, p, cost) {
    return RESOURCES.map((r) => ({ r, n: p.hand[r] - (cost[r] || 0), ratio: game.tradeRatio(r, p) }))
      .filter((s) => s.n > 0)
      .sort((a, b) => (this.level === 'hard' ? b.n / b.ratio - a.n / a.ratio : b.n - a.n));
  }

  /* ---------------------------------------------------------------- development cards */

  /** Is the robber sitting on a tile one of this player's pieces touches? */
  robberBlocksMe(game, p) {
    const t = game.board.robber.tile;
    for (const [vid, s] of game.pieces.vertexState) if (s.owner === p.key && game.graph.verts[vid].tiles.includes(t)) return true;
    return false;
  }

  /** Would one more knight take (or keep) the largest army? */
  knightWorthIt(game, p) {
    const next = p.knights + 1;
    if (next < 3) return false;
    const holder = game.players.find((q) => q.army);
    if (holder === p) return false;
    return game.players.every((q) => q === p || q.knights < next);
  }

  /** Before rolling: play a knight to unblock a productive tile. */
  preRoll(game, p) {
    if (this.level === 'easy' || !game.canPlayDev('knight', p)) return;
    if (this.robberBlocksMe(game, p)) {
      game.playDev('knight');
      if (game.phase === 'robber') game.moveRobber(this.chooseRobber(game, p));
    }
  }

  /** Plays at most one card if it helps. Returns true when a card was played. */
  playCard(game, p) {
    if (game.devPlayed) return false;
    const playable = ['knight', 'roads', 'plenty', 'monopoly'].filter((k) => game.canPlayDev(k, p));
    if (!playable.length) return false;
    if (this.level === 'easy') {
      if (game.rand() > 0.4) return false;
      const k = game.rand.pick(playable);
      if (k === 'plenty') game.playDev(k, [game.rand.pick(RESOURCES), game.rand.pick(RESOURCES)]);
      else if (k === 'monopoly') game.playDev(k, game.rand.pick(RESOURCES));
      else game.playDev(k);
      this.finishCard(game, p);
      return true;
    }
    const plan = this.plan(game, p);
    const miss = missing(p, plan.cost);
    const missCount = Object.values(miss).reduce((a, b) => a + b, 0);
    if (playable.includes('knight') && (this.robberBlocksMe(game, p) || (this.level === 'hard' && this.knightWorthIt(game, p)) || (this.level === 'hard' && p.dev.knight - p.fresh.knight >= 2))) {
      game.playDev('knight');
    } else if (playable.includes('roads') && (plan.kind === 'road' || this.level === 'hard' || game.rand() < 0.5)) {
      game.playDev('roads');
    } else if (playable.includes('plenty') && missCount > 0 && missCount <= 2) {
      const picks = [];
      for (const [r, n] of Object.entries(miss)) for (let i = 0; i < n && picks.length < 2; i++) picks.push(r);
      while (picks.length < 2) picks.push(Object.keys(plan.cost)[0]);
      game.playDev('plenty', picks);
    } else if (playable.includes('monopoly')) {
      const others = game.players.filter((q) => q !== p);
      const total = (r) => others.reduce((a, q) => a + q.hand[r], 0);
      let best = null, bestV = 0;
      for (const r of RESOURCES) {
        const v = total(r) * (miss[r] ? 1.5 : this.level === 'hard' ? 1 : 0.4);
        if (v > bestV) { bestV = v; best = r; }
      }
      if (best && bestV >= (this.level === 'hard' ? 3 : 2)) game.playDev('monopoly', best);
      else return false;
    } else return false;
    this.finishCard(game, p);
    return true;
  }

  /** Completes the interactive part of a card (robber move, free roads). */
  finishCard(game, p) {
    if (game.phase === 'robber') game.moveRobber(this.chooseRobber(game, p));
    let guard = 0;
    while (game.phase === 'freeroad' && guard++ < 3) {
      const r = this.bestRoad(game, p);
      if (!r) { game.skipFreeRoads(); break; }
      game.onPick({ kind: 'edge', id: r.eid }, 0);
    }
  }

  /** Buys a card when it cannot build and has the cards to spare. */
  tryBuy(game, p) {
    if (!game.deck.length || !game.canAfford(DEV_COST, p)) return false;
    const chance = { easy: 0.3, medium: 0.5, hard: 0.85 }[this.level];
    if (this.level === 'hard') {
      // don't burn the last ore/grain of a city that is one card away
      const city = this.bestCity(game, p);
      if (city) { const m = missing(p, COSTS.city); if (Object.values(m).reduce((a, b) => a + b, 0) === 1) return false; }
    }
    if (game.rand() > chance) return false;
    game.buyDev();
    return true;
  }

  /* ---------------------------------------------------------------- one action */

  /** Performs one build, trade or card play. Returns false when the bot is done for the turn. */
  async act(game, p) {
    if (this.level === 'easy') return this.actEasy(game, p);
    if (this.playCard(game, p)) return true;
    const plan = this.plan(game, p);
    if (plan.target == null) return this.tryBuy(game, p);
    const miss = missing(p, plan.cost);
    if (!Object.keys(miss).length) { this.execute(game, plan); return true; }
    const want = Object.keys(miss).sort((a, b) => miss[b] - miss[a])[0];
    const spare = this.spare(game, p, plan.cost);
    if (!spare.length) return this.tryCheaperBuild(game, p, plan);
    // Hard bots ask the table for a 1:1 swap before paying the bank.
    if (this.level === 'hard' && this.offersThisTurn < 2 && spare[0].ratio > 2) {
      this.offersThisTurn++;
      const accepted = await game.proposeOffer(p, spare[0].r, 1, want, 1);
      if (accepted) return true;
    }
    for (const s of spare) if (s.n >= s.ratio) { game.trade(s.r, want); return true; }
    return this.tryCheaperBuild(game, p, plan);
  }

  tryCheaperBuild(game, p, plan) {
    if (this.level === 'hard') {
      for (const kind of ['city', 'settlement', 'road']) {
        if (kind === plan.kind) continue;
        const alt = this.altPlan(game, p, kind);
        if (alt && alt.target != null && game.canAfford(alt.cost, p)) { this.execute(game, alt); return true; }
      }
    }
    return this.tryBuy(game, p);
  }

  actEasy(game, p) {
    if (game.rand() < 0.25) return false; // sometimes it just stops
    if (this.playCard(game, p)) return true;
    const options = [];
    const s = this.bestSettlement(game, p);
    const legalSpots = game.graph.verts.filter((v) => game.canPlaceSettlement(v.id, p.key));
    if (s && game.canAfford(COSTS.settlement, p)) options.push({ kind: 'settlement', cost: COSTS.settlement, target: game.rand.pick(legalSpots).id });
    const c = this.bestCity(game, p);
    if (c && game.canAfford(COSTS.city, p)) options.push({ kind: 'city', cost: COSTS.city, target: c.vid });
    const r = this.bestRoad(game, p);
    if (r && game.canAfford(COSTS.road, p)) options.push({ kind: 'road', cost: COSTS.road, target: r.eid });
    if (options.length) { this.execute(game, game.rand.pick(options)); return true; }
    // occasionally dump a big pile of one resource at the bank
    const pile = RESOURCES.find((k) => p.hand[k] >= game.tradeRatio(k, p) + 1);
    if (pile && game.rand() < 0.5) {
      const want = game.rand.pick(RESOURCES.filter((k) => k !== pile && p.hand[k] === 0));
      if (want) { game.trade(pile, want); return true; }
    }
    return this.tryBuy(game, p);
  }
}
