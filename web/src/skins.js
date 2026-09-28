// Piece skins: every skin supplies a settlement (hut), a city (house) and a road model plus
// a material palette. Skins are cosmetic only; which ones a player may equip is decided by
// the account's owned list (see SKINS[].price and the lobby store).
//
// All models share six material slots so one merged geometry per piece can be drawn with a
// material array:
//   0 paint  – the player's colour
//   1 accent – a darker shade of the player's colour (roofs)
//   2 stone  3 wood  4 glass (lit windows)  5 trim (thatch, gold, ...)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SLOT = { paint: 0, accent: 1, stone: 2, wood: 3, glass: 4, trim: 5 };

import { SKINS, DEFAULT_SKIN } from './catalog.js';

export { SKINS, DEFAULT_SKIN };

/* ------------------------------------------------------------------ part builder */

class Parts {
  constructor() { this.lists = Object.keys(SLOT).map(() => []); }
  add(kind, g) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    this.lists[SLOT[kind]].push(geo);
    return geo;
  }
  box(kind, w, h, d, x, y, z, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(ry);
    g.translate(x, y + h / 2, z);
    return this.add(kind, g);
  }
  cyl(kind, rTop, rBottom, h, x, y, z, seg = 12) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
    g.translate(x, y + h / 2, z);
    return this.add(kind, g);
  }
  /** Triangular prism, ridge along x: span d across z, height h, length w. */
  prism(kind, w, d, h, x, y, z) {
    const shape = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    g.translate(x - w / 2, y, z);
    return this.add(kind, g);
  }
  /** Gable roof of two slabs with eaves overhang and a ridge cap, over walls w x d. */
  roof(kind, x, z, w, d, baseY, h, oh = 0.02, t = 0.016) {
    const a = Math.atan2(h, d / 2);
    const s = d / 2 + oh;
    const L = s / Math.cos(a);
    const ridgeY = baseY + h;
    for (const side of [1, -1]) {
      const g = new THREE.BoxGeometry(w + oh * 2, t, L);
      g.translate(0, t / 2, 0);
      g.rotateX(side * a);
      g.translate(x, ridgeY - (s / 2) * Math.tan(a), z + side * (s / 2));
      this.add(kind, g);
    }
    const cap = new THREE.BoxGeometry(w + oh * 2 + 0.006, t * 1.3, t * 1.7);
    cap.rotateX(Math.PI / 4);
    cap.translate(x, ridgeY + t * 0.6, z);
    this.add(kind, cap);
  }
  /** Walls plus gable ends and a roof. */
  house(wallKind, roofKind, x, z, w, d, wallH, roofH, y = 0) {
    this.box(wallKind, w, wallH, d, x, y, z);
    this.prism(wallKind, w, d, roofH, x, y + wallH, z);
    this.roof(roofKind, x, z, w, d, y + wallH, roofH);
  }
  /**
   * Window pane with a sill. (x, z) are relative to a wall facing +z; ry turns it to
   * another wall and (cx, cz) is the centre of the building it belongs to.
   */
  window(x, y, z, ry = 0, cx = 0, cz = 0, w = 0.032, h = 0.036, sill = 'stone') {
    const pane = new THREE.BoxGeometry(w, h, 0.008);
    const ledge = new THREE.BoxGeometry(w + 0.012, 0.007, 0.014);
    pane.translate(x, y + h / 2, z);
    ledge.translate(x, y - 0.0035, z + 0.003);
    for (const g of [pane, ledge]) { g.rotateY(ry); g.translate(cx, 0, cz); }
    this.add('glass', pane);
    this.add(sill, ledge);
  }
  build() {
    const merged = this.lists.map((list) => (list.length ? mergeGeometries(list, false) : null));
    // keep all six groups in slot order, even when a skin leaves a slot unused
    const filler = () => { const g = new THREE.BoxGeometry(0.0001, 0.0001, 0.0001).toNonIndexed(); g.translate(0, -1, 0); return g; };
    const g = mergeGeometries(merged.map((m) => m || filler()), true);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ Village (default) */

/** Round hut: stone footing, wattle walls in the player's colour, dyed thatch cone. */
function villageHut() {
  const p = new Parts();
  p.cyl('stone', 0.165, 0.175, 0.035, 0, 0, 0, 14);
  p.cyl('paint', 0.14, 0.145, 0.13, 0, 0.035, 0, 14);
  p.cyl('trim', 0.2, 0.205, 0.02, 0, 0.155, 0, 14); // thatch eave
  const roof = new THREE.ConeGeometry(0.2, 0.19, 14, 1, true);
  roof.translate(0, 0.165 + 0.095, 0);
  p.add('accent', roof);
  const under = new THREE.CircleGeometry(0.2, 14);
  under.rotateX(Math.PI / 2);
  under.translate(0, 0.166, 0);
  p.add('trim', under);
  p.cyl('trim', 0.018, 0.03, 0.035, 0, 0.345, 0, 8); // thatch knot
  p.box('wood', 0.05, 0.085, 0.02, 0, 0.035, 0.137); // door
  p.box('wood', 0.07, 0.012, 0.024, 0, 0.12, 0.14); // lintel
  p.window(0, 0.085, 0.142, Math.PI / 2, 0, 0, 0.03, 0.03, 'wood');
  p.window(0, 0.085, 0.142, -Math.PI / 2, 0, 0, 0.03, 0.03, 'wood');
  return p.build();
}

/** Two-storey timber-framed house: stone ground floor, painted upper floor, steep roof. */
function villageHouse() {
  const p = new Parts();
  const w = 0.38, d = 0.26;
  p.box('stone', w + 0.06, 0.03, d + 0.06, 0, 0, 0);
  p.box('stone', w, 0.14, d, 0, 0.03, 0); // ground floor
  p.box('wood', w + 0.03, 0.02, d + 0.03, 0, 0.17, 0); // floor beam
  p.box('paint', w + 0.02, 0.12, d + 0.02, 0, 0.19, 0); // jettied upper floor
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) p.box('wood', 0.018, 0.12, 0.018, sx * (w / 2 + 0.005), 0.19, sz * (d / 2 + 0.005));
  for (const x of [-0.06, 0.06]) { p.box('wood', 0.012, 0.12, 0.006, x, 0.19, d / 2 + 0.012); p.box('wood', 0.012, 0.12, 0.006, x, 0.19, -d / 2 - 0.012); }
  p.prism('paint', w + 0.02, d + 0.02, 0.17, 0, 0.31, 0);
  p.roof('accent', 0, 0, w + 0.02, d + 0.02, 0.31, 0.17, 0.028, 0.02);
  p.box('stone', 0.05, 0.2, 0.05, 0.11, 0.33, -0.05); // chimney
  p.box('stone', 0.062, 0.014, 0.062, 0.11, 0.53, -0.05);
  p.box('wood', 0.06, 0.1, 0.01, -0.09, 0.03, d / 2 + 0.004); // door
  p.box('wood', 0.08, 0.014, 0.02, -0.09, 0.132, d / 2 + 0.008); // door hood
  p.window(0.1, 0.075, d / 2 + 0.004);
  p.window(-0.12, 0.225, d / 2 + 0.012);
  p.window(0, 0.225, d / 2 + 0.012);
  p.window(0.12, 0.225, d / 2 + 0.012);
  for (const x of [-0.12, 0.12]) { p.window(x, 0.075, d / 2 + 0.004, Math.PI); p.window(x, 0.225, d / 2 + 0.012, Math.PI); }
  p.window(0, 0.225, w / 2 + 0.012, Math.PI / 2);
  p.window(0, 0.225, w / 2 + 0.012, -Math.PI / 2);
  p.window(0, 0.34, w / 2 + 0.012, Math.PI / 2, 0, 0, 0.026, 0.03); // attic
  return p.build();
}

/* ------------------------------------------------------------------ Stonework */

function stoneCottage() {
  const p = new Parts();
  const w = 0.28, d = 0.2;
  p.box('stone', w + 0.05, 0.03, d + 0.05, 0, 0, 0);
  p.house('stone', 'paint', 0, 0, w, d, 0.14, 0.12, 0.03);
  p.box('stone', 0.04, 0.14, 0.04, 0.08, 0.18, -0.04);
  p.box('wood', 0.05, 0.085, 0.01, 0, 0.03, d / 2 + 0.003);
  for (const x of [-0.085, 0.085]) { p.window(x, 0.09, d / 2 + 0.003); p.window(x, 0.09, d / 2 + 0.003, Math.PI); }
  p.window(0, 0.09, w / 2 + 0.003, Math.PI / 2);
  p.window(0, 0.09, w / 2 + 0.003, -Math.PI / 2);
  return p.build();
}

function stoneKeep() {
  const p = new Parts();
  p.box('stone', 0.48, 0.03, 0.3, 0, 0, 0);
  const hx = 0.08, hw = 0.25, hd = 0.2;
  p.house('stone', 'paint', hx, 0, hw, hd, 0.16, 0.12, 0.03);
  p.box('wood', 0.056, 0.1, 0.01, hx + 0.04, 0.03, hd / 2 + 0.003);
  p.window(-0.06, 0.1, hd / 2 + 0.003, 0, hx);
  for (const x of [-0.06, 0.06]) p.window(x, 0.1, hd / 2 + 0.003, Math.PI, hx);
  p.window(0, 0.1, hw / 2 + 0.003, Math.PI / 2, hx);
  const tx = -0.13, tw = 0.15, tH = 0.33;
  p.box('stone', tw + 0.02, 0.05, tw + 0.02, tx, 0.03, 0);
  p.box('stone', tw, tH, tw, tx, 0.03, 0);
  p.box('paint', tw + 0.006, 0.03, tw + 0.006, tx, 0.03 + tH - 0.06, 0); // coloured band
  p.box('stone', tw + 0.024, 0.024, tw + 0.024, tx, 0.03 + tH, 0);
  for (const [ox, oz] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    p.box('stone', 0.03, 0.035, 0.03, tx + ox * (tw / 2 - 0.004), 0.03 + tH + 0.024, oz * (tw / 2 - 0.004));
  }
  const spire = new THREE.ConeGeometry(tw * 0.6, 0.2, 4, 1);
  spire.rotateY(Math.PI / 4);
  spire.translate(tx, 0.03 + tH + 0.024 + 0.1, 0);
  p.add('accent', spire);
  p.cyl('trim', 0.004, 0.004, 0.08, tx, 0.03 + tH + 0.22, 0, 6); // flag pole
  p.box('paint', 0.06, 0.035, 0.004, tx + 0.03, 0.03 + tH + 0.26, 0); // pennant
  for (const ry of [0, Math.PI, -Math.PI / 2]) {
    p.window(0, 0.12, tw / 2 + 0.003, ry, tx, 0, 0.028, 0.045);
    p.window(0, 0.23, tw / 2 + 0.003, ry, tx, 0, 0.028, 0.045);
  }
  return p.build();
}

/* ------------------------------------------------------------------ Nordic */

function nordicLonghouse(len = 0.3) {
  const p = new Parts();
  const d = 0.2;
  p.box('stone', len + 0.05, 0.025, d + 0.05, 0, 0, 0);
  p.box('wood', len, 0.07, d, 0, 0.025, 0);
  p.prism('wood', len, d, 0.2, 0, 0.095, 0);
  p.roof('paint', 0, 0, len, d, 0.095, 0.2, 0.03, 0.022);
  // crossed gable horns
  for (const sx of [-1, 1]) {
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.012, 0.09, 0.012);
      g.rotateX(side * 0.55);
      g.translate(sx * (len / 2 + 0.02), 0.32, side * 0.02);
      p.add('trim', g);
    }
  }
  p.box('trim', 0.05, 0.065, 0.01, len / 2 + 0.002, 0.025, 0, Math.PI / 2); // carved door
  p.window(-len / 4, 0.05, d / 2 + 0.003, 0, 0, 0, 0.026, 0.022, 'wood');
  p.window(len / 4, 0.05, d / 2 + 0.003, 0, 0, 0, 0.026, 0.022, 'wood');
  return p;
}

function nordicHut() { return nordicLonghouse(0.3).build(); }

function nordicHall() {
  const p = nordicLonghouse(0.44);
  p.box('wood', 0.02, 0.2, 0.02, -0.26, 0.0, 0.14); // totem post
  const head = new THREE.ConeGeometry(0.03, 0.06, 5);
  head.rotateZ(Math.PI / 2);
  head.translate(-0.24, 0.22, 0.14);
  p.add('paint', head);
  p.box('paint', 0.07, 0.12, 0.006, -0.26, 0.08, 0.152); // banner
  return p.build();
}

/* ------------------------------------------------------------------ registry */

const PALETTES = {
  village: { stone: 0xa39c90, wood: 0x4a3222, trim: 0xc9a55a, trimMetal: 0, trimRough: 0.95, accentMul: 0.55, paintRough: 0.65 },
  stonework: { stone: 0xb9b3a8, wood: 0x3d2a1c, trim: 0x2b2b2b, trimMetal: 0.6, trimRough: 0.4, accentMul: 0.75, paintRough: 0.5 },
  nordic: { stone: 0x6f6a62, wood: 0x3a2618, trim: 0xd8c7a0, trimMetal: 0, trimRough: 0.8, accentMul: 0.6, paintRough: 0.8 },
  royal: { stone: 0xf1ede4, wood: 0xd4a93a, trim: 0xe0b94a, trimMetal: 1, trimRough: 0.25, accentMul: 0.55, paintRough: 0.35 },
};

const BUILDERS = {
  village: { settlement: villageHut, city: villageHouse },
  stonework: { settlement: stoneCottage, city: stoneKeep },
  nordic: { settlement: nordicHut, city: nordicHall },
  royal: { settlement: villageHut, city: villageHouse },
};

const geoCache = new Map();
const matCache = new Map();

/** Road: a rounded plank bar, shared by every skin. */
const roadGeometry = (() => {
  const g = new RoundedBoxGeometry(0.46, 0.07, 0.11, 2, 0.02);
  g.translate(0, 0.035, 0);
  return g;
})();

/** Geometry for a piece kind ('settlement' | 'city' | 'road') of a skin. */
export function skinGeometry(skin, kind) {
  if (kind === 'road') return roadGeometry;
  const id = BUILDERS[skin] ? skin : DEFAULT_SKIN;
  const key = `${id}:${kind}`;
  if (!geoCache.has(key)) geoCache.set(key, BUILDERS[id][kind]());
  return geoCache.get(key);
}

/** Material array (six slots) for a skin in a player's colour. */
export function skinMaterials(skin, color) {
  const id = PALETTES[skin] ? skin : DEFAULT_SKIN;
  const key = `${id}:${color}`;
  if (matCache.has(key)) return matCache.get(key);
  const pal = PALETTES[id];
  const isWhite = color === 0xf2efe6;
  const mats = [
    new THREE.MeshStandardMaterial({ color, roughness: pal.paintRough, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(isWhite ? 0.5 : pal.accentMul), roughness: 0.75 }),
    new THREE.MeshStandardMaterial({ color: pal.stone, roughness: id === 'royal' ? 0.3 : 0.92 }),
    new THREE.MeshStandardMaterial({ color: pal.wood, roughness: id === 'royal' ? 0.3 : 0.8, metalness: id === 'royal' ? 1 : 0 }),
    new THREE.MeshStandardMaterial({ color: 0x2a2630, roughness: 0.25, emissive: 0xffb45e, emissiveIntensity: 0.4 }),
    new THREE.MeshStandardMaterial({ color: pal.trim, roughness: pal.trimRough, metalness: pal.trimMetal }),
  ];
  matCache.set(key, mats);
  return mats;
}
