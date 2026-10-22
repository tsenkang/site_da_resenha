import * as THREE from 'three'
import { addArms as proceduralArms, Builder, flashGroup, picatinny, redDotTexture, viewmodelMaterial, weaponMats, type ViewModel } from './guns'
import { buildArm, type ArmPose, type VmAssets } from './tripoguns'
import type { GunId } from './gunSpecs'

/**
 * First-person models of the tactical arsenal, built from machined parts (no asset files) and
 * held by the scanned gloved arms. Frame: barrel −Z, up +Y, right +X, metres.
 *
 * Long guns share one layout so the arm poses fit every model: the pistol grip sits at
 * (0, −0.1, 0.06) under the right hand, the bore axis runs at y ≈ 0.03, the left hand holds the
 * handguard. Pistols use the pistol layout (grip at (0, −0.07, 0.05)).
 *
 * Sights are real: iron sights are a rear notch/aperture and a front post on one line; at ADS the
 * Arsenal places that line on the screen centre (sightY/sightZ). Red dots project an LED dot on
 * the lens; scoped guns zoom with a full-screen scope picture instead (see the Arsenal).
 */

type V3 = [number, number, number]
type Mats = ReturnType<typeof weaponMats>

const POSE_LONG = { right: [0.75, 0.35, -0.6] as V3, left: [0.9, -0.55, 0.63] as V3 }
/** Grip-hole centre of the left hand below the gun's underside (measured on the original rifle). */
const LEFT_PALM_GAP = 0.006
const POSE_PISTOL = { right: [0.62, 0.35, -0.6] as V3, left: [0.95, -0.5, 0.9] as V3 }

// ─── extra materials ────────────────────────────────────────────────────
type Extra = Record<'wood' | 'woodDark' | 'teal' | 'tanPoly' | 'glass' | 'chrome' | 'bone' | 'odGreen' | 'sand', THREE.MeshStandardMaterial>
let extra: Extra | undefined
function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, 64, 256)
  let s = 7
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 46; i += 1) {
    const x = r() * 64
    g.strokeStyle = `rgba(90,50,20,${0.08 + r() * 0.18})`
    g.lineWidth = 0.6 + r() * 1.6
    g.beginPath()
    g.moveTo(x, 0)
    for (let y = 0; y <= 256; y += 16) g.lineTo(x + Math.sin(y * 0.05 + i) * 2.5, y)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}
function extraMats(): Extra {
  if (extra) return extra
  const mk = (p: THREE.MeshStandardMaterialParameters, env = 0.6) => {
    const m = viewmodelMaterial(new THREE.MeshStandardMaterial(p))
    m.envMapIntensity = env
    return m
  }
  const wood = woodTexture()
  extra = {
    wood: mk({ color: '#8a4f26', map: wood, roughness: 0.55, metalness: 0.02 }, 0.5),
    woodDark: mk({ color: '#5a3318', map: wood, roughness: 0.6, metalness: 0.02 }, 0.45),
    teal: mk({ color: '#5fae9c', roughness: 0.6, metalness: 0.05 }),
    tanPoly: mk({ color: '#a8916a', roughness: 0.75, metalness: 0.02 }),
    glass: mk({ color: '#0b1a2a', roughness: 0.08, metalness: 0.9 }, 1.2),
    chrome: mk({ color: '#b9bcc0', roughness: 0.22, metalness: 0.95 }, 1.1),
    bone: mk({ color: '#d9d2c2', roughness: 0.6, metalness: 0.02 }),
    odGreen: mk({ color: '#4a5a3a', roughness: 0.8, metalness: 0.02 }),
    sand: mk({ color: '#b49b72', roughness: 0.8, metalness: 0.02 }),
  }
  return extra
}

// ─── shared parts ───────────────────────────────────────────────────────
/** A curved (banana) magazine as a stack of slightly rotated segments. */
function bananaMag(b: Builder, mat: THREE.Material, segs: number, w: number, d: number, curve: number): void {
  let y = 0
  let z = 0
  let a = 0
  for (let i = 0; i < segs; i += 1) {
    b.box(mat, w, 0.034, d, [0, y, z], [a, 0, 0], 0.004)
    y -= 0.03 * Math.cos(a)
    z -= 0.03 * Math.sin(a)
    a += curve
  }
}

/** Telescopic sight: tube, turrets, eyepiece and objective bells, rings and a blued lens. */
function scope(b: Builder, M: Mats, X: Extra, y: number, z0: number, len: number, r: number, bell: number): void {
  const zc = z0 - len / 2
  b.tube(M.dark, r, r, len, [0, y, zc], 22)
  b.tube(M.dark, r * 1.25, r, 0.05, [0, y, z0 + 0.02], 22)
  b.tube(M.dark, bell, r, 0.07, [0, y, z0 - len - 0.03], 22)
  b.tube(X.glass, bell * 0.9, bell * 0.9, 0.004, [0, y, z0 - len - 0.066], 22)
  b.tube(X.glass, r * 1.1, r * 1.1, 0.004, [0, y, z0 + 0.046], 22)
  b.box(M.dark, 0.022, 0.02, 0.022, [0, y + r + 0.008, zc], undefined, 0.004)
  b.box(M.dark, 0.02, 0.022, 0.022, [r + 0.008, y, zc], undefined, 0.004)
  for (const zz of [z0 - len * 0.18, z0 - len * 0.82]) {
    b.tube(M.gunmetal, r + 0.004, r + 0.004, 0.012, [0, y, zz], 22)
    b.box(M.gunmetal, 0.016, y - 0.06, 0.014, [0, 0.06 + (y - 0.06) / 2 - r / 2, zz], undefined, 0.002)
  }
}

/** Notch rear sight + front post on the same line (y = sight height). */
function ironSights(b: Builder, M: Mats, y: number, zr: number, zf: number, frontBase: number, rearBase: number): void {
  for (const s of [-1, 1]) b.box(M.dark, 0.006, 0.012 + y - rearBase, 0.008, [s * 0.0065, (y + rearBase) / 2 + 0.002, zr], undefined, 0.001)
  b.box(M.dark, 0.022, 0.006, 0.012, [0, rearBase + 0.003, zr], undefined, 0.001)
  b.box(M.dark, 0.0036, y - frontBase + 0.002, 0.006, [0, (y + frontBase) / 2, zf], undefined, 0.0008)
  for (const s of [-1, 1]) b.box(M.dark, 0.003, y - frontBase + 0.004, 0.012, [s * 0.008, (y + frontBase) / 2, zf], undefined, 0.0008)
}

/** Standard long-gun lower: pistol grip, trigger guard and trigger (grip under the right hand). */
function lower(b: Builder, M: Mats, gripMat: THREE.Material): void {
  b.box(gripMat, 0.032, 0.11, 0.046, [0, -0.085, 0.065], [-0.36, 0, 0], 0.01)
  b.box(M.steel, 0.006, 0.006, 0.07, [0, -0.045, 0.005], undefined, 0.002)
  b.box(M.steel, 0.006, 0.03, 0.006, [0, -0.032, -0.03], undefined, 0.002)
  b.box(M.steel, 0.005, 0.02, 0.005, [0, -0.025, 0.012], [0.3, 0, 0], 0.001)
}

type Finish = {
  muzzle: V3
  eject?: V3
  flash?: number
  mag?: THREE.Group
  pump?: THREE.Group
  bolt?: THREE.Group
  slide?: THREE.Group
  sightY: number
  sightZ: number
  hip: V3
  ads: { x: number; y?: number; z: number }
  /** Left hand (support grip). */
  left: V3
  /** false: keep `left` as typed (the hand holds a vertical foregrip, not the handguard). */
  leftFit?: boolean
  layout: 'long' | 'pistol'
  /** Red-dot lens: centre height and z. */
  dot?: { y: number; z: number; w: number }
  /** Leave the arms off (each half of the dual pistols gets its own arm). */
  noArms?: boolean
}

/**
 * Underside of the gun at depth `z` (handguard, pump, receiver): the first surface hit by a ray
 * cast straight up at x = 0, in root space. Used to seat the support hand on the gun.
 */
function undersideY(root: THREE.Object3D, z: number, below: number): number | null {
  root.updateMatrixWorld(true)
  const meshes: THREE.Object3D[] = []
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.visible && !(m.material as THREE.Material).transparent) meshes.push(m)
  })
  const origin = new THREE.Vector3(0, -0.4, z).applyMatrix4(root.matrixWorld)
  const dir = new THREE.Vector3(0, 1, 0).transformDirection(root.matrixWorld)
  const ray = new THREE.Raycaster(origin, dir, 0, 0.4 + below)
  const hits = ray.intersectObjects(meshes, false)
  if (!hits.length) return null
  return root.worldToLocal(hits[0].point.clone()).y
}

function finish(root: THREE.Group, A: VmAssets, flashTex: THREE.Texture, flameTex: THREE.Texture, f: Finish): ViewModel {
  for (const part of [f.mag, f.pump, f.bolt, f.slide]) if (part) root.add(part)
  // Seat the support hand against the underside of the handguard / pump (palm touching, as on the
  // original rifle) instead of trusting hand-typed heights that left it floating below the gun.
  let left = f.left
  if (f.layout === 'long' && f.leftFit !== false) {
    const under = undersideY(root, f.left[2], f.sightY)
    if (under !== null) left = [f.left[0], under - LEFT_PALM_GAP, f.left[2]]
  }
  const muzzle = new THREE.Object3D()
  muzzle.position.set(...f.muzzle)
  root.add(muzzle)
  const flash = flashGroup(flashTex, flameTex, f.flash ?? 1)
  flash.position.copy(muzzle.position)
  root.add(flash)
  let eject: THREE.Object3D | undefined
  if (f.eject) {
    eject = new THREE.Object3D()
    eject.position.set(...f.eject)
    root.add(eject)
  }
  if (f.dot) {
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(f.dot.w, f.dot.w * 0.85), viewmodelMaterial(new THREE.MeshBasicMaterial({ color: 0x6a8a7a, transparent: true, opacity: 0.14, depthWrite: false })))
    lens.position.set(0, f.dot.y, f.dot.z - 0.001)
    const dot = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03), viewmodelMaterial(new THREE.MeshBasicMaterial({ map: redDotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(3.2, 1.1, 1), toneMapped: false })))
    dot.position.set(0, f.dot.y, f.dot.z)
    for (const m of [lens, dot]) {
      m.renderOrder = 5
      m.frustumCulled = false
      root.add(m)
    }
  }
  const pose = f.layout === 'long' ? POSE_LONG : POSE_PISTOL
  const right: V3 = f.layout === 'long' ? [0.005, -0.1, 0.06] : [0.004, -0.07, 0.05]
  if (f.noArms) {
    // Arms are attached by the caller.
  } else if (A.armR && A.armL) {
    root.add(buildArm(A.armR, 'armR', { at: right, rot: pose.right } as ArmPose))
    const leftArm = buildArm(A.armL, 'armL', { at: left, rot: pose.left } as ArmPose)
    ;(f.pump ?? root).add(leftArm)
    if (f.pump) leftArm.position.sub(f.pump.position)
  } else proceduralArms(root, { right: f.layout === 'long' ? [0, -0.09, 0.06] : [0, -0.05, 0.03], left: f.left })
  root.traverse(o => {
    o.frustumCulled = false
    const m = o as THREE.Mesh
    if (m.isMesh) m.castShadow = m.receiveShadow = false
  })
  return {
    root, muzzle, eject, flash, mag: f.mag, magRest: f.mag?.position.clone(), pump: f.pump, pumpRest: f.pump?.position.clone(), bolt: f.bolt, slide: f.slide,
    sightY: f.sightY, sightZ: f.sightZ, hip: new THREE.Vector3(...f.hip), ads: f.ads,
  }
}

// ─── rifles ─────────────────────────────────────────────────────────────
function ak47(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(M.gunmetal, 0.05, 0.058, 0.27, [0, 0.022, -0.035], undefined, 0.006)
  b.box(M.gunmetal, 0.047, 0.022, 0.25, [0, 0.058, -0.04], undefined, 0.01) // dust cover
  b.box(M.dark, 0.004, 0.02, 0.07, [0.026, 0.035, -0.05], undefined, 0.001) // ejection port
  b.box(M.steel, 0.022, 0.01, 0.02, [0.03, 0.035, -0.02], undefined, 0.003) // charging handle
  b.box(M.steel, 0.004, 0.02, 0.09, [0.027, 0.012, -0.02], [0.08, 0, 0], 0.001) // safety lever
  b.box(X.wood, 0.056, 0.05, 0.19, [0, 0.016, -0.27], undefined, 0.012) // lower handguard
  b.box(X.wood, 0.036, 0.028, 0.16, [0, 0.066, -0.25], undefined, 0.01) // gas tube cover
  b.tube(M.steel, 0.012, 0.012, 0.03, [0, 0.07, -0.35], 12) // gas block
  b.tube(M.steel, 0.0095, 0.0095, 0.3, [0, 0.03, -0.52], 14)
  b.tube(M.gunmetal, 0.006, 0.006, 0.2, [0, 0.07, -0.42], 10) // gas tube
  b.box(M.gunmetal, 0.022, 0.03, 0.024, [0, 0.052, -0.62], undefined, 0.003) // front sight block
  b.tube(M.dark, 0.0125, 0.012, 0.055, [0, 0.03, -0.695], 14) // muzzle brake
  b.box(M.gunmetal, 0.026, 0.012, 0.05, [0, 0.075, -0.17], undefined, 0.003) // rear sight base
  lower(b, M, X.woodDark)
  // Stock.
  b.box(X.wood, 0.04, 0.06, 0.12, [0, 0.005, 0.15], [0.12, 0, 0], 0.012)
  b.box(X.wood, 0.044, 0.09, 0.16, [0, -0.025, 0.27], [0.12, 0, 0], 0.016)
  b.box(M.steel, 0.046, 0.094, 0.012, [0, -0.04, 0.355], [0.12, 0, 0], 0.004)
  ironSights(b, M, 0.091, -0.17, -0.62, 0.068, 0.081)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  bananaMag(mb, M.dark, 7, 0.03, 0.07, 0.085)
  mb.build(mag)
  mag.position.set(0, -0.02, -0.085)
  return { root, f: { muzzle: [0, 0.03, -0.73], eject: [0.03, 0.04, -0.05], mag, sightY: 0.091, sightZ: -0.17, hip: [0.15, -0.17, -0.36], ads: { x: 0, z: -0.3 }, left: [-0.01, -0.03, -0.29] } }
}

function galil(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(M.gunmetal, 0.052, 0.06, 0.27, [0, 0.022, -0.035], undefined, 0.006)
  b.box(M.gunmetal, 0.048, 0.022, 0.24, [0, 0.058, -0.04], undefined, 0.01)
  b.box(M.dark, 0.004, 0.02, 0.07, [0.027, 0.035, -0.05], undefined, 0.001)
  b.box(M.steel, 0.02, 0.012, 0.02, [0.032, 0.04, -0.02], [0, 0, 0.6], 0.003)
  // Ventilated polymer handguard.
  b.box(M.polymer, 0.058, 0.058, 0.2, [0, 0.025, -0.27], undefined, 0.012)
  for (let i = 0; i < 5; i += 1) for (const s of [-1, 1]) b.box(M.dark, 0.003, 0.012, 0.022, [s * 0.029, 0.03, -0.2 - i * 0.034], undefined, 0.001)
  b.tube(M.steel, 0.009, 0.009, 0.24, [0, 0.03, -0.49], 14)
  b.box(M.gunmetal, 0.02, 0.04, 0.02, [0, 0.055, -0.585], undefined, 0.003)
  b.tube(M.dark, 0.012, 0.011, 0.05, [0, 0.03, -0.635], 14)
  // Carry handle and folding bipod legs under the barrel.
  b.box(M.gunmetal, 0.012, 0.012, 0.12, [0, 0.11, -0.12], undefined, 0.004)
  for (const z of [-0.07, -0.17]) b.box(M.gunmetal, 0.01, 0.04, 0.01, [0, 0.09, z], undefined, 0.002)
  for (const s of [-1, 1]) b.box(M.gunmetal, 0.008, 0.008, 0.2, [s * 0.012, -0.012, -0.47], undefined, 0.002)
  lower(b, M, M.polymer)
  // Skeleton folding stock.
  b.box(M.gunmetal, 0.012, 0.012, 0.25, [0, 0.03, 0.22], [0.05, 0, 0], 0.004)
  b.box(M.gunmetal, 0.012, 0.012, 0.24, [0, -0.04, 0.23], [-0.1, 0, 0], 0.004)
  b.box(M.rubber, 0.04, 0.11, 0.02, [0, -0.01, 0.35], undefined, 0.006)
  ironSights(b, M, 0.088, 0.04, -0.585, 0.075, 0.07)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  bananaMag(mb, M.dark, 7, 0.032, 0.07, 0.06)
  mb.build(mag)
  mag.position.set(0, -0.02, -0.085)
  return { root, f: { muzzle: [0, 0.03, -0.665], eject: [0.03, 0.04, -0.05], mag, sightY: 0.088, sightZ: 0.04, hip: [0.15, -0.17, -0.36], ads: { x: 0, z: -0.22 }, left: [-0.01, -0.025, -0.28] } }
}

function sg553(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(X.sand, 0.054, 0.064, 0.28, [0, 0.02, -0.04], undefined, 0.012)
  b.box(M.dark, 0.004, 0.02, 0.07, [0.028, 0.035, -0.05], undefined, 0.001)
  b.box(X.sand, 0.06, 0.06, 0.22, [0, 0.02, -0.28], undefined, 0.016)
  for (let i = 0; i < 6; i += 1) for (const s of [-1, 1]) b.box(M.dark, 0.003, 0.01, 0.018, [s * 0.03, 0.025, -0.2 - i * 0.03], undefined, 0.001)
  b.tube(M.steel, 0.009, 0.009, 0.2, [0, 0.03, -0.48], 14)
  b.tube(M.dark, 0.0125, 0.012, 0.06, [0, 0.03, -0.6], 14)
  picatinny(b, M.gunmetal, 0.056, 0.08, -0.17, 0.022)
  scope(b, M, X, 0.105, 0.03, 0.15, 0.017, 0.024)
  lower(b, M, M.polymer)
  b.box(X.sand, 0.044, 0.07, 0.24, [0, -0.01, 0.22], [0.08, 0, 0], 0.02)
  b.box(M.rubber, 0.046, 0.1, 0.02, [0, -0.025, 0.35], [0.08, 0, 0], 0.006)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  bananaMag(mb, M.dark, 6, 0.03, 0.068, 0.03)
  mb.build(mag)
  mag.position.set(0, -0.02, -0.085)
  return { root, f: { muzzle: [0, 0.03, -0.635], eject: [0.03, 0.04, -0.05], mag, sightY: 0.105, sightZ: 0.07, hip: [0.15, -0.18, -0.36], ads: { x: 0, z: -0.16 }, left: [-0.01, -0.025, -0.27] } }
}

function boltRifle(heavy: boolean): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  const stock = heavy ? X.odGreen : M.polymer
  // Action and barrel.
  b.tube(M.gunmetal, 0.02, 0.02, 0.22, [0, 0.03, -0.04], 18)
  b.box(M.dark, 0.004, 0.018, 0.06, [0.02, 0.04, -0.03], undefined, 0.001)
  const bl = heavy ? 0.5 : 0.46
  b.tube(M.steel, heavy ? 0.013 : 0.01, heavy ? 0.011 : 0.008, bl, [0, 0.03, -0.15 - bl / 2], 16)
  if (heavy) {
    b.tube(M.dark, 0.02, 0.02, 0.08, [0, 0.03, -0.15 - bl - 0.04], 16) // muzzle brake
    for (const s of [-1, 1]) b.box(M.dark, 0.006, 0.014, 0.05, [s * 0.02, 0.03, -0.15 - bl - 0.04], undefined, 0.001)
  }
  // Stock: forend, pistol grip with thumbhole (heavy) or slim sporter stock.
  b.box(stock, 0.06, 0.05, 0.32, [0, 0.0, -0.24], undefined, 0.018)
  b.box(stock, 0.06, 0.06, 0.18, [0, -0.005, 0.02], undefined, 0.016)
  if (heavy) {
    b.box(stock, 0.05, 0.13, 0.05, [0, -0.07, 0.07], [-0.3, 0, 0], 0.014)
    b.box(stock, 0.05, 0.03, 0.18, [0, 0.04, 0.22], undefined, 0.012)
    b.box(stock, 0.05, 0.13, 0.05, [0, -0.02, 0.29], undefined, 0.014)
    b.box(stock, 0.05, 0.04, 0.2, [0, -0.08, 0.21], [0.05, 0, 0], 0.012)
    b.box(M.rubber, 0.052, 0.15, 0.02, [0, -0.03, 0.32], undefined, 0.006)
    // Folded bipod.
    for (const s of [-1, 1]) b.box(M.dark, 0.008, 0.008, 0.18, [s * 0.016, -0.03, -0.42], undefined, 0.002)
  } else {
    lower(b, M, stock)
    b.box(stock, 0.042, 0.07, 0.24, [0, -0.02, 0.22], [0.1, 0, 0], 0.018)
    b.box(M.rubber, 0.044, 0.1, 0.02, [0, -0.04, 0.34], [0.1, 0, 0], 0.006)
  }
  b.box(M.steel, 0.006, 0.006, 0.06, [0, -0.045, 0.01], undefined, 0.002)
  b.box(M.steel, 0.005, 0.02, 0.005, [0, -0.028, 0.012], [0.3, 0, 0], 0.001)
  scope(b, M, X, heavy ? 0.1 : 0.095, heavy ? 0.1 : 0.08, heavy ? 0.26 : 0.22, heavy ? 0.02 : 0.017, heavy ? 0.032 : 0.026)
  b.build(root)
  // Bolt handle (cycles after each shot).
  const bolt = new THREE.Group()
  const bb = new Builder()
  bb.box(M.steel, 0.05, 0.008, 0.008, [0.025, 0, 0], [0, 0, -0.3], 0.003)
  bb.add(M.steel, new THREE.SphereGeometry(0.011, 10, 8), [0.05, -0.015, 0])
  bb.build(bolt)
  bolt.position.set(0.015, 0.035, 0.05)
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(M.dark, 0.03, 0.04, 0.07, [0, 0, 0], undefined, 0.004)
  mb.build(mag)
  mag.position.set(0, -0.04, -0.05)
  const len = -0.15 - bl - (heavy ? 0.09 : 0.01)
  return {
    root,
    f: { muzzle: [0, 0.03, len], eject: [0.03, 0.04, -0.03], mag, bolt, sightY: heavy ? 0.1 : 0.095, sightZ: 0.1, hip: [0.15, -0.17, -0.36], ads: { x: 0, z: -0.12 }, left: [-0.01, -0.035, -0.3], flash: heavy ? 1.5 : 1.1 },
  }
}

// ─── SMGs ───────────────────────────────────────────────────────────────
function mp7(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(M.polymer, 0.046, 0.07, 0.24, [0, 0.025, -0.07], undefined, 0.014)
  b.box(M.dark, 0.004, 0.018, 0.05, [0.024, 0.04, -0.04], undefined, 0.001)
  b.tube(M.steel, 0.008, 0.008, 0.08, [0, 0.03, -0.22], 12)
  b.tube(M.dark, 0.011, 0.011, 0.03, [0, 0.03, -0.27], 12)
  picatinny(b, M.gunmetal, 0.064, 0.03, -0.17, 0.02)
  // Folding front grip.
  b.box(M.polymer, 0.026, 0.08, 0.03, [0, -0.04, -0.15], [0.1, 0, 0], 0.01)
  // Pistol grip (the magazine lives inside it).
  b.box(M.polymer, 0.034, 0.12, 0.05, [0, -0.08, 0.06], [-0.25, 0, 0], 0.012)
  b.box(M.steel, 0.006, 0.006, 0.06, [0, -0.032, 0.005], undefined, 0.002)
  b.box(M.steel, 0.005, 0.02, 0.005, [0, -0.02, 0.012], [0.3, 0, 0], 0.001)
  // Collapsed stock: two rods and a butt pad.
  for (const s of [-1, 1]) b.box(M.gunmetal, 0.006, 0.006, 0.14, [s * 0.018, 0.02, 0.1], undefined, 0.002)
  b.box(M.polymer, 0.05, 0.08, 0.015, [0, 0.0, 0.17], undefined, 0.006)
  // Flip-up iron sights on the rail.
  ironSights(b, M, 0.085, 0.02, -0.15, 0.07, 0.07)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(M.dark, 0.026, 0.03, 0.04, [0, 0, 0], [-0.25, 0, 0], 0.004)
  mb.build(mag)
  mag.position.set(0, -0.14, 0.075)
  return { root, f: { muzzle: [0, 0.03, -0.29], eject: [0.026, 0.04, -0.04], mag, sightY: 0.085, sightZ: 0.02, hip: [0.14, -0.16, -0.34], ads: { x: 0, z: -0.24 }, left: [0, -0.06, -0.15], leftFit: false, flash: 0.85 } }
}

function p90(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  // Bullpup body: one rounded shell from the butt to the muzzle, thumbhole grip in the middle.
  b.box(X.tanPoly, 0.058, 0.09, 0.42, [0, 0.0, 0.0], undefined, 0.03)
  b.box(X.tanPoly, 0.05, 0.05, 0.12, [0, -0.07, -0.13], undefined, 0.02)
  b.box(M.dark, 0.052, 0.04, 0.1, [0, -0.06, 0.03], undefined, 0.012) // thumbhole shadow
  b.box(X.tanPoly, 0.04, 0.03, 0.1, [0, -0.11, 0.05], undefined, 0.012)
  b.tube(M.steel, 0.008, 0.008, 0.06, [0, 0.0, -0.24], 12)
  b.tube(M.dark, 0.012, 0.012, 0.03, [0, 0.0, -0.28], 12)
  // Translucent top magazine and the integrated reflex sight.
  b.box(M.dark, 0.05, 0.02, 0.3, [0, 0.055, 0.02], undefined, 0.008)
  b.box(M.dark, 0.028, 0.03, 0.05, [0, 0.08, -0.05], undefined, 0.006)
  b.box(M.dark, 0.006, 0.03, 0.05, [-0.015, 0.105, -0.05], undefined, 0.002)
  b.box(M.dark, 0.006, 0.03, 0.05, [0.015, 0.105, -0.05], undefined, 0.002)
  b.box(M.dark, 0.036, 0.006, 0.05, [0, 0.12, -0.05], undefined, 0.002)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(X.glass, 0.046, 0.016, 0.26, [0, 0, 0], undefined, 0.006)
  mb.build(mag)
  mag.position.set(0, 0.07, 0.04)
  return { root, f: { muzzle: [0, 0.0, -0.295], eject: [0, -0.06, 0.06], mag, sightY: 0.105, sightZ: -0.05, hip: [0.14, -0.15, -0.36], ads: { x: 0, z: -0.24 }, left: [0, -0.06, -0.14], flash: 0.85, dot: { y: 0.105, z: -0.05, w: 0.026 } } }
}

function mac10(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(M.gunmetal, 0.05, 0.07, 0.22, [0, 0.025, -0.05], undefined, 0.006)
  b.box(M.dark, 0.004, 0.02, 0.05, [0.026, 0.04, -0.06], undefined, 0.001)
  b.box(M.steel, 0.016, 0.012, 0.03, [0, 0.066, -0.02], undefined, 0.003) // cocking knob
  b.tube(M.steel, 0.009, 0.009, 0.05, [0, 0.03, -0.18], 12)
  b.tube(M.dark, 0.012, 0.012, 0.02, [0, 0.03, -0.21], 12)
  // Front strap (left hand) and pistol grip with the magazine.
  b.box(M.dark, 0.008, 0.05, 0.05, [-0.02, -0.025, -0.14], undefined, 0.003)
  b.box(M.polymer, 0.034, 0.13, 0.044, [0, -0.08, 0.05], [-0.1, 0, 0], 0.008)
  b.box(M.steel, 0.006, 0.006, 0.06, [0, -0.02, -0.005], undefined, 0.002)
  b.box(M.steel, 0.005, 0.02, 0.005, [0, -0.012, 0.0], [0.3, 0, 0], 0.001)
  // Folded wire stock.
  for (const s of [-1, 1]) b.box(M.steel, 0.006, 0.006, 0.18, [s * 0.026, 0.0, 0.0], undefined, 0.002)
  b.box(M.steel, 0.06, 0.03, 0.008, [0, -0.01, 0.09], undefined, 0.003)
  ironSights(b, M, 0.084, 0.04, -0.15, 0.06, 0.06)
  b.build(root)
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(M.dark, 0.028, 0.05, 0.036, [0, 0, 0], [-0.1, 0, 0], 0.004)
  mb.build(mag)
  mag.position.set(0, -0.16, 0.058)
  return { root, f: { muzzle: [0, 0.03, -0.225], eject: [0.026, 0.04, -0.06], mag, sightY: 0.084, sightZ: 0.04, hip: [0.13, -0.16, -0.38], ads: { x: 0, z: -0.27 }, left: [-0.02, -0.05, -0.14], flash: 0.85 } }
}

// ─── shotguns ───────────────────────────────────────────────────────────
function shotgun(auto: boolean): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  const furniture = auto ? X.teal : M.polymer
  b.box(M.gunmetal, 0.054, 0.075, 0.25, [0, 0.01, -0.04], undefined, 0.01)
  b.box(M.dark, 0.004, 0.026, 0.07, [0.028, 0.02, -0.04], undefined, 0.001)
  b.tube(M.steel, 0.012, 0.012, 0.46, [0, 0.032, -0.39], 16)
  b.tube(M.gunmetal, 0.012, 0.012, auto ? 0.34 : 0.38, [0, -0.005, auto ? -0.33 : -0.35], 14)
  b.tube(M.gunmetal, 0.015, 0.015, 0.02, [0, -0.005, auto ? -0.5 : -0.54], 12)
  if (auto) {
    b.box(furniture, 0.06, 0.05, 0.2, [0, 0.005, -0.26], undefined, 0.014) // fixed handguard
    picatinny(b, M.gunmetal, 0.05, 0.06, -0.12, 0.02)
    // Ghost-ring rear on the rail, post front.
    b.box(M.dark, 0.026, 0.02, 0.01, [0, 0.07, 0.04], undefined, 0.003)
    b.box(M.dark, 0.004, 0.026, 0.006, [0, 0.058, -0.6], undefined, 0.001)
    // Telescoping stock.
    b.box(furniture, 0.04, 0.03, 0.2, [0, 0.03, 0.2], undefined, 0.01)
    b.box(furniture, 0.045, 0.1, 0.03, [0, 0.0, 0.3], undefined, 0.01)
    lower(b, M, furniture)
  } else {
    b.box(M.dark, 0.004, 0.004, 0.006, [0, 0.048, -0.61], undefined, 0.001) // bead
    b.box(furniture, 0.046, 0.08, 0.16, [0, -0.01, 0.12], [0.05, 0, 0], 0.016)
    b.box(furniture, 0.05, 0.11, 0.18, [0, -0.04, 0.26], [0.12, 0, 0], 0.02)
    b.box(M.rubber, 0.052, 0.12, 0.02, [0, -0.055, 0.35], [0.12, 0, 0], 0.006)
    lower(b, M, furniture)
  }
  b.build(root)
  let pump: THREE.Group | undefined
  if (!auto) {
    pump = new THREE.Group()
    const pb = new Builder()
    pb.tube(X.woodDark, 0.026, 0.026, 0.17, [0, 0, 0], 16)
    for (let i = 0; i < 6; i += 1) pb.tube(M.dark, 0.0272, 0.0272, 0.006, [0, 0, -0.07 + i * 0.028], 16)
    pb.build(pump)
    pump.position.set(0, -0.005, -0.32)
  }
  const sightY = auto ? 0.075 : 0.05
  return { root, f: { muzzle: [0, 0.032, -0.62], eject: [0.03, 0.025, -0.04], pump, sightY, sightZ: auto ? 0.04 : -0.1, hip: [0.16, -0.18, -0.36], ads: { x: 0, z: auto ? -0.25 : -0.32 }, left: [0, -0.04, -0.32], flash: 1.6 } }
}

// ─── pistols ────────────────────────────────────────────────────────────
type PistolLook = { slide: THREE.Material; frame: THREE.Material; grip: THREE.Material; len: number; h: number; big?: boolean }
function pistolBody(look: PistolLook): { root: THREE.Group; f: Omit<Finish, 'layout'>; slide: THREE.Group } {
  const M = weaponMats()
  const root = new THREE.Group()
  const b = new Builder()
  const L = look.len
  b.box(look.frame, 0.028, 0.024, L * 0.85, [0, 0.004, -L * 0.3], undefined, 0.006)
  b.box(look.grip, 0.032, 0.12, 0.048, [0, -0.052, 0.028], [-0.26, 0, 0], 0.01)
  for (let i = 0; i < 4; i += 1) b.box(M.dark, 0.033, 0.003, 0.03, [0, -0.03 - i * 0.02, 0.03 + i * 0.005], [-0.26, 0, 0], 0)
  b.box(look.frame, 0.006, 0.006, 0.05, [0, -0.022, -0.02], undefined, 0.002)
  b.box(M.steel, 0.005, 0.016, 0.005, [0, -0.012, -0.012], [0.3, 0, 0], 0.001)
  if (look.big) b.box(M.steel, 0.01, 0.022, 0.012, [0, 0.05, 0.03], [-0.4, 0, 0], 0.003) // hammer
  b.build(root)
  // Slide (racks back when firing): sights ride on it.
  const slide = new THREE.Group()
  const sb = new Builder()
  sb.box(look.slide, 0.031, look.h, L, [0, 0, 0], undefined, 0.005)
  for (let i = 0; i < 5; i += 1) for (const s of [-1, 1]) sb.box(M.dark, 0.003, look.h * 0.6, 0.004, [s * 0.0158, 0, L * 0.38 - i * 0.008], undefined, 0)
  sb.box(M.dark, 0.003, look.h * 0.45, 0.04, [0.0158, 0.002, -L * 0.05], undefined, 0)
  sb.tube(M.steel, 0.006, 0.006, 0.012, [0, 0, -L / 2 - 0.004], 12)
  const top = look.h / 2
  sb.box(M.dark, 0.004, 0.008, 0.006, [0, top + 0.004, -L / 2 + 0.012], undefined, 0.001)
  for (const s of [-1, 1]) sb.box(M.dark, 0.006, 0.009, 0.007, [s * 0.006, top + 0.0045, L / 2 - 0.012], undefined, 0.001)
  sb.build(slide)
  slide.position.set(0, 0.016 + look.h / 2, -L * 0.3)
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(M.dark, 0.026, 0.012, 0.04, [0, 0, 0], undefined, 0.003)
  mb.build(mag)
  mag.position.set(0, -0.112, 0.045)
  const sightY = 0.016 + look.h + 0.008
  return {
    root,
    slide,
    f: { muzzle: [0, 0.016 + look.h / 2, -L * 0.8 - 0.01], eject: [0.02, 0.016 + look.h, -0.035], mag, slide, sightY, sightZ: -L * 0.3 + L / 2 - 0.012, hip: [0.13, -0.15, -0.42], ads: { x: 0, z: -0.4 }, left: [-0.022, -0.1, 0.05], flash: look.big ? 1 : 0.7 },
  }
}

function tec9(): { root: THREE.Group; f: Omit<Finish, 'layout'> } {
  const M = weaponMats()
  const X = extraMats()
  const root = new THREE.Group()
  const b = new Builder()
  b.box(M.gunmetal, 0.036, 0.046, 0.2, [0, 0.02, -0.04], undefined, 0.006)
  // Perforated barrel shroud.
  b.tube(M.gunmetal, 0.016, 0.016, 0.1, [0, 0.025, -0.19], 14)
  for (let i = 0; i < 5; i += 1) for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) b.add(M.dark, new THREE.CylinderGeometry(0.004, 0.004, 0.002, 8), [Math.cos(a) * 0.0162, 0.025 + Math.sin(a) * 0.0162, -0.15 - i * 0.018], [0, 0, a + Math.PI / 2])
  b.tube(M.dark, 0.009, 0.009, 0.01, [0, 0.025, -0.245], 12)
  b.box(X.bone, 0.032, 0.11, 0.045, [0, -0.05, 0.035], [-0.2, 0, 0], 0.01)
  b.box(M.steel, 0.006, 0.006, 0.05, [0, -0.018, -0.01], undefined, 0.002)
  b.box(M.steel, 0.005, 0.016, 0.005, [0, -0.01, -0.005], [0.3, 0, 0], 0.001)
  b.box(M.steel, 0.014, 0.01, 0.025, [-0.022, 0.03, 0.02], undefined, 0.003) // bolt knob
  ironSights(b, M, 0.058, 0.045, -0.13, 0.043, 0.043)
  b.build(root)
  // Long magazine in front of the trigger guard.
  const mag = new THREE.Group()
  const mb = new Builder()
  mb.box(M.dark, 0.026, 0.12, 0.034, [0, 0, 0], undefined, 0.004)
  mb.build(mag)
  mag.position.set(0, -0.06, -0.06)
  return { root, f: { muzzle: [0, 0.025, -0.255], eject: [0.02, 0.04, -0.04], mag, sightY: 0.058, sightZ: 0.045, hip: [0.13, -0.15, -0.4], ads: { x: 0, z: -0.36 }, left: [-0.02, -0.11, -0.06], flash: 0.75 } }
}

// ─── catalogue ──────────────────────────────────────────────────────────
type Built = { root: THREE.Group; f: Omit<Finish, 'layout'> }
const BUILDERS: Record<Exclude<GunId, 'dualies'>, () => Built & { layout: Finish['layout'] }> = {
  ak47: () => ({ ...ak47(), layout: 'long' }),
  galil: () => ({ ...galil(), layout: 'long' }),
  sg553: () => ({ ...sg553(), layout: 'long' }),
  ssg08: () => ({ ...boltRifle(false), layout: 'long' }),
  awp: () => ({ ...boltRifle(true), layout: 'long' }),
  mp7: () => ({ ...mp7(), layout: 'long' }),
  p90: () => ({ ...p90(), layout: 'long' }),
  mac10: () => ({ ...mac10(), layout: 'long' }),
  nova: () => ({ ...shotgun(false), layout: 'long' }),
  xm1014: () => ({ ...shotgun(true), layout: 'long' }),
  tec9: () => ({ ...tec9(), layout: 'pistol' }),
  glock: () => {
    const M = weaponMats()
    const X = extraMats()
    return { ...pistolBody({ slide: M.gunmetal, frame: X.tanPoly, grip: X.tanPoly, len: 0.186, h: 0.034 }), layout: 'pistol' }
  },
  p250: () => {
    const M = weaponMats()
    return { ...pistolBody({ slide: M.steel, frame: M.polymer, grip: M.polymer, len: 0.17, h: 0.032 }), layout: 'pistol' }
  },
  deagle: () => {
    const M = weaponMats()
    const X = extraMats()
    const p = pistolBody({ slide: X.chrome, frame: X.chrome, grip: M.rubber, len: 0.26, h: 0.042, big: true })
    p.f.hip = [0.13, -0.16, -0.44]
    p.f.ads = { x: 0, z: -0.42 }
    return { ...p, layout: 'pistol' }
  },
}

/** Build the first-person model of a tactical gun, with arms (scanned when available). */
export function buildGunVM(id: GunId, A: VmAssets, flashTex: THREE.Texture, flameTex: THREE.Texture, arms = true): ViewModel {
  if (id === 'dualies' && arms) return buildDualies(A, flashTex, flameTex)
  const { root, f, layout } = BUILDERS[id === 'dualies' ? 'glock' : id]()
  return finish(root, A, flashTex, flameTex, { ...f, layout, noArms: !arms })
}

/** Two pistols, one per hand, firing alternately (right first). */
function buildDualies(A: VmAssets, flashTex: THREE.Texture, flameTex: THREE.Texture): ViewModel {
  const M = weaponMats()
  const X = extraMats()
  const look: PistolLook = { slide: M.steel, frame: M.steel, grip: X.woodDark, len: 0.2, h: 0.032 }
  const right = pistolBody(look)
  const left = pistolBody(look)
  const vmR = finish(right.root, A, flashTex, flameTex, { ...right.f, layout: 'pistol', noArms: true })
  const vmL = finish(left.root, A, flashTex, flameTex, { ...left.f, layout: 'pistol', noArms: true })
  const root = new THREE.Group()
  right.root.position.set(0.075, 0, 0)
  right.root.rotation.z = -0.08
  left.root.position.set(-0.165, 0, 0)
  left.root.rotation.z = 0.08
  // The left gun is the right one mirrored, hand included: the left arm model is posed to wrap a
  // handguard, so on a pistol grip it read as a second, wrong hand.
  left.root.scale.x = -1
  root.add(right.root, left.root)
  if (A.armR) {
    right.root.add(buildArm(A.armR, 'armR', { at: [0.004, -0.07, 0.05], rot: POSE_PISTOL.right }))
    left.root.add(buildArm(A.armR, 'armL', { at: [0.004, -0.07, 0.05], rot: POSE_PISTOL.right }))
  } else {
    proceduralArms(right.root, { right: [0, -0.05, 0.03], left: [0.4, -0.6, 0.8] })
  }
  root.traverse(o => (o.frustumCulled = false))
  return {
    root, muzzle: vmR.muzzle, eject: vmR.eject, flash: vmR.flash, mag: vmR.mag, magRest: vmR.magRest, slide: vmR.slide,
    alt: { muzzle: vmL.muzzle, flash: vmL.flash, eject: vmL.eject, slide: vmL.slide },
    sightY: vmR.sightY, sightZ: vmR.sightZ, hip: new THREE.Vector3(0.05, -0.16, -0.44), ads: { x: 0.0, y: -0.12, z: -0.4 },
  }
}
