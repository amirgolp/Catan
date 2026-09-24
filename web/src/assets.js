// Loads CC0 PBR texture sets and a sky HDRI from Poly Haven (CORS enabled) plus the
// water normal map from the three.js repository. Everything is 1k JPG to keep the
// download around 10 MB.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const PH = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/';
const SETS = {
  grass: 'aerial_grass_rock/aerial_grass_rock',
  dryGrass: 'withered_grass/withered_grass',
  soil: 'farm_soil/farm_soil',
  forestFloor: [
    'forest_leaves_02/forest_leaves_02_diffuse_1k.jpg',
    'forest_leaves_02/forest_leaves_02_nor_gl_1k.jpg',
    'forest_leaves_02/forest_leaves_02_arm_1k.jpg',
  ],
  rock: 'rock_face/rock_face',
  boulder: 'rock_boulder_dry/rock_boulder_dry',
  clay: 'red_laterite_soil_stones/red_laterite_soil_stones',
  sand: 'aerial_sand/aerial_sand',
  riverbed: 'river_small_rocks/river_small_rocks',
  planks: 'weathered_planks/weathered_planks',
  darkWood: 'dark_wood/dark_wood',
  bark: 'bark_willow_02/bark_willow_02',
};
const HDRI = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_43d_clear_puresky_1k.hdr';
const WATER_NORMALS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/waternormals.jpg';

/**
 * Resolves to { tex: { name: { map, normalMap, arm } }, hdri, waterNormals }.
 * `arm` packs ambient occlusion (R), roughness (G) and metalness (B).
 */
export async function loadAssets(onProgress = () => {}) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => onProgress(loaded / total);
  const texLoader = new THREE.TextureLoader(manager);

  const loadTex = (url, srgb) =>
    new Promise((resolve, reject) =>
      texLoader.load(
        url,
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.userData.url = url;
          resolve(t);
        },
        undefined,
        reject
      )
    );

  const loadSet = async (spec) => {
    const [d, n, a] = Array.isArray(spec)
      ? spec
      : [`${spec}_diff_1k.jpg`, `${spec}_nor_gl_1k.jpg`, `${spec}_arm_1k.jpg`];
    const [map, normalMap, arm] = await Promise.all([
      loadTex(PH + d, true),
      loadTex(PH + n, false),
      loadTex(PH + a, false),
    ]);
    return { map, normalMap, arm };
  };

  const rgbe = new RGBELoader(manager);
  const hdriPromise = new Promise((resolve, reject) => rgbe.load(HDRI, resolve, undefined, reject));

  const entries = await Promise.all(Object.entries(SETS).map(async ([k, s]) => [k, await loadSet(s)]));
  const tex = Object.fromEntries(entries);
  const [hdri, waterNormals] = await Promise.all([hdriPromise, loadTex(WATER_NORMALS, false)]);
  hdri.mapping = THREE.EquirectangularReflectionMapping;
  return { tex, hdri, waterNormals };
}

/**
 * Replace the 1k images of the named texture sets with their 2k versions in place.
 * Materials keep their texture objects; clones made by materials.js are flagged too.
 */
export async function upgradeTextures(assets, keys, onProgress = () => {}) {
  const loader = new THREE.ImageLoader();
  loader.setCrossOrigin('anonymous');
  const jobs = [];
  for (const key of keys) {
    const set = assets.tex[key];
    if (!set) continue;
    for (const tex of [set.map, set.normalMap, set.arm]) {
      const url = tex.userData.url;
      if (!url || !url.includes('/1k/')) continue;
      jobs.push({ tex, url: url.replace('/1k/', '/2k/').replace('_1k.jpg', '_2k.jpg') });
    }
  }
  let done = 0;
  await Promise.all(
    jobs.map(
      (job) =>
        new Promise((resolve) => {
          loader.load(
            job.url,
            (img) => {
              // GPU storage was allocated at the old size (immutable texStorage), so
              // release it before swapping in the larger image, on the clones too.
              const all = [job.tex, ...(job.tex.userData.clones || [])];
              for (const t of all) t.dispose();
              job.tex.image = img;
              for (const t of all) t.needsUpdate = true;
              job.tex.userData.url = job.url;
              onProgress(++done / jobs.length);
              resolve();
            },
            undefined,
            () => {
              console.warn('2k texture failed', job.url);
              onProgress(++done / jobs.length);
              resolve();
            }
          );
        })
    )
  );
}

/** Direction (unit vector) of the brightest texel in an equirectangular HDRI. */
export function findSunDirection(hdri) {
  const { data, width, height } = hdri.image;
  const isHalf = hdri.type === THREE.HalfFloatType;
  const read = (i) => (isHalf ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  let best = -1;
  let bestIndex = 0;
  const stride = data.length / (width * height);
  for (let i = 0; i < width * height; i++) {
    const l = read(i * stride) + read(i * stride + 1) + read(i * stride + 2);
    if (l > best) {
      best = l;
      bestIndex = i;
    }
  }
  const c = bestIndex % width;
  const r = Math.floor(bestIndex / width);
  // RGBELoader sets flipY, so memory row 0 (top of the file) ends up at v = 1 (zenith).
  const u = (c + 0.5) / width;
  const v = 1 - (r + 0.5) / height;
  const phi = (u - 0.5) * Math.PI * 2;
  const theta = (v - 0.5) * Math.PI;
  return new THREE.Vector3(Math.cos(phi) * Math.cos(theta), Math.sin(theta), Math.sin(phi) * Math.cos(theta));
}
