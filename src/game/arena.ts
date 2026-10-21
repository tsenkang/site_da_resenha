import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RAPIER, type Physics } from '../engine/physics'
import { worldBox, type Library } from './library'
import { BLOCKED, NavGrid } from './nav'

/**
 * "Base Aurora": a sunny two-site tactical map in a painted, low-poly style. Attackers spawn in the
 * south, defenders in the north; Site A sits west, Site B east, joined by a central Mid that splits
 * into two links and a narrow Market corridor. Every lane is 8 m wide or more so bots path cleanly.
 *
 * Built for weak GPUs: flat Lambert materials with tiny canvas textures, static geometry merged per
 * material (a dozen draw calls for the whole map), no point lights, no scanned models in the level.
 * Every solid has a matching Rapier box collider and the bot navigation grid is baked from them.
 *
 * Coordinates: X west(−) → east(+), Z north(−) → south(+), metres, floor at y = 0.
 */
export type Surface = 'concrete' | 'metal' | 'wood'
export type ColliderTag =
  | { kind: 'world'; surface: Surface }
  | { kind: 'bot'; id: number }
  | { kind: 'drone'; id: number }
  | { kind: 'player' }
  | { kind: 'prop'; index: number }

export const HALF_X = 46
export const HALF_Z = 50

export type PropSpot = { pos: THREE.Vector3; model: 'barrel' | 'propane'; rot: number }
export type PickupSpot = { pos: THREE.Vector3; kind: 'health' | 'armor' | 'ammo' | 'rocket' }
export type SiteId = 'A' | 'B'
/** Axis-aligned plant zone. */
export type Site = { id: SiteId; center: THREE.Vector3; halfX: number; halfZ: number; color: string }
/** Minimap rectangle (top-down), `kind` picks its fill. */
export type MapRect = { x0: number; x1: number; z0: number; z1: number; kind: 'building' | 'cover' | 'wall' }
export type TeamSide = 'attack' | 'defend'

/** Building blocks [x0, x1, z0, z1, height, style]. Lanes are the gaps between them. */
const BUILDINGS: [number, number, number, number, number, number][] = [
  [-46, -38, -4, 20, 7.5, 0], // A main, west row
  [-30, -8, -6, 24, 8, 1], // west block (between A main and Mid)
  [8, 30, -6, 24, 8, 2], // east block (between Mid and B main)
  [38, 46, -4, 20, 7.5, 0], // B main, east row
  [-16, -3, -36, -14, 7, 2], // north-west block (A link / Market)
  [3, 16, -36, -14, 7, 1], // north-east block (Market / B link)
]

/** Cover: [x, z, w, d, h, kind] — kind 0 crate, 1 stone planter / low wall, 2 metal generator. */
const COVER: [number, number, number, number, number, number][] = [
  // Site A
  [-31, -24, 3.2, 3.2, 2.2, 2], [-38, -16, 2, 2, 1.6, 0], [-38, -14, 2, 2, 1.6, 0], [-38, -15, 2, 2, 3.2, 0],
  [-24, -31, 2, 2, 1.6, 0], [-22, -31, 2, 2, 1.6, 0], [-41, -30, 1.2, 6, 1.1, 1], [-22, -18, 4, 1.2, 1.1, 1],
  // Site B
  [31, -24, 3.2, 3.2, 2.2, 2], [38, -16, 2, 2, 1.6, 0], [38, -14, 2, 2, 1.6, 0], [38, -15, 2, 2, 3.2, 0],
  [24, -31, 2, 2, 1.6, 0], [22, -31, 2, 2, 1.6, 0], [41, -30, 1.2, 6, 1.1, 1], [22, -18, 4, 1.2, 1.1, 1],
  // Mid
  [0, 7, 4.5, 4.5, 1.1, 1], [-4, -10, 2, 2, 1.6, 0], [4, -10, 2, 2, 1.6, 0], [0, 18, 2, 2, 1.6, 0], [1.6, 19.2, 1.4, 1.4, 1.1, 0],
  // Mains and lobbies
  [-34, 6, 2, 2, 1.6, 0], [-35.5, 7.5, 1.4, 1.4, 1.1, 0], [34, 6, 2, 2, 1.6, 0], [35.5, 7.5, 1.4, 1.4, 1.1, 0],
  [-26, 30, 5, 1.2, 1.1, 1], [26, 30, 5, 1.2, 1.1, 1], [-40, 28, 2, 2, 1.6, 0], [40, 28, 2, 2, 1.6, 0],
  // Defender back lane
  [-26, -43, 2, 2, 1.6, 0], [26, -43, 2, 2, 1.6, 0], [0, -42, 6, 1.2, 1.1, 1],
]

const PALETTE = {
  floor: '#d8ccb6',
  street: '#c9bca4',
  stucco: ['#ebe0cb', '#e3cfae', '#d9e2df'],
  trim: ['#b65a3c', '#2e8b86', '#3d5f8a'],
  base: '#a48f74',
  window: '#33495c',
  frame: '#f4efe6',
  crate: '#b98250',
  stone: '#c3b49b',
  metal: '#7c8a93',
  perimeter: '#d5c4a6',
  mountain: '#8fa6b8',
}

export class Arena {
  readonly group = new THREE.Group()
  readonly tags = new Map<number, ColliderTag>()
  readonly nav: NavGrid
  sun!: THREE.DirectionalLight
  /** Free-for-all spawns (Deathmatch / Onslaught). */
  readonly spawns: THREE.Vector3[] = []
  readonly teamSpawns: Record<TeamSide, THREE.Vector3[]> = { attack: [], defend: [] }
  readonly sites: Site[] = []
  readonly props: PropSpot[] = []
  readonly pickups: PickupSpot[] = []
  /** Places worth walking to when there is nothing better to do. */
  readonly hotspots: THREE.Vector3[] = []
  readonly minimap: MapRect[] = []
  // Kept for API compatibility with the old yard (no fires or lamps in daylight).
  readonly fires: { pos: THREE.Vector3; glow: THREE.MeshBasicMaterial }[] = []
  readonly lamps: THREE.PointLight[] = []
  private readonly mats: Record<string, THREE.Material> = {}
  private readonly pending = new Map<string, THREE.BufferGeometry[]>()
  private readonly noShadow = new Set<string>()
  private readonly barriers: { side: TeamSide; collider: RAPIER.Collider; mesh: THREE.Mesh }[] = []
  private readonly barrierMat: THREE.MeshBasicMaterial
  private time = 0

  constructor(readonly scene: THREE.Scene, private readonly physics: Physics, private readonly lib: Library) {
    void this.lib
    const lam = (key: string, color: string, map?: THREE.Texture) => (this.mats[key] = new THREE.MeshLambertMaterial({ color, map: map ?? null }))
    const stucco = stuccoTexture()
    lam('floor', PALETTE.floor, tileTexture())
    lam('street', PALETTE.street, tileTexture(true))
    PALETTE.stucco.forEach((c, i) => lam(`stucco${i}`, c, stucco))
    PALETTE.trim.forEach((c, i) => lam(`trim${i}`, c))
    lam('base', PALETTE.base, stucco)
    lam('window', PALETTE.window)
    lam('frame', PALETTE.frame)
    lam('crate', PALETTE.crate, crateTexture())
    lam('stone', PALETTE.stone, stucco)
    lam('metal', PALETTE.metal)
    lam('perimeter', PALETTE.perimeter, stucco)
    this.mats.paint = new THREE.MeshBasicMaterial({ map: sitePaintTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    for (const k of ['window', 'frame', 'paint']) this.noShadow.add(k)
    this.barrierMat = new THREE.MeshBasicMaterial({ map: barrierTexture(), color: new THREE.Color(0.35, 1.6, 1.4), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    this.buildSky()
    this.buildLighting()
    this.buildGround()
    this.buildPerimeter()
    for (const [x0, x1, z0, z1, h, style] of BUILDINGS) this.building(x0, x1, z0, z1, h, style)
    for (const c of COVER) this.cover(...c)
    this.buildSites()
    this.flush()
    this.physics.world.step()
    this.nav = this.bakeNav()
    // Spawn barriers go in after the nav bake: they are temporary and must not carve the grid.
    this.barrier('attack', 34.5)
    this.barrier('defend', -37.5)
    this.defineSpots()
    this.scene.add(this.group)
  }

  // ─── building helpers ──────────────────────────────────────────────────
  private queue(key: string, geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix)
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
    const list = this.pending.get(key) ?? []
    list.push(g)
    this.pending.set(key, list)
  }

  private flush(): void {
    for (const [key, list] of this.pending) {
      const merged = mergeGeometries(list, false)
      if (!merged) continue
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, this.mats[key])
      mesh.castShadow = !this.noShadow.has(key)
      mesh.receiveShadow = key !== 'paint'
      mesh.matrixAutoUpdate = false
      if (key === 'paint') mesh.renderOrder = 2
      this.group.add(mesh)
    }
    this.pending.clear()
  }

  /** Solid box (bottom at y0) with a matching collider. */
  private box(mat: string, cx: number, y0: number, cz: number, w: number, h: number, d: number, opts: { tile?: number; collide?: boolean; surface?: Surface } = {}): void {
    const geo = worldBox(w, h, d, opts.tile ?? 4)
    this.queue(mat, geo, new THREE.Matrix4().makeTranslation(cx, y0 + h / 2, cz))
    if (opts.collide !== false) this.collider(cx, y0 + h / 2, cz, w, h, d, opts.surface ?? 'concrete')
  }

  private collider(cx: number, cy: number, cz: number, w: number, h: number, d: number, surface: Surface): RAPIER.Collider {
    const c = this.physics.addStaticBox(new THREE.Vector3(cx, cy, cz), new THREE.Vector3(w, h, d))
    this.tags.set(c.handle, { kind: 'world', surface })
    return c
  }

  // ─── sky, light, ground ────────────────────────────────────────────────
  private buildSky(): void {
    const scene = this.scene
    scene.background = skyTexture()
    scene.backgroundIntensity = 1
    scene.environmentIntensity = 0.55
    scene.fog = new THREE.FogExp2('#cfdde6', 0.0042)
    // Distant low-poly ridge ring: one unlit draw call that gives the horizon depth.
    const segs = 96
    const R = 260
    const pos: number[] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const heights = Array.from({ length: segs }, (_, i) => 18 + Math.sin(i * 0.31) * 10 + Math.sin(i * 0.11 + 1) * 14 + rnd() * 9)
    for (let i = 0; i < segs; i += 1) {
      const a0 = (i / segs) * Math.PI * 2
      const a1 = ((i + 1) / segs) * Math.PI * 2
      const h0 = heights[i]
      const h1 = heights[(i + 1) % segs]
      const p = (a: number, y: number) => [Math.cos(a) * R, y, Math.sin(a) * R]
      pos.push(...p(a0, -5), ...p(a1, -5), ...p(a1, h1), ...p(a0, -5), ...p(a1, h1), ...p(a0, h0))
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const ridge = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: PALETTE.mountain, side: THREE.DoubleSide, fog: false }))
    ridge.matrixAutoUpdate = false
    this.group.add(ridge)
  }

  private buildLighting(): void {
    const sunDir = new THREE.Vector3(-0.45, 0.82, 0.38).normalize()
    const sun = new THREE.DirectionalLight('#fff0d8', 2.1)
    sun.position.copy(sunDir).multiplyScalar(90)
    sun.target.position.set(0, 0, 0)
    sun.castShadow = true
    const cam = sun.shadow.camera
    cam.left = cam.bottom = -62
    cam.right = cam.top = 62
    cam.near = 10
    cam.far = 200
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.05
    sun.shadow.mapSize.set(1024, 1024)
    this.sun = sun
    this.scene.add(sun, sun.target)
    this.scene.add(new THREE.HemisphereLight('#d6e8ff', '#b39a7c', 1.35))
  }

  private buildGround(): void {
    const floor = (key: string, x0: number, x1: number, z0: number, z1: number, tile: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
      g.rotateX(-Math.PI / 2)
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * (x1 - x0)) / tile, (uv.getY(i) * (z1 - z0)) / tile)
      this.queue(key, g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, 0, (z0 + z1) / 2))
    }
    floor('floor', -HALF_X, HALF_X, -HALF_Z, HALF_Z, 4)
    // Paved lanes read as streets between the plazas.
    floor('street', -38, -30, -4, 24, 2)
    floor('street', 30, 38, -4, 24, 2)
    floor('street', -8, 8, -6, 28, 2)
    floor('street', -3, 3, -36, -6, 2)
    // Outside the walls: a wide plain under the ridge so the horizon never shows a void.
    for (const [x0, x1, z0, z1] of [[-300, 300, -300, -HALF_Z], [-300, 300, HALF_Z, 300], [-300, -HALF_X, -HALF_Z, HALF_Z], [HALF_X, 300, -HALF_Z, HALF_Z]]) {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
      g.rotateX(-Math.PI / 2)
      this.queue('stone', g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, -0.05, (z0 + z1) / 2))
    }
    this.collider(0, -0.5, 0, HALF_X * 2 + 6, 1, HALF_Z * 2 + 6, 'concrete')
  }

  private buildPerimeter(): void {
    const h = 9
    const t = 2
    const wall = (cx: number, cz: number, w: number, d: number) => {
      this.box('perimeter', cx, 0, cz, w, h, d, { tile: 6 })
      this.box('trim0', cx, h - 0.6, cz, w + 0.3, 0.8, d + 0.3, { collide: false, tile: 2 })
      this.box('base', cx, 0, cz, w + 0.12, 0.8, d + 0.12, { collide: false, tile: 2 })
    }
    wall(0, -HALF_Z - t / 2 + 1, HALF_X * 2 + 2 * t, t)
    wall(0, HALF_Z + t / 2 - 1, HALF_X * 2 + 2 * t, t)
    wall(-HALF_X - t / 2 + 1, 0, t, HALF_Z * 2)
    wall(HALF_X + t / 2 - 1, 0, t, HALF_Z * 2)
    this.minimap.push(
      { x0: -HALF_X - 1, x1: HALF_X + 1, z0: -HALF_Z - 1, z1: -HALF_Z + 1, kind: 'wall' },
      { x0: -HALF_X - 1, x1: HALF_X + 1, z0: HALF_Z - 1, z1: HALF_Z + 1, kind: 'wall' },
      { x0: -HALF_X - 1, x1: -HALF_X + 1, z0: -HALF_Z, z1: HALF_Z, kind: 'wall' },
      { x0: HALF_X - 1, x1: HALF_X + 1, z0: -HALF_Z, z1: HALF_Z, kind: 'wall' },
    )
  }

  /** A stucco building: body, base trim, coloured cornice, framed windows and doors on every face. */
  private building(x0: number, x1: number, z0: number, z1: number, h: number, style: number): void {
    const w = x1 - x0
    const d = z1 - z0
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    this.box(`stucco${style}`, cx, 0, cz, w, h, d, { tile: 5 })
    this.box('base', cx, 0, cz, w + 0.14, 0.9, d + 0.14, { collide: false, tile: 2 })
    // Cornice doubles as the roof: its top sits above the body so the two never z-fight.
    this.box(`trim${style}`, cx, h - 0.55, cz, w + 0.4, 0.75, d + 0.4, { collide: false, tile: 2 })
    this.box(`trim${style}`, cx, h * 0.55, cz, w + 0.18, 0.18, d + 0.18, { collide: false, tile: 2 })
    // Windows/doors on the four faces (skipping faces flush with the perimeter wall).
    const faces: { along: 'x' | 'z'; at: number; from: number; to: number; normal: number }[] = [
      { along: 'x', at: z0, from: x0, to: x1, normal: -1 },
      { along: 'x', at: z1, from: x0, to: x1, normal: 1 },
      { along: 'z', at: x0, from: z0, to: z1, normal: -1 },
      { along: 'z', at: x1, from: z0, to: z1, normal: 1 },
    ]
    for (const f of faces) {
      if ((f.along === 'z' && Math.abs(Math.abs(f.at) - HALF_X) < 0.5) || (f.along === 'x' && Math.abs(Math.abs(f.at) - HALF_Z) < 0.5)) continue
      const len = f.to - f.from
      const n = Math.max(1, Math.floor(len / 4.2))
      const step = len / n
      for (let i = 0; i < n; i += 1) {
        const t = f.from + step * (i + 0.5)
        const door = i % 3 === 1 && len > 10
        const ww = door ? 1.5 : 1.3
        const wh = door ? 2.5 : 1.7
        const wy = door ? wh / 2 : h * 0.55 + 1.35
        if (door && i % 6 !== 1) continue
        this.facade(f.along, f.at, t, wy, ww, wh, f.normal, door)
        if (!door && h > 7.2) this.facade(f.along, f.at, t, h * 0.3, ww, 1.4, f.normal, false)
      }
    }
    this.minimap.push({ x0, x1, z0, z1, kind: 'building' })
  }

  /** Framed window or door slightly proud of a wall face. */
  private facade(along: 'x' | 'z', at: number, t: number, y: number, w: number, h: number, normal: number, door: boolean): void {
    const off = 0.04 * normal
    const pos = along === 'x' ? new THREE.Vector3(t, y, at + off) : new THREE.Vector3(at + off, y, t)
    const rot = along === 'x' ? (normal > 0 ? 0 : Math.PI) : normal > 0 ? Math.PI / 2 : -Math.PI / 2
    const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1))
    const frame = worldBox(w + 0.3, h + 0.3, 0.06, 4)
    this.queue('frame', frame, m)
    const pane = worldBox(w, h, 0.08, 4)
    this.queue(door ? 'crate' : 'window', pane, m)
  }

  /** Cover piece; crates get plank texture, planters are stone, generators are metal with a trim band. */
  private cover(x: number, z: number, w: number, d: number, h: number, kind: number): void {
    if (kind === 0) {
      // Stacked crates: bottom crate when h > 1.6 is drawn as two boxes.
      const unit = Math.min(1.6, h)
      this.box('crate', x, 0, z, w, unit, d, { tile: 1.6, surface: 'wood' })
      if (h > unit + 0.1) this.box('crate', x + 0.1, unit, z - 0.08, w * 0.9, h - unit, d * 0.9, { tile: 1.6, surface: 'wood' })
    } else if (kind === 1) {
      this.box('stone', x, 0, z, w, h, d, { tile: 2 })
      this.box('trim1', x, h - 0.12, z, w + 0.12, 0.2, d + 0.12, { collide: false, tile: 2 })
    } else {
      this.box('metal', x, 0, z, w, h, d, { tile: 2, surface: 'metal' })
      this.box('trim0', x, h * 0.6, z, w + 0.06, 0.25, d + 0.06, { collide: false, tile: 2 })
      this.box('base', x, h, z, w * 0.6, 0.3, d * 0.6, { collide: false, tile: 2 })
    }
    this.minimap.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, kind: 'cover' })
  }

  private buildSites(): void {
    const defs: [SiteId, number, number, string][] = [['A', -31, -24, '#ff6b5a'], ['B', 31, -24, '#ffb648']]
    for (const [id, x, z, color] of defs) {
      const site: Site = { id, center: new THREE.Vector3(x, 0, z), halfX: 9.5, halfZ: 8.5, color }
      this.sites.push(site)
      // Painted plant zone on the floor (tile atlas: letter cell per site).
      const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, 0.02, z)
      const g = new THREE.PlaneGeometry(site.halfX * 2, site.halfZ * 2)
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      this.queue('paint', g, m)
      // Big site letter on the nearest building wall facing the plaza.
      const wallX = id === 'A' ? -16 : 16
      const sign = new THREE.PlaneGeometry(3.4, 3.4)
      const suv = sign.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < suv.count; i += 1) suv.setX(i, suv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      const sm = new THREE.Matrix4().compose(new THREE.Vector3(wallX + (id === 'A' ? -0.08 : 0.08), 4.2, -25), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), id === 'A' ? -Math.PI / 2 : Math.PI / 2), new THREE.Vector3(1, 1, 1))
      this.queue('paint', sign, sm)
    }
  }

  // ─── spawn barriers (buy phase) ────────────────────────────────────────
  private barrier(side: TeamSide, z: number): void {
    const w = HALF_X * 2
    const h = 6
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.barrierMat)
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * w) / 3, (uv.getY(i) * h) / 3)
    mesh.position.set(0, h / 2, z)
    mesh.visible = false
    mesh.renderOrder = 3
    this.group.add(mesh)
    const collider = this.collider(0, h / 2, z, w, h, 0.3, 'metal')
    collider.setEnabled(false)
    this.barriers.push({ side, collider, mesh })
  }

  /** Raise/lower the buy-phase walls in front of each spawn. */
  setBarriers(on: boolean): void {
    for (const b of this.barriers) {
      b.mesh.visible = on
      b.collider.setEnabled(on)
    }
  }

  /** Which site (if any) contains a point. */
  siteAt(p: THREE.Vector3): Site | undefined {
    return this.sites.find(s => Math.abs(p.x - s.center.x) <= s.halfX && Math.abs(p.z - s.center.z) <= s.halfZ)
  }

  // ─── navigation ────────────────────────────────────────────────────────
  private bakeNav(): NavGrid {
    const nav = new NavGrid(HALF_X * 2, HALF_Z * 2, 1, -HALF_X, -HALF_Z)
    const world = this.physics.world
    const ray = new RAPIER.Ray({ x: 0, y: 4.5, z: 0 }, { x: 0, y: -1, z: 0 })
    const sample = (x: number, z: number): { h: number; ny: number } => {
      ray.origin = { x, y: 4.5, z }
      const hit = world.castRayAndGetNormal(ray, 6, true)
      if (!hit) return { h: BLOCKED, ny: 0 }
      return { h: 4.5 - hit.timeOfImpact, ny: hit.normal.y }
    }
    const r = 0.5
    for (let cz = 0; cz < nav.rows; cz += 1) {
      for (let cx = 0; cx < nav.cols; cx += 1) {
        const x = -HALF_X + cx + 0.5
        const z = -HALF_Z + cz + 0.5
        const c = sample(x, z)
        let ok = c.h !== BLOCKED && c.h < 0.5 && c.ny > 0.8 && Math.abs(x) < HALF_X - 1.2 && Math.abs(z) < HALF_Z - 1.2
        if (ok) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
            const s = sample(x + dx, z + dz)
            if (Math.abs(s.h - c.h) > 0.3) {
              ok = false
              break
            }
          }
        }
        nav.heights[nav.index(cx, cz)] = ok ? c.h : BLOCKED
      }
    }
    nav.computeEdges()
    return nav
  }

  private snap(x: number, z: number): THREE.Vector3 {
    const i = this.nav.nearest(x, z, 6)
    const c = i >= 0 ? this.nav.center(i) : { x, z }
    return new THREE.Vector3(c.x, i >= 0 ? this.nav.heights[i] : 0, c.z)
  }

  private defineSpots(): void {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const ffa: [number, number][] = [
      [-41, -44], [41, -44], [-34, 10], [34, 10], [-41, -22], [41, -22], [0, -44], [0, 44],
      [-36, 42], [36, 42], [0, 12], [-20, -10], [20, -10], [-30, 30], [30, 30], [0, -26],
    ]
    for (const [x, z] of ffa) this.spawns.push(this.snap(x, z))
    for (let i = 0; i < 5; i += 1) {
      const x = (i - 2) * 3.2
      this.teamSpawns.attack.push(this.snap(x, 43 + (i % 2) * 2))
      this.teamSpawns.defend.push(this.snap(x, -44 - (i % 2) * 2))
    }
    const hot: [number, number][] = [[-31, -20], [31, -20], [0, 0], [0, -24], [-34, 10], [34, 10], [-12, -10], [12, -10], [-30, 32], [30, 32], [0, 30], [-30, -44], [30, -44]]
    for (const [x, z] of hot) this.hotspots.push(this.snap(x, z))
    const barrels: [number, number, PropSpot['model']][] = [
      [-36.5, 15, 'barrel'], [36.5, 15, 'barrel'], [-6.2, 16, 'propane'], [6.2, -12, 'barrel'], [-43, -36, 'barrel'], [43, -36, 'propane'],
    ]
    for (const [x, z, model] of barrels) this.props.push({ pos: v(x, 0, z), model, rot: (x * 7.1 + z) % (Math.PI * 2) })
    const pick: [number, number, number, PickupSpot['kind']][] = [
      [-34, 0, 12, 'health'], [34, 0, 12, 'health'], [0, 0, -30, 'health'], [0, 0, 32, 'health'],
      [-30, 0, -40, 'armor'], [30, 0, -40, 'armor'],
      [-20, 0, 32, 'ammo'], [20, 0, 32, 'ammo'], [-12, 0, -44, 'ammo'], [12, 0, -44, 'ammo'],
      [0, 0, 1, 'rocket'],
    ]
    for (const [x, y, z, kind] of pick) this.pickups.push({ pos: v(x, y, z), kind })
  }

  /** Ground height below a point (used by FX pieces). */
  groundAt(x: number, z: number, fromY: number): number {
    const hit = this.physics.world.castRay(new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 12, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, c => this.tags.get(c.handle)?.kind === 'world')
    return hit ? fromY - hit.timeOfImpact : 0
  }

  // Old-yard hooks (no crane skyline or rain on this map).
  attachSts(scene: THREE.Object3D): void {
    void scene
  }
  attachCamera(camera: THREE.Camera, density: number): void {
    void camera
    void density
  }
  setRainDensity(density: number): void {
    void density
  }

  update(time: number): void {
    this.time = time
    const map = this.barrierMat.map
    if (map && this.barriers[0]?.mesh.visible) map.offset.y = -this.time * 0.25
  }
}

// ─── canvas textures (tiny: they only add painted variation to flat colours) ───

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, color = true): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d')!, size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (color) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 2
  return t
}

function seeded(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

/** Light hand-painted stucco: soft blotches around white, so it multiplies the material colour. */
function stuccoTexture(): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#f4f4f4'
    g.fillRect(0, 0, s, s)
    const r = seeded(11)
    for (let i = 0; i < 90; i += 1) {
      const v = 225 + Math.floor(r() * 30)
      g.fillStyle = `rgba(${v},${v},${v - 6},0.5)`
      g.beginPath()
      g.arc(r() * s, r() * s, 4 + r() * 14, 0, Math.PI * 2)
      g.fill()
    }
  })
}

/** Square stone tiles with soft grout; `street` makes long cobble rows. */
function tileTexture(street = false): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#f2f0ec'
    g.fillRect(0, 0, s, s)
    const r = seeded(street ? 5 : 3)
    const n = street ? 4 : 2
    const cell = s / n
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const v = 228 + Math.floor(r() * 22)
        g.fillStyle = `rgb(${v},${v - 2},${v - 6})`
        const off = street && y % 2 ? cell / 2 : 0
        g.fillRect(x * cell + off + 2, y * cell + 2, cell - 4, cell - 4)
        if (off) g.fillRect(off - cell + 2, y * cell + 2, cell - 4, cell - 4)
      }
    }
  })
}

function crateTexture(): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#efe4d6'
    g.fillRect(0, 0, s, s)
    g.fillStyle = '#d8c3a8'
    for (let i = 0; i < 4; i += 1) g.fillRect(0, i * 32 + 30, s, 2)
    g.strokeStyle = '#a6835e'
    g.lineWidth = 10
    g.strokeRect(5, 5, s - 10, s - 10)
    g.beginPath()
    g.moveTo(8, 8)
    g.lineTo(s - 8, s - 8)
    g.stroke()
  })
}

/** Two-cell atlas: Site A (left) and Site B (right) floor paint / wall sign. */
function sitePaintTexture(): THREE.CanvasTexture {
  const t = canvasTex(256, (g, s) => {
    g.clearRect(0, 0, s, s)
    const half = s / 2
    for (const [i, letter, col] of [[0, 'A', '#ff6b5a'], [1, 'B', '#ffb648']] as const) {
      const x0 = i * half
      g.strokeStyle = col
      g.globalAlpha = 0.85
      g.lineWidth = 6
      g.setLineDash([14, 8])
      g.strokeRect(x0 + 6, 6, half - 12, s - 12)
      g.setLineDash([])
      g.globalAlpha = 0.18
      g.fillStyle = col
      g.fillRect(x0 + 6, 6, half - 12, s - 12)
      g.globalAlpha = 0.9
      g.fillStyle = col
      g.font = 'bold 84px sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(letter, x0 + half / 2, s / 2)
    }
    g.globalAlpha = 1
  })
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

function barrierTexture(): THREE.CanvasTexture {
  return canvasTex(64, (g, s) => {
    g.clearRect(0, 0, s, s)
    g.strokeStyle = 'rgba(255,255,255,0.9)'
    g.lineWidth = 3
    g.beginPath()
    for (let i = -s; i < s * 2; i += 16) {
      g.moveTo(i, 0)
      g.lineTo(i + s, s)
    }
    g.stroke()
    g.fillStyle = 'rgba(255,255,255,0.12)'
    g.fillRect(0, 0, s, s)
  })
}

/** Vertical sky gradient mapped equirectangularly (zenith blue → warm haze at the horizon). */
function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#5f9fe0')
  grad.addColorStop(0.38, '#9cc8ee')
  grad.addColorStop(0.5, '#f1e6d2')
  grad.addColorStop(0.56, '#d9d1c2')
  grad.addColorStop(1, '#b8ab96')
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.mapping = THREE.EquirectangularReflectionMapping
  return t
}
