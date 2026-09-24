// Hex helpers and geometry builders: beveled base, heightmapped hex surface with skirt, flat hex.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const HEX_R = 1;                  // circumradius of a tile
export const APOTHEM = Math.sqrt(3) / 2; // inradius for R = 1
export const BASE_DEPTH = 0.16;
export const BASE_BEVEL = 0.04;
export const BASE_TOP = BASE_DEPTH + BASE_BEVEL * 2; // y of the top of the base (bottom at 0)

/** Pointy-top hex corners in the XZ plane (corners at 30 deg, 90 deg, ...). */
export function hexCorners(r = HEX_R) {
  const out = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

/** 0 at the centre, 1 on the hex edge (hexagonal metric). */
export function hexDist(x, z, r = HEX_R) {
  const d0 = Math.abs(x);
  const d1 = Math.abs(x * 0.5 + z * APOTHEM);
  const d2 = Math.abs(-x * 0.5 + z * APOTHEM);
  return Math.max(d0, d1, d2) / (APOTHEM * r);
}

function hexShape(r) {
  const shape = new THREE.Shape();
  hexCorners(r).forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  return shape;
}

/** Beveled slab that every tile sits on (reference image 1). Bottom at y=0, top at BASE_TOP. */
export function hexBaseGeometry(r = HEX_R) {
  const g = new THREE.ExtrudeGeometry(hexShape(r - BASE_BEVEL), {
    depth: BASE_DEPTH,
    bevelEnabled: true,
    bevelThickness: BASE_BEVEL,
    bevelSize: BASE_BEVEL,
    bevelSegments: 3,
    steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, BASE_BEVEL, 0);
  g.computeVertexNormals();
  return g;
}

/** Flat hex plane facing +y (used for water levels inside tiles). */
export function flatHexGeometry(r = HEX_R) {
  const g = new THREE.ShapeGeometry(hexShape(r));
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Height-mapped hexagonal surface with a vertical skirt around the rim.
 *  height(x, z, ctx) -> y                         ctx = { d: hexDist }
 *  color(x, z, y, slope, ctx) -> [r, g, b]        linear rgb tint
 *  blend(x, z, y, slope, ctx) -> 0..1             texture layer B weight
 */
export function hexSurfaceGeometry({
  r = HEX_R,
  n = 48,
  height,
  color,
  blend = () => 0,
  skirtColor = [0.16, 0.11, 0.07],
  skirtDepth = 0.35,
}) {
  const corners = hexCorners(r);
  const positions = [];
  const colors = [];
  const blends = [];
  const uvs = [];
  const indices = [];
  const lookup = new Map();
  const eps = 0.004;

  const evalHeight = (x, z) => height(x, z, { d: hexDist(x, z, r) });

  const getIndex = (x, z) => {
    const key = `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
    let idx = lookup.get(key);
    if (idx !== undefined) return idx;
    const y = evalHeight(x, z);
    const dx = (evalHeight(x + eps, z) - evalHeight(x - eps, z)) / (2 * eps);
    const dz = (evalHeight(x, z + eps) - evalHeight(x, z - eps)) / (2 * eps);
    const slope = Math.hypot(dx, dz);
    const ctx = { d: hexDist(x, z, r) };
    const c = color(x, z, y, slope, ctx);
    idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(c[0], c[1], c[2]);
    blends.push(blend(x, z, y, slope, ctx));
    uvs.push(x / (2 * r) + 0.5, z / (2 * r) + 0.5);
    lookup.set(key, idx);
    return idx;
  };

  const ring = []; // boundary vertex indices, ordered around the rim
  for (let t = 0; t < 6; t++) {
    const [ax, az] = corners[t];
    const [bx, bz] = corners[(t + 1) % 6];
    const grid = [];
    for (let a = 0; a <= n; a++) {
      grid[a] = [];
      for (let b = 0; b <= n - a; b++) {
        const x = (a / n) * ax + (b / n) * bx;
        const z = (a / n) * az + (b / n) * bz;
        grid[a][b] = getIndex(x, z);
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n - a; b++) {
        indices.push(grid[a][b], grid[a][b + 1], grid[a + 1][b]);
        if (a + b < n - 1) indices.push(grid[a + 1][b], grid[a][b + 1], grid[a + 1][b + 1]);
      }
    }
    for (let a = n; a >= 1; a--) ring.push(grid[a][n - a]);
  }

  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  top.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  top.setAttribute('blend', new THREE.Float32BufferAttribute(blends, 1));
  top.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  top.setIndex(indices);
  top.computeVertexNormals();
  const topNI = top.toNonIndexed();

  // Skirt: vertical strip from the rim down into the base so terrain never shows a gap.
  const sp = [], sc = [], su = [], sb = [];
  const m = ring.length;
  const push = (p, c, u) => { sp.push(p[0], p[1], p[2]); sc.push(c[0], c[1], c[2]); su.push(u[0], u[1]); sb.push(0); };
  for (let k = 0; k < m; k++) {
    const i0 = ring[k], i1 = ring[(k + 1) % m];
    const t0 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
    const t1 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
    const b0 = [t0[0], -skirtDepth, t0[2]];
    const b1 = [t1[0], -skirtDepth, t1[2]];
    const c0 = [colors[i0 * 3] * 0.7, colors[i0 * 3 + 1] * 0.7, colors[i0 * 3 + 2] * 0.7];
    const c1 = [colors[i1 * 3] * 0.7, colors[i1 * 3 + 1] * 0.7, colors[i1 * 3 + 2] * 0.7];
    const u0 = (k / m) * 2, u1 = ((k + 1) / m) * 2; // ~1 texture repeat per unit of perimeter
    push(t0, c0, [u0, 0.3]); push(t1, c1, [u1, 0.3]); push(b0, skirtColor, [u0, 0]);
    push(t1, c1, [u1, 0.3]); push(b1, skirtColor, [u1, 0]); push(b0, skirtColor, [u0, 0]);
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  skirt.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  skirt.setAttribute('blend', new THREE.Float32BufferAttribute(sb, 1));
  skirt.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
  skirt.computeVertexNormals();

  const merged = mergeGeometries([topNI, skirt]);
  top.dispose();
  topNI.dispose();
  skirt.dispose();
  return merged;
}
