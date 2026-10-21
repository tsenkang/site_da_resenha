import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RAPIER, type Physics } from '../engine/physics'
import { worldBox, type Library } from './library'
import { BLOCKED, NavGrid } from './nav'
import { MAPS, type MapDef } from './maps'

/**
 * "Base Aurora": a sunny two-site tactical map in a painted, low-poly Mediterranean style.
 * Attackers spawn in the south, defenders in the north; Site A sits west, Site B east, joined by a
 * central Mid (with a fountain) that splits into two links and a narrow Market corridor.
 *
 * The layout tables are in design units and scaled by MAP_SCALE, so the whole map (lanes,
 * plazas, spawns, sites, bot goals) grows or shrinks together.
 *
 * Built for weak GPUs: Lambert materials with tiny canvas textures and a cheap height-based contact
 * shade, static geometry merged per material (a couple of dozen draw calls for the whole level,
 * horizon included), no point lights. Every solid the player can touch has a matching Rapier box
 * collider; the bot navigation grid is baked from those colliders.
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

/** Tactical map scale and extents (the HUD minimap and the round director use them). */
export const MAP_SCALE = MAPS.aurora.scale
export const HALF_X = Math.round(MAPS.aurora.halfX * MAP_SCALE)
export const HALF_Z = Math.round(MAPS.aurora.halfZ * MAP_SCALE)

export type PropSpot = { pos: THREE.Vector3; model: 'barrel' | 'propane'; rot: number }
export type PickupSpot = { pos: THREE.Vector3; kind: 'health' | 'armor' | 'ammo' | 'rocket' }
export type SiteId = 'A' | 'B'
/** Axis-aligned plant zone. */
export type Site = { id: SiteId; center: THREE.Vector3; halfX: number; halfZ: number; color: string }
/** Minimap rectangle (top-down), `kind` picks its fill. */
export type MapRect = { x0: number; x1: number; z0: number; z1: number; kind: 'building' | 'cover' | 'wall' }
export type TeamSide = 'attack' | 'defend'

/** Materials shared by every map (per-map colours come from MapDef.look). */
const PALETTE = {
  plaza: '#d9cdb5',
  base: '#b09b7f',
  window: '#2c4357',
  frame: '#fbf6ec',
  crate: '#c08a55',
  stone: '#cdbfa6',
  metal: '#7f8e98',
  perimeter: '#dccbaa',
  trunk: '#7a5636',
  leaf: ['#6f9a45', '#8db352'],
  water: '#5fb6c9',
  bloom: ['#e2546a', '#f2b33d', '#f6f1f3', '#b46ad1'],
  backdrop: ['#efe2c8', '#e8cfae', '#dfe5e0', '#f0d9c0'],
}

export class Arena {
  readonly group = new THREE.Group()
  readonly nav: NavGrid
  /** Layout scale and half extents in metres. */
  readonly K: number
  readonly HX: number
  readonly HZ: number
  /** World offset of this map (maps sit side by side in one physics world). */
  readonly origin: THREE.Vector3
  private readonly hemi: THREE.HemisphereLight
  private readonly skyTex: THREE.Texture
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
  private readonly clouds = new THREE.Group()
  private time = 0
  private seed = 4242

  constructor(
    readonly scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly lib: Library,
    readonly def: MapDef,
    origin: [number, number],
    readonly tags: Map<number, ColliderTag>,
  ) {
    void this.lib
    this.K = def.scale
    this.HX = Math.round(def.halfX * def.scale)
    this.HZ = Math.round(def.halfZ * def.scale)
    this.origin = new THREE.Vector3(origin[0], 0, origin[1])
    this.group.position.copy(this.origin)
    const L = def.look
    this.skyTex = skyTexture(L.sky)
    this.hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiIntensity)
    const lam = (key: string, color: string, map?: THREE.Texture, ao = 0.3) => {
      const m = new THREE.MeshLambertMaterial({ color, map: map ?? null })
      if (ao > 0) groundShade(m, ao)
      return (this.mats[key] = m)
    }
    const stucco = stuccoTexture()
    lam('floor', L.floor, tileTexture(), 0)
    lam('street', L.street, tileTexture(true), 0)
    lam('plaza', PALETTE.plaza, plazaTexture(), 0)
    lam('grass', L.grass, grassTexture(), 0)
    L.stucco.forEach((c, i) => lam(`stucco${i}`, c, stucco))
    L.trim.forEach((c, i) => lam(`trim${i}`, c))
    const tiles = roofTexture()
    L.roof.forEach((c, i) => lam(`roof${i}`, c, tiles, 0))
    L.trim.forEach((c, i) => {
      const m = lam(`awning${i}`, '#ffffff', awningTexture(c), 0)
      m.side = THREE.DoubleSide
    })
    lam('base', PALETTE.base, stucco)
    const win = lam('window', PALETTE.window, windowTexture(), 0) as THREE.MeshLambertMaterial
    if (L.night) {
      // Lit rooms at night: warm emissive panes.
      win.emissive.set('#ffc879')
      win.emissiveIntensity = 0.75
    }
    lam('frame', PALETTE.frame)
    lam('crate', PALETTE.crate, crateTexture())
    lam('stone', PALETTE.stone, stucco)
    lam('metal', PALETTE.metal)
    lam('perimeter', PALETTE.perimeter, stucco)
    lam('trunk', PALETTE.trunk)
    PALETTE.leaf.forEach((c, i) => {
      const m = lam(`leaf${i}`, c, undefined, 0.45)
      ;(m as THREE.MeshLambertMaterial).flatShading = true
    })
    PALETTE.bloom.forEach((c, i) => lam(`bloom${i}`, c, undefined, 0))
    this.mats.water = new THREE.MeshLambertMaterial({ color: PALETTE.water, emissive: '#1d5e6e', emissiveIntensity: 0.35 })
    this.mats.lampGlow = new THREE.MeshBasicMaterial({ color: L.night ? '#ffe2a0' : '#fff1c8' })
    this.mats.lampPool = new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#ffb768', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
    PALETTE.backdrop.forEach((c, i) => (this.mats[`far${i}`] = new THREE.MeshLambertMaterial({ color: c })))
    this.mats.farRoof = new THREE.MeshLambertMaterial({ color: '#c27053' })
    this.mats.cypress = new THREE.MeshLambertMaterial({ color: '#4f7a3f', flatShading: true })
    this.mats.paint = new THREE.MeshBasicMaterial({ map: sitePaintTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    for (const k of ['lampPool', 'window', 'frame', 'paint', 'lampGlow', 'water', 'far0', 'far1', 'far2', 'far3', 'farRoof', 'cypress', 'grass', 'bloom0', 'bloom1', 'bloom2', 'bloom3']) this.noShadow.add(k)
    this.barrierMat = new THREE.MeshBasicMaterial({ map: barrierTexture(), color: new THREE.Color(0.35, 1.6, 1.4), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    this.buildSky()
    this.buildLighting()
    this.buildGround()
    this.buildPerimeter()
    def.buildings.forEach(([x0, x1, z0, z1, h, style], i) => this.building(x0 * this.K, x1 * this.K, z0 * this.K, z1 * this.K, h, style, i))
    for (const [x, z, w, d, h, kind] of def.cover) this.cover(x * this.K, z * this.K, w, d, h, kind)
    for (const [x, z, s] of def.trees) this.tree(x * this.K, z * this.K, s)
    for (const [x, z] of def.lamps) this.lamp(x * this.K, z * this.K)
    if (def.sites) this.buildSites()
    this.buildBackdrop()
    this.flush()
    this.physics.world.step()
    this.nav = this.bakeNav()
    // Spawn barriers go in after the nav bake: they are temporary and must not carve the grid.
    if (def.barriers) {
      this.barrier('attack', def.barriers[0] * this.K)
      this.barrier('defend', def.barriers[1] * this.K)
    }
    this.defineSpots()
    this.scene.add(this.group)
    this.setActive(false)
  }

  /** Show this map and apply its sky, fog and light (only the active map is visible). */
  setActive(on: boolean): void {
    this.group.visible = on
    this.sun.visible = on
    this.hemi.visible = on
    if (!on) return
    const L = this.def.look
    this.scene.background = this.skyTex
    this.scene.environmentIntensity = L.night ? 0.4 : 0.9
    const fog = this.scene.fog as THREE.FogExp2 | null
    if (fog) {
      fog.color.set(L.fog)
      fog.density = L.fogDensity
    } else this.scene.fog = new THREE.FogExp2(L.fog, L.fogDensity)
  }

  /** Map centre in world space. */
  get center(): THREE.Vector3 {
    return this.origin
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }

  // ─── building helpers ──────────────────────────────────────────────────
  private queue(key: string, geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix)
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
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
  private box(mat: string, cx: number, y0: number, cz: number, w: number, h: number, d: number, opts: { tile?: number; collide?: boolean; surface?: Surface; rotY?: number } = {}): void {
    const geo = worldBox(w, h, d, opts.tile ?? 4)
    const m = new THREE.Matrix4().makeRotationY(opts.rotY ?? 0).setPosition(cx, y0 + h / 2, cz)
    this.queue(mat, geo, m)
    if (opts.collide !== false) this.collider(cx, y0 + h / 2, cz, w, h, d, opts.surface ?? 'concrete')
  }

  private collider(cx: number, cy: number, cz: number, w: number, h: number, d: number, surface: Surface): RAPIER.Collider {
    const c = this.physics.addStaticBox(new THREE.Vector3(cx + this.origin.x, cy, cz + this.origin.z), new THREE.Vector3(w, h, d))
    this.tags.set(c.handle, { kind: 'world', surface })
    return c
  }

  private flat(key: string, x0: number, x1: number, z0: number, z1: number, y: number, tile: number): void {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
    g.rotateX(-Math.PI / 2)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * (x1 - x0)) / tile, (uv.getY(i) * (z1 - z0)) / tile)
    this.queue(key, g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, y, (z0 + z1) / 2))
  }

  // ─── sky, light, ground ────────────────────────────────────────────────
  private buildSky(): void {
    const L = this.def.look
    // Two low-poly ridge rings (near and far) for depth on the horizon.
    const ridge = (R: number, base: number, amp: number, color: string, seed: number) => {
      const segs = 120
      const pos: number[] = []
      let s = seed
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
      const hs = Array.from({ length: segs }, (_, i) => base + Math.sin(i * 0.23 + seed) * amp + Math.sin(i * 0.07 + 1) * amp * 1.4 + rnd() * amp * 0.7)
      for (let i = 0; i < segs; i += 1) {
        const a0 = (i / segs) * Math.PI * 2
        const a1 = ((i + 1) / segs) * Math.PI * 2
        const p = (a: number, y: number) => [Math.cos(a) * R, y, Math.sin(a) * R]
        pos.push(...p(a0, -5), ...p(a1, -5), ...p(a1, hs[(i + 1) % segs]), ...p(a0, -5), ...p(a1, hs[(i + 1) % segs]), ...p(a0, hs[i]))
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: false }))
      m.matrixAutoUpdate = false
      this.group.add(m)
    }
    ridge(330, 34, 16, L.ridge[1], 3 + this.def.id.length)
    ridge(250, 16, 9, L.ridge[0], 7 + this.def.id.length)
    // Sun (or moon) disc and soft halo where the light comes from.
    const sunDir = new THREE.Vector3(...L.sunDir).normalize()
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(L.night ? 50 : 90, L.night ? 50 : 90), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, color: L.sunGlow }))
    halo.position.copy(sunDir).multiplyScalar(380)
    halo.lookAt(0, 0, 0)
    this.group.add(halo)
    // Clouds: flattened low-poly puffs, one draw call, drifting slowly.
    const puffs: THREE.BufferGeometry[] = []
    let s = 11
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let c = 0; c < 16; c += 1) {
      const a = rnd() * Math.PI * 2
      const r = 140 + rnd() * 120
      const cx = Math.cos(a) * r
      const cz = Math.sin(a) * r
      const cy = 55 + rnd() * 35
      for (let p = 0; p < 4; p += 1) {
        const g = new THREE.IcosahedronGeometry(1, 1)
        const sz = 7 + rnd() * 9
        g.scale(sz * 1.6, sz * 0.55, sz)
        g.translate(cx + (p - 1.5) * sz * 1.2, cy + rnd() * 3, cz + (rnd() - 0.5) * sz)
        puffs.push(g)
      }
    }
    const cloud = new THREE.Mesh(mergeGeometries(puffs, false)!, new THREE.MeshLambertMaterial({ color: L.cloud, emissive: L.cloudGlow, emissiveIntensity: 0.55, fog: false, flatShading: true }))
    this.clouds.add(cloud)
    this.group.add(this.clouds)
  }

  private buildLighting(): void {
    const L = this.def.look
    const sunDir = new THREE.Vector3(...L.sunDir).normalize()
    const sun = new THREE.DirectionalLight(L.sunColor, L.sunIntensity)
    sun.position.copy(sunDir).multiplyScalar(110).add(this.origin)
    sun.target.position.copy(this.origin)
    sun.castShadow = true
    const cam = sun.shadow.camera
    cam.left = cam.bottom = -82
    cam.right = cam.top = 82
    cam.near = 10
    cam.far = 260
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.05
    sun.shadow.mapSize.set(1024, 1024)
    this.sun = sun
    this.scene.add(sun, sun.target)
    this.scene.add(this.hemi)
  }

  private buildGround(): void {
    this.flat('floor', -this.HX, this.HX, -this.HZ, this.HZ, 0, 4)
    // Paved streets through the lanes, plazas on the sites and in Mid.
    const K = this.K
    for (const [x0, x1, z0, z1] of this.def.streets) this.flat('street', x0 * K, x1 * K, z0 * K, z1 * K, 0.005, 2)
    for (const [x0, x1, z0, z1] of this.def.plazas) this.flat('plaza', x0 * K, x1 * K, z0 * K, z1 * K, 0.004, 6)
    // Grass verges along the back walls.
    this.flat('grass', -this.HX + 1, this.HX - 1, -this.HZ + 1, -this.HZ + 5, 0.008, 5)
    this.flat('grass', -this.HX + 1, this.HX - 1, this.HZ - 5, this.HZ - 1, 0.008, 5)
    // Outside the walls: a plain under the ridge so the horizon never shows a void.
    for (const [x0, x1, z0, z1] of [[-400, 400, -400, -this.HZ], [-400, 400, this.HZ, 400], [-400, -this.HX, -this.HZ, this.HZ], [this.HX, 400, -this.HZ, this.HZ]]) {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
      g.rotateX(-Math.PI / 2)
      this.queue('grass', g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, -0.05, (z0 + z1) / 2))
    }
    this.collider(0, -0.5, 0, this.HX * 2 + 6, 1, this.HZ * 2 + 6, 'concrete')
  }

  /** Town wall: stucco with pilasters, a cap and a terracotta coping. */
  private buildPerimeter(): void {
    const h = 9
    const t = 2
    const wall = (cx: number, cz: number, w: number, d: number) => {
      this.box('perimeter', cx, 0, cz, w, h, d, { tile: 6 })
      this.box('roof0', cx, h, cz, w + 0.5, 0.5, d + 0.5, { collide: false, tile: 2 })
      this.box('base', cx, 0, cz, w + 0.14, 0.9, d + 0.14, { collide: false, tile: 2 })
      // Pilasters every 8 m on the inner face.
      const alongX = w > d
      const len = alongX ? w : d
      for (let p = -len / 2 + 4; p < len / 2 - 2; p += 8) {
        const px = alongX ? cx + p : cx - Math.sign(cx) * (t / 2)
        const pz = alongX ? cz - Math.sign(cz) * (t / 2) : cz + p
        this.box('stone', px, 0, pz, alongX ? 0.9 : 0.5, h + 0.2, alongX ? 0.5 : 0.9, { collide: false, tile: 2 })
      }
    }
    wall(0, -this.HZ - t / 2 + 1, this.HX * 2 + 2 * t, t)
    wall(0, this.HZ + t / 2 - 1, this.HX * 2 + 2 * t, t)
    wall(-this.HX - t / 2 + 1, 0, t, this.HZ * 2)
    wall(this.HX + t / 2 - 1, 0, t, this.HZ * 2)
    this.minimap.push(
      { x0: -this.HX - 1, x1: this.HX + 1, z0: -this.HZ - 1, z1: -this.HZ + 1, kind: 'wall' },
      { x0: -this.HX - 1, x1: this.HX + 1, z0: this.HZ - 1, z1: this.HZ + 1, kind: 'wall' },
      { x0: -this.HX - 1, x1: -this.HX + 1, z0: -this.HZ, z1: this.HZ, kind: 'wall' },
      { x0: this.HX - 1, x1: this.HX + 1, z0: -this.HZ, z1: this.HZ, kind: 'wall' },
    )
  }

  /** A stucco building with a tiled pitched roof, framed windows with shutters and flower boxes, and awnings over doors. */
  private building(x0: number, x1: number, z0: number, z1: number, h: number, style: number, index: number): void {
    const w = x1 - x0
    const d = z1 - z0
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    this.box(`stucco${style}`, cx, 0, cz, w, h, d, { tile: 5 })
    this.box('base', cx, 0, cz, w + 0.14, 1, d + 0.14, { collide: false, tile: 2 })
    this.box(`trim${style}`, cx, h - 0.35, cz, w + 0.3, 0.35, d + 0.3, { collide: false, tile: 2 })
    this.box(`trim${style}`, cx, h * 0.5, cz, w + 0.16, 0.16, d + 0.16, { collide: false, tile: 2 })
    // Pitched roof, ridge along the long side.
    const roof = roofGeometry(w + 1, d + 1, Math.min(4, Math.min(w, d) * 0.3), w >= d)
    const rm = new THREE.Matrix4().makeTranslation(cx, h, cz)
    this.queue(`roof${(style + index) % 3}`, roof.slopes, rm)
    this.queue(`stucco${style}`, roof.gables, rm)
    // Chimney on bigger blocks.
    if (w * d > 200) this.box('base', cx + w * 0.22, h, cz - d * 0.18, 1, 3.2, 1, { collide: false, tile: 2 })
    const faces: { along: 'x' | 'z'; at: number; from: number; to: number; normal: number }[] = [
      { along: 'x', at: z0, from: x0, to: x1, normal: -1 },
      { along: 'x', at: z1, from: x0, to: x1, normal: 1 },
      { along: 'z', at: x0, from: z0, to: z1, normal: -1 },
      { along: 'z', at: x1, from: z0, to: z1, normal: 1 },
    ]
    for (const f of faces) {
      if ((f.along === 'z' && Math.abs(Math.abs(f.at) - this.HX) < 1) || (f.along === 'x' && Math.abs(Math.abs(f.at) - this.HZ) < 1)) continue
      const len = f.to - f.from
      const n = Math.max(1, Math.floor(len / 4.4))
      const step = len / n
      for (let i = 0; i < n; i += 1) {
        const t = f.from + step * (i + 0.5)
        const door = i % 3 === 1 && len > 10 && i % 6 === 1
        // Upper floor window always; ground floor gets a door or a window.
        this.facade(f.along, f.at, t, h * 0.5 + 1.6, 1.3, 1.7, f.normal, false, style, i)
        if (door) this.facade(f.along, f.at, t, 1.35, 1.6, 2.7, f.normal, true, style, i)
        else if (i % 2 === 0) this.facade(f.along, f.at, t, 1.9, 1.3, 1.5, f.normal, false, style, i + 1)
      }
    }
    this.minimap.push({ x0, x1, z0, z1, kind: 'building' })
  }

  /** Framed window (with shutters, sometimes a flower box) or a door with an awning, proud of a wall face. */
  private facade(along: 'x' | 'z', at: number, t: number, y: number, w: number, h: number, normal: number, door: boolean, style: number, i: number): void {
    const rot = along === 'x' ? (normal > 0 ? 0 : Math.PI) : normal > 0 ? Math.PI / 2 : -Math.PI / 2
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
    // Local frame: x along the wall, z out of the wall.
    const at3 = (lx: number, ly: number, lz: number) => {
      const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q)
      return along === 'x' ? new THREE.Vector3(t + v.x, y + ly, at + v.z) : new THREE.Vector3(at + v.x, y + ly, t + v.z)
    }
    const put = (key: string, g: THREE.BufferGeometry, lx: number, ly: number, lz: number, extraRot?: THREE.Euler) => {
      const m = new THREE.Matrix4().compose(at3(lx, ly, lz), extraRot ? q.clone().multiply(new THREE.Quaternion().setFromEuler(extraRot)) : q, new THREE.Vector3(1, 1, 1))
      this.queue(key, g, m)
    }
    put('frame', worldBox(w + 0.3, h + 0.3, 0.08, 4), 0, 0, 0.04)
    put(door ? 'crate' : 'window', worldBox(w, h, 0.1, w), 0, 0, 0.06)
    if (door) {
      // Striped awning sloping out over the door.
      const awning = new THREE.PlaneGeometry(w + 1.2, 1.3)
      put(`awning${(style + i) % 3}`, awning, 0, h / 2 + 0.55, 0.65, new THREE.Euler(-Math.PI / 2 + 0.55, 0, 0))
      return
    }
    // Shutters in the trim colour.
    for (const sx of [-1, 1]) put(`trim${(style + 1) % 3}`, worldBox(w * 0.48, h + 0.1, 0.06, 2), sx * (w / 2 + w * 0.26 + 0.12), 0, 0.07)
    if ((i + style) % 3 === 0) {
      put('crate', worldBox(w + 0.2, 0.28, 0.32, 1), 0, -h / 2 - 0.2, 0.22)
      for (let b = 0; b < 4; b += 1) put(`bloom${(b + i) % 4}`, new THREE.IcosahedronGeometry(0.13, 0), -w / 2 + 0.2 + b * ((w - 0.4) / 3), -h / 2 - 0.02, 0.24)
    }
  }

  /** Cover piece: crates (planks), stone planters with shrubs, metal generators, the Mid fountain. */
  private cover(x: number, z: number, w: number, d: number, h: number, kind: number): void {
    if (kind === 0) {
      const unit = Math.min(1.6, h)
      const turn = (this.rand() - 0.5) * 0.2
      this.box('crate', x, 0, z, w, unit, d, { tile: 1.6, surface: 'wood', rotY: turn })
      if (h > unit + 0.1) this.box('crate', x + 0.1, unit, z - 0.08, w * 0.9, h - unit, d * 0.9, { tile: 1.6, surface: 'wood', rotY: -turn })
    } else if (kind === 1) {
      this.box('stone', x, 0, z, w, h, d, { tile: 2 })
      this.box('trim1', x, h - 0.12, z, w + 0.12, 0.2, d + 0.12, { collide: false, tile: 2 })
      // Shrubs on top.
      const n = Math.max(1, Math.round(Math.max(w, d) / 1.4))
      for (let i = 0; i < n; i += 1) {
        const f = (i + 0.5) / n - 0.5
        const g = new THREE.IcosahedronGeometry(0.42 + this.rand() * 0.15, 0)
        this.queue(`leaf${i % 2}`, g, new THREE.Matrix4().makeTranslation(x + (w > d ? f * w : 0), h + 0.3, z + (w > d ? 0 : f * d)))
      }
    } else if (kind === 2) {
      this.box('metal', x, 0, z, w, h, d, { tile: 2, surface: 'metal' })
      this.box('trim0', x, h * 0.6, z, w + 0.06, 0.25, d + 0.06, { collide: false, tile: 2 })
      this.box('base', x, h, z, w * 0.6, 0.3, d * 0.6, { collide: false, tile: 2 })
    } else {
      // Fountain: stone rim, water, central column with a basin.
      this.collider(x, h / 2, z, w, h, d, 'concrete')
      const rim = 0.45
      this.box('stone', x, 0, z - d / 2 + rim / 2, w, h, rim, { collide: false, tile: 2 })
      this.box('stone', x, 0, z + d / 2 - rim / 2, w, h, rim, { collide: false, tile: 2 })
      this.box('stone', x - w / 2 + rim / 2, 0, z, rim, h, d - rim * 2, { collide: false, tile: 2 })
      this.box('stone', x + w / 2 - rim / 2, 0, z, rim, h, d - rim * 2, { collide: false, tile: 2 })
      this.flat('water', x - w / 2 + rim, x + w / 2 - rim, z - d / 2 + rim, z + d / 2 - rim, h * 0.75, 4)
      this.box('stone', x, 0, z, 0.7, 2.4, 0.7, { collide: false, tile: 2 })
      const basin = new THREE.CylinderGeometry(1.1, 0.6, 0.35, 10)
      this.queue('stone', basin, new THREE.Matrix4().makeTranslation(x, 2.4, z))
      const top = new THREE.CylinderGeometry(0.9, 0.9, 0.05, 10)
      this.queue('water', top, new THREE.Matrix4().makeTranslation(x, 2.56, z))
    }
    this.minimap.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, kind: 'cover' })
  }

  /** Low-poly broadleaf tree; only the trunk collides (canopy is above head height). */
  private tree(x: number, z: number, s: number): void {
    const trunkH = 2.6 * s
    const trunk = new THREE.CylinderGeometry(0.16 * s, 0.24 * s, trunkH, 6)
    this.queue('trunk', trunk, new THREE.Matrix4().makeTranslation(x, trunkH / 2, z))
    this.collider(x, trunkH / 2, z, 0.45 * s, trunkH, 0.45 * s, 'wood')
    for (let i = 0; i < 4; i += 1) {
      const r = (1.3 + this.rand() * 0.6) * s
      const g = new THREE.IcosahedronGeometry(r, 0)
      const a = this.rand() * Math.PI * 2
      const off = i === 0 ? 0 : 0.9 * s
      this.queue(`leaf${i % 2}`, g, new THREE.Matrix4().makeTranslation(x + Math.cos(a) * off, trunkH + r * 0.6 + (i === 0 ? 0.6 * s : 0), z + Math.sin(a) * off))
    }
    this.minimap.push({ x0: x - 0.4, x1: x + 0.4, z0: z - 0.4, z1: z + 0.4, kind: 'cover' })
  }

  /** Street lamp: thin dark post with a lantern. */
  private lamp(x: number, z: number): void {
    this.box('metal', x, 0, z, 0.16, 4.2, 0.16, { surface: 'metal', tile: 1 })
    this.box('metal', x, 4.2, z, 0.5, 0.12, 0.5, { collide: false, tile: 1 })
    this.box('lampGlow', x, 3.75, z, 0.32, 0.45, 0.32, { collide: false, tile: 1 })
    this.box('metal', x, 0, z, 0.36, 0.5, 0.36, { collide: false, tile: 1 })
    if (this.def.look.night) {
      const g = new THREE.PlaneGeometry(9, 9)
      g.rotateX(-Math.PI / 2)
      this.queue('lampPool', g, new THREE.Matrix4().makeTranslation(x, 0.03, z))
    }
  }

  private buildSites(): void {
    const defs: [SiteId, number, number, string][] = [['A', -31 * this.K, -24 * this.K, '#ff6b5a'], ['B', 31 * this.K, -24 * this.K, '#ffb648']]
    for (const [id, x, z, color] of defs) {
      const site: Site = { id, center: new THREE.Vector3(x, 0, z).add(this.origin), halfX: 9.5 * this.K * 0.95, halfZ: 8.5 * this.K * 0.95, color }
      this.sites.push(site)
      const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, 0.02, z)
      const g = new THREE.PlaneGeometry(site.halfX * 2, site.halfZ * 2)
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      this.queue('paint', g, m)
      // Big site letter on the building wall facing the plaza.
      const wallX = (id === 'A' ? -16 : 16) * this.K
      const sign = new THREE.PlaneGeometry(4, 4)
      const suv = sign.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < suv.count; i += 1) suv.setX(i, suv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      const sm = new THREE.Matrix4().compose(new THREE.Vector3(wallX + (id === 'A' ? -0.1 : 0.1), 4.4, -25 * this.K), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), id === 'A' ? -Math.PI / 2 : Math.PI / 2), new THREE.Vector3(1, 1, 1))
      this.queue('paint', sign, sm)
    }
  }

  /** Town skyline outside the walls: hazy houses with roofs and cypress trees (no colliders). */
  private buildBackdrop(): void {
    let s = 77
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 70; i += 1) {
      const a = rnd() * Math.PI * 2
      const r = 95 + rnd() * 70
      const x = Math.cos(a) * r * 1.05
      const z = Math.sin(a) * r
      if (Math.abs(x) < this.HX + 8 && Math.abs(z) < this.HZ + 8) continue
      const w = 6 + rnd() * 10
      const d = 6 + rnd() * 10
      const h = 6 + rnd() * 12
      const rot = Math.round(rnd() * 3) * (Math.PI / 2) + (rnd() - 0.5) * 0.3
      const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, h / 2, z)
      this.queue(`far${i % 4}`, new THREE.BoxGeometry(w, h, d), m)
      const roof = roofGeometry(w + 0.6, d + 0.6, Math.min(w, d) * 0.3, w >= d)
      const rm = new THREE.Matrix4().makeRotationY(rot).setPosition(x, h, z)
      this.queue('farRoof', roof.slopes, rm)
      this.queue(`far${i % 4}`, roof.gables, rm)
    }
    for (let i = 0; i < 46; i += 1) {
      const a = rnd() * Math.PI * 2
      const r = 72 + rnd() * 50
      const x = Math.cos(a) * r * 1.05
      const z = Math.sin(a) * r
      if (Math.abs(x) < this.HX + 4 && Math.abs(z) < this.HZ + 4) continue
      const h = 9 + rnd() * 7
      const g = new THREE.ConeGeometry(1.4 + rnd() * 0.6, h, 6)
      this.queue('cypress', g, new THREE.Matrix4().makeTranslation(x, h / 2, z))
    }
  }

  // ─── spawn barriers (buy phase) ────────────────────────────────────────
  private barrier(side: TeamSide, z: number): void {
    const w = this.HX * 2
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
    const ox = this.origin.x
    const oz = this.origin.z
    const nav = new NavGrid(this.HX * 2, this.HZ * 2, 1, -this.HX + ox, -this.HZ + oz)
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
        const x = -this.HX + cx + 0.5
        const z = -this.HZ + cz + 0.5
        const c = sample(x + ox, z + oz)
        let ok = c.h !== BLOCKED && c.h < 0.5 && c.ny > 0.8 && Math.abs(x) < this.HX - 1.2 && Math.abs(z) < this.HZ - 1.2
        if (ok) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
            const s = sample(x + ox + dx, z + oz + dz)
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

  /** Nearest walkable cell to a map-local point, in world space. */
  private snap(x: number, z: number): THREE.Vector3 {
    const wx = x + this.origin.x
    const wz = z + this.origin.z
    const i = this.nav.nearest(wx, wz, 6)
    const c = i >= 0 ? this.nav.center(i) : { x: wx, z: wz }
    return new THREE.Vector3(c.x, i >= 0 ? this.nav.heights[i] : 0, c.z)
  }

  private defineSpots(): void {
    const d = this.def
    const K = this.K
    const v = (x: number, z: number) => new THREE.Vector3(x * K + this.origin.x, 0, z * K + this.origin.z)
    for (const [x, z] of d.ffaSpawns) this.spawns.push(this.snap(x * K, z * K))
    for (let i = 0; i < 5; i += 1) {
      const x = (i - 2) * 3.2
      const zs = Math.sign(d.teamSpawnZ[0])
      this.teamSpawns.attack.push(this.snap(x, d.teamSpawnZ[0] * K + zs * (i % 2) * 2))
      this.teamSpawns.defend.push(this.snap(x, d.teamSpawnZ[1] * K - zs * (i % 2) * 2))
    }
    for (const [x, z] of d.hotspots) this.hotspots.push(this.snap(x * K, z * K))
    for (const [x, z, model] of d.barrels) this.props.push({ pos: v(x, z), model, rot: (x * 7.1 + z) % (Math.PI * 2) })
    for (const [x, z, kind] of d.pickups) this.pickups.push({ pos: v(x, z), kind })
  }

  /** Ground height below a point (used by FX pieces). */
  groundAt(x: number, z: number, fromY: number): number {
    const hit = this.physics.world.castRay(new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 12, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, c => this.tags.get(c.handle)?.kind === 'world')
    return hit ? fromY - hit.timeOfImpact : 0
  }

  update(time: number): void {
    this.time = time
    this.clouds.rotation.y = this.time * 0.0025
    const map = this.barrierMat.map
    if (map && this.barriers[0]?.mesh.visible) map.offset.y = -this.time * 0.25
  }
}

// ─── shading helpers ─────────────────────────────────────────────────────

/**
 * Contact shade: darkens a material toward the ground by world height (a fake ambient occlusion
 * that grounds walls, crates and trunks), plus a faint warm lift toward the top. One multiply in the
 * fragment shader; no extra pass or texture.
 */
function groundShade(m: THREE.MeshLambertMaterial, strength: number): void {
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      gl_FragColor.rgb *= mix(${(1 - strength).toFixed(3)}, 1.0, smoothstep(0.0, 2.4, vWorldY)) * (1.0 + 0.05 * smoothstep(4.0, 9.0, vWorldY));`)
  }
  m.customProgramCacheKey = () => `groundShade${strength}`
}

/** Gabled roof: two tiled slopes plus the two triangular gable ends (returned separately). */
function roofGeometry(w: number, d: number, rise: number, ridgeAlongX: boolean): { slopes: THREE.BufferGeometry; gables: THREE.BufferGeometry } {
  const L = ridgeAlongX ? w : d
  const S = ridgeAlongX ? d : w
  const hs = S / 2
  const hl = L / 2
  const slope = Math.hypot(hs, rise)
  // Built with the ridge along local X, then rotated if needed.
  const sp: number[] = []
  const su: number[] = []
  const quad = (a: number[], b: number[], c: number[], e: number[]) => {
    sp.push(...a, ...b, ...c, ...a, ...c, ...e)
    su.push(0, 0, L / 2.2, 0, L / 2.2, slope / 1.1, 0, 0, L / 2.2, slope / 1.1, 0, slope / 1.1)
  }
  quad([-hl, 0, hs], [hl, 0, hs], [hl, rise, 0], [-hl, rise, 0])
  quad([hl, 0, -hs], [-hl, 0, -hs], [-hl, rise, 0], [hl, rise, 0])
  const slopes = new THREE.BufferGeometry()
  slopes.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))
  slopes.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2))
  slopes.computeVertexNormals()
  const gp = [-hl, 0, -hs, -hl, 0, hs, -hl, rise, 0, hl, 0, hs, hl, 0, -hs, hl, rise, 0]
  const gables = new THREE.BufferGeometry()
  gables.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3))
  gables.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2))
  gables.computeVertexNormals()
  if (!ridgeAlongX) {
    slopes.rotateY(Math.PI / 2)
    gables.rotateY(Math.PI / 2)
  }
  return { slopes, gables }
}

// ─── canvas textures (tiny: they only add painted variation to flat colours) ───

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, color = true, h = size): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = size
  c.height = h
  draw(c.getContext('2d')!, size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (color) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function seeded(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

/** Hand-painted stucco: soft blotches and a few hairline cracks around white. */
function stuccoTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#f6f6f4'
    g.fillRect(0, 0, s, s)
    const r = seeded(11)
    for (let i = 0; i < 220; i += 1) {
      const v = 222 + Math.floor(r() * 33)
      g.fillStyle = `rgba(${v},${v - 2},${v - 8},0.45)`
      g.beginPath()
      g.arc(r() * s, r() * s, 6 + r() * 26, 0, Math.PI * 2)
      g.fill()
    }
    g.strokeStyle = 'rgba(150,130,110,0.25)'
    g.lineWidth = 1
    for (let i = 0; i < 6; i += 1) {
      let x = r() * s
      let y = r() * s
      g.beginPath()
      g.moveTo(x, y)
      for (let k = 0; k < 5; k += 1) {
        x += (r() - 0.5) * 30
        y += r() * 18
        g.lineTo(x, y)
      }
      g.stroke()
    }
  })
}

/** Square stone tiles with soft grout; `street` makes offset cobble rows. */
function tileTexture(street = false): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#d6d0c4'
    g.fillRect(0, 0, s, s)
    const r = seeded(street ? 5 : 3)
    const n = street ? 8 : 4
    const cell = s / n
    for (let y = 0; y < n; y += 1) {
      for (let x = -1; x < n; x += 1) {
        const v = 228 + Math.floor(r() * 24)
        g.fillStyle = `rgb(${v},${v - 3},${v - 9})`
        const off = street && y % 2 ? cell / 2 : 0
        const rw = street ? cell * (0.9 + r() * 0.2) : cell
        g.fillRect(x * cell + off + 2, y * cell + 2, rw - 4, cell - 4)
      }
    }
  })
}

/** Concentric-ring plaza paving. */
function plazaTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#efe9de'
    g.fillRect(0, 0, s, s)
    const r = seeded(9)
    for (let i = 0; i < 64; i += 1) {
      const x = (i % 8) * 32
      const y = Math.floor(i / 8) * 32
      const v = 226 + Math.floor(r() * 24)
      g.fillStyle = `rgb(${v},${v - 4},${v - 12})`
      g.fillRect(x + 2, y + 2, 28, 28)
    }
    g.strokeStyle = 'rgba(190,160,120,0.5)'
    g.lineWidth = 6
    g.strokeRect(10, 10, s - 20, s - 20)
  })
}

function grassTexture(): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#eef6e0'
    g.fillRect(0, 0, s, s)
    const r = seeded(21)
    for (let i = 0; i < 400; i += 1) {
      const v = 200 + Math.floor(r() * 55)
      g.fillStyle = `rgba(${v - 30},${v},${v - 60},0.6)`
      g.fillRect(r() * s, r() * s, 2, 4)
    }
  })
}

/** Rows of rounded clay tiles (multiplied by each roof colour). */
function roofTexture(): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#d8d2cc'
    g.fillRect(0, 0, s, s)
    const rows = 6
    const cols = 6
    const rh = s / rows
    const cw = s / cols
    for (let y = 0; y < rows; y += 1) {
      for (let x = -1; x <= cols; x += 1) {
        const off = y % 2 ? cw / 2 : 0
        const grad = g.createLinearGradient(0, y * rh, 0, (y + 1) * rh)
        grad.addColorStop(0, '#ffffff')
        grad.addColorStop(1, '#bdb5ad')
        g.fillStyle = grad
        g.beginPath()
        g.ellipse(x * cw + off + cw / 2, y * rh + rh * 0.55, cw * 0.46, rh * 0.55, 0, 0, Math.PI * 2)
        g.fill()
      }
    }
  })
}

/** Canvas stripes: colour and off-white. */
function awningTexture(color: string): THREE.CanvasTexture {
  return canvasTex(64, (g, s) => {
    for (let i = 0; i < 8; i += 1) {
      g.fillStyle = i % 2 ? '#f7f1e6' : color
      g.fillRect((i * s) / 8, 0, s / 8, s)
    }
    g.fillStyle = 'rgba(0,0,0,0.12)'
    g.fillRect(0, s * 0.82, s, s * 0.18)
  })
}

/** Window panes: sky reflection gradient with mullions. */
function windowTexture(): THREE.CanvasTexture {
  return canvasTex(64, (g, s) => {
    const grad = g.createLinearGradient(0, 0, s, s)
    grad.addColorStop(0, '#b9dcef')
    grad.addColorStop(0.45, '#6f98b6')
    grad.addColorStop(1, '#4d6f88')
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
    g.fillStyle = 'rgba(255,255,255,0.35)'
    g.beginPath()
    g.moveTo(s * 0.1, s)
    g.lineTo(s * 0.35, s)
    g.lineTo(s * 0.8, 0)
    g.lineTo(s * 0.55, 0)
    g.fill()
    g.fillStyle = '#f2ece2'
    g.fillRect(s / 2 - 2, 0, 4, s)
    g.fillRect(0, s / 2 - 2, s, 4)
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

function glowTexture(): THREE.CanvasTexture {
  const t = canvasTex(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    r.addColorStop(0, 'rgba(255,255,255,1)')
    r.addColorStop(0.12, 'rgba(255,250,235,0.95)')
    r.addColorStop(0.3, 'rgba(255,240,210,0.25)')
    r.addColorStop(1, 'rgba(255,240,210,0)')
    g.fillStyle = r
    g.fillRect(0, 0, s, s)
  })
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

/** Vertical sky gradient mapped equirectangularly (zenith → horizon haze → ground). */
function skyTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  for (const [at, color] of stops) grad.addColorStop(at, color)
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.mapping = THREE.EquirectangularReflectionMapping
  return t
}

/** Soft warm disc for lamp light pooled on the ground (night maps). */
function poolTexture(): THREE.CanvasTexture {
  const t = canvasTex(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    r.addColorStop(0, 'rgba(255,255,255,0.9)')
    r.addColorStop(0.45, 'rgba(255,255,255,0.35)')
    r.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = r
    g.fillRect(0, 0, s, s)
  })
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  return t
}
