import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Assets } from '../engine/assets'

/**
 * Asset library: CC0 Poly Haven PBR texture sets, HDRI sky and prop models, all loaded at boot
 * behind the progress bar (the whole arena is the first playable segment).
 */
export const TEXTURE_SETS = [
  'concrete_floor_03',
  'concrete_floor_worn_001',
  'concrete_wall_008',
  'rusty_metal_02',
  'corrugated_iron_02',
  'metal_plate',
] as const
export type TextureSet = (typeof TEXTURE_SETS)[number]

export const MODELS = ['barrel_03', 'old_military_crate', 'wooden_military_crate', 'medical_box', 'ammo_box', 'propane_tank', 'utility_box_02', 'security_light', 'armor_plate', 'jersey_barrier', 'sandbags', 'frag_grenade', 'rtg_crane', 'reach_stacker'] as const
export type ModelId = (typeof MODELS)[number]

export type PbrSet = { map: THREE.Texture; normalMap: THREE.Texture; arm: THREE.Texture }

export type Library = {
  sets: Record<TextureSet, PbrSet>
  models: Record<ModelId, GLTF>
  envHdr: THREE.DataTexture
  sky: THREE.Texture
}

export async function loadLibrary(assets: Assets, anisotropy: number, onProgress: (p: number) => void): Promise<Library> {
  const base = 'assets/'
  // Keep the supplied GLB gameplay assets, but replace the original PBR/HDR boot payload with
  // one tiny neutral texture and a procedural gradient. This is the core of RiftStrike's light,
  // cartonized look: flat materials, clear silhouettes and no shader-heavy grime pass.
  const flat = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
  flat.colorSpace = THREE.SRGBColorSpace
  flat.wrapS = flat.wrapT = THREE.RepeatWrapping
  flat.anisotropy = Math.min(1, anisotropy)
  flat.needsUpdate = true
  const sets = Object.fromEntries(TEXTURE_SETS.map(name => [name, { map: flat, normalMap: flat, arm: flat }])) as unknown as Record<TextureSet, PbrSet>
  const models = {} as Record<ModelId, GLTF>
  const modelPromises = MODELS.map(async id => {
    models[id] = await assets.gltf(`${base}models/${id}.glb`)
  })
  onProgress(0)
  await Promise.all(modelPromises)
  const skyTex = new THREE.DataTexture(new Uint8Array([
    22, 35, 58, 255, 72, 118, 164, 255,
    250, 180, 88, 255, 47, 67, 82, 255,
  ]), 2, 2, THREE.RGBAFormat)
  skyTex.colorSpace = THREE.SRGBColorSpace
  skyTex.mapping = THREE.EquirectangularReflectionMapping
  skyTex.needsUpdate = true
  onProgress(1)
  return { sets, models, envHdr: skyTex, sky: skyTex }
}

/** Re-scale a BoxGeometry's UVs so textures tile at `tile` metres on every face. */
export function worldBox(w: number, h: number, d: number, tile = 4): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let f = 0; f < 6; f += 1) {
    for (let v = 0; v < 4; v += 1) {
      const i = f * 4 + v
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile)
    }
  }
  uv.needsUpdate = true
  g.setAttribute('uv1', uv.clone())
  return g
}

export type MatOptions = {
  color?: THREE.ColorRepresentation
  roughness?: number
  metalness?: number
  normalScale?: number
  envMapIntensity?: number
  emissive?: THREE.ColorRepresentation
  emissiveIntensity?: number
}

/** Standard PBR material from a Poly Haven set (ARM = AO/roughness/metalness packed). */
export function pbr(set: PbrSet, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? '#ffffff',
    roughness: o.roughness ?? 0.9,
    metalness: Math.min(0.25, o.metalness ?? 0.1),
    envMapIntensity: 0.08,
    flatShading: true,
  })
  void set
  void o.normalScale
  void o.envMapIntensity
  if (o.emissive) {
    m.emissive.set(o.emissive)
    m.emissiveIntensity = o.emissiveIntensity ?? 1
  }
  return m
}

/** Tileable value-noise canvas texture for procedural roughness / grime (weapons, robots). */
export function noiseTexture(size = 256, seed = 1, scale = 8, contrast = 1): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  let s = seed * 9301 + 49297
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const layers = [scale, scale * 2, scale * 4, scale * 8]
  const grids = layers.map(n => Array.from({ length: n * n }, rand))
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let v = 0
      let amp = 0.5
      for (let l = 0; l < layers.length; l += 1) {
        const n = layers[l]
        const fx = (x / size) * n
        const fy = (y / size) * n
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const tx = fx - x0
        const ty = fy - y0
        const g = grids[l]
        const at = (a: number, b: number) => g[((b % n) * n + (a % n))]
        const sx = tx * tx * (3 - 2 * tx)
        const sy = ty * ty * (3 - 2 * ty)
        const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx
        const bot = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx
        v += (top * (1 - sy) + bot * sy) * amp
        amp *= 0.5
      }
      const c = Math.max(0, Math.min(255, (0.5 + (v / 0.9375 - 0.5) * contrast) * 255))
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

export type GrimeOptions = {
  /** 0..1 strength of dark grime blotches. */
  amount?: number
  /** World-space frequency multiplier (higher = smaller blotches). */
  scale?: number
  /** 0..1 wet patches (lower roughness + slightly darker albedo); floors only. Kept subtle to avoid glare. */
  wet?: number
  /** 0..1 darkening toward the ground contact line (walls, props). */
  foot?: number
}

/**
 * Break up tiling with world-space grime, contact darkening and restrained wet patches, so
 * repeated PBR textures read as a lived-in industrial site. Pure shader patch: no extra textures.
 */
export function applyGrime(m: THREE.MeshStandardMaterial, o: GrimeOptions = {}): void {
  // The showcase's world-space grime shader is intentionally removed in the light remix.
  // Retaining this function keeps the original arena source compatible while avoiding a custom
  // fragment program for every static material.
  void m
  void o
}
