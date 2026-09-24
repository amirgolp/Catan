// Prop geometry and procedural card textures: grass / wheat tufts, leaf-card trees,
// smooth textured boulders, sheep, logs, mine frames, docks, ships, plus an
// InstancedMesh scatter helper.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from './noise.js';

const nonIndexed = (g) => (g.index ? g.toNonIndexed() : g);
export const col = (hex) => new THREE.Color(hex);

/* ------------------------------------------------------------------ attribute helpers */

/** Adds a per-vertex colour attribute (tint) with random brightness variation. */
export function colorize(geometry, color = 0xffffff, variation = 0, rand = Math.random, shade = null) {
  const pos = geometry.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const c = color.isColor ? color : new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    let f = 1 + (rand() - 0.5) * 2 * variation;
    if (shade) f *= shade(pos.getX(i), pos.getY(i), pos.getZ(i));
    arr[i * 3] = c.r * f;
    arr[i * 3 + 1] = c.g * f;
    arr[i * 3 + 2] = c.b * f;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}

/** Per-triangle planar UVs on the dominant axis of the face normal (non-indexed only). */
export function planarUV(geometry, scale = 1) {
  const g = nonIndexed(geometry);
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k), y = pos.getY(i + k), z = pos.getZ(i + k);
      let u, v;
      if (ax >= ay && ax >= az) { u = z; v = y; }
      else if (ay >= az) { u = x; v = z; }
      else { u = x; v = y; }
      uv[(i + k) * 2] = u * scale;
      uv[(i + k) * 2 + 1] = v * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Push vertices along their radial direction by layered noise. */
export function displace(geometry, noise, amp, freq, offset = 0) {
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      noise.fbm(v.x * freq + offset, v.y * freq, 3) +
      noise.fbm(v.y * freq + offset + 7.3, v.z * freq, 3) +
      noise.fbm(v.z * freq + offset + 13.1, v.x * freq, 3);
    dir.copy(v).normalize();
    v.addScaledVector(dir, n * amp);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  return geometry;
}

/* ------------------------------------------------------------------ card textures */

function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}

function finishTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** A tuft of blades. kind: 'grass' | 'wheat' | 'shrub'. */
export function tuftTexture(kind = 'grass', seed = 1, size = 256) {
  const rand = makeRng(seed);
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const blades = kind === 'wheat' ? 16 : 14;
  for (let i = 0; i < blades; i++) {
    const x0 = size * 0.5 + (rand() - 0.5) * size * 0.55;
    const w = kind === 'wheat' ? rand.range(4, 7) : rand.range(7, 14);
    const tipY = rand.range(size * 0.05, size * 0.35);
    const lean = (rand() - 0.5) * size * 0.5;
    const tipX = x0 + lean;
    const cx = x0 + lean * 0.35;
    const cy = size * 0.55;
    let h, s, l;
    if (kind === 'wheat') { h = rand.range(40, 50); s = rand.range(75, 90); l = rand.range(60, 80); }
    else if (kind === 'shrub') { h = rand.range(70, 95); s = rand.range(30, 45); l = rand.range(30, 42); }
    else { h = rand.range(85, 115); s = rand.range(40, 58); l = rand.range(26, 44); }
    const grad = ctx.createLinearGradient(0, size, 0, tipY);
    grad.addColorStop(0, `hsl(${h}, ${s}%, ${l * 0.8}%)`); // lighter bottom
    grad.addColorStop(1, `hsl(${h}, ${s}%, ${Math.min(l * 1.35, 90)}%)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0 - w / 2, size);
    ctx.quadraticCurveTo(cx - w * 0.3, cy, tipX, tipY);
    ctx.quadraticCurveTo(cx + w * 0.3, cy, x0 + w / 2, size);
    ctx.closePath();
    ctx.fill();
    if (kind === 'wheat') {
      // seed head
      ctx.fillStyle = `hsl(${rand.range(38, 46)}, 60%, ${rand.range(40, 52)}%)`;
      const dx = (tipX - cx) / 6, dy = (tipY - cy) / 6;
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        ctx.ellipse(tipX - dx * k + (k % 2 ? 4 : -4), tipY - dy * k + k * 2, 4.5, 7, Math.atan2(dy, dx) + Math.PI / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return finishTexture(canvas);
}

/** A cluster of leaves for tree canopy cards. */
export function leafClusterTexture(seed = 2, size = 256, hueBase = 105) {
  const rand = makeRng(seed);
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * size * 0.4;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const rot = rand() * Math.PI;
    const rx = rand.range(12, 22), ry = rand.range(7, 12);
    const h = hueBase + rand.range(-12, 18), s = rand.range(35, 50), l = rand.range(14, 34);
    ctx.fillStyle = `hsl(${h}, ${s}%, ${l}%)`;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `hsl(${h}, ${s}%, ${l * 0.7}%)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(rot) * rx, y - Math.sin(rot) * rx);
    ctx.lineTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx);
    ctx.stroke();
  }
  return finishTexture(canvas);
}

/**
 * 2x2 atlas of leaf clusters with different leaf shapes (round, elongated, small
 * dense, needle sprays). Tree cards pick a quadrant at random for variety.
 */
export function leafAtlasTexture(seed = 2, size = 512, hueBase = 105) {
  const rand = makeRng(seed);
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const q = size / 2;
  const styles = [
    { count: 90, rx: [12, 22], ry: [7, 12], stroke: true },
    { count: 70, rx: [20, 30], ry: [4, 7], stroke: true },
    { count: 170, rx: [6, 11], ry: [5, 8], stroke: false },
    { count: 55, rx: [16, 26], ry: [10, 15], stroke: true },
  ];
  styles.forEach((st, si) => {
    const cx = (si % 2) * q + q / 2, cy = Math.floor(si / 2) * q + q / 2;
    const hue = hueBase + rand.range(-8, 8);
    if (st.needles) {
      ctx.lineCap = 'round';
      for (let i = 0; i < st.needles; i++) {
        const a = rand() * Math.PI * 2;
        const r0 = Math.sqrt(rand()) * q * 0.3;
        const x = cx + Math.cos(a) * r0, y = cy + Math.sin(a) * r0;
        const dir = a + rand.range(-0.6, 0.6);
        const len = rand.range(22, 40);
        const h = hue + rand.range(-10, 10), s = rand.range(30, 45), l = rand.range(14, 32);
        ctx.strokeStyle = `hsl(${h}, ${s}%, ${l}%)`;
        ctx.lineWidth = rand.range(2.5, 4);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(dir) * len, y + Math.sin(dir) * len);
        ctx.stroke();
      }
      return;
    }
    for (let i = 0; i < st.count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * q * 0.4;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const rot = rand() * Math.PI;
      const rx = rand.range(st.rx[0], st.rx[1]), ry = rand.range(st.ry[0], st.ry[1]);
      const h = hue + rand.range(-12, 18), s = rand.range(35, 50), l = rand.range(14, 34);
      ctx.fillStyle = `hsl(${h}, ${s}%, ${l}%)`;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
      ctx.fill();
      if (st.stroke) {
        ctx.strokeStyle = `hsl(${h}, ${s}%, ${l * 0.7}%)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(rot) * rx, y - Math.sin(rot) * rx);
        ctx.lineTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx);
        ctx.stroke();
      }
    }
  });
  return finishTexture(canvas);
}

/* ------------------------------------------------------------------ cards */

/** Two crossed upright quads with full-card UVs; origin at the root. */
export function tuftGeometry(w = 0.16, h = 0.16) {
  const quad = (rot) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.translate(0, h / 2, 0);
    const c = [];
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const s = p.getY(i) > h * 0.5 ? 1.0 : 0.55;
      c.push(s, s, s);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.rotateY(rot);
    return nonIndexed(g);
  };
  const g = mergeGeometries([quad(0), quad(Math.PI / 2)]);
  // Mostly-up normals so tufts take the ground's lighting instead of flashing per quad.
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) {
    const nx = nrm.getX(i) * 0.3, nz = nrm.getZ(i) * 0.3;
    const len = Math.hypot(nx, 1, nz);
    nrm.setXYZ(i, nx / len, 1 / len, nz / len);
  }
  return g;
}

/* ------------------------------------------------------------------ trees */

/**
 * Trunk + branches (group 0, bark material) and a shell of leaf cards (group 1, leaf
 * material). Card normals point away from their canopy blob for soft lighting.
 */
export function makeTreeGeometry(rand, noise, opts = {}) {
  const {
    trunkH = 0.16,
    trunkR = 0.02,
    canopyR = 0.11,
    blobs = 3,
    cardsPerBlob = 18,
    cardSize = 1.25,
    shape = 'round', // 'round' | 'wide' | 'conical'
    atlas = true, // cards pick one of 4 quadrants of a leaf atlas
  } = opts;
  const bark = [];
  const trunkLen = shape === 'conical' ? trunkH + 0.12 : trunkH + 0.08;
  const trunk = nonIndexed(new THREE.CylinderGeometry(trunkR * 0.75, trunkR * 1.15, trunkLen, 7));
  trunk.translate(0, trunkLen / 2 - 0.04, 0);
  bark.push(trunk);
  const centers = [];
  if (shape === 'conical') {
    const n = Math.max(blobs, 3);
    for (let b = 0; b < n; b++) {
      const tt = b / (n - 1);
      const r = canopyR * (1.05 - 0.65 * tt);
      centers.push({ center: new THREE.Vector3(0, trunkH * 0.7 + r * 0.5 + tt * canopyR * 2.1, 0), r });
    }
  } else {
    const spread = shape === 'wide' ? 1.15 : 0.7;
    const lift = shape === 'wide' ? 0.35 : 0.8;
    for (let b = 0; b < blobs; b++) {
      const r = b === 0 ? canopyR : canopyR * rand.range(0.5, 0.85);
      let center;
      if (b === 0) center = new THREE.Vector3(0, trunkH + r * 0.7, 0);
      else {
        const a = rand() * Math.PI * 2;
        const d = canopyR * spread * rand.range(0.7, 1.0);
        center = new THREE.Vector3(Math.cos(a) * d, trunkH + r * 0.5 + rand() * canopyR * lift, Math.sin(a) * d);
        const len = Math.hypot(center.x, center.z);
        const branch = nonIndexed(new THREE.CylinderGeometry(trunkR * 0.35, trunkR * 0.6, Math.hypot(len, center.y - trunkH * 0.8), 5));
        const dir = new THREE.Vector3(center.x, center.y - trunkH * 0.8, center.z).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        branch.applyQuaternion(q);
        branch.translate(center.x * 0.5, trunkH * 0.8 + (center.y - trunkH * 0.8) * 0.5, center.z * 0.5);
        bark.push(branch);
      }
      centers.push({ center, r });
    }
  }
  for (const g of bark) colorize(g, 0xffffff, 0.08, rand);
  const barkGeo = mergeGeometries(bark);

  // Leaf cards: a shell of tilted cards around each blob plus a few inner cards.
  const pos = [], nrm = [], uv = [], colr = [], bright = [];
  const up = new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3(), bt = new THREE.Vector3(), n = new THREE.Vector3(), cn = new THREE.Vector3(), p = new THREE.Vector3(), tmp = new THREE.Vector3();
  let minY = Infinity, maxY = -Infinity;
  for (const { center, r } of centers) {
    for (let i = 0; i < cardsPerBlob; i++) {
      const inner = i < cardsPerBlob * 0.2;
      n.set(rand() * 2 - 1, rand() * 2 - 1 + 0.35, rand() * 2 - 1).normalize();
      p.copy(center).addScaledVector(n, r * (inner ? rand.range(0.1, 0.5) : rand.range(0.55, 1.0)));
      // card orientation: outward direction with a random tilt for a ragged silhouette
      cn.copy(n).addScaledVector(tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize(), 0.3).normalize();
      tmp.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      t.crossVectors(cn, tmp).normalize();
      bt.crossVectors(cn, t).normalize();
      const s = r * cardSize * rand.range(0.7, 1.4);
      const corners = [
        p.clone().addScaledVector(t, -s / 2).addScaledVector(bt, -s / 2),
        p.clone().addScaledVector(t, s / 2).addScaledVector(bt, -s / 2),
        p.clone().addScaledVector(t, s / 2).addScaledVector(bt, s / 2),
        p.clone().addScaledVector(t, -s / 2).addScaledVector(bt, s / 2),
      ];
      // soft normal: blend outward direction with up
      const sn = n.clone().addScaledVector(up, 0.5).normalize();
      const order = [0, 1, 2, 0, 2, 3];
      const qx = atlas ? rand.int(2) * 0.5 : 0, qy = atlas ? rand.int(2) * 0.5 : 0, qs = atlas ? 0.5 : 1;
      const uvs = [[qx, qy], [qx + qs, qy], [qx + qs, qy + qs], [qx, qy + qs]];
      const b = rand.range(0.85, 1.15);
      for (const k of order) {
        pos.push(corners[k].x, corners[k].y, corners[k].z);
        nrm.push(sn.x, sn.y, sn.z);
        uv.push(uvs[k][0], uvs[k][1]);
        colr.push(corners[k].y);
        bright.push(b);
        minY = Math.min(minY, corners[k].y);
        maxY = Math.max(maxY, corners[k].y);
      }
    }
  }
  for (let i = 0; i < colr.length; i++) {
    const f = (0.55 + 0.5 * ((colr[i] - minY) / (maxY - minY + 1e-6))) * bright[i];
    colr[i] = f;
  }
  const leafGeo = new THREE.BufferGeometry();
  leafGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  leafGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  leafGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const cArr = new Float32Array(colr.length * 3);
  for (let i = 0; i < colr.length; i++) { cArr[i * 3] = colr[i]; cArr[i * 3 + 1] = colr[i]; cArr[i * 3 + 2] = colr[i]; }
  leafGeo.setAttribute('color', new THREE.BufferAttribute(cArr, 3));

  return mergeGeometries([barkGeo, leafGeo], true); // groups: 0 bark, 1 leaves
}

/* ------------------------------------------------------------------ rocks */

/** Smooth-shaded displaced sphere with planar UVs for a rock PBR set. */
export function makeRockGeometry(rand, noise) {
  let g = mergeVertices(new THREE.IcosahedronGeometry(1, 3));
  displace(g, noise, 0.28, rand.range(0.9, 1.6), rand() * 100);
  g.scale(rand.range(0.7, 1.3), rand.range(0.55, 0.95), rand.range(0.7, 1.3));
  g.computeVertexNormals();
  g = planarUV(g.toNonIndexed(), 0.6);
  return g;
}

/* ------------------------------------------------------------------ small props */

export function makeSheepGeometry(rand) {
  const body = nonIndexed(new THREE.SphereGeometry(0.045, 12, 10));
  body.scale(1.35, 1, 1.05);
  body.translate(0, 0.055, 0);
  colorize(body, 0xf1ece0, 0.05, rand);
  const head = nonIndexed(new THREE.SphereGeometry(0.022, 8, 6));
  head.scale(1.3, 1, 1);
  head.translate(0.065, 0.06, 0);
  colorize(head, 0x2a2622, 0.05, rand);
  const parts = [body, head];
  for (const [x, z] of [[-0.028, -0.02], [-0.028, 0.02], [0.028, -0.02], [0.028, 0.02]]) {
    const leg = nonIndexed(new THREE.CylinderGeometry(0.007, 0.007, 0.04, 5));
    leg.translate(x, 0.02, z);
    colorize(leg, 0x2a2622, 0.05, rand);
    parts.push(leg);
  }
  return mergeGeometries(parts);
}

export function makeLogGeometry() {
  const g = nonIndexed(new THREE.CylinderGeometry(0.03, 0.03, 0.26, 10));
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.03, 0);
  return g;
}

export function makeFlowerGeometry(rand) {
  const g = nonIndexed(new THREE.SphereGeometry(0.011, 5, 4));
  colorize(g, 0xf6f0dc, 0.05, rand);
  return g;
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = nonIndexed(new THREE.BoxGeometry(w, h, d));
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Wooden mine head-frame with platform + ladder. Planar UVs for a plank texture. */
export function makeMineFrameGeometry() {
  const parts = [];
  const px = 0.13, pz = 0.09, ph = 0.2;
  for (const [x, z] of [[-px, -pz], [px, -pz], [-px, pz], [px, pz]]) parts.push(box(0.025, ph, 0.025, x, ph / 2, z));
  parts.push(box(px * 2 + 0.06, 0.018, pz * 2 + 0.06, 0, ph, 0));
  for (let i = 0; i < 6; i++) parts.push(box(0.03, 0.006, pz * 2 + 0.08, -px + (i * 2 * px) / 5, ph + 0.012, 0));
  parts.push(box(0.02, 0.16, 0.02, -px * 0.6, ph + 0.08, 0));
  parts.push(box(0.02, 0.16, 0.02, px * 0.6, ph + 0.08, 0));
  parts.push(box(px * 1.5, 0.02, 0.03, 0, ph + 0.17, 0));
  const rails = [box(0.012, 0.3, 0.012, -0.03, 0.15, 0), box(0.012, 0.3, 0.012, 0.03, 0.15, 0)];
  for (let i = 0; i < 5; i++) rails.push(box(0.07, 0.01, 0.01, 0, 0.04 + i * 0.055, 0));
  const ladder = mergeGeometries(rails);
  ladder.rotateZ(-0.3);
  ladder.translate(px + 0.06, 0, pz * 0.4);
  parts.push(ladder);
  return planarUV(mergeGeometries(parts), 2.5);
}

/** Planked dock; local +x points away from the tile edge. */
export function makeDockGeometry() {
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(box(0.075, 0.022, 0.34, 0.05 + i * 0.09, 0.04, 0));
  parts.push(box(0.58, 0.02, 0.03, 0.28, 0.024, -0.16));
  parts.push(box(0.58, 0.02, 0.03, 0.28, 0.024, 0.16));
  for (const [x, z] of [[0.08, -0.19], [0.08, 0.19], [0.5, -0.19], [0.5, 0.19]]) {
    const post = nonIndexed(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 7));
    post.translate(x, -0.06, z);
    parts.push(post);
  }
  return planarUV(mergeGeometries(parts), 2.5);
}

/**
 * Cog-style sailing ship, about 0.9 units long, facing +x with the waterline at y = 0:
 * rounded planked hull with a raised stern castle, deck, mast with yard, billowing
 * square sail, bowsprit and pennant.
 */
export function makeShip(rand, mats) {
  const group = new THREE.Group();
  const shadow = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  // Hull outline (top view) extruded downward with a bevel for a rounded bilge.
  const outline = new THREE.Shape();
  outline.moveTo(0.55, 0);
  outline.quadraticCurveTo(0.32, 0.17, -0.05, 0.18);
  outline.lineTo(-0.4, 0.15);
  outline.quadraticCurveTo(-0.52, 0.1, -0.52, 0);
  outline.quadraticCurveTo(-0.52, -0.1, -0.4, -0.15);
  outline.lineTo(-0.05, -0.18);
  outline.quadraticCurveTo(0.32, -0.17, 0.55, 0);
  let hullGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.1, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.07, bevelSegments: 4 });
  hullGeo.rotateX(Math.PI / 2); // extrude axis -> -y
  hullGeo.translate(0, 0.1, 0); // deck rim at y = 0.1, keel near y = -0.07
  hullGeo = planarUV(hullGeo, 3);
  group.add(shadow(new THREE.Mesh(hullGeo, mats.planks)));

  // Deck
  const deckShape = new THREE.Shape();
  deckShape.moveTo(0.46, 0);
  deckShape.quadraticCurveTo(0.28, 0.13, -0.05, 0.14);
  deckShape.lineTo(-0.38, 0.12);
  deckShape.quadraticCurveTo(-0.46, 0.08, -0.46, 0);
  deckShape.quadraticCurveTo(-0.46, -0.08, -0.38, -0.12);
  deckShape.lineTo(-0.05, -0.14);
  deckShape.quadraticCurveTo(0.28, -0.13, 0.46, 0);
  let deckGeo = new THREE.ShapeGeometry(deckShape);
  deckGeo.rotateX(-Math.PI / 2);
  deckGeo.translate(0, 0.085, 0);
  deckGeo = planarUV(deckGeo, 4);
  group.add(shadow(new THREE.Mesh(deckGeo, mats.planks)));

  // Stern castle
  const castle = shadow(new THREE.Mesh(planarUV(nonIndexed(new THREE.BoxGeometry(0.2, 0.1, 0.24)), 3), mats.planks));
  castle.position.set(-0.32, 0.135, 0);
  group.add(castle);
  const roof = shadow(new THREE.Mesh(planarUV(nonIndexed(new THREE.BoxGeometry(0.23, 0.02, 0.27)), 3), mats.planks));
  roof.position.set(-0.32, 0.195, 0);
  group.add(roof);

  // Mast, yard, bowsprit
  const mast = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.8, 8), mats.bark));
  mast.position.set(0.02, 0.48, 0);
  group.add(mast);
  const yard = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6), mats.bark));
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.03, 0.78, 0);
  group.add(yard);
  const bowsprit = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.3, 6), mats.bark));
  bowsprit.rotation.z = -Math.PI / 2 + 0.35;
  bowsprit.position.set(0.6, 0.16, 0);
  group.add(bowsprit);

  // Square sail hanging from the yard, bellied toward +x
  const sailGeo = new THREE.PlaneGeometry(0.46, 0.5, 10, 10);
  const p = sailGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / 0.46 + 0.5;
    const v = p.getY(i) / 0.5 + 0.5;
    p.setZ(i, Math.sin(u * Math.PI) * Math.pow(Math.sin(v * Math.PI), 0.7) * 0.12);
  }
  sailGeo.computeVertexNormals();
  const sail = shadow(new THREE.Mesh(sailGeo, mats.cloth));
  sail.rotation.y = Math.PI / 2;
  sail.position.set(0.04, 0.52, 0);
  group.add(sail);

  // Pennant
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.05), new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 1, side: THREE.DoubleSide }));
  flag.position.set(0.08, 0.9, 0);
  group.add(flag);

  return group;
}

/** Sheep material: the head (local x > 0.045) dips rhythmically as if grazing. */
export function makeSheepMaterial(uTime) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          if ( position.x > 0.045 ) {
            float phase = instanceMatrix[3].x * 7.0 + instanceMatrix[3].z * 5.0;
            float chew = 0.5 + 0.5 * sin( uTime * 5.0 + phase );
            float graze = smoothstep( 0.2, 0.8, 0.5 + 0.5 * sin( uTime * 0.7 + phase ) );
            transformed.y -= graze * 0.03 + chew * graze * 0.006;
            transformed.x += graze * 0.01;
          }
        #endif`
      );
  };
  m.customProgramCacheKey = () => 'sheep-graze';
  return m;
}

/* ------------------------------------------------------------------ scatter helper */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Build an InstancedMesh from `count` calls to place(i) -> { x, y, z, scale, rotY, tiltX, tiltZ, color } | null
 */
export function scatter({ geometry, material, count, place, castShadow = true, receiveShadow = true, noAO = false }) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const it = place(i);
    if (it) items.push(it);
  }
  if (items.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  items.forEach((it, i) => {
    _p.set(it.x, it.y, it.z);
    _e.set(it.tiltX || 0, it.rotY || 0, it.tiltZ || 0);
    _q.setFromEuler(_e);
    const sc = it.scale === undefined ? 1 : it.scale;
    if (Array.isArray(sc)) _s.set(sc[0], sc[1], sc[2]);
    else _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    if (it.color !== undefined) {
      if (it.color.isColor) _c.copy(it.color);
      else _c.set(it.color);
      mesh.setColorAt(i, _c);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  if (noAO) mesh.userData.noAO = true; // alpha-tested cards are excluded from the AO pass
  return mesh;
}

/* ------------------------------------------------------------------ ambient life */

export function makeMistMaterial(uTime) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    roughness: 1.0,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          float phase = instanceMatrix[3].x * 21.0 + instanceMatrix[3].z * 13.0;
          transformed.y += sin(uTime * 0.8 + phase) * 0.1;
          transformed.x += cos(uTime * 0.6 + phase) * 0.1;
          transformed.z += sin(uTime * 0.7 + phase) * 0.1;
        #endif
      `);
  };
  return m;
}

export function makeBirdGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.1, 0.05, 0.2, 0); // right wing tip
  shape.lineTo(0.05, -0.05);
  shape.lineTo(0, -0.1); // tail
  shape.lineTo(-0.05, -0.05);
  shape.lineTo(-0.2, 0); // left wing tip
  shape.quadraticCurveTo(-0.1, 0.05, 0, 0);
  
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.scale(0.5, 0.5, 0.5);
  return nonIndexed(geo);
}

export function makeCloudGeometry(rand) {
  const parts = [];
  const count = rand.range(4, 7);
  for (let i = 0; i < count; i++) {
    const geo = nonIndexed(new THREE.IcosahedronGeometry(rand.range(0.3, 0.6), 2));
    geo.scale(1, rand.range(0.5, 0.7), 1);
    geo.translate(rand.range(-0.5, 0.5), rand.range(-0.2, 0.2), rand.range(-0.5, 0.5));
    parts.push(geo);
  }
  return mergeGeometries(parts);
}
