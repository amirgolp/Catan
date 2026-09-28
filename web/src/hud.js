// Game HUD extras driven by game events: sound effects, the 3D dice toss, the turn banner,
// the chat / log / stats drawer and the end-of-game summary.
import { PLAYER_COLORS } from './pieces.js';
import { avatarSvg, ICONS } from './avatars.js';
import { play as sfx } from './sound.js';
import { handSize, PIPS } from './rules.js';

const hex = (key) => (key && PLAYER_COLORS[key] !== undefined ? '#' + PLAYER_COLORS[key].toString(16).padStart(6, '0') : '#f4f1ea');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

export class Hud {
  /**
   * @param {object} o
   *   game, dice (DiceRoller), sendChat(text) – how a typed chat line is delivered,
   *   onLeave(), onRematch() – end-of-game buttons
   */
  constructor({ game, dice, sendChat, onLeave, onRematch }) {
    this.game = game;
    this.dice = dice;
    this.sendChat = sendChat;
    this.onLeave = onLeave;
    this.onRematch = onRematch;
    this.chatLines = [];
    this.unread = 0;
    this.pane = null;
    this.bannerTimer = null;
    game.on((ev) => this.onEvent(ev));
    this.wire();
  }

  /* ---------------------------------------------------------------- events */

  onEvent(ev) {
    const g = this.game;
    const p = ev.key ? g.playerOf(ev.key) : null;
    switch (ev.type) {
      case 'roll':
        sfx('dice');
        if (this.dice) this.dice.throw(ev.d, Math.max(0.6, g.rollDelay / 1000 - 0.1));
        break;
      case 'build': sfx(ev.kind === 'city' ? 'city' : ev.kind === 'settlement' ? 'settlement' : 'road'); break;
      case 'robber': sfx('robber'); break;
      case 'steal': sfx('steal', 0.5); break;
      case 'trade': sfx('trade'); break;
      case 'buy': sfx('buy'); break;
      case 'card': sfx('card'); break;
      case 'knight': sfx('knight'); break;
      case 'award': sfx('turn', 0.3); break;
      case 'error': sfx('error'); break;
      case 'tick': sfx('tick'); break;
      case 'turn':
        if (p) {
          const mine = g.isLocal(p) && g.isHuman(p);
          if (mine) sfx('turn');
          const solo = g.me || Object.values(g.controllers).filter((c) => c === 'human').length <= 1;
          if (ev.setup) {
            const nth = ev.setup === 1 ? 'first' : 'second';
            this.banner(mine && solo ? `Place your ${nth} hut` : `${p.name}: ${nth} hut`, p.key);
          } else this.banner(mine && solo ? 'Your turn' : `${p.name}'s turn`, p.key);
        }
        break;
      case 'chat':
        this.addChat({ key: ev.key, name: p ? p.name : 'Game', text: ev.text });
        break;
      case 'win': {
        const local = p && g.isLocal(p) && g.isHuman(p);
        const anyLocal = g.players.some((q) => g.isLocal(q) && g.isHuman(q));
        sfx(local || !anyLocal ? 'win' : 'lose');
        setTimeout(() => this.showEnd(), 1400);
        break;
      }
      default:
    }
    if (this.pane === 'log') this.renderLog();
    if (this.pane === 'stats') this.renderStats();
  }

  banner(text, key) {
    const el = $('banner');
    if (!el) return;
    el.style.setProperty('--pc', hex(key));
    el.querySelector('span').textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /* ---------------------------------------------------------------- drawer */

  wire() {
    for (const b of document.querySelectorAll('#drawerToggle [data-pane]')) b.addEventListener('click', () => this.open(this.pane === b.dataset.pane ? null : b.dataset.pane));
    for (const b of document.querySelectorAll('#drawer [data-tab]')) b.addEventListener('click', () => this.open(b.dataset.tab));
    $('drawer').querySelector('.close').addEventListener('click', () => this.open(null));
    $('chatForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.sendChat(text);
    });
    for (const b of document.querySelectorAll('#chatForm [data-emo]')) b.addEventListener('click', () => this.sendChat(b.dataset.emo));
    // typing in chat must not trigger game shortcuts or orbit controls
    $('chatInput').addEventListener('keydown', (ev) => ev.stopPropagation());
  }

  open(pane) {
    this.pane = pane;
    $('drawer').classList.toggle('open', !!pane);
    for (const b of document.querySelectorAll('#drawer [data-tab]')) b.classList.toggle('on', b.dataset.tab === pane);
    for (const el of document.querySelectorAll('#drawer .pane')) el.classList.toggle('on', el.dataset.pane === pane);
    for (const b of document.querySelectorAll('#drawerToggle [data-pane]')) b.classList.toggle('on', b.dataset.pane === pane);
    if (pane === 'chat') { this.unread = 0; this.renderBadge(); this.renderChat(); }
    if (pane === 'log') this.renderLog();
    if (pane === 'stats') this.renderStats();
  }

  /** Adds a chat line: { key?, name, text, sys? }. */
  addChat(line) {
    this.chatLines.push(line);
    if (this.chatLines.length > 200) this.chatLines.shift();
    if (this.pane === 'chat') this.renderChat();
    else { this.unread++; this.renderBadge(); sfx('chat'); }
  }

  renderBadge() {
    const b = $('chatBadge');
    b.textContent = this.unread > 9 ? '9+' : String(this.unread);
    b.classList.toggle('on', this.unread > 0);
  }

  renderChat() {
    const box = $('chatLines');
    box.innerHTML = this.chatLines.map((l) => (l.sys
      ? `<div class="line sys">${esc(l.text)}</div>`
      : `<div class="line" style="--pc:${hex(l.key)}"><b>${esc(l.name)}</b> ${esc(l.text)}</div>`)).join('') || '<div class="line sys">Say hello to the table.</div>';
    box.scrollTop = box.scrollHeight;
  }

  renderLog() {
    const g = this.game;
    const box = $('logLines');
    box.innerHTML = g.log.map((l) => {
      if (l.kind === 'turn') return `<div class="line turn">${esc(l.text)}</div>`;
      return `<div class="line" style="--pc:${hex(l.key)}"><span class="n">${l.n}</span>${l.key ? `<b>●</b> ` : ''}${esc(l.text)}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------------------------------------------------------- statistics */

  statsHtml() {
    const g = this.game;
    const rolls = g.stats.rolls;
    const total = Object.values(rolls).reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...Object.values(rolls), ...Object.keys(rolls).map((n) => (total * ((PIPS[n] || 6) / 36))));
    const bars = Object.entries(rolls).map(([n, c]) => {
      const expected = total * ((PIPS[n] || 6) / 36);
      return `<div class="col"><span class="v">${c}</span><div class="bar${n === '6' || n === '8' || n === '7' ? ' hot' : ''}" style="height:${(c / max) * 80}px"><span class="exp" style="bottom:${(expected / max) * 80}px"></span></div><span class="k">${n}</span></div>`;
    }).join('');
    const over = g.phase === 'over';
    const rows = g.players.slice().sort((a, b) => (over ? g.score(b) - g.score(a) : g.publicScore(b) - g.publicScore(a))).map((p) => {
      const s = g.stats.players[p.key];
      return `<tr style="--pc:${hex(p.key)}"><td><span class="dot"></span>${esc(p.name)}</td><td>${over ? g.score(p) : g.publicScore(p)}</td><td>${s.gained}</td><td>${s.stolen}/${s.lost}</td><td>${s.trades}</td><td>${s.roads}/${s.settlements}/${s.cities}</td><td>${s.cards}</td><td>${p.knights}</td><td>${p.roadLength}</td></tr>`;
    }).join('');
    return `<div class="stats-h">Dice rolls (${total})</div><div class="hist">${bars}</div>
      <div class="legend">Dashed line: how often each number is expected after ${total} rolls.</div>
      <div class="stats-h">Players</div>
      <table class="stable"><thead><tr><th>Player</th><th>VP</th><th title="Resource cards produced">Got</th><th title="Cards stolen / lost to the robber">Rob</th><th>Trades</th><th title="Roads / huts / houses built">Built</th><th title="Development cards bought">Dev</th><th title="Knights played">Kn</th><th title="Longest road">Rd</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  renderStats() {
    $('statsPane').innerHTML = this.statsHtml();
  }

  /* ---------------------------------------------------------------- end of game */

  showEnd() {
    const g = this.game;
    const w = g.playerOf(g.winner);
    if (!w) return;
    const card = $('endCard');
    const hidden = w.dev.vp ? ` including ${w.dev.vp} hidden victory point card${w.dev.vp > 1 ? 's' : ''}` : '';
    const mine = g.isLocal(w) && g.isHuman(w);
    card.innerHTML = `
      <h2><span class="avatar" style="--pc:${hex(w.key)}">${avatarSvg(w.key, PLAYER_COLORS[w.key])}</span>${mine && g.me ? 'You win!' : `${esc(w.name)} wins!`}</h2>
      <p class="sub">${g.score(w)} victory points${hidden} after ${g.turn} rounds.</p>
      ${this.statsHtml()}
      <div class="actions">
        <button class="btn" id="endClose">View board</button>
        <button class="btn" id="endLobby">Back to lobby</button>
        ${this.onRematch ? '<button class="btn primary" id="endAgain">Play again</button>' : ''}
      </div>`;
    $('endgame').classList.add('open');
    $('endClose').onclick = () => $('endgame').classList.remove('open');
    $('endLobby').onclick = () => this.onLeave();
    if (this.onRematch) $('endAgain').onclick = () => this.onRematch();
  }
}

export { handSize, ICONS };
