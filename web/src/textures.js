// Procedural textures: grain detail map, tileable water normal map, number tokens.
import * as THREE from 'three';
import { makeRng } from './noise.js';

export function grainTexture(size = 256, seed = 7) {
  const rand = makeRng(seed);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = 215 + Math.floor(rand() * 40);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable normal map from a sum of integer-frequency sine waves. */
export function waterNormalTexture(size = 512, seed = 3) {
  const rand = makeRng(seed);
  const waves = [];
  for (let i = 0; i < 12; i++) {
    waves.push({
      kx: Math.round(rand.range(-7, 7)),
      ky: Math.round(rand.range(-7, 7)),
      amp: rand.range(0.4, 1) / (1 + i * 0.35),
      ph: rand() * Math.PI * 2,
    });
  }
  const h = (u, v) => {
    let s = 0;
    for (const w of waves) s += w.amp * Math.sin(2 * Math.PI * (w.kx * u + w.ky * v) + w.ph);
    return s;
  };
  const data = new Uint8Array(size * size * 4);
  const e = 1 / size, str = 0.012;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const dx = ((h(u + e, v) - h(u - e, v)) / (2 * e)) * str;
      const dy = ((h(u, v + e) - h(u, v - e)) / (2 * e)) * str;
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len, ny = -dy / len, nz = 1 / len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Catan number token face: number + probability pips. */
export function tokenTexture(number, transparentBg = false) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (transparentBg) ctx.clearRect(0, 0, size, size);
  else {
    ctx.fillStyle = '#e8d9b0';
    ctx.fillRect(0, 0, size, size);
  }
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = '#f1e5c2';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#c9b184';
  ctx.stroke();

  const hot = number === 6 || number === 8;
  ctx.fillStyle = hot ? '#b3261e' : '#2b2119';
  ctx.font = 'bold ' + (hot ? 128 : 112) + 'px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), size / 2, size / 2 - 14);

  const pips = 6 - Math.abs(7 - number);
  const gap = 22;
  const startX = size / 2 - ((pips - 1) * gap) / 2;
  for (let i = 0; i < pips; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * gap, size / 2 + 66, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const RESOURCE_STYLE = {
  wood: { label: 'WOOD', color: '#2f6a1e' },
  brick: { label: 'BRICK', color: '#a34a2c' },
  wool: { label: 'WOOL', color: '#8cc63f' },
  grain: { label: 'GRAIN', color: '#d9b048' },
  ore: { label: 'ORE', color: '#5a6068' },
};

/** Harbour sign: "3:1" or "2:1 + resource" on a wooden board. */
export function portSignTexture(type) {
  const w = 320, h = 200;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // board
  ctx.fillStyle = '#5a3f26';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8f6b3f';
  ctx.fillRect(10, 10, w - 20, h - 20);
  ctx.strokeStyle = '#6b4f2e';
  ctx.lineWidth = 3;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(10, 10 + (i * (h - 20)) / 3);
    ctx.lineTo(w - 10, 10 + (i * (h - 20)) / 3);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f7ecd2';
  ctx.strokeStyle = '#2b2119';
  ctx.lineWidth = 6;
  if (type === '3:1') {
    ctx.font = 'bold 120px Georgia, serif';
    ctx.strokeText('3:1', w / 2, h / 2 + 6);
    ctx.fillText('3:1', w / 2, h / 2 + 6);
  } else {
    const st = RESOURCE_STYLE[type];
    ctx.font = 'bold 96px Georgia, serif';
    ctx.strokeText('2:1', w / 2, 66);
    ctx.fillText('2:1', w / 2, 66);
    ctx.fillStyle = st.color;
    ctx.strokeStyle = '#2b2119';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(40, 122, w - 80, 56, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2b2119';
    ctx.lineWidth = 5;
    ctx.font = 'bold 44px Georgia, serif';
    ctx.strokeText(st.label, w / 2, 151);
    ctx.fillText(st.label, w / 2, 151);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
