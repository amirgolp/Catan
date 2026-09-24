// Board graph (vertices / edges of the hex layout) and player pieces: settlements,
// cities and roads, with hover + click placement.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { HEX_R, BASE_TOP, hexCorners } from './hexGeometry.js';

export const PLAYER_COLORS = {
  red: 0xc0392b,
  blue: 0x2e6db4,
  white: 0xf2efe6,
  orange: 0xe67e22,
};

const PICK_LAYER = 3;
const AO_LAYER = 2; // pieces take part in the ambient occlusion pass

/* ------------------------------------------------------------------ graph */

function surfaceY(x, z, tiles) {
  let h = 0.03;
  for (const t of tiles) h = Math.max(h, t.tile.heightAt(x - t.x, z - t.z));
  return BASE_TOP + h;
}

/** Unique corners (vertices) and edges shared between the 19 tiles. */
export function buildGraph(tiles) {
  const verts = [];
  const edges = [];
  const emap = new Map();
  const findVertex = (x, z) => {
    for (const v of verts) if (Math.hypot(v.x - x, v.z - z) < 0.06) return v;
    return null;
  };
  for (const t of tiles) {
    const ids = hexCorners(HEX_R).map(([cx, cz]) => {
      const x = t.x + cx, z = t.z + cz;
      let v = findVertex(x, z);
      if (!v) {
        v = { id: verts.length, x, z, n: 0, tiles: [] };
        verts.push(v);
      }
      v.x = (v.x * v.n + x) / (v.n + 1);
      v.z = (v.z * v.n + z) / (v.n + 1);
      v.n++;
      v.tiles.push(t);
      return v.id;
    });
    for (let i = 0; i < 6; i++) {
      const a = ids[i], b = ids[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!emap.has(k)) {
        emap.set(k, edges.length);
        edges.push({ id: edges.length, a, b, tiles: [t] });
      } else edges[emap.get(k)].tiles.push(t);
    }
  }
  for (const v of verts) v.y = surfaceY(v.x, v.z, v.tiles);
  for (const e of edges) {
    const va = verts[e.a], vb = verts[e.b];
    e.x = (va.x + vb.x) / 2;
    e.z = (va.z + vb.z) / 2;
    e.y = surfaceY(e.x, e.z, e.tiles);
    e.angle = Math.atan2(vb.z - va.z, vb.x - va.x);
  }
  return { verts, edges };
}

/* ------------------------------------------------------------------ piece geometry */

// Piece models are assembled from simple parts, merged per material into one geometry
// with five groups: 0 painted walls (player colour), 1 roof (darker player colour),
// 2 stone, 3 wood, 4 window glass. The front of a building faces +z.
const PART = { wall: 0, roof: 1, stone: 2, wood: 3, glass: 4 };

class Parts {
  constructor() { this.lists = [[], [], [], [], []]; }
  add(kind, g) { this.lists[PART[kind]].push(g.index ? g.toNonIndexed() : g); return g; }
  box(kind, w, h, d, x, y, z, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(ry);
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
  /** Walls with a gable roof: slabs with eaves overhang, a ridge cap and gable ends. */
  house(x, z, w, d, wallH, roofH, y = 0) {
    this.box('wall', w, wallH, d, x, y, z);
    this.prism('wall', w, d, roofH, x, y + wallH, z);
    const oh = 0.016, t = 0.012;
    const a = Math.atan2(roofH, d / 2);
    const s = d / 2 + oh;
    const L = s / Math.cos(a);
    const ridgeY = y + wallH + roofH;
    for (const side of [1, -1]) {
      const g = new THREE.BoxGeometry(w + oh * 2, t, L);
      g.translate(0, t / 2, 0);
      g.rotateX(side * a);
      g.translate(x, ridgeY - (s / 2) * Math.tan(a), z + side * (s / 2));
      this.add('roof', g);
    }
    const cap = new THREE.BoxGeometry(w + oh * 2 + 0.004, t * 1.2, t * 1.6);
    cap.rotateX(Math.PI / 4);
    cap.translate(x, ridgeY + t * 0.6, z);
    this.add('roof', cap);
  }
  /**
   * Small window pane with a stone sill. (x, z) are relative to a wall facing +z; ry turns
   * it to another wall and (cx, cz) is the centre of the building it belongs to.
   */
  window(x, y, z, ry = 0, cx = 0, cz = 0, w = 0.022, h = 0.024) {
    const pane = new THREE.BoxGeometry(w, h, 0.006);
    const sill = new THREE.BoxGeometry(w + 0.008, 0.005, 0.01);
    pane.translate(x, y + h / 2, z);
    sill.translate(x, y - 0.0025, z + 0.002);
    for (const g of [pane, sill]) { g.rotateY(ry); g.translate(cx, 0, cz); }
    this.add('glass', pane);
    this.add('stone', sill);
  }
  build() {
    const merged = this.lists.map((list) => mergeGeometries(list, false));
    const g = mergeGeometries(merged, true);
    g.computeBoundingSphere();
    return g;
  }
}

/** A cottage: stone plinth, painted walls, gable roof, chimney, door and lit windows. */
function makeSettlementGeometry() {
  const p = new Parts();
  const w = 0.17, d = 0.12, wallH = 0.085, roofH = 0.065, base = 0.02;
  p.box('stone', w + 0.04, base, d + 0.04, 0, 0, 0);
  p.house(0, 0, w, d, wallH, roofH, base);
  p.box('stone', 0.026, 0.085, 0.026, 0.05, base + wallH + 0.01, -0.028);
  p.box('stone', 0.032, 0.008, 0.032, 0.05, base + wallH + 0.095, -0.028);
  p.box('wood', 0.03, 0.052, 0.006, 0, base, d / 2 + 0.002);
  for (const x of [-0.052, 0.052]) {
    p.window(x, base + 0.04, d / 2 + 0.002);
    p.window(x, base + 0.04, d / 2 + 0.002, Math.PI);
  }
  p.window(0, base + 0.04, w / 2 + 0.002, Math.PI / 2);
  p.window(0, base + 0.04, w / 2 + 0.002, -Math.PI / 2);
  return p.build();
}

/** A small town: a hall and a square tower with a spire on a shared stone plinth. */
function makeCityGeometry() {
  const p = new Parts();
  const base = 0.022;
  p.box('stone', 0.29, base, 0.19, 0, 0, 0);
  // hall
  const hx = 0.052, hw = 0.15, hd = 0.12, hWall = 0.095, hRoof = 0.07;
  p.house(hx, 0, hw, hd, hWall, hRoof, base);
  p.box('wood', 0.034, 0.06, 0.006, hx + 0.02, base, hd / 2 + 0.002);
  p.window(-0.035, base + 0.05, hd / 2 + 0.002, 0, hx);
  for (const x of [-0.035, 0.035]) p.window(x, base + 0.05, hd / 2 + 0.002, Math.PI, hx);
  p.window(0, base + 0.05, hw / 2 + 0.002, Math.PI / 2, hx);
  // tower
  const tx = -0.078, tw = 0.092, tH = 0.2;
  p.box('stone', tw + 0.012, 0.035, tw + 0.012, tx, base, 0);
  p.box('wall', tw, tH, tw, tx, base, 0);
  p.box('stone', tw + 0.014, 0.016, tw + 0.014, tx, base + tH, 0);
  for (const [ox, oz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    p.box('stone', 0.02, 0.022, 0.02, tx + ox * (tw / 2 - 0.004), base + tH + 0.016, oz * (tw / 2 - 0.004));
  }
  const spire = new THREE.ConeGeometry(tw * 0.62, 0.13, 4, 1);
  spire.rotateY(Math.PI / 4);
  spire.translate(tx, base + tH + 0.016 + 0.065, 0);
  p.add('roof', spire);
  const finial = new THREE.SphereGeometry(0.009, 8, 6);
  finial.translate(tx, base + tH + 0.016 + 0.135, 0);
  p.add('stone', finial);
  for (const ry of [0, Math.PI, -Math.PI / 2]) {
    p.window(0, base + 0.06, tw / 2 + 0.002, ry, tx, 0, 0.02, 0.032);
    p.window(0, base + 0.135, tw / 2 + 0.002, ry, tx, 0, 0.02, 0.032);
  }
  return p.build();
}

// Modelled at tabletop-piece size, then enlarged so they stand clear of trees and rocks.
const PIECE_SCALE = 1.5;
export const settlementGeometry = makeSettlementGeometry().scale(PIECE_SCALE, PIECE_SCALE, PIECE_SCALE);
export const cityGeometry = makeCityGeometry().scale(PIECE_SCALE, PIECE_SCALE, PIECE_SCALE);
export const roadGeometry = (() => {
  const g = new RoundedBoxGeometry(0.44, 0.06, 0.1, 2, 0.018);
  g.translate(0, 0.03, 0);
  return g;
})();

/* ------------------------------------------------------------------ manager */

export class Pieces {
  constructor(scene, graph, camera, domElement, tiles = []) {
    this.graph = graph;
    this.camera = camera;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.onPick = null; // optional (hit, button) => void; replaces the default free-build cycling
    this.pickKinds = new Set(['vertex', 'edge', 'tile']);
    // adjacency
    this.vertexEdges = graph.verts.map(() => []);
    for (const e of graph.edges) {
      this.vertexEdges[e.a].push(e);
      this.vertexEdges[e.b].push(e);
    }
    // Per player: [walls, roof, stone, wood, glass] matching the piece geometry groups.
    const stone = new THREE.MeshStandardMaterial({ color: 0xa39c90, roughness: 0.92 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3222, roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x2a2630, roughness: 0.25, emissive: 0xffb45e, emissiveIntensity: 0.35 });
    this.materials = Object.fromEntries(
      Object.entries(PLAYER_COLORS).map(([k, c]) => {
        const wall = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.02 });
        const roofColor = new THREE.Color(c).multiplyScalar(k === 'white' ? 0.45 : 0.5);
        const roof = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.7 });
        return [k, [wall, roof, stone, wood, glass]];
      })
    );
    this.spawning = []; // meshes popping in after placement
    this.player = 'red';
    this.vertexState = new Map(); // id -> { owner, level: 1|2, mesh }
    this.edgeState = new Map(); // id -> { owner, mesh }
    this.onChange = null;

    // Invisible pick targets on their own layer (never rendered by the view camera).
    this.pickGroup = new THREE.Group();
    scene.add(this.pickGroup);
    const vGeo = new THREE.SphereGeometry(0.14, 8, 6);
    const eGeo = new THREE.BoxGeometry(0.4, 0.14, 0.16);
    const pickMat = new THREE.MeshBasicMaterial();
    for (const v of graph.verts) {
      const m = new THREE.Mesh(vGeo, pickMat);
      m.position.set(v.x, v.y, v.z);
      m.userData = { kind: 'vertex', id: v.id };
      m.layers.set(PICK_LAYER);
      this.pickGroup.add(m);
    }
    for (const e of graph.edges) {
      const m = new THREE.Mesh(eGeo, pickMat);
      m.position.set(e.x, e.y, e.z);
      m.rotation.y = -e.angle;
      m.userData = { kind: 'edge', id: e.id };
      m.layers.set(PICK_LAYER);
      this.pickGroup.add(m);
    }
    const tGeo = new THREE.CircleGeometry(HEX_R * 0.8, 6);
    tGeo.rotateX(-Math.PI / 2);
    tGeo.rotateY(Math.PI / 6);
    tiles.forEach((t, i) => {
      const m = new THREE.Mesh(tGeo, pickMat);
      m.position.set(t.x, BASE_TOP + 0.06, t.z);
      m.userData = { kind: 'tile', id: i };
      m.layers.set(PICK_LAYER);
      this.pickGroup.add(m);
    });

    // Hover markers
    const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
    this.hoverVertex = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), hoverMat);
    this.hoverEdge = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.12), hoverMat);
    const ringGeo = new THREE.RingGeometry(HEX_R * 0.78, HEX_R * 0.9, 6);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.rotateY(Math.PI / 6);
    this.hoverTile = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    this.hoverVertex.visible = this.hoverEdge.visible = this.hoverTile.visible = false;
    scene.add(this.hoverVertex, this.hoverEdge, this.hoverTile);
    this.tiles = tiles;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(PICK_LAYER);
    this.pointer = new THREE.Vector2();
    this.down = null;
    this.hovered = null;

    domElement.addEventListener('pointermove', (ev) => this.onMove(ev));
    domElement.addEventListener('pointerdown', (ev) => { this.down = [ev.clientX, ev.clientY, ev.button]; });
    domElement.addEventListener('pointerup', (ev) => {
      if (!this.down) return;
      const moved = Math.hypot(ev.clientX - this.down[0], ev.clientY - this.down[1]);
      const button = this.down[2];
      this.down = null;
      if (moved < 5) this.onClick(ev, button);
    });
    domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /** Pop-in animation for newly placed pieces; call once per frame. */
  update(dt) {
    for (let i = this.spawning.length - 1; i >= 0; i--) {
      const sp = this.spawning[i];
      sp.t = Math.min(1, sp.t + dt / 0.35);
      const c = 1.70158, u = sp.t - 1;
      const k = 1 + (c + 1) * u * u * u + c * u * u; // ease-out back
      sp.mesh.scale.setScalar(Math.max(0.001, k));
      sp.mesh.position.y = sp.y + (1 - sp.t) * 0.25;
      if (sp.t >= 1) this.spawning.splice(i, 1);
    }
  }

  spawn(mesh) {
    mesh.scale.setScalar(0.001);
    this.spawning.push({ mesh, t: 0, y: mesh.position.y });
  }

  setPlayer(name) {
    if (this.materials[name]) this.player = name;
  }

  pick(ev) {
    const rect = ev.target.getBoundingClientRect();
    this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickGroup.children, false);
    const hit = hits.find((h) => this.pickKinds.has(h.object.userData.kind));
    return hit ? hit.object.userData : null;
  }

  vertexNeighbors(vid) {
    return this.vertexEdges[vid].map((e) => (e.a === vid ? e.b : e.a));
  }

  edgesOfVertex(vid) {
    return this.vertexEdges[vid];
  }

  onMove(ev) {
    const hit = this.pick(ev);
    this.hovered = hit;
    this.hoverVertex.visible = this.hoverEdge.visible = this.hoverTile.visible = false;
    if (!hit) return;
    if (hit.kind === 'vertex') {
      const v = this.graph.verts[hit.id];
      this.hoverVertex.position.set(v.x, v.y + 0.05, v.z);
      this.hoverVertex.visible = true;
    } else if (hit.kind === 'edge') {
      const e = this.graph.edges[hit.id];
      this.hoverEdge.position.set(e.x, e.y + 0.02, e.z);
      this.hoverEdge.rotation.y = -e.angle;
      this.hoverEdge.visible = true;
    } else {
      const t = this.tiles[hit.id];
      this.hoverTile.position.set(t.x, BASE_TOP + 0.08, t.z);
      this.hoverTile.visible = true;
    }
  }

  onClick(ev, button) {
    const hit = this.pick(ev);
    if (!hit) return;
    if (this.onPick) {
      this.onPick(hit, button);
      return;
    }
    if (hit.kind === 'tile') return;
    if (hit.kind === 'vertex') {
      if (button === 2) this.removeVertex(hit.id);
      else this.cycleVertex(hit.id, this.player);
    } else {
      if (button === 2) this.removeEdge(hit.id);
      else this.toggleRoad(hit.id, this.player);
    }
    if (this.onChange) this.onChange();
  }

  /* ---- placement API ---- */

  placeSettlement(id, owner) { this._setVertex(id, owner, 1); }
  placeCity(id, owner) { this._setVertex(id, owner, 2); }

  cycleVertex(id, owner) {
    const s = this.vertexState.get(id);
    if (!s) this._setVertex(id, owner, 1);
    else if (s.owner !== owner) this._setVertex(id, owner, 1);
    else if (s.level === 1) this._setVertex(id, owner, 2);
    else this.removeVertex(id);
  }

  removeVertex(id) {
    const s = this.vertexState.get(id);
    if (!s) return;
    this.group.remove(s.mesh);
    this.vertexState.delete(id);
  }

  _setVertex(id, owner, level) {
    this.removeVertex(id);
    const v = this.graph.verts[id];
    const mesh = new THREE.Mesh(level === 2 ? cityGeometry : settlementGeometry, this.materials[owner]);
    mesh.position.set(v.x, v.y, v.z);
    // front door toward the board centre
    mesh.rotation.y = Math.atan2(-v.x, -v.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(AO_LAYER);
    this.group.add(mesh);
    this.spawn(mesh);
    this.vertexState.set(id, { owner, level, mesh });
  }

  placeRoad(id, owner) {
    this.removeEdge(id);
    const e = this.graph.edges[id];
    const mesh = new THREE.Mesh(roadGeometry, this.materials[owner][0]);
    mesh.position.set(e.x, e.y, e.z);
    mesh.rotation.y = -e.angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(AO_LAYER);
    this.group.add(mesh);
    this.spawn(mesh);
    this.edgeState.set(id, { owner, mesh });
  }

  toggleRoad(id, owner) {
    const s = this.edgeState.get(id);
    if (s && s.owner === owner) this.removeEdge(id);
    else this.placeRoad(id, owner);
  }

  removeEdge(id) {
    const s = this.edgeState.get(id);
    if (!s) return;
    this.group.remove(s.mesh);
    this.edgeState.delete(id);
  }

  /** Opening-style demo: two settlements (one upgraded) and two roads per player. */
  demo(rand) {
    const players = Object.keys(PLAYER_COLORS);
    const taken = new Set();
    const tooClose = (v) => {
      for (const id of taken) {
        const o = this.graph.verts[id];
        if (Math.hypot(o.x - v.x, o.z - v.z) < HEX_R * 1.05) return true;
      }
      return false;
    };
    const adjacentEdges = (vid) => this.graph.edges.filter((e) => e.a === vid || e.b === vid);
    for (const p of players) {
      for (let k = 0; k < 2; k++) {
        for (let tries = 0; tries < 200; tries++) {
          const v = rand.pick(this.graph.verts);
          if (v.tiles.length < 2 || tooClose(v)) continue;
          taken.add(v.id);
          this._setVertex(v.id, p, k === 1 ? 2 : 1);
          const es = adjacentEdges(v.id).filter((e) => !this.edgeState.has(e.id));
          if (es.length) this.placeRoad(rand.pick(es).id, p);
          break;
        }
      }
    }
  }
}
