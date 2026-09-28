// Board layouts: the standard 19-hex island and the 30-hex 5-6 player extension, with
// terrain shuffle, number tokens, robber, harbours and ships.
import * as THREE from 'three';
import { TileFactory } from './tiles.js';
import { HEX_R, APOTHEM } from './hexGeometry.js';
import { makeRng } from './noise.js';
import { tokenTexture, portSignTexture } from './textures.js';
import { makeDockGeometry, makeShip } from './props.js';
import { buildGraph } from './pieces.js';

export const WATER_Y = 0.07;
const SPACING = 1.003; // hairline seam; the base bevels form the dark groove between tiles
const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const TERRAIN_COUNTS = { fields: 4, forest: 4, pasture: 4, hills: 3, mountains: 3, desert: 1 };
const NUMBERS = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

/**
 * Board variants offered in the lobby. `numbers: 'spiral'` lays the printed token order
 * around the spiral; 'balanced' shuffles them so no 6 / 8 touch and no equal numbers meet.
 */
export const VARIANTS = {
  classic: {
    name: 'Classic', players: [2, 4], rows: null,
    terrain: TERRAIN_COUNTS, numbers: 'spiral', tokens: NUMBERS,
    ports: ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'wool', 'grain', 'ore'],
    blurb: 'The standard 19-tile island for 2-4 players.',
  },
  balanced: {
    name: 'Balanced', players: [2, 4], rows: null,
    terrain: TERRAIN_COUNTS, numbers: 'balanced', tokens: NUMBERS,
    ports: ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'wool', 'grain', 'ore'],
    blurb: 'Classic island with shuffled numbers: no 6 and 8 side by side.',
  },
  extension: {
    name: '5-6 Extension', players: [2, 6], rows: [3, 4, 5, 6, 5, 4, 3],
    terrain: { fields: 6, forest: 6, pasture: 6, hills: 5, mountains: 5, desert: 2 }, numbers: 'balanced',
    tokens: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12],
    ports: ['3:1', '3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'wool', 'wool', 'grain', 'ore'],
    blurb: 'A 30-tile island with two deserts for up to 6 players.',
  },
};

/** Axial coordinates for a board given as tile counts per row (north to south). */
function rowsAxial(rows) {
  const out = [];
  const mid = (rows.length - 1) / 2;
  const shift = rows.some((m) => m % 2 === 0) ? 0.5 : 0;
  rows.forEach((n, i) => {
    const r = i - mid;
    const q0 = -(n - 1) / 2 - r / 2 + shift;
    for (let k = 0; k < n; k++) out.push([Math.round(q0 + k), r]);
  });
  return out;
}

/** Shuffles number tokens until no 6/8 are neighbours and no equal numbers touch. */
function balancedNumbers(coords, types, tokens, rand) {
  const key = (q, r) => `${q},${r}`;
  const index = new Map(coords.map(([q, r], i) => [key(q, r), i]));
  const neighbours = coords.map(([q, r]) => AXIAL_DIRS.map(([dq, dr]) => index.get(key(q + dq, r + dr))).filter((j) => j !== undefined));
  const slots = coords.map((_, i) => i).filter((i) => types[i] !== 'desert');
  for (let attempt = 0; attempt < 5000; attempt++) {
    const order = rand.shuffle(tokens);
    const nums = new Array(coords.length).fill(null);
    slots.forEach((i, k) => { nums[i] = order[k]; });
    const ok = coords.every((_, i) => {
      const n = nums[i];
      if (n == null) return true;
      return neighbours[i].every((j) => {
        const m = nums[j];
        if (m == null) return true;
        if ((n === 6 || n === 8) && (m === 6 || m === 8)) return false;
        return m !== n;
      });
    });
    if (ok) return nums;
  }
  return null;
}

export function axialToWorld(q, r) {
  return [HEX_R * SPACING * Math.sqrt(3) * (q + r / 2), HEX_R * SPACING * 1.5 * r];
}

/** Outer ring first (counter-clockwise), then inner ring, then the centre. */
function spiralAxial(radius = 2) {
  const out = [];
  for (let k = radius; k >= 1; k--) {
    let q = AXIAL_DIRS[4][0] * k;
    let r = AXIAL_DIRS[4][1] * k;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < k; j++) {
        out.push([q, r]);
        q += AXIAL_DIRS[i][0];
        r += AXIAL_DIRS[i][1];
      }
    }
  }
  out.push([0, 0]);
  return out;
}

/** Camera-facing number label floating above the tile centre, readable from any angle. */
function addToken(tile, number) {
  const y = Math.max(tile.heightAt(0, 0), 0);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tokenTexture(number, true), transparent: true, depthWrite: false }));
  label.scale.set(0.28, 0.28, 1);
  label.position.set(0, y + 0.45, 0);
  label.userData.noAO = true;
  tile.surf.add(label);
}

function makeRobber() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x35312e, roughness: 0.6 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 24), mat);
  body.position.y = 0.12;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 16), mat);
  head.position.y = 0.26;
  g.add(body, head);
  g.userData.robber = true; // pieces never clear it like a prop
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** The robber lives in a tile's surface group, beside the token, and can be moved. */
function createRobber(tiles) {
  const mesh = makeRobber();
  const robber = {
    mesh,
    tile: null,
    moveTo(index) {
      const info = tiles[index];
      const ox = 0.26, oz = 0.12;
      const y = Math.max(info.tile.heightAt(ox, oz), 0);
      info.tile.surf.add(mesh);
      mesh.position.set(ox, y, oz);
      robber.tile = info;
    },
  };
  robber.moveTo(tiles.findIndex((t) => t.type === 'desert'));
  return robber;
}

function addPorts(group, tiles, rand, factory, portTypes) {
  const set = new Set(tiles.map((t) => `${t.q},${t.r}`));
  const edges = [];
  for (const t of tiles) {
    for (const [dq, dr] of AXIAL_DIRS) {
      if (set.has(`${t.q + dq},${t.r + dr}`)) continue;
      const [nx, nz] = axialToWorld(t.q + dq, t.r + dr);
      const len = Math.hypot(nx - t.x, nz - t.z);
      const ux = (nx - t.x) / len, uz = (nz - t.z) / len;
      const mx = t.x + ux * APOTHEM * HEX_R;
      const mz = t.z + uz * APOTHEM * HEX_R;
      edges.push({ mx, mz, ux, uz, ang: Math.atan2(mz, mx) });
    }
  }
  edges.sort((a, b) => a.ang - b.ang);
  const offset = rand.int(3);
  const dockGeo = makeDockGeometry();
  const types = rand.shuffle(portTypes);
  const count = types.length;
  const postGeo = new THREE.CylinderGeometry(0.02, 0.025, 0.55, 7);
  const ports = [];
  for (let i = 0; i < count; i++) {
    const e = edges[(Math.round((i * edges.length) / count) + offset) % edges.length];
    const dock = new THREE.Mesh(dockGeo, factory.planksMat);
    dock.position.set(e.mx, WATER_Y + 0.02, e.mz);
    dock.rotation.y = Math.atan2(-e.uz, e.ux);
    dock.castShadow = true;
    dock.receiveShadow = true;
    group.add(dock);

    // Harbour sign at the end of the dock: a post plus a camera-facing board.
    const type = types[i];
    const px = e.mx + e.ux * 0.62, pz = e.mz + e.uz * 0.62;
    const post = new THREE.Mesh(postGeo, factory.barkMat);
    post.position.set(px, WATER_Y + 0.2, pz);
    post.castShadow = true;
    group.add(post);
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: portSignTexture(type), transparent: true, depthWrite: false }));
    sign.scale.set(0.42, 0.26, 1);
    sign.position.set(px, WATER_Y + 0.6, pz);
    sign.userData.noAO = true;
    group.add(sign);
    ports.push({ type, x: e.mx, z: e.mz, dirX: e.ux, dirZ: e.uz });
  }
  return ports;
}

function addShips(scene, rand, factory, boardRadius) {
  const ships = [];
  const mats = { planks: factory.planksMat, bark: factory.barkMat, cloth: factory.clothMat };
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + rand.range(-0.35, 0.35);
    const radius = rand.range(boardRadius + 1.2, boardRadius + 2.8);
    const ship = makeShip(rand, mats);
    ship.scale.setScalar(rand.range(0.7, 0.85));
    ship.position.set(Math.cos(angle) * radius, WATER_Y - 0.02, Math.sin(angle) * radius);
    scene.add(ship);
    // Ships sail slow loops around the island; a few go the other way.
    const speed = rand.range(0.035, 0.06) * (rand() < 0.35 ? -1 : 1);
    ships.push({ mesh: ship, phase: rand() * Math.PI * 2, baseY: WATER_Y - 0.02, angle, radius, speed });
  }
  return ships;
}

/**
 * Builds the whole board for a variant. Tiles are generated one per animation frame so
 * the loading overlay can report progress. Returns { group, tiles, ships, ports, graph,
 * robber, radius }.
 */
export async function buildBoard(scene, seed, uTime, assets, onProgress = () => {}, variantKey = 'classic') {
  const variant = VARIANTS[variantKey] || VARIANTS.classic;
  const rand = makeRng(seed);
  const factory = new TileFactory(assets, uTime);
  const group = new THREE.Group();
  scene.add(group);

  const terrainList = rand.shuffle(Object.entries(variant.terrain).flatMap(([t, n]) => Array(n).fill(t)));
  const order = variant.rows ? rowsAxial(variant.rows) : spiralAxial(2);
  let numbers = variant.numbers === 'balanced' ? balancedNumbers(order, terrainList, variant.tokens, rand) : null;
  if (!numbers) {
    let k = 0;
    numbers = terrainList.map((t) => (t === 'desert' ? null : variant.tokens[k++]));
  }
  // Centre the layout (rows with an even count sit half a tile off the axis).
  const pts = order.map(([q, r]) => axialToWorld(q, r));
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const tiles = [];

  for (let i = 0; i < order.length; i++) {
    const [q, r] = order[i];
    const type = terrainList[i];
    const tile = factory.build(type, (seed * 31 + i * 7 + 1) >>> 0);
    const x = pts[i][0] - cx, z = pts[i][1] - cz;
    tile.group.position.set(x, -3, z);
    tile.group.userData = { targetY: 0, delay: i * 0.06, time: 0 };
    group.add(tile.group);
    const info = { q, r, type, x, z, tile, number: null };
    if (type !== 'desert') {
      info.number = numbers[i];
      addToken(tile, info.number);
    }
    tiles.push(info);
    onProgress((i + 1) / order.length, type);
    await new Promise((res) => requestAnimationFrame(res));
  }

  const radius = Math.max(...tiles.map((t) => Math.hypot(t.x, t.z))) + HEX_R;
  const ports = addPorts(group, tiles, rand, factory, variant.ports);
  const ships = addShips(scene, rand, factory, radius);
  const graph = buildGraph(tiles);
  const robber = createRobber(tiles);
  return { group, tiles, ships, ports, graph, robber, radius, variant: variantKey };
}
