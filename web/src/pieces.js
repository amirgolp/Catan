// Board graph (vertices / edges of the hex layout) and player pieces: settlements,
// cities and roads in each player's skin, with hover + click placement.
import * as THREE from 'three';
import { HEX_R, BASE_TOP, hexCorners } from './hexGeometry.js';
import { skinGeometry, skinMaterials, DEFAULT_SKIN } from './skins.js';

/** Seat colours in turn order; games use the first N. */
export const PLAYER_COLORS = {
  red: 0xc0392b,
  blue: 0x2e6db4,
  white: 0xf2efe6,
  orange: 0xe67e22,
  green: 0x3f9b57,
  brown: 0x7a4b2a,
};
export const PLAYER_KEYS = Object.keys(PLAYER_COLORS);

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
    this.skins = {}; // owner -> skin id (cosmetic)
    this.spawning = []; // meshes popping in after placement
    this.ghostMats = {}; // owner -> see-through material for hidden parts
    // Placement hints (opening, free roads): pulsing rings / bars drawn over everything.
    this.hintGroup = new THREE.Group();
    this.hintGroup.renderOrder = 20;
    scene.add(this.hintGroup);
    this.hintKey = '';
    this.hintTime = 0;
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

  /**
   * World positions of every small prop (trees, rocks, grass tufts, sheep, mine frames) on
   * the tiles, built on first use so pieces can clear the ground they stand on.
   */
  propIndex() {
    if (this._props) return this._props;
    const list = [];
    const m = new THREE.Matrix4(), w = new THREE.Matrix4(), v = new THREE.Vector3();
    for (const t of this.tiles) {
      const surf = t.tile && t.tile.surf;
      if (!surf) continue;
      surf.updateWorldMatrix(true, true);
      surf.traverse((o) => {
        if (o.isInstancedMesh) {
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, m);
            w.multiplyMatrices(o.matrixWorld, m);
            v.setFromMatrixPosition(w);
            list.push({ mesh: o, index: i, x: v.x, z: v.z });
          }
        } else if (o.isMesh && o.geometry && !(o.parent && o.parent.userData.robber)) {
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          if (o.geometry.boundingSphere.radius > 0.45) return; // terrain, base slab, water
          o.getWorldPosition(v);
          list.push({ mesh: o, index: -1, x: v.x, z: v.z });
        }
      });
    }
    this._props = list;
    return list;
  }

  /** Hides props within `r` of (x, z), or within `r` of the segment to (x2, z2). */
  clearProps(x, z, r, x2 = x, z2 = z) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const dx = x2 - x, dz = z2 - z, len2 = dx * dx + dz * dz;
    const touched = new Set();
    for (const p of this.propIndex()) {
      if (p.hidden) continue;
      let t = len2 ? ((p.x - x) * dx + (p.z - z) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (x + dx * t), p.z - (z + dz * t));
      if (d > r) continue;
      p.hidden = true;
      if (p.index >= 0) { p.mesh.setMatrixAt(p.index, zero); touched.add(p.mesh); }
      else p.mesh.visible = false;
    }
    for (const mesh of touched) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere?.(); }
  }

  /**
   * Material for the see-through copy of a piece: drawn only where something (a tree, a
   * mountain, another piece) is in front of it, so pieces stay visible from every angle.
   */
  ghostMaterial(owner) {
    if (!this.ghostMats[owner]) {
      this.ghostMats[owner] = new THREE.MeshBasicMaterial({
        color: PLAYER_COLORS[owner], transparent: true, opacity: 0.55, depthWrite: false, depthFunc: THREE.GreaterDepth,
      });
    }
    return this.ghostMats[owner];
  }

  addGhost(mesh, owner) {
    const ghost = new THREE.Mesh(mesh.geometry, this.ghostMaterial(owner));
    ghost.renderOrder = 10;
    ghost.userData.noAO = true;
    mesh.add(ghost);
  }

  /**
   * Highlights legal spots: { vertices: [ids], edges: [ids] } in a player's colour.
   * Called on every render; rebuilds only when the set changes.
   */
  setHints(spots, color) {
    const key = `${color}|${spots.vertices.join(',')}|${spots.edges.join(',')}`;
    if (key === this.hintKey) return;
    this.hintKey = key;
    for (const c of [...this.hintGroup.children]) this.hintGroup.remove(c);
    if (!spots.vertices.length && !spots.edges.length) return;
    if (!this._hintGeo) {
      const ring = new THREE.RingGeometry(0.1, 0.16, 32);
      ring.rotateX(-Math.PI / 2);
      const dot = new THREE.CircleGeometry(0.07, 20);
      dot.rotateX(-Math.PI / 2);
      const bar = new THREE.BoxGeometry(0.36, 0.03, 0.08);
      const barCore = new THREE.BoxGeometry(0.3, 0.035, 0.04);
      this._hintGeo = { ring, dot, bar, barCore };
    }
    // white halo so the hint reads on any terrain, the player's colour in the middle
    const halo = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    const core = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    const add = (geo, mat, x, y, z, ry = 0, order = 20) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.renderOrder = order;
      this.hintGroup.add(m);
    };
    for (const id of spots.vertices) {
      const v = this.graph.verts[id];
      add(this._hintGeo.ring, halo, v.x, v.y + 0.05, v.z);
      add(this._hintGeo.dot, core, v.x, v.y + 0.05, v.z, 0, 21);
    }
    for (const id of spots.edges) {
      const e = this.graph.edges[id];
      add(this._hintGeo.bar, halo, e.x, e.y + 0.06, e.z, -e.angle);
      add(this._hintGeo.barCore, core, e.x, e.y + 0.065, e.z, -e.angle, 21);
    }
  }

  /** Pop-in animation for newly placed pieces; call once per frame. */
  update(dt) {
    this.hintTime += dt;
    if (this.hintGroup.children.length) {
      const k = 1 + Math.sin(this.hintTime * 5) * 0.18;
      for (const m of this.hintGroup.children) m.scale.setScalar(k);
      this.hintGroup.children[0].material.opacity = 0.7 + Math.sin(this.hintTime * 5) * 0.25;
    }
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
    if (PLAYER_COLORS[name] !== undefined) this.player = name;
  }

  skinOf(owner) { return this.skins[owner] || DEFAULT_SKIN; }

  materialsOf(owner) { return skinMaterials(this.skinOf(owner), PLAYER_COLORS[owner]); }

  /** Equips a skin for one player and rebuilds that player's pieces already on the board. */
  setSkin(owner, skin) {
    if (this.skins[owner] === skin) return;
    this.skins[owner] = skin;
    for (const [id, s] of [...this.vertexState]) if (s.owner === owner) this._setVertex(id, owner, s.level, false);
    for (const [id, s] of [...this.edgeState]) if (s.owner === owner) this.placeRoad(id, owner, false);
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

  _setVertex(id, owner, level, animate = true) {
    this.removeVertex(id);
    const v = this.graph.verts[id];
    this.clearProps(v.x, v.z, level === 2 ? 0.5 : 0.42);
    const mesh = new THREE.Mesh(skinGeometry(this.skinOf(owner), level === 2 ? 'city' : 'settlement'), this.materialsOf(owner));
    mesh.position.set(v.x, v.y, v.z);
    // front door toward the board centre
    mesh.rotation.y = Math.atan2(-v.x, -v.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(AO_LAYER);
    this.addGhost(mesh, owner);
    this.group.add(mesh);
    if (animate) this.spawn(mesh);
    this.vertexState.set(id, { owner, level, mesh });
  }

  placeRoad(id, owner, animate = true) {
    this.removeEdge(id);
    const e = this.graph.edges[id];
    const a = this.graph.verts[e.a], b = this.graph.verts[e.b];
    this.clearProps(a.x, a.z, 0.2, b.x, b.z);
    const mesh = new THREE.Mesh(skinGeometry(this.skinOf(owner), 'road'), this.materialsOf(owner)[0]);
    mesh.position.set(e.x, e.y, e.z);
    mesh.rotation.y = -e.angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(AO_LAYER);
    this.addGhost(mesh, owner);
    this.group.add(mesh);
    if (animate) this.spawn(mesh);
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
    const players = PLAYER_KEYS.slice(0, 4);
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
