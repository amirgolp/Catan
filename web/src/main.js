// Scene setup: HDRI sky and lighting, sun aligned with the HDRI, reflective ocean,
// ambient occlusion post-processing, camera controls and the render loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Water } from 'three/addons/objects/Water.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadAssets, findSunDirection, upgradeTextures } from './assets.js';
import { buildBoard, WATER_Y } from './board.js';
import { makeBirdGeometry, makeCloudGeometry } from './props.js';
import { makeRng } from './noise.js';
import { Pieces } from './pieces.js';
import { Game } from './game.js';
import { ICONS } from './avatars.js';

const params = new URLSearchParams(location.search);
const seed = parseInt(params.get('seed'), 10) || 2024;

/** `?seats=human,easy,medium,hard` assigns red, blue, white, orange in that order. */
function seatsFromUrl() {
  const list = (params.get('seats') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const keys = ['red', 'blue', 'white', 'orange'];
  const out = {};
  list.forEach((l, i) => { if (keys[i]) out[keys[i]] = l; });
  return out;
}
// Phones and tablets (coarse pointer) get a lighter pipeline: no GTAO pass, smaller
// shadow and reflection maps, 1k textures. ?quality=high / ?quality=low override.
const quality = params.get('quality');
const lowPower = quality === 'low' || (quality !== 'high' && matchMedia('(pointer: coarse)').matches);
const wantHiRes = params.get('tex') !== '1k' && !lowPower;
const timerParam = params.get('timer');
const turnSeconds = timerParam !== null && Number.isFinite(+timerParam) ? Math.max(0, +timerParam) : 90;
const AO_LAYER = 2; // everything except foliage cards is also on this layer

const canvas = document.getElementById('scene');
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
const BOARD_RADIUS = 4.6; // tiles plus harbours
const PAN_RADIUS = 3.2;
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
  const across = (BOARD_RADIUS * 0.92) / Math.tan(hfov / 2);
  const up = (BOARD_RADIUS * (0.35 + 0.65 * Math.cos(tilt)) + 0.5) / Math.tan(vfov / 2);
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

/** Keeps the orbit target within PAN_RADIUS of the board centre, moving the camera with it. */
function clampPan() {
  const t = controls.target;
  const r = Math.hypot(t.x, t.z);
  const dy = HOME_TARGET.y - t.y;
  if (r <= PAN_RADIUS && Math.abs(dy) < 1e-6) return;
  const k = r > PAN_RADIUS ? PAN_RADIUS / r : 1;
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
if (camParam) camera.position.set(...camParam);
if (targetParam) controls.target.set(...targetParam);
if (camParam || targetParam) controls.maxDistance = Math.max(controls.maxDistance, camera.position.distanceTo(controls.target));
controls.update();

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

const overlay = document.getElementById('overlay');
const progressEl = document.getElementById('progress');
const hiresEl = document.getElementById('hires');
const uTime = { value: 0 };
let ships = [];
let water = null;
let boardGroup = null;
let cloudGroup = null;
let birdGroup = null;
let pieces = null;
let game = null;

function tagForAO(root) {
  root.traverse((o) => {
    if (o.isMesh && !o.userData.noAO) o.layers.enable(AO_LAYER);
  });
}

async function init() {
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
  });
  ships = board.ships;
  boardGroup = board.group;

  const rand = makeRng(seed);

  // Four-player game on the board graph.
  pieces = new Pieces(scene, board.graph, camera, canvas, board.tiles);
  const $ = (id) => document.getElementById(id);
  const seats = Object.fromEntries([...document.querySelectorAll('.seat')].map((el) => [el.dataset.key, el]));
  game = new Game({
    board, pieces, rand,
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
    controllers: seatsFromUrl(),
    turnSeconds,
  });
  $('timerSel').value = String(turnSeconds);
  if ($('timerSel').value !== String(turnSeconds)) {
    $('timerSel').insertAdjacentHTML('beforeend', `<option value="${turnSeconds}">${turnSeconds} s</option>`);
    $('timerSel').value = String(turnSeconds);
  }
  game.setup();
  $('roll').addEventListener('click', () => game.roll());
  $('endturn').addEventListener('click', () => { closeSheets(); game.endTurn(); });
  $('trade').addEventListener('click', () => game.trade(game.ui.giveSel.value, game.ui.getSel.value));
  $('offer').addEventListener('click', () => {
    const ui = game.ui;
    game.proposeOffer(game.player, ui.giveSel.value, Math.max(1, +ui.giveN.value || 1), ui.getSel.value, Math.max(1, +ui.getN.value || 1));
  });
  for (const id of ['give', 'get', 'giveN', 'getN']) $(id).addEventListener('change', () => game.render());
  $('offerbox').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.withdraw) game.withdrawOffer();
    else if (b.dataset.respond) game.respondOffer(b.dataset.respond, b.dataset.accept === '1');
  });
  $('buydev').addEventListener('click', () => game.buyDev());
  $('cards').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-play]');
    if (b) { closeSheets(); game.playDev(b.dataset.play); }
  });
  $('chooser').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-res]');
    if (b) game.chooseResource(b.dataset.res);
  });
  for (const el of Object.values(seats)) {
    el.addEventListener('change', (ev) => {
      const sel = ev.target.closest('select.ctrl');
      if (sel) game.setController(sel.dataset.key, sel.value);
    });
  }
  $('timerSel').addEventListener('change', (ev) => game.setTurnSeconds(+ev.target.value));
  document.addEventListener('visibilitychange', () => game.pauseClock(document.hidden));
  window.__pieces = pieces; // debug / scripting handles
  window.__game = game;
  window.__view = { camera, controls, resetView };

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
  document.getElementById('seed').textContent = String(seed);

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
  progressEl.textContent = 'Failed to load: ' + err.message;
});

document.getElementById('reshuffle').addEventListener('click', () => {
  const next = new URLSearchParams(location.search);
  next.set('seed', String(Math.floor(Math.random() * 1e6)));
  location.search = next.toString();
});
document.getElementById('resetView').addEventListener('click', () => { resetView(); closeSheets(); });

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
canvas.addEventListener('pointerdown', () => closeSheets());

// Sheets and the portrait layout position themselves from the dock and seat heights.
const rootStyle = document.documentElement.style;
const layoutObserver = new ResizeObserver(() => {
  rootStyle.setProperty('--dock-h', document.getElementById('dock').offsetHeight + 'px');
  rootStyle.setProperty('--seat-h', document.getElementById('seat-red').offsetHeight + 'px');
});
layoutObserver.observe(document.getElementById('dock'));
layoutObserver.observe(document.getElementById('seat-red'));

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
function animate() {
  const dt = clock.getDelta();
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
        ud.time += dt;
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
  if (game) game.tick();
  controls.update();
  clampPan();
  // Keep the AO camera in step with the view camera but restricted to the AO layer.
  aoCamera.copy(camera, false);
  aoCamera.layers.set(AO_LAYER);
  composer.render();
  requestAnimationFrame(animate);
}
animate();
