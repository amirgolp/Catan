// Minimap: a flat, north-up SVG of the island with every hut, house, road and the robber,
// plus a marker for where the camera looks from. Clicking a tile flies the camera there.
import { HEX_R, hexCorners } from './hexGeometry.js';
import { PLAYER_COLORS } from './pieces.js';

const TERRAIN = { fields: '#e0bf55', forest: '#2f6b2a', pasture: '#93c45c', hills: '#b8643a', mountains: '#7f878f', desert: '#dcc995' };
const hex = (key) => '#' + PLAYER_COLORS[key].toString(16).padStart(6, '0');
const f = (n) => n.toFixed(2);

export class Minimap {
  /** @param svg the <svg> element; onFocus(x, z) moves the camera. */
  constructor(svg, { board, pieces, camera, controls, onFocus }) {
    this.svg = svg;
    this.board = board;
    this.pieces = pieces;
    this.camera = camera;
    this.controls = controls;
    this.onFocus = onFocus;
    this.key = '';
    this.camAngle = null;
    this.build();
    svg.addEventListener('click', (ev) => this.click(ev));
  }

  build() {
    const tiles = this.board.tiles;
    const pad = HEX_R * 1.25;
    const xs = tiles.map((t) => t.x), zs = tiles.map((t) => t.z);
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
    this.box = { minX, minZ, w: maxX - minX, h: maxZ - minZ };
    this.svg.setAttribute('viewBox', `${f(minX)} ${f(minZ)} ${f(this.box.w)} ${f(this.box.h)}`);
    const corners = hexCorners(HEX_R * 0.96);
    let terrain = '';
    for (const t of tiles) {
      const pts = corners.map(([cx, cz]) => `${f(t.x + cx)},${f(t.z + cz)}`).join(' ');
      terrain += `<polygon points="${pts}" fill="${TERRAIN[t.type] || '#999'}" stroke="rgba(0,0,0,0.35)" stroke-width="0.04"/>`;
      if (t.number) {
        const hot = t.number === 6 || t.number === 8;
        terrain += `<circle cx="${f(t.x)}" cy="${f(t.z)}" r="0.3" fill="#f6efdc" stroke="rgba(0,0,0,0.3)" stroke-width="0.03"/>` +
          `<text x="${f(t.x)}" y="${f(t.z + 0.11)}" font-size="0.32" font-weight="700" text-anchor="middle" fill="${hot ? '#b8322a' : '#2a211a'}">${t.number}</text>`;
      }
    }
    let ports = '';
    for (const p of this.board.ports || []) {
      const x = p.x + (p.dirX || 0) * 0.45, z = p.z + (p.dirZ || 0) * 0.45;
      ports += `<g transform="translate(${f(x)} ${f(z)})"><rect x="-0.3" y="-0.16" width="0.6" height="0.32" rx="0.06" fill="#7a5a2c"/><text y="0.08" font-size="0.2" font-weight="700" text-anchor="middle" fill="#f6efdc">${p.type === '3:1' ? '3:1' : '2:1'}</text></g>`;
    }
    this.svg.innerHTML = `<g>${terrain}</g><g>${ports}</g><g class="mm-pieces"></g><g class="mm-cam"></g>`;
    this.piecesLayer = this.svg.querySelector('.mm-pieces');
    this.camLayer = this.svg.querySelector('.mm-cam');
    this.refresh(true);
  }

  /** Redraws buildings, roads and the robber when anything changed. */
  refresh(force = false) {
    const pc = this.pieces;
    const robber = this.board.tiles.indexOf(this.board.robber.tile);
    const key = `${robber}|${[...pc.vertexState].map(([id, s]) => id + s.owner + s.level).join(',')}|${[...pc.edgeState].map(([id, s]) => id + s.owner).join(',')}`;
    if (!force && key === this.key) return;
    this.key = key;
    const g = pc.graph;
    let roads = '', builds = '';
    for (const [id, s] of pc.edgeState) {
      const e = g.edges[id], a = g.verts[e.a], b = g.verts[e.b];
      const line = `x1="${f(a.x + (b.x - a.x) * 0.15)}" y1="${f(a.z + (b.z - a.z) * 0.15)}" x2="${f(b.x + (a.x - b.x) * 0.15)}" y2="${f(b.z + (a.z - b.z) * 0.15)}"`;
      roads += `<line ${line} stroke="#111" stroke-width="0.2" stroke-linecap="round"/><line ${line} stroke="${hex(s.owner)}" stroke-width="0.13" stroke-linecap="round"/>`;
    }
    for (const [id, s] of pc.vertexState) {
      const v = g.verts[id];
      builds += s.level === 2
        ? `<path transform="translate(${f(v.x)} ${f(v.z)})" d="M-0.2 0.16 V-0.04 L0 -0.22 L0.2 -0.04 V0.16 Z" fill="${hex(s.owner)}" stroke="#111" stroke-width="0.05"/>`
        : `<circle cx="${f(v.x)}" cy="${f(v.z)}" r="0.14" fill="${hex(s.owner)}" stroke="#111" stroke-width="0.05"/>`;
    }
    let rob = '';
    const t = this.board.tiles[robber];
    if (t) rob = `<g transform="translate(${f(t.x + 0.3)} ${f(t.z + 0.28)})"><circle r="0.16" fill="#1d1a17" stroke="#f6efdc" stroke-width="0.04"/><circle cy="-0.2" r="0.09" fill="#1d1a17" stroke="#f6efdc" stroke-width="0.03"/></g>`;
    this.piecesLayer.innerHTML = roads + builds + rob;
  }

  /** Per frame: turns the camera marker to the current viewing direction. */
  tick() {
    const c = this.camera.position, t = this.controls.target;
    const ang = Math.atan2(c.z - t.z, c.x - t.x);
    if (this.camAngle !== null && Math.abs(ang - this.camAngle) < 0.01 && this.camTarget === `${f(t.x)},${f(t.z)}`) return;
    this.camAngle = ang;
    this.camTarget = `${f(t.x)},${f(t.z)}`;
    const r = Math.min(this.box.w, this.box.h) / 2 - 0.25;
    const cx = this.box.minX + this.box.w / 2, cz = this.box.minZ + this.box.h / 2;
    const ex = cx + Math.cos(ang) * r, ez = cz + Math.sin(ang) * r;
    const deg = (ang * 180) / Math.PI;
    // eye marker at the rim pointing at the view target, plus a cross on the target
    this.camLayer.innerHTML =
      `<line x1="${f(ex)}" y1="${f(ez)}" x2="${f(t.x)}" y2="${f(t.z)}" stroke="rgba(255,255,255,0.55)" stroke-width="0.05" stroke-dasharray="0.15 0.12"/>` +
      `<g transform="translate(${f(ex)} ${f(ez)}) rotate(${f(deg + 180)})"><path d="M0.32 0 L-0.18 -0.22 L-0.08 0 L-0.18 0.22 Z" fill="#f2c14e" stroke="#111" stroke-width="0.04"/></g>` +
      `<circle cx="${f(t.x)}" cy="${f(t.z)}" r="0.12" fill="none" stroke="#f2c14e" stroke-width="0.05"/>`;
  }

  click(ev) {
    const rect = this.svg.getBoundingClientRect();
    // viewBox uses "meet": work out the drawn area inside the element
    const scale = Math.min(rect.width / this.box.w, rect.height / this.box.h);
    const ox = rect.left + (rect.width - this.box.w * scale) / 2;
    const oy = rect.top + (rect.height - this.box.h * scale) / 2;
    const x = this.box.minX + (ev.clientX - ox) / scale;
    const z = this.box.minZ + (ev.clientY - oy) / scale;
    if (this.onFocus) this.onFocus(x, z);
  }
}
