import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

/**
 * Cached asset loading with one progress stream for the boot screen.
 *
 * The starter builds its world procedurally, so nothing is required here at boot. When adding
 * models or textures, put the files in `public/assets/` and preload them in `main.ts` with
 * `assets.gltf('assets/hero.glb')` before `game.start()` so the loading bar covers them.
 */
export class Assets {
  private readonly manager = new THREE.LoadingManager()
  private readonly gltfLoader = new GLTFLoader(this.manager)
  private readonly textureLoader = new THREE.TextureLoader(this.manager)
  private readonly cache = new Map<string, Promise<unknown>>()
  private listeners = new Set<(progress: number) => void>()

  constructor() {
    // Character rigs are meshopt-compressed (geometry + animation) to keep the boot payload small.
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder)
    this.manager.onProgress = (_url, loaded, total) => {
      const progress = total > 0 ? loaded / total : 1
      for (const fn of this.listeners) fn(progress)
    }
  }

  onProgress(fn: (progress: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  gltf(url: string): Promise<GLTF> {
    return this.memo(url, async () => {
      // Hosts that refuse .glb (claude.ai artifacts) get a build with VITE_GLB_SUFFIX=.wasm.
      const gltf = await this.gltfLoader.loadAsync(url + (import.meta.env.VITE_GLB_SUFFIX ?? ''))
      gltf.scene.traverse(node => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = false
        mesh.receiveShadow = true
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials) {
          const standard = material as THREE.MeshStandardMaterial
          if (!standard.isMeshStandardMaterial) continue
          standard.flatShading = true
          standard.roughness = 0.88
          standard.metalness = Math.min(0.2, standard.metalness)
          standard.envMapIntensity = 0.12
          standard.normalMap = null
          standard.roughnessMap = null
          standard.metalnessMap = null
          standard.aoMap = null
          standard.needsUpdate = true
        }
      })
      return gltf
    })
  }

  /** Color textures are tagged sRGB; pass `color: false` for normal/roughness maps. */
  texture(url: string, { color = true, repeat }: { color?: boolean; repeat?: number } = {}): Promise<THREE.Texture> {
    return this.memo(`${url}#${color}#${repeat ?? 1}`, async () => {
      const tex = await this.textureLoader.loadAsync(url)
      if (color) tex.colorSpace = THREE.SRGBColorSpace
      if (repeat) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(repeat, repeat)
      }
      return tex
    })
  }

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let pending = this.cache.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = load()
      this.cache.set(key, pending)
      pending.catch(() => this.cache.delete(key))
    }
    return pending
  }
}
