// Landing page (sign up / log in / guest / offline) and the lobby: quick play against
// bots, creating and joining rooms, room seats and chat, leaderboard and skins.
import { VARIANT_INFO, SKINS, DEFAULT_SKIN, skinArt, variantArt } from './catalog.js';
import { api, getAuth, setAuth, connect, serverAvailable } from './net.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEAT_COLORS = ['#c0392b', '#2e6db4', '#f2efe6', '#e67e22', '#3f9b57', '#7a4b2a'];
const PLAYABLE = Object.keys(VARIANT_INFO).filter((k) => !VARIANT_INFO[k].soon);

let online = false;

/** Display options on the lobby URL (quality, frame cap, ...) carry over to the game page. */
function carryParams() {
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of ['quality', 'maxfps', 'tex', 'sw']) if (q.has(k)) out.set(k, q.get(k));
  const str = out.toString();
  return str ? '&' + str : '';
}
let net = null;
let room = null; // current room summary
let me = null;

/* ================================================================ landing */

async function boot() {
  $('shot').style.backgroundImage = "url('img/hero.jpg')";
  online = await serverAvailable();
  const st = $('serverStatus');
  st.classList.add(online ? 'on' : 'off');
  st.querySelector('span').textContent = online ? 'Game server online' : 'Game server offline: offline play only';
  $('guestBtn').disabled = !online;
  $('authSubmit').disabled = !online;

  const auth = getAuth();
  if (online && auth) {
    try {
      const user = await api('/api/me');
      setAuth({ ...auth, user });
      return enterLobby();
    } catch { setAuth(null); }
  }
  $('landing').classList.remove('hidden');
}

let mode = 'login';
$('authTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-mode]');
  if (!b) return;
  mode = b.dataset.mode;
  for (const x of $('authTabs').children) x.classList.toggle('on', x === b);
  $('authSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authErr').textContent = '';
});

$('authForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('authErr').textContent = '';
  $('authSubmit').disabled = true;
  try {
    const res = await api(mode === 'login' ? '/api/login' : '/api/signup', { username: $('username').value.trim(), password: $('password').value });
    setAuth(res);
    enterLobby();
  } catch (err) {
    $('authErr').textContent = err.message;
  } finally {
    $('authSubmit').disabled = !online;
  }
});

$('guestBtn').addEventListener('click', async () => {
  try {
    const res = await api('/api/guest', { name: 'Guest' });
    setAuth(res);
    enterLobby();
  } catch (err) { $('authErr').textContent = err.message; }
});

/* ================================================================ lobby */

function enterLobby() {
  me = getAuth().user;
  $('landing').classList.add('hidden');
  $('lobbyView').classList.remove('hidden');
  renderMe();
  fillVariantSelect();
  renderVariantCards($('crVariants'), 'classic', (id) => { crVariant = id; syncMax($('crMax'), $('crMaxV'), id); });
  syncMax($('crMax'), $('crMaxV'), 'classic');
  renderSkins();
  net = connect({
    onOpen: () => { net.send({ t: 'lobby' }); if (room) net.send({ t: 'join', id: room.id }); },
    onMessage,
  });
  const q = new URLSearchParams(location.search).get('join');
  if (q) setTimeout(() => net.send({ t: 'join', id: q }), 300);
}

function renderMe() {
  $('meAva').textContent = me.username[0].toUpperCase();
  $('meName').textContent = me.username;
  $('meStats').textContent = me.guest ? 'Guest · not ranked' : `Rating ${me.rating} · ${me.wins}/${me.games} wins`;
  $('coinBalance').textContent = `${me.coins || 0} coins`;
}

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', {}); } catch { /* ignore */ }
  setAuth(null);
  location.href = 'index.html';
});

/* ---------------------------------------------------------------- tabs */

$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tab]');
  if (!b) return;
  for (const x of $('tabs').children) x.classList.toggle('on', x === b);
  for (const v of document.querySelectorAll('[data-view]')) v.classList.toggle('hidden', v.dataset.view !== b.dataset.tab);
  if (b.dataset.tab === 'leaderboard') loadLeaderboard();
  if (b.dataset.tab === 'skins') renderSkins();
});

/* ---------------------------------------------------------------- quick play (offline) */

function fillVariantSelect() {
  $('qpVariant').innerHTML = PLAYABLE.map((k) => `<option value="${k}">${VARIANT_INFO[k].name} · ${VARIANT_INFO[k].players[0]}-${VARIANT_INFO[k].players[1]} players</option>`).join('');
}

/** Fits a player-count slider to a variant: defaults to the maximum until the user moves it. */
function syncMax(input, label, variant) {
  const [lo, hi] = VARIANT_INFO[variant].players;
  const wanted = input.dataset.touched === '1' ? +input.value : hi;
  input.min = String(lo);
  input.max = String(hi);
  input.value = String(Math.max(lo, Math.min(hi, wanted)));
  label.textContent = input.value;
}

$('qpVariant').addEventListener('change', () => syncMax($('qpPlayers'), $('qpPlayersV'), $('qpVariant').value));
$('qpPlayers').addEventListener('input', (ev) => { ev.target.dataset.touched = '1'; $('qpPlayersV').textContent = ev.target.value; });
$('qpStart').addEventListener('click', () => {
  const n = +$('qpPlayers').value;
  const level = $('qpBots').value;
  const mix = ['easy', 'medium', 'hard', 'medium', 'hard'];
  const seats = ['human', ...Array.from({ length: n - 1 }, (_, i) => (level === 'mixed' ? mix[i] : level))];
  location.href = `play.html?variant=${$('qpVariant').value}&players=${n}&seats=${seats.join(',')}${carryParams()}`;
});

/* ---------------------------------------------------------------- create / join */

let crVariant = 'classic';

function renderVariantCards(box, selected, onPick, disabled = false) {
  box.innerHTML = Object.entries(VARIANT_INFO).map(([id, v]) => `
    <button class="variant${id === selected ? ' on' : ''}" data-variant="${id}"${v.soon || disabled ? ' disabled' : ''}>
      ${variantArt(id)}
      <b>${v.name}</b><small>${v.blurb} ${v.players[0]}-${v.players[1]} players.</small>
      ${v.soon ? '<span class="pill warn soon">Soon</span>' : ''}
    </button>`).join('');
  box.onclick = (ev) => {
    const b = ev.target.closest('[data-variant]');
    if (!b || b.disabled) return;
    for (const x of box.children) x.classList.toggle('on', x === b);
    onPick(b.dataset.variant);
  };
}

$('crMax').addEventListener('input', (ev) => { ev.target.dataset.touched = '1'; $('crMaxV').textContent = ev.target.value; });
$('crCreate').addEventListener('click', () => {
  net.send({ t: 'create', name: $('crName').value, variant: crVariant, max: +$('crMax').value, timer: +$('crTimer').value, fill: $('crFill').value, private: $('crPrivate').checked });
});
$('joinBtn').addEventListener('click', () => { const id = $('joinCode').value.trim(); if (id) net.send({ t: 'join', id }); });
$('joinCode').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('joinBtn').click(); });

function renderRooms(rooms) {
  const box = $('rooms');
  if (!rooms.length) { box.innerHTML = '<div class="empty-state">No open rooms yet. Create one and invite friends with its code.</div>'; return; }
  box.innerHTML = rooms.map((r) => {
    const v = VARIANT_INFO[r.variant] || VARIANT_INFO.classic;
    const status = r.status === 'waiting' ? `<span class="pill good">Waiting · ${r.players.length}/${r.max}</span>` : r.status === 'playing' ? '<span class="pill blue">Playing</span>' : '<span class="pill">Finished</span>';
    const chips = r.players.map((p, i) => `<span class="chip" style="--c:${SEAT_COLORS[i]}"><i>${esc(p.name[0])}</i>${esc(p.name)}</span>`).join('') +
      Array.from({ length: Math.max(0, r.max - r.players.length) }, () => '<span class="chip empty">open seat</span>').join('');
    const canJoin = r.status === 'waiting' && r.players.length < r.max;
    return `<div class="room">
      <div><div class="name">${esc(r.name)}</div><div class="meta">${status}<span>${v.name}</span><span>${r.timer ? r.timer + ' s turns' : 'no timer'}</span><span>code ${r.id}</span></div></div>
      <button class="btn small${canJoin ? ' primary' : ''}" data-join="${r.id}"${canJoin ? '' : ' disabled'}>Join</button>
      <div class="players">${chips}</div>
    </div>`;
  }).join('');
}
$('rooms').addEventListener('click', (ev) => { const b = ev.target.closest('[data-join]'); if (b) net.send({ t: 'join', id: b.dataset.join }); });

/* ---------------------------------------------------------------- room view */

function showRoom(r, chat) {
  room = r;
  $('lobbyGrid').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  const host = r.hostId === me.id;
  const v = VARIANT_INFO[r.variant];
  $('roomTitle').textContent = r.name;
  $('roomCode').textContent = `Code ${r.id}`;
  $('roomMeta').textContent = `${v.name} · ${r.max} seats · ${r.timer ? r.timer + ' s turns' : 'no turn timer'} · empty seats: ${r.fill} bots${r.private ? ' · private' : ''}`;
  $('hostControls').classList.toggle('hidden', !host);
  if (host) {
    renderVariantCards($('rmVariants'), r.variant, (id) => net.send({ t: 'config', variant: id, max: Math.min(+$('rmMax').value, VARIANT_INFO[id].players[1]) }));
    const [lo, hi] = v.players;
    $('rmMax').min = String(Math.max(lo, r.players.length));
    $('rmMax').max = String(hi);
    $('rmMax').value = String(r.max);
    $('rmMaxV').textContent = String(r.max);
    $('rmTimer').value = String(r.timer);
    $('rmFill').value = r.fill;
    $('rmPrivate').checked = r.private;
  }
  const mine = r.players.find((p) => p.id === me.id);
  $('rmReady').classList.toggle('hidden', host);
  $('rmReady').textContent = mine && mine.ready ? 'Not ready' : "I'm ready";
  $('rmStart').classList.toggle('hidden', !host);
  const waiting = r.players.filter((p) => p.id !== r.hostId && !p.ready).length;
  $('rmStart').disabled = waiting > 0;
  $('rmStart').textContent = waiting > 0 ? `Waiting for ${waiting} player${waiting > 1 ? 's' : ''}` : 'Start game';
  $('seatCount').textContent = `${r.players.length} players · ${r.max - r.players.length} bots`;
  $('seatList').innerHTML = Array.from({ length: r.max }, (_, i) => {
    const p = r.players[i];
    if (!p) return `<div class="seatcard bot"><span class="dot" style="--c:${SEAT_COLORS[i]}">🤖</span><div><b>${r.fill[0].toUpperCase() + r.fill.slice(1)} bot</b><small>fills this seat</small></div></div>`;
    const tag = p.id === r.hostId ? 'Host' : p.ready ? 'Ready' : 'Not ready';
    return `<div class="seatcard"><span class="dot" style="--c:${SEAT_COLORS[i]}">${esc(p.name[0].toUpperCase())}</span><div><b>${esc(p.name)}${p.id === me.id ? ' (you)' : ''}</b><small>${tag}${p.guest ? ' · guest' : ` · ${p.rating}`}</small></div></div>`;
  }).join('');
  if (chat) renderLines($('roomLines'), chat);
}

function leaveRoomView() {
  room = null;
  $('roomView').classList.add('hidden');
  $('lobbyGrid').classList.remove('hidden');
}

$('rmLeave').addEventListener('click', () => { net.send({ t: 'leave' }); leaveRoomView(); });
$('rmReady').addEventListener('click', () => { const mine = room && room.players.find((p) => p.id === me.id); net.send({ t: 'ready', ready: !(mine && mine.ready) }); });
$('rmStart').addEventListener('click', () => net.send({ t: 'start' }));
$('rmMax').addEventListener('input', (ev) => { $('rmMaxV').textContent = ev.target.value; });
$('rmMax').addEventListener('change', (ev) => net.send({ t: 'config', max: +ev.target.value }));
$('rmTimer').addEventListener('change', (ev) => net.send({ t: 'config', timer: +ev.target.value }));
$('rmFill').addEventListener('change', (ev) => net.send({ t: 'config', fill: ev.target.value }));
$('rmPrivate').addEventListener('change', (ev) => net.send({ t: 'config', private: ev.target.checked }));

/* ---------------------------------------------------------------- chat */

function renderLines(box, lines) {
  box.innerHTML = lines.map((l) => (l.from ? `<div><b>${esc(l.from.name)}</b> ${esc(l.text)}</div>` : `<div class="sys">${esc(l.text)}</div>`)).join('');
  box.scrollTop = box.scrollHeight;
}
function appendLine(box, l) {
  box.insertAdjacentHTML('beforeend', l.from ? `<div><b>${esc(l.from.name)}</b> ${esc(l.text)}</div>` : `<div class="sys">${esc(l.text)}</div>`);
  box.scrollTop = box.scrollHeight;
}
for (const [form, input] of [['lobbyChat', 'lobbyInput'], ['roomChat', 'roomInput']]) {
  $(form).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $(input).value.trim();
    if (!text) return;
    $(input).value = '';
    net.send({ t: 'chat', text });
  });
}

/* ---------------------------------------------------------------- server messages */

function onMessage(msg) {
  switch (msg.t) {
    case 'hello': me = { ...me, ...msg.user }; setAuth({ ...getAuth(), user: me }); renderMe(); break;
    case 'rooms': renderRooms(msg.rooms); break;
    case 'room': showRoom(msg.room, msg.chat); break;
    case 'left': leaveRoomView(); break;
    case 'lobbyChat': renderLines($('lobbyLines'), msg.lines); break;
    case 'chat': appendLine(msg.scope === 'room' ? $('roomLines') : $('lobbyLines'), msg); break;
    case 'start':
      net.close(); // the game page opens its own connection
      location.href = `play.html?room=${encodeURIComponent(msg.game.id)}${carryParams()}`;
      break;
    case 'error':
      if (room) $('roomErr').textContent = msg.text;
      else alert(msg.text);
      break;
    default:
  }
}

/* ---------------------------------------------------------------- leaderboard */

async function loadLeaderboard() {
  const body = $('lbBody');
  body.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center">Loading...</td></tr>';
  try {
    const rows = await api('/api/leaderboard');
    body.innerHTML = rows.length ? rows.map((r) => `<tr class="${r.username === me.username ? 'me' : ''}">
      <td><span class="rank${r.rank <= 3 ? ' r' + r.rank : ''}">${r.rank}</span></td><td>${esc(r.username)}</td><td>${r.rating}</td><td>${r.wins}</td><td>${r.games}</td>
      <td>${r.games ? Math.round((100 * r.wins) / r.games) : 0}%</td><td>${r.games ? (r.vp / r.games).toFixed(1) : '-'}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted" style="text-align:center">No ranked games yet. Win one online to top the board!</td></tr>';
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center">${esc(err.message)}</td></tr>`;
  }
}
$('lbRefresh').addEventListener('click', loadLeaderboard);

/* ---------------------------------------------------------------- skins */

function renderSkins() {
  if (!me) return;
  const owned = me.owned || [DEFAULT_SKIN];
  $('skinGrid').innerHTML = Object.entries(SKINS).map(([id, s]) => {
    const has = owned.includes(id);
    const equipped = me.skin === id;
    const action = equipped ? '<span class="pill good">Equipped</span>'
      : has ? `<button class="btn small" data-equip="${id}">Equip</button>`
        : `<button class="btn small" disabled title="The store opens soon">🔒 ${s.price}</button>`;
    return `<div class="skincard"><div class="art">${skinArt(id)}</div><div class="body">
      <span class="rar ${s.rarity.toLowerCase()}">${s.rarity}</span><b>${s.name}</b><span class="muted" style="font-size:12.5px">${s.blurb}</span>
      <div class="row"><span class="coins">${s.price ? s.price + ' coins' : 'Free'}</span>${action}</div></div></div>`;
  }).join('');
}
$('skinGrid').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-equip]');
  if (!b) return;
  try {
    me = await api('/api/me/skin', { skin: b.dataset.equip });
    setAuth({ ...getAuth(), user: me });
    renderSkins();
  } catch (err) { alert(err.message); }
});

boot();
