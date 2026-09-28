// 3D dice toss: two dice fly in from the camera side, bounce on an invisible table above
// the island, tumble and settle showing the rolled values, then fade away.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Face order of BoxGeometry groups: +x, -x, +y, -y, +z, -z (opposite faces sum to 7).
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
const FACE_NORMALS = {
  3: new THREE.Vector3(1, 0, 0), 4: new THREE.Vector3(-1, 0, 0),
  1: new THREE.Vector3(0, 1, 0), 6: new THREE.Vector3(0, -1, 0),
  2: new THREE.Vector3(0, 0, 1), 5: new THREE.Vector3(0, 0, -1),
};
const PIPS = { 1: [[0.5, 0.5]], 2: [[0.28, 0.28], [0.72, 0.72]], 3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]], 5: [[0.26, 0.26], [0.74, 0.26], [0.5, 0.5], [0.26, 0.74], [0.74, 0.74]],
  6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]] };

function faceTexture(value, pipColor) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#fbf7ee';
  g.fillRect(0, 0, s, s);
  g.fillStyle = value === 1 ? '#b8322a' : pipColor;
  for (const [x, y] of PIPS[value]) {
    g.beginPath();
    g.arc(x * s, y * s, value === 1 ? 15 : 11, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class DiceRoller {
  constructor(scene, camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const geo = new RoundedBoxGeometry(1, 1, 1, 3, 0.14);
    const mats = FACE_VALUES.map((v) => new THREE.MeshStandardMaterial({ map: faceTexture(v, '#1d1a17'), roughness: 0.35, transparent: true }));
    this.dice = [0, 1].map(() => {
      const m = new THREE.Mesh(geo, mats);
      m.castShadow = true;
      m.userData.noAO = true;
      this.group.add(m);
      return m;
    });
    this.anim = null;
  }

  /** Starts a toss that lands on `values` ([d1, d2]) after `duration` seconds. */
  throw(values, duration = 1.15) {
    const cam = this.camera.position;
    const target = this.controls.target;
    const toCam = new THREE.Vector3(cam.x - target.x, 0, cam.z - target.z).normalize();
    const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const dist = cam.distanceTo(target);
    const size = THREE.MathUtils.clamp(dist * 0.03, 0.14, 0.5);
    const tableY = target.y + 0.55 + size;
    const land = target.clone().addScaledVector(toCam, dist * 0.16).setY(tableY);
    const up = new THREE.Vector3(0, 1, 0);
    this.anim = {
      t: 0, duration, hold: 1.5, fade: 0.35, size,
      dice: this.dice.map((mesh, i) => {
        const offset = (i === 0 ? -1 : 1) * size * 0.9;
        const end = land.clone().addScaledVector(side, offset).addScaledVector(toCam, (Math.random() - 0.5) * size);
        const start = end.clone().addScaledVector(toCam, dist * 0.35).addScaledVector(side, offset * 2).setY(tableY + size * 6);
        const yaw = new THREE.Quaternion().setFromAxisAngle(up, Math.random() * Math.PI * 2);
        const final = new THREE.Quaternion().setFromUnitVectors(FACE_NORMALS[values[i]], up).premultiply(yaw);
        const spin = new THREE.Vector3(Math.random() * 14 + 10, Math.random() * 10 - 5, Math.random() * 14 + 10);
        mesh.scale.setScalar(size);
        mesh.material.forEach((m) => { m.opacity = 1; });
        return { mesh, start, end, final, spin };
      }),
    };
    this.group.visible = true;
  }

  update(dt) {
    const a = this.anim;
    if (!a) return;
    a.t += dt;
    const u = Math.min(1, a.t / a.duration);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const d of a.dice) {
      // horizontal: ease out; vertical: a throw arc then two shrinking bounces
      const h = 1 - Math.pow(1 - u, 2.2);
      d.mesh.position.lerpVectors(d.start, d.end, h);
      let y;
      if (u < 0.5) { const k = u / 0.5; y = (1 - k * k); }
      else if (u < 0.75) { const k = (u - 0.5) / 0.25; y = 4 * k * (1 - k) * 0.22; }
      else if (u < 0.9) { const k = (u - 0.75) / 0.15; y = 4 * k * (1 - k) * 0.07; }
      else y = 0;
      d.mesh.position.y = d.end.y + y * (d.start.y - d.end.y);
      const spinT = 1 - Math.pow(1 - u, 2);
      e.set(d.spin.x * spinT, d.spin.y * spinT, d.spin.z * spinT);
      q.setFromEuler(e);
      d.mesh.quaternion.slerpQuaternions(q, d.final, smooth(0.45, 0.92, u));
    }
    const after = a.t - a.duration - a.hold;
    if (after > 0) {
      const k = Math.min(1, after / a.fade);
      for (const d of a.dice) {
        d.mesh.material.forEach((m) => { m.opacity = 1 - k; });
        d.mesh.scale.setScalar(a.size * (1 - 0.4 * k));
      }
      if (k >= 1) { this.anim = null; this.group.visible = false; }
    }
  }
}
