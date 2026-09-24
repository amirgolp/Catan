// PBR material helpers built on MeshStandardMaterial, including a two-layer terrain
// splat material that blends texture sets by a per-vertex `blend` attribute.
import * as THREE from 'three';

function withRepeat(tex, repeat) {
  if (repeat === 1) return tex;
  const t = tex.clone(); // shares the GPU upload via Source
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  // Track clones so a later image swap (2k upgrade) can flag them for re-upload.
  (tex.userData.clones || (tex.userData.clones = [])).push(t);
  return t;
}

/** Standard PBR material from a { map, normalMap, arm } set. */
export function pbrMaterial(set, { repeat = 1, color = 0xffffff, normalScale = 1, roughness = 1, vertexColors = false, side = THREE.FrontSide, envMapIntensity = 1 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    map: withRepeat(set.map, repeat),
    normalMap: withRepeat(set.normalMap, repeat),
    aoMap: withRepeat(set.arm, repeat),
    roughnessMap: withRepeat(set.arm, repeat),
    metalness: 0,
    roughness,
    vertexColors,
    side,
    envMapIntensity,
  });
  m.normalScale.set(normalScale, normalScale);
  return m;
}

/**
 * Terrain material: layer A everywhere, layer B where the geometry's `blend`
 * attribute approaches 1. Vertex colours act as a tint on the result.
 */
export function terrainMaterial(setA, setB, { repeatA = 3, repeatB = 3, normalScale = 1 } = {}) {
  if (!setB) return pbrMaterial(setA, { repeat: repeatA, vertexColors: true, normalScale });

  const m = new THREE.MeshStandardMaterial({
    map: setA.map,
    normalMap: setA.normalMap,
    aoMap: setA.arm,
    roughnessMap: setA.arm,
    metalness: 0,
    roughness: 1,
    vertexColors: true,
  });
  m.normalScale.set(normalScale, normalScale);

  const uniforms = {
    mapB: { value: setB.map },
    normalMapB: { value: setB.normalMap },
    armB: { value: setB.arm },
    repeatA: { value: new THREE.Vector2(repeatA, repeatA) },
    repeatB: { value: new THREE.Vector2(repeatB, repeatB) },
  };

  // Colour and ARM are sampled triplanar in tile-local space so cliffs and the skirt
  // are not smeared by the top-down UVs. Normal maps stay UV based but fade on steep faces.
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float blend;\nvarying float vBlend;\nvarying vec3 vLPos;\nvarying vec3 vLNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlend = blend;\nvLPos = transformed;\nvLNrm = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D mapB;
        uniform sampler2D normalMapB;
        uniform sampler2D armB;
        uniform vec2 repeatA;
        uniform vec2 repeatB;
        varying float vBlend;
        varying vec3 vLPos;
        varying vec3 vLNrm;
        vec4 triplanar( sampler2D t, vec3 p, vec3 w, float rep ) {
          return texture2D( t, p.zy * rep ) * w.x + texture2D( t, p.xz * rep ) * w.y + texture2D( t, p.xy * rep ) * w.z;
        }`
      )
      .replace(
        '#include <map_fragment>',
        `vec3 tw = pow( abs( normalize( vLNrm ) ), vec3( 4.0 ) );
        tw /= ( tw.x + tw.y + tw.z );
        float rA = repeatA.x * 0.5;
        float rB = repeatB.x * 0.5;
        vec4 texA = triplanar( map, vLPos, tw, rA );
        vec4 texB = triplanar( mapB, vLPos, tw, rB );
        diffuseColor *= mix( texA, texB, vBlend );`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        vec4 armMix = mix( triplanar( roughnessMap, vLPos, tw, rA ), triplanar( armB, vLPos, tw, rB ), vBlend );
        roughnessFactor *= armMix.g;`
      )
      .replace(
        'float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;',
        'float ambientOcclusion = ( armMix.r - 1.0 ) * aoMapIntensity + 1.0;'
      )
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec3 mapN = mix( texture2D( normalMap, vNormalMapUv * repeatA ), texture2D( normalMapB, vNormalMapUv * repeatB ), vBlend ).xyz * 2.0 - 1.0;
        mapN.xy *= 1.0 - smoothstep( 0.45, 0.8, 1.0 - abs( normalize( vLNrm ).y ) );`
      );
  };
  m.customProgramCacheKey = () => 'terrain-splat';
  return m;
}

/** Alpha-tested foliage card material with a gentle wind sway driven by `uTime`. */
export function foliageMaterial(texture, uTime, { sway = 0.3 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: texture,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    // Cards carry authored "soft" normals; keep them for back faces too so the
    // far side of a leaf card is not shaded as if it faced away from the light.
    shader.fragmentShader = shader.fragmentShader.replace('normal *= faceDirection;', '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float phase = instanceMatrix[3].x * 3.1 + instanceMatrix[3].z * 2.7;
          float swayAmt = sin(uTime * 1.6 + phase) * ${sway.toFixed(3)} * position.y;
          transformed.x += swayAmt;
          transformed.z += swayAmt * 0.4;
        #endif`
      );
  };
  m.customProgramCacheKey = () => 'foliage-' + sway.toFixed(3);
  return m;
}
