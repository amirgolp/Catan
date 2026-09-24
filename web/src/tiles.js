// Procedural terrain tiles for the six Catan terrain types, textured with PBR sets.
// Each builder returns { group, surf, heightAt }; `surf` sits on top of the base slab
// and holds props / tokens in surface-local coordinates.
import * as THREE from 'three';
import { Noise2D, makeRng, smoothstep, clamp01 } from './noise.js';
import { HEX_R, BASE_TOP, hexDist, hexCorners, hexBaseGeometry, hexSurfaceGeometry, flatHexGeometry } from './hexGeometry.js';
import { pbrMaterial, terrainMaterial, foliageMaterial } from './materials.js';
import * as P from './props.js';

const TAU = Math.PI * 2;
const col = P.col;
const C = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const rgb = (c) => [c.r, c.g, c.b];
const mixNew = (a, b, t) => new THREE.Color().lerpColors(a, b, clamp01(t));

function angDiff(a, b) {
  const d = a - b;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

function sampleHex(rand, maxD = 0.96) {
  for (;;) {
    const x = rand.range(-1, 1);
    const z = rand.range(-1, 1);
    if (hexDist(x, z) < maxD) return [x, z];
  }
}

// Hex corners (settlement spots) and edge midpoints (road spots) in tile space.
const CORNERS = hexCorners(HEX_R);
const EDGE_MIDS = CORNERS.map(([x, z], i) => {
  const [nx, nz] = CORNERS[(i + 1) % 6];
  return [(x + nx) / 2, (z + nz) / 2];
});

/** True when (x, z) would collide with a piece placed on a corner or an edge. */
function nearPieceSpot(x, z, cornerR = 0.22, edgeR = 0.16) {
  for (const [cx, cz] of CORNERS) if (Math.hypot(x - cx, z - cz) < cornerR) return true;
  for (const [mx, mz] of EDGE_MIDS) if (Math.hypot(x - mx, z - mz) < edgeR) return true;
  return false;
}

function distToPath(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z, bx = pts[i + 1].x, bz = pts[i + 1].z;
    const vx = bx - ax, vz = bz - az;
    const t = clamp01(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz));
    const dx = ax + vx * t - x, dz = az + vz * t - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Shared geometry / materials for all tiles. */
export class TileFactory {
  constructor(assets, uTime) {
    this.uTime = uTime;
    const T = assets.tex;
    const rand = makeRng(4242);
    const noise = new Noise2D(4242);

    this.baseGeo = hexBaseGeometry();
    this.baseMat = pbrMaterial(T.darkWood, { repeat: 1, color: 0x9a8f80 });

    this.mats = {
      fields: terrainMaterial(T.dryGrass, T.soil, { repeatA: 3, repeatB: 4 }),
      pasture: terrainMaterial(T.grass, T.dryGrass, { repeatA: 3, repeatB: 3 }),
      forest: terrainMaterial(T.forestFloor, T.riverbed, { repeatA: 3, repeatB: 3 }),
      mountains: terrainMaterial(T.rock, T.grass, { repeatA: 2.5, repeatB: 3, normalScale: 1.2 }),
      hills: terrainMaterial(T.clay, T.rock, { repeatA: 3, repeatB: 2.5 }),
      desert: terrainMaterial(T.sand, null, { repeatA: 2 }),
    };

    this.planksMat = pbrMaterial(T.planks);
    this.barkMat = pbrMaterial(T.bark);
    this.boulderMat = pbrMaterial(T.boulder, { color: 0x5c5d62 });
    this.redBoulderMat = pbrMaterial(T.boulder, { color: 0xb8704e });
    this.clothMat = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 1, side: THREE.DoubleSide });
    this.plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.sheepMat = P.makeSheepMaterial(uTime);

    const water = assets.waterNormals.clone();
    water.repeat.set(1.5, 1.5);
    water.needsUpdate = true;
    this.waterMat = new THREE.MeshStandardMaterial({
      color: 0x2a8db0, normalMap: water, normalScale: new THREE.Vector2(0.25, 0.25),
      roughness: 0.06, metalness: 0, transparent: true, opacity: 0.88, envMapIntensity: 1.2,
    });
    this.waterGeo = flatHexGeometry(HEX_R * 0.995);

    this.grassTex = P.tuftTexture('grass', 11);
    this.wheatTex = P.tuftTexture('wheat', 12);
    this.shrubTex = P.tuftTexture('shrub', 13);
    this.leafTex = P.leafAtlasTexture(21, 512, 105);
    this.leafTex2 = P.leafAtlasTexture(22, 512, 90);
    this.grassMat = foliageMaterial(this.grassTex, uTime, { sway: 0.3 });
    this.wheatMat = foliageMaterial(this.wheatTex, uTime, { sway: 0.35 });
    this.shrubMat = foliageMaterial(this.shrubTex, uTime, { sway: 0.15 });
    this.leafMat = foliageMaterial(this.leafTex, uTime, { sway: 0.04 });
    this.leafMat2 = foliageMaterial(this.leafTex2, uTime, { sway: 0.04 });
    this.treeMats = [this.barkMat, this.leafMat];
    this.treeMats2 = [this.barkMat, this.leafMat2];

    this.tuftGeo = P.tuftGeometry(0.17, 0.15);
    this.wheatGeo = P.tuftGeometry(0.15, 0.2);
    this.forestTrees = [
      { shape: 'round', canopyR: 0.1, trunkH: 0.13, blobs: 3 },
      { shape: 'conical', canopyR: 0.085, trunkH: 0.12, blobs: 4 },
      { shape: 'wide', canopyR: 0.095, trunkH: 0.14, blobs: 4 },
    ].map((o) => P.makeTreeGeometry(rand, noise, { trunkR: 0.016, cardsPerBlob: 16, ...o }));
    this.bigTrees = [
      { shape: 'round', canopyR: 0.2, trunkH: 0.22, blobs: 5 },
      { shape: 'wide', canopyR: 0.19, trunkH: 0.2, blobs: 5 },
    ].map((o) => P.makeTreeGeometry(rand, noise, { trunkR: 0.03, cardsPerBlob: 20, ...o }));
    this.rocks = [0, 1, 2, 3].map(() => P.makeRockGeometry(rand, noise));
    this.sheep = P.makeSheepGeometry(rand);
    this.log = P.makeLogGeometry();
    this.flower = P.makeFlowerGeometry(rand);
    this.mineFrame = P.makeMineFrameGeometry();
    this.mistMat = P.makeMistMaterial(uTime);
    this.mistGeo = this.flower; // Use the small sphere for mist puffs
  }

  build(type, seed) {
    switch (type) {
      case 'fields': return buildFields(this, seed);
      case 'forest': return buildForest(this, seed);
      case 'pasture': return buildPasture(this, seed);
      case 'hills': return buildHills(this, seed);
      case 'mountains': return buildMountains(this, seed);
      case 'desert': return buildDesert(this, seed);
      default: throw new Error('unknown tile type ' + type);
    }
  }
}

/* ------------------------------------------------------------------ scaffold */

function makeTile(f, { type, height, color, blend, skirtColor, props }) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(f.baseGeo, f.baseMat);
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const surf = new THREE.Group();
  surf.position.y = BASE_TOP;
  group.add(surf);

  const geo = hexSurfaceGeometry({ height, color, blend, skirtColor: rgb(col(skirtColor)) });
  const mesh = new THREE.Mesh(geo, f.mats[type]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  surf.add(mesh);

  const add = (m) => { if (m) surf.add(m); };
  props(surf, add);

  return { group, surf, heightAt: (x, z) => height(x, z, { d: hexDist(x, z) }) };
}

// Slightly above the base slab's top cap (surface-local y = 0) so the two never z-fight.
function addWaterLevel(f, surf, y = 0.008) {
  const w = new THREE.Mesh(f.waterGeo, f.waterMat);
  w.position.y = y;
  w.receiveShadow = true;
  surf.add(w);
}

function treeTint(rand) {
  const b = rand.range(0.8, 1.1);
  return mixNew(new THREE.Color(b, b, b), col(0xd8e6a0), rand() * 0.3);
}

/**
 * Ease terrain that rises above the flat baseline down toward the rim so no tile
 * ends in a sheer wall. Carved water channels (below the baseline) are left alone
 * so rivers still reach the edge.
 */
function taperEdge(baseHeight, baseline = 0.03) {
  return (x, z, ctx) => {
    const c = ctx || { d: hexDist(x, z) };
    const h = baseHeight(x, z, c);
    if (h <= baseline) return h;
    return baseline + (h - baseline) * smoothstep(1.0, 0.9, c.d);
  };
}

function tintNoise(noise, x, z, amount = 0.12, scale = 3) {
  const n = noise.fbm(x * scale + 5, z * scale + 9, 3);
  const f = 1 + n * amount;
  return [f, f, f];
}

/* ------------------------------------------------------------------ FIELDS (grain) */

function buildFields(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const ang = rand() * TAU;
  const pc = [Math.cos(ang) * 0.42, Math.sin(ang) * 0.42];
  const fd = ang + Math.PI / 2 + rand.range(-0.4, 0.4);
  const fdx = Math.cos(fd), fdz = Math.sin(fd);

  const flavor = Math.floor(rand() * 3);
  let plough;
  if (flavor === 2) {
    plough = (x, z) => {
      const dist = Math.abs(x * Math.cos(ang) + z * Math.sin(ang));
      const isPath = smoothstep(0.1, 0.15, dist);
      return smoothstep(0.93, 0.82, hexDist(x, z)) * isPath;
    };
  } else {
    plough = (x, z) => {
      const dist = Math.hypot(x - pc[0], z - pc[1]) + noise.fbm(x * 2.5 + 31, z * 2.5 + 17, 3) * 0.2;
      return smoothstep(0.68, 0.58, dist) * smoothstep(0.93, 0.82, hexDist(x, z));
    };
  }
  
  let furrow;
  if (flavor === 0) furrow = (x, z) => Math.sin(Math.hypot(x - pc[0], z - pc[1]) * 60);
  else furrow = (x, z) => Math.sin((x * fdx + z * fdz) * 60);

  let height = (x, z) => {
    const p = plough(x, z);
    return 0.035 + noise.fbm(x * 1.6, z * 1.6, 3) * 0.02 + p * (-0.025 + furrow(x, z) * 0.012);
  };
  const GOLD = col(0xf2d27a);
  const color = (x, z) => {
    const p = plough(x, z);
    const [f0] = tintNoise(noise, x, z, 0.15);
    C.lerpColors(GOLD, WHITE, p).multiplyScalar(f0);
    return rgb(C);
  };
  const blend = (x, z) => plough(x, z);

  height = taperEdge(height);
  return makeTile(f, {
    type: 'fields', height, color, blend, skirtColor: 0x6b5a3a,
    props(surf, add) {
      const GA = col(0xffffff), GB = col(0xd9b070);
      add(P.scatter({
        geometry: f.wheatGeo, material: f.wheatMat, count: 2600, castShadow: false, noAO: true,
        place: () => {
          const [x, z] = sampleHex(rand, 0.95);
          if (rand() < plough(x, z) + 0.02) return null;
          if (Math.hypot(x, z) < 0.21 || nearPieceSpot(x, z, 0.18, 0.13)) return null;
          return {
            x, z, y: height(x, z) - 0.01,
            scale: [rand.range(0.8, 1.2), rand.range(0.8, 1.25), rand.range(0.8, 1.2)],
            rotY: rand() * TAU, color: mixNew(GA, GB, rand()),
          };
        },
      }));
      add(P.scatter({
        geometry: f.flower, material: f.plainMat, count: 160, castShadow: false,
        place: () => {
          const [x, z] = sampleHex(rand, 0.95);
          if (rand() < plough(x, z) + 0.1) return null;
          return { x, z, y: height(x, z) + 0.13 * rand.range(0.5, 1), scale: rand.range(0.5, 0.9) };
        },
      }));
      add(P.scatter({
        geometry: f.bigTrees[0], material: f.treeMats, count: 2, receiveShadow: false, noAO: true,
        place: () => {
          const a = ang + Math.PI + rand.range(-0.7, 0.7);
          const r = rand.range(0.5, 0.72);
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          if (plough(x, z) < 0.5 || nearPieceSpot(x, z, 0.3, 0.22)) return null;
          return { x, z, y: height(x, z) - 0.02, scale: rand.range(0.9, 1.2), rotY: rand() * TAU, color: treeTint(rand) };
        },
      }));
    },
  });
}

/* ------------------------------------------------------------------ PASTURE (wool) */

function buildPasture(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const flavor = Math.floor(rand() * 3);
  let height;
  let hasPond = false;
  if (flavor === 0) {
    height = (x, z) => 0.035 + noise.fbm(x * 1.8, z * 1.8, 3) * 0.028;
  } else if (flavor === 1) {
    height = (x, z) => {
      const d = Math.hypot(x, z);
      return 0.035 + smoothstep(0.6, 0.1, d) * 0.15 + noise.fbm(x * 2, z * 2, 2) * 0.02;
    };
  } else {
    hasPond = true;
    height = (x, z) => {
      const d = Math.hypot(x, z);
      const pond = smoothstep(0.3, 0.2, d);
      return 0.035 + noise.fbm(x * 1.8, z * 1.8, 3) * 0.028 - pond * 0.08;
    };
  }

  const color = (x, z) => tintNoise(noise, x, z, 0.12);
  const blend = (x, z) => clamp01(noise.fbm(x * 2 + 40, z * 2 + 3, 3) * 1.4) * 0.6;
  height = taperEdge(height);
  return makeTile(f, {
    type: 'pasture', height, color, blend, skirtColor: 0x5a4a30,
    props(surf, add) {
      if (hasPond) addWaterLevel(f, surf);
      const BA = col(0xffffff), BB = col(0xb8d890);
      add(P.scatter({
        geometry: f.tuftGeo, material: f.grassMat, count: 2000, castShadow: false, noAO: true,
        place: () => {
          const [x, z] = sampleHex(rand, 0.95);
          if (Math.hypot(x, z) < 0.2 || nearPieceSpot(x, z, 0.18, 0.13)) return null;
          if (hasPond && Math.hypot(x, z) < 0.3) return null;
          return {
            x, z, y: height(x, z) - 0.01,
            scale: [rand.range(0.7, 1.1), rand.range(0.5, 0.9), rand.range(0.7, 1.1)],
            rotY: rand() * TAU, color: mixNew(BA, BB, rand()),
          };
        },
      }));
      add(P.scatter({
        geometry: f.sheep, material: f.sheepMat, count: 7,
        place: () => {
          const [x, z] = sampleHex(rand, 0.85);
          if (Math.hypot(x, z) < 0.3 && !hasPond) return null;
          if (hasPond && Math.hypot(x, z) < 0.2) return null;
          return { x, z, y: height(x, z), scale: rand.range(0.6, 0.75), rotY: rand() * TAU };
        },
      }));
      add(P.scatter({
        geometry: f.flower, material: f.plainMat, count: 60, castShadow: false,
        place: () => {
          const [x, z] = sampleHex(rand, 0.95);
          if (hasPond && Math.hypot(x, z) < 0.3) return null;
          return { x, z, y: height(x, z) + 0.05, scale: rand.range(0.45, 0.7), color: col(0xfff2a8) };
        },
      }));
      add(P.scatter({
        geometry: f.bigTrees[1], material: f.treeMats2, count: 3, receiveShadow: false, noAO: true,
        place: () => {
          const [x, z] = sampleHex(rand, 0.85);
          if (Math.hypot(x, z) < 0.5 || nearPieceSpot(x, z, 0.3, 0.22)) return null;
          return { x, z, y: height(x, z) - 0.02, scale: rand.range(0.7, 1.0), rotY: rand() * TAU, color: treeTint(rand) };
        },
      }));
    },
  });
}

/* ------------------------------------------------------------------ FOREST (lumber) */

function makeRiver(rand) {
  const a1 = rand() * TAU;
  const a2 = a1 + Math.PI + rand.range(-0.9, 0.9);
  const p0 = new THREE.Vector3(Math.cos(a1) * 1.2, 0, Math.sin(a1) * 1.2);
  const p3 = new THREE.Vector3(Math.cos(a2) * 1.2, 0, Math.sin(a2) * 1.2);
  const perp = new THREE.Vector3(-(p3.z - p0.z), 0, p3.x - p0.x).normalize();
  const mid = p0.clone().lerp(p3, 0.5);
  if (perp.dot(mid) < 0) perp.negate();
  const p1 = p0.clone().lerp(p3, 0.33).addScaledVector(perp, rand.range(0.3, 0.5));
  const p2 = p0.clone().lerp(p3, 0.66).addScaledVector(perp, rand.range(0.3, 0.5));
  return new THREE.CatmullRomCurve3([p0, p1, p2, p3]).getPoints(30);
}

function buildForest(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const flavor = Math.floor(rand() * 3);
  let riverMask = () => 0;
  let clearing = () => 0;
  let ridge = () => 0;

  if (flavor === 0) {
    const rivers = [makeRiver(rand), makeRiver(rand)];
    const riverD = (x, z) => Math.min(distToPath(rivers[0], x, z), distToPath(rivers[1], x, z));
    riverMask = (x, z) => {
      const w = 0.09 + noise.fbm(x * 3, z * 3, 2) * 0.02;
      return smoothstep(w + 0.07, w - 0.01, riverD(x, z));
    };
    clearing = (x, z) => smoothstep(0.32, 0.2, Math.hypot(x, z) + noise.fbm(x * 4, z * 4, 2) * 0.05);
  } else if (flavor === 1) {
    clearing = (x, z) => smoothstep(0.45, 0.25, Math.hypot(x, z) + noise.fbm(x * 4, z * 4, 2) * 0.05);
  } else if (flavor === 2) {
    const a = rand() * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    ridge = (x, z) => {
      const d = Math.abs(x * ca + z * sa);
      return smoothstep(0.4, 0.1, d);
    };
  }

  let height = (x, z) =>
    0.075 + noise.fbm(x * 2, z * 2, 3) * 0.035 - riverMask(x, z) * 0.15 - clearing(x, z) * 0.02 + ridge(x, z) * 0.1;

  const color = (x, z) => {
    const [t] = tintNoise(noise, x, z, 0.15);
    const rm = riverMask(x, z);
    const wet = 1 - 0.35 * smoothstep(0.5, 0.9, rm);
    return [t * wet, t * wet, t * wet];
  };
  const blend = (x, z) => smoothstep(0.02, 0.45, riverMask(x, z)) + ridge(x, z) * 0.8;

  height = taperEdge(height);
  return makeTile(f, {
    type: 'forest', height, color, blend, skirtColor: 0x4a3a26,
    props(surf, add) {
      if (flavor === 0) addWaterLevel(f, surf);
      for (let v = 0; v < 3; v++) {
        add(P.scatter({
          geometry: f.forestTrees[v], material: v === 1 ? f.treeMats2 : f.treeMats, count: 150, receiveShadow: false, noAO: true,
          place: () => {
            const [x, z] = sampleHex(rand, 0.95);
            if (riverMask(x, z) > 0.05) return null;
            if (clearing(x, z) > 0.1 || nearPieceSpot(x, z, 0.24, 0.17)) return null;
            if (Math.hypot(x, z) < 0.3 && flavor === 0) return null;
            return { x, z, y: height(x, z) - 0.03, scale: rand.range(0.7, 1.3), rotY: rand() * TAU, color: treeTint(rand) };
          },
        }));
      }
      
      const logCount = flavor === 1 ? 12 : 4;
      add(P.scatter({
        geometry: f.log, material: f.barkMat, count: logCount,
        place: () => {
          if (flavor === 1) {
             const a = rand() * TAU, r = rand.range(0.05, 0.35);
             const x = Math.cos(a) * r, z = Math.sin(a) * r;
             return { x, z, y: height(x, z), rotY: rand() * TAU, scale: rand.range(0.7, 1) };
          } else {
             const a = rand() * TAU, r = rand.range(0.05, 0.22);
             const x = Math.cos(a) * r, z = Math.sin(a) * r;
             if (riverMask(x, z) > 0.05) return null;
             return { x, z, y: height(x, z), rotY: rand() * TAU, scale: rand.range(0.7, 1) };
          }
        },
      }));
    },
  });
}

/* ------------------------------------------------------------------ MOUNTAINS (ore) */

function buildMountains(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const flavor = Math.floor(rand() * 3);
  let gapAng = rand() * TAU;
  let gx = Math.cos(gapAng), gz = Math.sin(gapAng);

  const rim = (d) => smoothstep(0.42, 0.56, d) * smoothstep(0.92, 0.78, d);
  const gap = (x, z) => smoothstep(0.85, 0.3, angDiff(Math.atan2(z, x), gapAng));
  let rock = (x, z, d) => rim(d) * (1 - 0.92 * gap(x, z)) * (0.35 + 0.65 * noise.ridged(x * 2.4 + 3, z * 2.4 + 1, 4));
  let channel = (x, z) => 0;
  let lake = (d) => 0;
  let height = () => 0;
  let hasWater = false;

  if (flavor === 0) {
    hasWater = true;
    channel = (x, z) => {
      const along = x * gx + z * gz;
      if (along < 0) return 0;
      const perp = Math.abs(-x * gz + z * gx) + noise.fbm(x * 4, z * 4, 2) * 0.03;
      return smoothstep(0.11, 0.04, perp) * smoothstep(0.1, 0.3, along);
    };
    lake = (d) => smoothstep(0.5, 0.3, d);
    height = (x, z, ctx) => 0.05 + noise.fbm(x * 3, z * 3, 2) * 0.01 + rock(x, z, ctx.d) * 0.42 - Math.max(lake(ctx.d) * 0.1, channel(x, z) * 0.09);
  } else if (flavor === 1) {
    hasWater = true;
    rock = (x, z, d) => {
      const peak = smoothstep(1.5, 0.0, Math.hypot(x + gx * 0.4, z + gz * 0.4));
      return (rim(d) * 0.3 + peak * 0.9) * (0.35 + 0.65 * noise.ridged(x * 2.4 + 3, z * 2.4 + 1, 4));
    };
    channel = (x, z) => {
      const along = x * -gx + z * -gz;
      const perp = Math.abs(-x * gz + z * gx) + noise.fbm(x * 4, z * 4, 2) * 0.03;
      return smoothstep(0.15, 0.02, perp) * smoothstep(0.3, 0.8, along);
    };
    height = (x, z, ctx) => 0.05 + noise.fbm(x * 3, z * 3, 2) * 0.01 + rock(x, z, ctx.d) * 0.8 - channel(x, z) * 0.09;
  } else {
    rock = (x, z, d) => rim(d) * (0.35 + 0.65 * noise.ridged(x * 2.4 + 3, z * 2.4 + 1, 4));
    const pit = (x, z) => smoothstep(0.4, 0.1, Math.hypot(x, z));
    height = (x, z, ctx) => 0.05 + noise.fbm(x * 3, z * 3, 2) * 0.01 + rock(x, z, ctx.d) * 0.42 - pit(x, z) * 0.4;
  }

  const rockiness = (x, z, slope, d) => clamp01(rock(x, z, d) * 2.5 + slope * 0.8 + lake(d) * 0.6);
  const GRAY = col(0x5a6068);
  const color = (x, z, y, slope, ctx) => {
    const [t] = tintNoise(noise, x, z, 0.12, 4);
    const wet = hasWater ? 1 - 0.3 * smoothstep(0.02, -0.03, y) : 1;
    C.lerpColors(WHITE, GRAY, rockiness(x, z, slope, ctx.d)).multiplyScalar(t * wet);
    return rgb(C);
  };
  const blend = (x, z, y, slope, ctx) => 1 - rockiness(x, z, slope, ctx.d);

  height = taperEdge(height);
  return makeTile(f, {
    type: 'mountains', height, color, blend, skirtColor: 0x4a4644,
    props(surf, add) {
      if (hasWater) addWaterLevel(f, surf);
      for (let v = 0; v < 4; v++) {
        add(P.scatter({
          geometry: f.rocks[v], material: f.boulderMat, count: 34,
          place: () => {
            const [x, z] = sampleHex(rand, 0.9);
            const d = hexDist(x, z);
            const w = flavor === 1 ? rock(x, z, d) : rim(d) * (1 - gap(x, z));
            if (rand() > w || lake(d) > 0.05 || channel(x, z) > 0.3) return null;
            const s = rand() < 0.12 ? rand.range(0.17, 0.25) : rand.range(0.05, 0.15);
            return {
              x, z, y: height(x, z) - s * 0.3, scale: [s * rand.range(0.8, 1.2), s, s * rand.range(0.8, 1.2)],
              rotY: rand() * TAU, tiltX: rand.range(-0.3, 0.3), tiltZ: rand.range(-0.3, 0.3),
              color: mixNew(col(0xffffff), col(0x9aa0aa), rand()),
            };
          },
        }));
      }
      add(P.scatter({
        geometry: f.rocks[0], material: f.boulderMat, count: 40,
        place: () => {
          const [x, z] = sampleHex(rand, 0.9);
          const d = hexDist(x, z);
          if (lake(d) < 0.2 && channel(x, z) < 0.3) return null;
          const s = rand.range(0.02, 0.05);
          return { x, z, y: height(x, z) + s * 0.2, scale: s, rotY: rand() * TAU };
        },
      }));
      if (flavor === 2) {
        add(P.scatter({
          geometry: f.mineFrame, material: f.planksMat, count: 5,
          place: () => {
            const [x, z] = sampleHex(rand, 0.7);
            const d = hexDist(x, z);
            if (d < 0.3) return null;
            return { x, z, y: height(x, z) - 0.005, scale: rand.range(0.6, 0.9), rotY: rand() * TAU };
          },
        }));
      }
      const BA = col(0xffffff), BB = col(0xb8d890);
      add(P.scatter({
        geometry: f.tuftGeo, material: f.grassMat, count: 900, castShadow: false, noAO: true,
        place: () => {
          const [x, z] = sampleHex(rand, 0.95);
          const d = hexDist(x, z);
          if (d < 0.8 || rock(x, z, d) > 0.06 || channel(x, z) > 0.2 || nearPieceSpot(x, z, 0.18, 0.13)) return null;
          return { x, z, y: height(x, z) - 0.01, scale: [1, rand.range(0.5, 0.8), 1], rotY: rand() * TAU, color: mixNew(BA, BB, rand()) };
        },
      }));
      if (flavor === 0) {
        add(P.scatter({
          geometry: f.mistGeo, material: f.mistMat, count: 45, castShadow: false, receiveShadow: false,
          place: () => {
            const [x, z] = sampleHex(rand, 0.6);
            const d = hexDist(x, z);
            if (lake(d) < 0.1 && channel(x, z) < 0.1) return null;
            return { x, z, y: height(x, z) + 0.05 + rand.range(0, 0.1), scale: rand.range(2, 4) };
          },
        }));
      }
    },
  });
}

/* ------------------------------------------------------------------ HILLS (brick) */

function buildHills(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const a0 = rand() * TAU;
  
  const flavor = Math.floor(rand() * 3);
  let height;
  let plateau = () => 0;

  if (flavor === 0) {
    const arc = rand.range(3.6, 4.4);
    const arcMask = (x, z) => {
      let t = ((Math.atan2(z, x) - a0) % TAU + TAU) % TAU;
      return smoothstep(0, 0.3, t) * smoothstep(arc, arc - 0.3, t);
    };
    plateau = (x, z, d) => {
      const j = noise.fbm(x * 3 + 8, z * 3 + 2, 3) * 0.05;
      return smoothstep(0.37, 0.45, d + j) * smoothstep(0.86, 0.78, d + j) * arcMask(x, z);
    };
    height = (x, z, ctx) => 0.03 + noise.fbm(x*5, z*5, 3)*0.008 + plateau(x, z, ctx.d) * (0.27 + 0.05 * noise.fbm(x*4+1, z*4+3, 3));
  } else if (flavor === 1) {
    plateau = (x, z, d) => {
       const j = noise.fbm(x * 2, z * 2, 2) * 0.05;
       const rad = d + j;
       const t1 = smoothstep(0.9, 0.8, rad);
       const t2 = smoothstep(0.6, 0.5, rad);
       const t3 = smoothstep(0.3, 0.2, rad);
       return (t1 + t2 + t3) * 0.33;
    };
    height = (x, z, ctx) => 0.03 + noise.fbm(x*3, z*3, 2)*0.01 + plateau(x, z, ctx.d) * 0.35;
  } else {
    const p1x = Math.cos(a0)*0.4, p1z = Math.sin(a0)*0.4;
    const p2x = Math.cos(a0+Math.PI)*0.4, p2z = Math.sin(a0+Math.PI)*0.4;
    plateau = (x, z) => {
       const d1 = Math.hypot(x-p1x, z-p1z);
       const d2 = Math.hypot(x-p2x, z-p2z);
       return smoothstep(0.5, 0.0, d1) + smoothstep(0.5, 0.0, d2);
    };
    height = (x, z) => 0.03 + noise.fbm(x*3, z*3, 2)*0.01 + plateau(x, z) * 0.35;
  }

  const RED = col(0xd08a6a);
  const color = (x, z, y, slope) => {
    const [t] = tintNoise(noise, x, z, 0.12, 4);
    C.lerpColors(WHITE, RED, 0.35 + 0.4 * smoothstep(0.6, 2.2, slope)).multiplyScalar(t);
    return rgb(C);
  };
  const blend = (x, z, y, slope, ctx) =>
    clamp01(smoothstep(0.5, 1.8, slope) + plateau(x, z, ctx.d) * 0.35 * (noise.fbm(x * 6, z * 6, 2) * 0.5 + 0.5));

  height = taperEdge(height);
  return makeTile(f, {
    type: 'hills', height, color, blend, skirtColor: 0x7a3a26,
    props(surf, add) {
      if (flavor === 0 || flavor === 1) {
        const spin = rand() * TAU;
        for (const [ox, oz] of [[0.28, 0.04], [-0.26, -0.08]]) {
          const x = ox * Math.cos(spin) - oz * Math.sin(spin);
          const z = ox * Math.sin(spin) + oz * Math.cos(spin);
          const m = new THREE.Mesh(f.mineFrame, f.planksMat);
          m.position.set(x, height(x, z) - 0.005, z);
          m.rotation.y = rand() * TAU;
          m.scale.setScalar(rand.range(0.8, 0.9));
          m.castShadow = true;
          m.receiveShadow = true;
          surf.add(m);
        }
      }
      for (let v = 0; v < 2; v++) {
        add(P.scatter({
          geometry: f.rocks[v + 1], material: f.redBoulderMat, count: 30,
          place: () => {
            const [x, z] = sampleHex(rand, 0.93);
            const d = hexDist(x, z);
            if (Math.hypot(x, z) < 0.24 && flavor === 0) return null;
            const p = plateau(x, z, d);
            const s = p > 0.5 ? rand.range(0.03, 0.09) : rand.range(0.02, 0.05);
            return { x, z, y: height(x, z) + s * 0.1, scale: [s * rand.range(0.8, 1.3), s * 0.8, s], rotY: rand() * TAU };
          },
        }));
      }
    },
  });
}

/* ------------------------------------------------------------------ DESERT */

function buildDesert(f, seed) {
  const rand = makeRng(seed);
  const noise = new Noise2D(seed);
  const ang = rand() * Math.PI;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let height = (x, z) => {
    const u = x * ca - z * sa, v = x * sa + z * ca;
    const r = noise.ridged(u * 0.8 + 2, v * 2.0 + 5, 4);
    return 0.03 + 0.12 * Math.pow(r, 1.6) + noise.fbm(x * 6, z * 6, 2) * 0.004;
  };
  const SAND = col(0xe8cfa0);
  const color = (x, z, y, slope) => {
    const [t] = tintNoise(noise, x, z, 0.08);
    const f0 = t * (0.9 + y * 1.0) * (1 - 0.12 * smoothstep(0.5, 1.6, slope));
    return [SAND.r * f0, SAND.g * f0, SAND.b * f0];
  };
  height = taperEdge(height);
  return makeTile(f, {
    type: 'desert', height, color, blend: () => 0, skirtColor: 0xa08a64,
    props(surf, add) {
      const centers = [];
      for (let i = 0; i < 7; i++) centers.push(sampleHex(rand, 0.85));
      add(P.scatter({
        geometry: f.tuftGeo, material: f.shrubMat, count: 7 * 8, castShadow: false, noAO: true,
        place: (i) => {
          const [cx, cz] = centers[Math.floor(i / 8)];
          const x = cx + rand.range(-0.05, 0.05), z = cz + rand.range(-0.05, 0.05);
          return { x, z, y: height(x, z) - 0.005, scale: [1.1, rand.range(0.6, 1.0), 1.1], rotY: rand() * TAU };
        },
      }));
    },
  });
}
