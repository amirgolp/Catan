// Game page: scene (HDRI sky and lighting, reflective ocean, AO post-processing, bounded
// camera), the board for the chosen variant, and a Game played offline (hot seat + bots)
// or online (?room=ID: the host runs the game, other devices mirror it).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Water } from 'three/addons/objects/Water.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadAssets, findSunDirection, upgradeTextures } from './assets.js';
import { buildBoard, WATER_Y, VARIANTS } from './board.js';
import { makeBirdGeometry, makeCloudGeometry } from './props.js';
import { makeRng } from './noise.js';
import { Pieces, PLAYER_KEYS } from './pieces.js';
import { Game } from './game.js';
import { ICONS } from './avatars.js';
import { DiceRoller } from './dice.js';
import { Minimap } from './minimap.js';
import { Hud } from './hud.js';
import { SKINS, DEFAULT_SKIN } from './skins.js';
import { unlockAudio, setVolume, setMuted, play as sfx } from './sound.js';
import { loadSettings, saveSettings, BOT_SPEEDS } from './settings.js';
import { getAuth, setAuth, connect, api } from './net.js';

const params = new URLSearchParams(location.search);
const settings = loadSettings();
const roomId = params.get('room');
const fast = params.get('fast') === '1'; // tests: no pacing, no dice animation

/** `?seats=human,easy,medium,hard` assigns the seats in turn order. */
function seatsFromUrl(keys) {
  const list = (params.get('seats') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = {};
  list.forEach((l, i) => { if (keys[i]) out[keys[i]] = l; });
  return out;
}

// Phones and tablets (coarse pointer) get a lighter pipeline: no GTAO pass, smaller
// shadow and reflection maps, 1k textures. ?quality= or the settings panel override.
const quality = params.get('quality') || (settings.quality !== 'auto' ? settings.quality : null);
const lowPower = quality === 'low' || (quality !== 'high' && matchMedia('(pointer: coarse)').matches);
const wantHiRes = params.get('tex') !== '1k' && !lowPower;
const timerParam = params.get('timer');
const AO_LAYER = 2; // everything except foliage cards is also on this layer
const $ = (id) => document.getElementById(id);

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ed0e6);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 400);

// The view is bounded: the orbit target stays over the island, zoom is limited to a range
// around the distance that fits the whole board on screen, and the camera never dips to the sea.
let boardRadius = 4.6; // tiles plus harbours; updated once the board is built
let panRadius = 3.2;
const VIEW_DIR = new THREE.Vector3(0, 8.2, 10.4).normalize();
const HOME_TARGET = new THREE.Vector3(0, 0.3, 0.35); // slightly south, so the island clears the dock

/**
 * Camera distance at which the board fits the viewport. Across the screen the board spans
 * its full width; up the screen it is foreshortened by the viewing angle.
 */
function fitDistance() {
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const tilt = Math.acos(VIEW_DIR.y); // angle between the view and straight down
  const across = (boardRadius * 0.92) / Math.tan(hfov / 2);
  const up = (boardRadius * (0.35 + 0.65 * Math.cos(tilt)) + 0.5) / Math.tan(vfov / 2);
  return Math.max(across, up);
}

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false; // pan across the table, not up into the sky
controls.minPolarAngle = 0.05;
controls.maxPolarAngle = Math.PI * 0.44;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.autoRotateSpeed = 0.4;
controls.autoRotate = !!settings.autoRotate;

function setZoomLimits() {
  const fit = fitDistance();
  controls.minDistance = Math.min(3, fit * 0.4);
  controls.maxDistance = fit * 1.3;
}

function resetView() {
  controls.target.copy(HOME_TARGET);
  camera.position.copy(HOME_TARGET).addScaledVector(VIEW_DIR, fitDistance());
  controls.update();
}

// Smooth camera moves (reset view button, minimap clicks).
let flight = null;
controls.addEventListener('start', () => { flight = null; }); // a drag takes over

function flyTo(target, position, seconds = 0.7) {
  flight = { t: 0, seconds, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target, toP: position };
}

/** Back to the default framing of the whole table. */
function flyHome() {
  flyTo(HOME_TARGET.clone(), HOME_TARGET.clone().addScaledVector(VIEW_DIR, fitDistance()));
}

/** Looks at a point on the island, keeping the current viewing angle and zoom. */
function flyToPoint(x, z) {
  const r = Math.hypot(x, z);
  const k = r > panRadius ? panRadius / r : 1;
  const target = new THREE.Vector3(x * k, HOME_TARGET.y, z * k);
  const offset = camera.position.clone().sub(controls.target);
  const maxOff = fitDistance() * 0.75; // move in a little when looking at one spot
  if (offset.length() > maxOff) offset.setLength(maxOff);
  flyTo(target, target.clone().add(offset));
}

function updateFlight(dt) {
  if (!flight) return;
  flight.t = Math.min(1, flight.t + dt / flight.seconds);
  const k = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2; // ease in-out
  controls.target.lerpVectors(flight.fromT, flight.toT, k);
  camera.position.lerpVectors(flight.fromP, flight.toP, k);
  if (flight.t >= 1) flight = null;
}

/** Keeps the orbit target within panRadius of the board centre, moving the camera with it. */
function clampPan() {
  const t = controls.target;
  const r = Math.hypot(t.x, t.z);
  const dy = HOME_TARGET.y - t.y;
  if (r <= panRadius && Math.abs(dy) < 1e-6) return;
  const k = r > panRadius ? panRadius / r : 1;
  const dx = t.x * k - t.x, dz = t.z * k - t.z;
  t.x += dx; t.z += dz; t.y += dy;
  camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
}

setZoomLimits();
resetView();
// Optional framing via URL: ?cam=x,y,z&target=x,y,z
const vec3Param = (name) => {
  const v = params.get(name);
  if (!v) return null;
  const parts = v.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
};
const camParam = vec3Param('cam');
const targetParam = vec3Param('target');
function applyCamParams() {
  if (camParam) camera.position.set(...camParam);
  if (targetParam) controls.target.set(...targetParam);
  if (camParam || targetParam) controls.maxDistance = Math.max(controls.maxDistance, camera.position.distanceTo(controls.target));
  controls.update();
}
applyCamParams();

// Sun (direction is aligned with the HDRI once it has loaded)
const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(lowPower ? 2048 : 4096);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -8;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun);
scene.add(sun.target);

// Post-processing: MSAA colour pass -> ground-truth AO -> tone mapping / sRGB output.
// The AO pass renders through a camera that only sees AO_LAYER, so alpha-tested
// foliage cards do not show up as solid squares in the occlusion buffer.
const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const aoCamera = camera.clone();
aoCamera.layers.set(AO_LAYER);
if (!lowPower) {
  const gtao = new GTAOPass(scene, aoCamera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.85;
  gtao.updateGtaoMaterial({ radius: 0.22, distanceExponent: 1, thickness: 1, distanceFallOff: 1, scale: 1, samples: 16, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
  composer.addPass(gtao);
}
composer.addPass(new OutputPass());

const overlay = $('overlay');
const progressEl = $('progress');
const hiresEl = $('hires');
const uTime = { value: 0 };
let ships = [];
let water = null;
let boardGroup = null;
let cloudGroup = null;
let birdGroup = null;
let pieces = null;
let game = null;
let dice = null;
let minimap = null;
let hud = null;
let net = null;
let online = null; // { game: room game info, you, isHost }

function tagForAO(root) {
  root.traverse((o) => {
    if (o.isMesh && !o.userData.noAO) o.layers.enable(AO_LAYER);
  });
}

/* ---------------------------------------------------------------- seats on screen */

/** Screen positions clockwise from the top left, by number of players. */
const SEAT_SPOTS = {
  2: ['tl', 'tr'], 3: ['tl', 'tr', 'br'], 4: ['tl', 'tr', 'br', 'bl'],
  5: ['tl', 'tr', 'mr', 'br', 'bl'], 6: ['tl', 'tr', 'mr', 'br', 'bl', 'ml'],
};

function buildSeats(keys) {
  const spots = SEAT_SPOTS[keys.length] || SEAT_SPOTS[4];
  $('seats').innerHTML = keys.map((k, i) =>
    `<div class="seat glass ${spots[i]}" id="seat-${k}" data-key="${k}"><svg class="ring"><rect /></svg><div class="seat-body"></div><div class="clock"></div></div>`).join('');
  document.body.classList.toggle('six', keys.length > 4);
  const seats = Object.fromEntries(keys.map((k) => [k, $(`seat-${k}`)]));
  layoutObserver.observe(seats[keys[0]]);
  return seats;
}

/* ---------------------------------------------------------------- online: waiting for the room */

/** Connects to the room and resolves with the game description once the server sends it. */
function joinRoom() {
  return new Promise((resolve, reject) => {
    if (!getAuth()) { reject(new Error('Please log in first.')); return; }
    let started = false;
    net = connect({
      onOpen: () => { net.send({ t: 'rejoin', id: roomId }); showNet(''); },
      onClose: () => showNet('Reconnecting...', true),
      onMessage: (msg) => {
        if (msg.t === 'start' && !started) { started = true; resolve(msg); return; }
        if (msg.t === 'error' && msg.fatal && !started) { reject(new Error(msg.text)); return; }
        onNetMessage(msg);
      },
    });
  });
}

function showNet(text, bad = false) {
  const el = $('net');
  el.textContent = text;
  el.classList.toggle('show', !!text);
  el.classList.toggle('bad', bad);
}

/** Messages after the game has started. */
function onNetMessage(msg) {
  if (!game) { pendingNet.push(msg); return; }
  switch (msg.t) {
    case 'state': if (game.mirror) game.applySnapshot(msg.snap); break;
    case 'resume': becomeHost(msg.state, msg.deck, msg.away || []); break;
    case 'intent': if (!game.mirror) game.applyIntent(msg.seat, msg.name, msg.args); break;
    case 'seatLeft': if (!game.mirror && game.controllers[msg.seat] === 'remote') { game.controllers[msg.seat] = 'medium'; game.render(); game.maybeRunBot(); } break;
    case 'seatBack': if (!game.mirror && game.controllers[msg.seat] === 'medium' && online.game.seats.find((s) => s.key === msg.seat)?.userId) { game.controllers[msg.seat] = 'remote'; game.turnToken++; game.botRunning = false; game.render(); } break;
    case 'host': hud && hud.addChat({ sys: true, text: `${msg.name} is now hosting.` }); break;
    case 'chat':
      if (msg.scope !== 'room' || !hud) break;
      if (msg.from) hud.addChat({ key: msg.from.seat, name: msg.from.name, text: msg.text });
      else hud.addChat({ sys: true, text: msg.text });
      break;
    case 'error': game.message = msg.text; game.render(); break;
    default:
  }
}
const pendingNet = [];

/** This device takes over running the game (after a reload, or when the host left). */
function becomeHost(state, deck, away) {
  if (!state) return;
  online.isHost = true;
  if (!game.mirror && game.seq > 0) return; // already running it
  for (const s of online.game.seats) {
    if (s.userId === getAuth().user.id) game.controllers[s.key] = 'human';
    else if (s.userId) game.controllers[s.key] = away.includes(s.key) ? 'medium' : 'remote';
  }
  state.controllers = { ...game.controllers };
  game.restore(state, deck);
  hookHost();
  hud && hud.addChat({ sys: true, text: 'You are hosting this game now.' });
}

let stateQueued = false;
/** Host: send a snapshot after each burst of changes. */
function hookHost() {
  game.onState = () => {
    if (stateQueued || !net) return;
    stateQueued = true;
    queueMicrotask(() => {
      stateQueued = false;
      net.send({ t: 'state', snap: game.snapshot(), deck: game.deck });
    });
  };
  game.on((ev) => {
    if (ev.type === 'win' && net) {
      // after the final snapshot has gone out
      setTimeout(() => net.send({ t: 'result', winner: ev.key, vps: Object.fromEntries(game.players.map((p) => [p.key, game.score(p)])) }), 0);
    }
  });
  game.onState();
}

/* ---------------------------------------------------------------- init */

async function init() {
  // Which game: an online room or a local game from the URL.
  let seed, variant, keys, controllers, names = {}, skins = {}, you = null, turnSeconds, resume = null;
  if (roomId) {
    progressEl.textContent = 'Joining the table...';
    const start = await joinRoom();
    const g = start.game;
    const me = getAuth().user;
    online = { game: g, you: start.you, isHost: g.hostId === me.id };
    seed = g.seed;
    variant = g.variant;
    keys = g.seats.map((s) => s.key);
    controllers = Object.fromEntries(g.seats.map((s) => [s.key, s.userId ? (s.userId === me.id ? 'human' : 'remote') : s.controller]));
    names = Object.fromEntries(g.seats.map((s) => [s.key, s.name]));
    skins = Object.fromEntries(g.seats.map((s) => [s.key, s.skin || DEFAULT_SKIN]));
    you = start.you;
    turnSeconds = g.timer;
    resume = online.isHost ? start.resume : null;
  } else {
    seed = parseInt(params.get('seed'), 10) || Math.floor(Math.random() * 1e6);
    variant = VARIANTS[params.get('variant')] ? params.get('variant') : 'classic';
    const [minP, maxP] = VARIANTS[variant].players;
    const count = Math.max(minP, Math.min(maxP, parseInt(params.get('players'), 10) || Math.min(4, maxP)));
    keys = PLAYER_KEYS.slice(0, count);
    controllers = seatsFromUrl(keys);
    turnSeconds = timerParam !== null && Number.isFinite(+timerParam) ? Math.max(0, +timerParam) : settings.turnSeconds;
    const auth = getAuth();
    const humanKey = keys.find((k) => (controllers[k] || (k === 'red' ? 'human' : '')) === 'human');
    if (auth && humanKey) names[humanKey] = auth.user.username;
  }

  progressEl.textContent = 'Loading textures 0%';
  const assets = await loadAssets((p) => {
    progressEl.textContent = `Loading textures ${Math.round(p * 100)}%`;
  });

  // Sky + image based lighting
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(assets.hdri).texture;
  scene.background = assets.hdri;
  scene.backgroundBlurriness = 0;
  scene.environmentIntensity = 1.0;
  pmrem.dispose();

  const sunDir = findSunDirection(assets.hdri);
  sun.position.copy(sunDir).multiplyScalar(40);
  sun.target.position.set(0, 0, 0);

  // Ocean
  water = new Water(new THREE.PlaneGeometry(600, 600), {
    textureWidth: lowPower ? 512 : 1024,
    textureHeight: lowPower ? 512 : 1024,
    waterNormals: assets.waterNormals,
    sunDirection: sunDir.clone(),
    sunColor: 0xffffff,
    waterColor: 0x0f6f9a,
    distortionScale: 3.5,
    fog: false,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.material.uniforms.size.value = 3.0;
  // Lower the fixed 30% base reflectance and tint the sky reflection toward the
  // water colour so the sea reads deep blue instead of pale sky grey.
  water.material.fragmentShader = water.material.fragmentShader
    .replace('float rf0 = 0.3;', 'float rf0 = 0.12;')
    .replace('vec3( 0.1 ) + reflectionSample * 0.9', 'vec3( 0.02, 0.08, 0.12 ) + reflectionSample * 0.75 * vec3( 0.55, 0.85, 1.0 )');
  water.material.needsUpdate = true;
  scene.add(water);

  const board = await buildBoard(scene, seed, uTime, assets, (p, type) => {
    progressEl.textContent = `Building ${type} tile  ${Math.round(p * 100)}%`;
  }, variant);
  ships = board.ships;
  boardGroup = board.group;
  boardRadius = board.radius + 0.7;
  panRadius = board.radius * 0.72;
  const shadowSize = Math.max(8, board.radius + 2);
  Object.assign(sun.shadow.camera, { left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize });
  sun.shadow.camera.updateProjectionMatrix();
  setZoomLimits();
  resetView();
  applyCamParams();

  const rand = makeRng(seed);

  pieces = new Pieces(scene, board.graph, camera, canvas, board.tiles);
  const seats = buildSeats(keys);
  const mirror = !!online && !online.isHost;
  game = new Game({
    board, pieces, rand, playerKeys: keys, controllers, names, turnSeconds, mirror,
    ui: {
      seats,
      hand: $('hand'),
      dice: $('dice'),
      message: $('message'),
      rollBtn: $('roll'),
      endBtn: $('endturn'),
      giveSel: $('give'),
      getSel: $('get'),
      tradeBtn: $('trade'),
      giveN: $('giveN'),
      getN: $('getN'),
      offerBtn: $('offer'),
      offerBox: $('offerbox'),
      buyBtn: $('buydev'),
      cards: $('cards'),
      cardCount: $('cardCount'),
      chooser: $('chooser'),
    },
  });
  if (you) game.me = you;
  if (fast) { game.botDelay = 0; game.rollDelay = 0; }
  game.speed = BOT_SPEEDS[settings.botSpeed] ?? 1;
  if (game.speed === 0) game.rollDelay = Math.min(game.rollDelay, 400);

  // Skins: online seats bring their owner's equipped skin; offline the local humans use
  // the one picked in settings.
  if (online) for (const [k, s] of Object.entries(skins)) pieces.setSkin(k, s);
  else for (const k of keys) if (game.controllers[k] === 'human') pieces.setSkin(k, settings.skin);

  dice = new DiceRoller(scene, camera, controls);
  hud = new Hud({
    game, dice,
    sendChat: (text) => { if (net) net.send({ t: 'chat', text }); else game.chat(game.viewer ? game.viewer.key : null, text); },
    onLeave: () => { location.href = 'index.html'; },
    onRematch: online ? null : () => { const q = new URLSearchParams(location.search); q.set('seed', String(Math.floor(Math.random() * 1e6))); location.search = q.toString(); },
  });
  if (online) {
    hud.addChat({ sys: true, text: `Room ${roomId}: ${online.isHost ? 'you are hosting this game.' : 'connected to the host.'}` });
  }
  minimap = new Minimap($('mmSvg'), { board, pieces, camera, controls, onFocus: flyToPoint });
  game.ui.onRender = () => minimap.refresh();
  const mapOpen = settings.minimap ?? (window.innerWidth >= 900 && window.innerHeight >= 600 && keys.length <= 4);
  setMap(mapOpen, false);

  wireControls();
  wireSettings();

  if (online && online.isHost && resume) {
    // this device hosted the game before (page reload): carry on from the saved state
    becomeHost(resume.state, resume.deck, resume.away || []);
  } else if (online && online.isHost) {
    // hold the turn clock until every remote player has the board loaded
    const waiting = new Set(online.game.seats.filter((s) => s.userId && s.key !== you).map((s) => s.key));
    const release = () => { if (!game.clockHold) return; game.clockHold = false; game.startClock(); game.render(); };
    if (waiting.size) {
      game.clockHold = true;
      game.onLoaded = (seat) => { waiting.delete(seat); if (!waiting.size) release(); };
      setTimeout(release, 40000);
    }
    hookHost();
    game.setup();
  } else if (!mirror) {
    if (params.get('setup') === 'auto') game.autoSetup(); // tests: skip the opening draft
    else game.setup();
  } else {
    game.render();
    net.send({ t: 'intent', name: 'loaded', args: [] });
  }
  while (pendingNet.length) onNetMessage(pendingNet.shift());

  window.__pieces = pieces; // debug / scripting handles
  window.__game = game;
  window.__view = { camera, controls, resetView, flyHome, flight: () => flight };
  window.__net = net;

  // Clouds (no shadows: drifting cloud shadows over a table-top board read as smudges)
  cloudGroup = new THREE.Group();
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 1.0 });
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(makeCloudGeometry(rand), cloudMat);
    const a = (i / 8) * Math.PI * 2 + rand.range(0, Math.PI);
    const r = rand.range(12, 22);
    mesh.position.set(Math.cos(a) * r, rand.range(4, 7), Math.sin(a) * r);
    mesh.scale.setScalar(rand.range(1.5, 3));
    mesh.rotation.y = rand.range(0, Math.PI);
    mesh.userData.noAO = true;
    cloudGroup.add(mesh);
  }
  scene.add(cloudGroup);

  // Birds
  birdGroup = new THREE.Group();
  const birdMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide });
  for (let i = 0; i < 15; i++) {
    const mesh = new THREE.Mesh(makeBirdGeometry(), birdMat);
    mesh.userData = {
      noAO: true,
      angle: rand.range(0, Math.PI * 2),
      radius: rand.range(3, 8),
      speed: rand.range(0.2, 0.5),
      height: rand.range(2.5, 4.5),
      flapSpeed: rand.range(12, 18),
      flapOffset: rand.range(0, Math.PI * 2),
    };
    birdGroup.add(mesh);
  }
  scene.add(birdGroup);

  tagForAO(scene);
  overlay.classList.add('hidden');
  $('seed').textContent = `${VARIANTS[variant].name} · seed ${seed}`;

  // Swap the terrain textures for 2k versions once the board is visible.
  if (wantHiRes) {
    hiresEl.textContent = 'Loading 2k textures...';
    try {
      await upgradeTextures(assets, ['grass', 'dryGrass', 'soil', 'forestFloor', 'rock', 'boulder', 'clay', 'sand'], (p) => {
        hiresEl.textContent = `Loading 2k textures ${Math.round(p * 100)}%`;
      });
      hiresEl.textContent = '';
    } catch (err) {
      console.warn('2k texture upgrade failed', err);
      hiresEl.textContent = '';
    }
  }
  document.body.dataset.hires = 'done';
}

init().catch((err) => {
  console.error(err);
  progressEl.innerHTML = `${err.message.replace(/</g, '&lt;')}<br><br><a href="index.html" style="color:#f2c14e">Back to the lobby</a>`;
});

/* ---------------------------------------------------------------- moves: local or sent to the host */

/** Runs a game action here, or sends it to the host when this device mirrors an online game. */
function act(name, ...args) {
  if (!game) return;
  if (game.mirror) {
    if (net) net.send({ t: 'intent', name, args });
    return;
  }
  switch (name) {
    case 'proposeOffer': game.proposeOffer(game.player, ...args); break;
    case 'onPick': game.onPick(args[0], 0); break;
    default: game[name](...args);
  }
}

function wireControls() {
  pieces.onPick = (hit, button) => { if (button !== 2) act('onPick', hit); };
  $('roll').addEventListener('click', () => act('roll'));
  $('endturn').addEventListener('click', () => { closeSheets(); act('endTurn'); });
  $('trade').addEventListener('click', () => act('trade', $('give').value, $('get').value));
  $('offer').addEventListener('click', () => {
    act('proposeOffer', $('give').value, Math.max(1, +$('giveN').value || 1), $('get').value, Math.max(1, +$('getN').value || 1));
  });
  for (const id of ['give', 'get', 'giveN', 'getN']) $(id).addEventListener('change', () => game.render());
  $('offerbox').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.withdraw) act('withdrawOffer');
    else if (b.dataset.respond) act('respondOffer', b.dataset.respond, b.dataset.accept === '1');
  });
  $('buydev').addEventListener('click', () => act('buyDev'));
  $('cards').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-play]');
    if (b) { closeSheets(); act('playDev', b.dataset.play); }
  });
  $('chooser').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-res]');
    if (b) act('chooseResource', b.dataset.res);
  });
  $('seats').addEventListener('change', (ev) => {
    const sel = ev.target.closest('select.ctrl');
    if (sel && !online) game.setController(sel.dataset.key, sel.value);
  });
  document.addEventListener('visibilitychange', () => game.pauseClock(document.hidden && !online));
  // keyboard: R roll, E end turn
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, select, textarea')) return;
    if (ev.key === 'r' || ev.key === 'R') act('roll');
    if (ev.key === 'e' || ev.key === 'E') act('endTurn');
    if (ev.key === 'v' || ev.key === 'V') flyHome();
    if (ev.key === 'm' || ev.key === 'M') setMap(!$('minimap').classList.contains('open'));
  });
  $('viewReset').addEventListener('click', () => flyHome());
  $('mapToggle').addEventListener('click', () => setMap(!$('minimap').classList.contains('open')));
  $('mapClose').addEventListener('click', () => setMap(false));
}

/* ---------------------------------------------------------------- settings sheet */

function wireSettings() {
  setVolume(settings.volume);
  setMuted(settings.muted);
  $('volume').value = String(settings.volume);
  $('mute').checked = settings.muted;
  $('botSpeed').value = settings.botSpeed;
  $('quality').value = settings.quality;
  $('autoRotate').checked = !!settings.autoRotate;
  const timerSel = $('timerSel');
  timerSel.value = String(game.turnSeconds);
  if (timerSel.value !== String(game.turnSeconds)) {
    timerSel.insertAdjacentHTML('beforeend', `<option value="${game.turnSeconds}">${game.turnSeconds} s</option>`);
    timerSel.value = String(game.turnSeconds);
  }
  if (online) $('timerRow').style.display = 'none';
  if (online) $('reshuffle').style.display = 'none';
  const save = () => saveSettings(settings);
  $('volume').addEventListener('input', (ev) => { settings.volume = +ev.target.value; setVolume(settings.volume); save(); });
  $('volume').addEventListener('change', () => sfx('settlement'));
  $('mute').addEventListener('change', (ev) => { settings.muted = ev.target.checked; setMuted(settings.muted); save(); });
  $('botSpeed').addEventListener('change', (ev) => {
    settings.botSpeed = ev.target.value;
    game.speed = BOT_SPEEDS[settings.botSpeed] ?? 1;
    save();
  });
  timerSel.addEventListener('change', (ev) => { settings.turnSeconds = +ev.target.value; game.setTurnSeconds(settings.turnSeconds); save(); });
  $('quality').addEventListener('change', (ev) => {
    settings.quality = ev.target.value;
    save();
    if (confirm('Reload now to apply the graphics setting?')) location.reload();
  });
  $('autoRotate').addEventListener('change', (ev) => { settings.autoRotate = ev.target.checked; controls.autoRotate = settings.autoRotate; save(); });
  renderSkins();
  $('skins').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-skin]');
    if (!b) return;
    const id = b.dataset.skin;
    const auth = getAuth();
    const owned = ownedSkins();
    if (online) {
      if (!owned.includes(id)) { game.message = `${SKINS[id].name} unlocks in the store (coming soon).`; game.render(); return; }
      try { const user = await api('/api/me/skin', { skin: id }); setAuth({ ...auth, user }); } catch (err) { game.message = err.message; game.render(); return; }
      game.message = 'Skin saved: it applies from your next online game.';
      game.render();
    } else {
      for (const p of game.players) if (game.controllers[p.key] === 'human') pieces.setSkin(p.key, id);
      if (auth && owned.includes(id) && !auth.user.guest) api('/api/me/skin', { skin: id }).then((user) => setAuth({ ...auth, user })).catch(() => {});
    }
    settings.skin = id;
    save();
    sfx('settlement');
    renderSkins();
  });
  $('leave').addEventListener('click', () => { location.href = 'index.html'; });
}

function ownedSkins() {
  const auth = getAuth();
  return auth && auth.user && auth.user.owned ? auth.user.owned : [DEFAULT_SKIN];
}

function renderSkins() {
  const owned = ownedSkins();
  const current = online ? (getAuth()?.user?.skin || DEFAULT_SKIN) : settings.skin;
  $('skins').innerHTML = Object.entries(SKINS).map(([id, s]) => {
    const has = owned.includes(id);
    const status = has ? '' : online ? `<span class="lock">🔒 ${s.price} coins · store coming soon</span>` : `<span class="lock">Preview · ${s.price} coins</span>`;
    return `<button class="skin${id === current ? ' on' : ''}" data-skin="${id}"><span class="tag ${s.rarity.toLowerCase()}">${s.rarity}</span><b>${s.name}</b><small>${s.blurb}</small>${status}</button>`;
  }).join('');
}

document.getElementById('reshuffle').addEventListener('click', () => {
  const next = new URLSearchParams(location.search);
  next.set('seed', String(Math.floor(Math.random() * 1e6)));
  location.search = next.toString();
});
document.getElementById('resetView').addEventListener('click', () => { flyHome(); closeSheets(); });

/** Shows or hides the minimap; `remember` stores the choice for next time. */
function setMap(open, remember = true) {
  $('minimap').classList.toggle('open', open);
  $('mapToggle').classList.toggle('on', open);
  if (open && minimap) { minimap.refresh(true); minimap.camAngle = null; }
  if (remember) { settings.minimap = open; saveSettings(settings); }
}

/* ---------- HUD: icons, pop-up sheets, layout variables */

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon] || '';

function closeSheets(except) {
  for (const sh of document.querySelectorAll('.sheet')) if (sh.id !== except) sh.classList.remove('open');
  for (const b of document.querySelectorAll('[data-sheet]')) b.classList.toggle('on', b.dataset.sheet === except && document.getElementById(except).classList.contains('open'));
}
for (const b of document.querySelectorAll('[data-sheet]')) {
  b.addEventListener('click', () => {
    const sheet = document.getElementById(b.dataset.sheet);
    sheet.classList.toggle('open');
    closeSheets(b.dataset.sheet);
  });
}
canvas.addEventListener('pointerdown', () => { closeSheets(); unlockAudio(); });
document.addEventListener('pointerdown', unlockAudio, { once: true });

// Sheets and the portrait layout position themselves from the dock and seat heights.
const rootStyle = document.documentElement.style;
const layoutObserver = new ResizeObserver(() => {
  rootStyle.setProperty('--dock-h', $('dock').offsetHeight + 'px');
  const seat = document.querySelector('.seat');
  if (seat) rootStyle.setProperty('--seat-h', seat.offsetHeight + 'px');
});
layoutObserver.observe($('dock'));

/* ---------- resizing: the board keeps the same framing at any window size or orientation */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const before = fitDistance();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const after = fitDistance();
  const offset = camera.position.clone().sub(controls.target).multiplyScalar(after / before);
  camera.position.copy(controls.target).add(offset);
  setZoomLimits();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));

// Installable app: the service worker caches the page, three.js and the textures.
if ('serviceWorker' in navigator && location.protocol !== 'file:' && params.get('sw') !== '0') {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
}

const clock = new THREE.Clock();
// ?maxfps=N caps the frame rate (battery saving, automated tests).
const frameGap = params.get('maxfps') ? 1000 / Math.max(1, +params.get('maxfps')) : 0;
let lastFrame = 0;
function animate(now = 0) {
  if (frameGap && now - lastFrame < frameGap) { requestAnimationFrame(animate); return; }
  lastFrame = now;
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.25); // animations; the board intro below uses real time
  const t = clock.elapsedTime;
  uTime.value = t;
  if (water) water.material.uniforms.time.value += dt * 0.5;
  for (const s of ships) {
    s.angle += s.speed * dt;
    const dir = Math.sign(s.speed);
    const hx = -Math.sin(s.angle) * dir, hz = Math.cos(s.angle) * dir; // tangent heading
    s.mesh.position.set(Math.cos(s.angle) * s.radius, s.baseY + Math.sin(t * 1.3 + s.phase) * 0.02, Math.sin(s.angle) * s.radius);
    s.mesh.rotation.set(Math.sin(t * 1.1 + s.phase * 1.7) * 0.03, Math.atan2(-hz, hx), Math.sin(t * 0.9 + s.phase) * 0.04);
  }

  // Board spawn animation
  if (boardGroup) {
    boardGroup.children.forEach((child) => {
      const ud = child.userData;
      if (ud && ud.targetY !== undefined) {
        ud.time += rawDt;
        if (ud.time > ud.delay) {
          const p = Math.min(1.0, (ud.time - ud.delay) * 1.5);
          if (p >= 1) {
            child.position.y = ud.targetY;
            ud.targetY = undefined;
          } else {
            const c4 = (2 * Math.PI) / 3;
            const ease = p === 0 ? 0 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
            child.position.y = -3 + ease * (ud.targetY - -3);
          }
        }
      }
    });
  }

  // Ambient life animation
  if (cloudGroup) cloudGroup.rotation.y -= dt * 0.015;
  if (birdGroup) {
    for (const b of birdGroup.children) {
      const ud = b.userData;
      ud.angle -= ud.speed * dt;
      b.position.set(Math.cos(ud.angle) * ud.radius, ud.height + Math.sin(t * 2.0 + ud.flapOffset) * 0.2, Math.sin(ud.angle) * ud.radius);
      b.scale.y = 1 + Math.sin(t * ud.flapSpeed + ud.flapOffset) * 0.6;
      b.rotation.y = -ud.angle;
    }
  }

  if (pieces) pieces.update(dt);
  if (dice) dice.update(dt);
  if (game) game.tick();
  updateFlight(rawDt);
  controls.update();
  clampPan();
  if (minimap && $('minimap').classList.contains('open')) minimap.tick();
  // Keep the AO camera in step with the view camera but restricted to the AO layer.
  aoCamera.copy(camera, false);
  aoCamera.layers.set(AO_LAYER);
  composer.render();
  requestAnimationFrame(animate);
}
animate();
