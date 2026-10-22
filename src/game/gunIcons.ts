import * as THREE from 'three'
import { buildGunVM } from './gunModels'
import { GUN_IDS, type GunId } from './gunSpecs'
import type { VmAssets } from './tripoguns'

/**
 * Buy-menu icons rendered from the real gun models: a side-on orthographic shot of each
 * viewmodel (no arms) drawn as a flat white silhouette, like the weapon icons of tactical
 * shooters. Rendered once into a small render target and kept as data URLs.
 */
export function renderGunIcons(gl: THREE.WebGLRenderer, assets: VmAssets, flashTex: THREE.Texture, flameTex: THREE.Texture): Record<GunId, string> {
  const W = 192
  const H = 72
  const target = new THREE.WebGLRenderTarget(W, H, { samples: 4 })
  const scene = new THREE.Scene()
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10)
  // From the gun's left side: the barrel (−Z) points left on screen.
  cam.position.set(-5, 0, 0)
  cam.lookAt(0, 0, 0)
  const prevTarget = gl.getRenderTarget()
  const prevClear = gl.getClearColor(new THREE.Color())
  const prevAlpha = gl.getClearAlpha()
  const prevTone = gl.toneMapping
  gl.toneMapping = THREE.NoToneMapping
  gl.setClearColor(0x000000, 0)
  const pixels = new Uint8Array(W * H * 4)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(W, H)
  const out = {} as Record<GunId, string>
  for (const id of GUN_IDS) {
    const group = new THREE.Group()
    const add = (z: number, y: number) => {
      const vm = buildGunVM(id, assets, flashTex, flameTex, false)
      vm.flash.visible = false
      vm.root.position.set(0, y, z)
      group.add(vm.root)
    }
    if (id === 'dualies') {
      add(0, 0.03)
      add(0.07, -0.03)
    } else add(0, 0)
    scene.add(group)
    group.updateMatrixWorld(true)
    const box = new THREE.Box3()
    group.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.visible && !(m.material as THREE.Material).transparent) box.expandByObject(m)
    })
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const aspect = W / H
    const half = Math.max(size.z / 2 / aspect, size.y / 2) * 1.08
    cam.left = -half * aspect
    cam.right = half * aspect
    cam.top = half
    cam.bottom = -half
    cam.position.set(-5, c.y, c.z)
    cam.lookAt(0, c.y, c.z)
    cam.updateProjectionMatrix()
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, cam)
    gl.readRenderTargetPixels(target, 0, 0, W, H, pixels)
    // Flip rows (GL is bottom-up) and keep only coverage as alpha.
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const s = ((H - 1 - y) * W + x) * 4
        const d = (y * W + x) * 4
        img.data[d] = img.data[d + 1] = img.data[d + 2] = 255
        img.data[d + 3] = pixels[s + 3]
      }
    }
    ctx.putImageData(img, 0, 0)
    out[id] = canvas.toDataURL('image/png')
    scene.remove(group)
    group.traverse(o => (o as THREE.Mesh).geometry?.dispose())
  }
  gl.setRenderTarget(prevTarget)
  gl.setClearColor(prevClear, prevAlpha)
  gl.toneMapping = prevTone
  target.dispose()
  ;(scene.overrideMaterial as THREE.Material).dispose()
  return out
}
