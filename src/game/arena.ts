import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RAPIER, type Physics } from '../engine/physics'
import { worldBox, type Library } from './library'
import { BLOCKED, NavGrid } from './nav'
import { MAPS, type MapDef, type MapStyle, type PropKind } from './maps'

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
export type MapRect = { x0: number; x1: number; z0: number; z1: number; kind: 'building' | 'cover' | 'wall' | 'water' }
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
  /** Look and decor options of this map (roofs, trees, paving, landmark…). */
  private style: MapStyle = {}
  private accentCount = 1
  /**
   * Ground height added to everything queued (meshes and colliders) while placing an element on
   * a hillside map; 0 on flat maps and for the terrain itself.
   */
  private lift = 0
  /** Pole tops, in placement order, for stringing wires (favela). */
  private poleTops: THREE.Vector3[] = []
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
    const st: MapStyle = def.style ?? {}
    this.style = st
    const floorTex = { tile: tileTexture, sand: sandTexture, cobble: () => cobbleTexture(false), gravel: gravelTexture, concrete: asphaltTexture }[st.floorTex ?? 'tile']
    const streetTex = { tile: () => tileTexture(true), waves: wavesTexture, asphalt: asphaltTexture, cobble: () => cobbleTexture(true) }[st.streetTex ?? 'tile']
    lam('floor', L.floor, floorTex(), 0)
    lam('street', L.street, streetTex(), 0)
    lam('plaza', PALETTE.plaza, plazaTexture(), 0)
    lam('grass', L.grass, grassTexture(), 0)
    // Exposed brick on the first style when the map asks for it (unfinished houses).
    const brick = st.brick ? brickTexture() : stucco
    L.stucco.forEach((c, i) => lam(`stucco${i}`, c, i === 0 ? brick : stucco))
    L.trim.forEach((c, i) => lam(`trim${i}`, c))
    // Favela slabs are bare concrete, not clay tiles.
    const tiles = st.favela ? asphaltTexture() : roofTexture()
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
    ;(st.leaf ?? PALETTE.leaf).forEach((c, i) => {
      const m = lam(`leaf${i}`, c, undefined, 0.45)
      ;(m as THREE.MeshLambertMaterial).flatShading = true
    })
    PALETTE.bloom.forEach((c, i) => lam(`bloom${i}`, c, undefined, 0))
    // Prop accents (torii vermilion, parasols, stall awnings, taxi yellow…).
    const accents = st.accent ?? ['#d2382b']
    this.accentCount = accents.length
    accents.forEach((c, i) => {
      const m = lam(`accent${i}`, c, undefined, 0.2)
      m.side = THREE.DoubleSide
    })
    lam('dark', '#26282c', undefined, 0)
    lam('red', '#c8392b', undefined, 0)
    lam('rock', '#6f7d6c', undefined, 0)
    ;(this.mats.rock as THREE.MeshLambertMaterial).flatShading = true
    lam('brick', '#b4623f', undefined, 0)
    lam('verdigris', '#7fa38c', undefined, 0)
    lam('gold', '#e0b450', undefined, 0)
    lam('white', '#f4f1ea', undefined, 0)
    this.mats.sea = new THREE.MeshLambertMaterial({ color: '#2a8fb8', emissive: '#0f4f6a', emissiveIntensity: 0.45 })
    const tower = new THREE.MeshLambertMaterial({ color: L.night ? '#1c2030' : '#9aa2ae', map: towerTexture(L.night) })
    if (L.night) {
      tower.emissive.set('#ffffff')
      tower.emissiveMap = tower.map
      tower.emissiveIntensity = 0.9
    }
    this.mats.tower = tower
    lam('retain', '#a39d93', stucco)
    lam('hill', L.grass, grassTexture(), 0)
    this.mats.water = new THREE.MeshLambertMaterial({ color: st.water ?? PALETTE.water, map: rippleTexture(), emissive: st.water ?? '#1d5e6e', emissiveIntensity: 0.25 })
    this.mats.lampGlow = new THREE.MeshBasicMaterial({ color: L.night ? '#ffe2a0' : '#fff1c8' })
    this.mats.lampPool = new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#ffb768', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
    PALETTE.backdrop.forEach((c, i) => (this.mats[`far${i}`] = new THREE.MeshLambertMaterial({ color: c })))
    this.mats.farRoof = new THREE.MeshLambertMaterial({ color: '#c27053' })
    this.mats.cypress = new THREE.MeshLambertMaterial({ color: '#4f7a3f', flatShading: true })
    this.mats.paint = new THREE.MeshBasicMaterial({ map: sitePaintTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    // Contact shadow skirts (fake ambient occlusion where walls and props meet the ground).
    this.mats.ao = new THREE.MeshBasicMaterial({ map: aoTexture(), color: L.night ? '#04060c' : '#1e140d', transparent: true, opacity: L.night ? 0.8 : 0.78, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    for (const k of ['sea', 'tower', 'rock', 'ao', 'lampPool', 'window', 'frame', 'paint', 'lampGlow', 'water', 'far0', 'far1', 'far2', 'far3', 'farRoof', 'cypress', 'grass', 'bloom0', 'bloom1', 'bloom2', 'bloom3']) this.noShadow.add(k)
    this.barrierMat = new THREE.MeshBasicMaterial({ map: barrierTexture(), color: new THREE.Color(0.35, 1.6, 1.4), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    this.buildSky()
    this.buildLighting()
    this.buildGround()
    this.buildPerimeter()
    if (def.terrain) this.buildTerrain()
    const K = this.K
    // Each element sits on the terrain under it (hillside maps); `lift` is 0 on flat maps.
    const on = (x: number, z: number, place: () => void) => {
      this.lift = this.groundY(x, z)
      place()
      this.lift = 0
    }
    def.buildings.forEach(([x0, x1, z0, z1, h, style], i) => on(((x0 + x1) / 2) * K, ((z0 + z1) / 2) * K, () => this.building(x0 * K, x1 * K, z0 * K, z1 * K, h, style, i)))
    for (const [x, z, w, d, h, kind] of def.cover) on(x * K, z * K, () => this.cover(x * K, z * K, w, d, h, kind))
    for (const [x, z, s] of def.trees) on(x * K, z * K, () => this.tree(x * K, z * K, s))
    for (const [x, z] of def.lamps) on(x * K, z * K, () => this.lamp(x * K, z * K))
    for (const r of def.water ?? []) this.canal(r[0] * K, r[1] * K, r[2] * K, r[3] * K)
    for (const [x, z, kind, rot] of def.props ?? []) on(x * K, z * K, () => this.prop(kind, x * K, z * K, rot ?? 0))
    this.stringWires()
    if (def.sites) this.buildSites()
    this.buildBackdrop()
    this.buildLandmark()
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
    const m = this.lift ? new THREE.Matrix4().makeTranslation(0, this.lift, 0).multiply(matrix) : matrix
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m)
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
      mesh.receiveShadow = key !== 'paint' && key !== 'ao'
      mesh.matrixAutoUpdate = false
      if (key === 'paint') mesh.renderOrder = 2
      if (key === 'ao') mesh.renderOrder = 1
      this.group.add(mesh)
    }
    this.pending.clear()
  }

  /**
   * Soft contact shadow on the ground along an edge from (ax, az) to (bx, bz); (nx, nz) points away
   * from the obstacle. The gradient runs from dark at the base to clear `width` metres out.
   */
  private aoStrip(ax: number, az: number, bx: number, bz: number, nx: number, nz: number, width: number): void {
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 0.05) return
    const inset = 0.12
    const g = new THREE.BufferGeometry()
    const p = (x: number, z: number, k: number) => [x + nx * k, 0.012, z + nz * k]
    g.setAttribute('position', new THREE.Float32BufferAttribute([...p(ax, az, -inset), ...p(bx, bz, -inset), ...p(bx, bz, width), ...p(ax, az, width)], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
    this.queue('ao', g, new THREE.Matrix4())
  }

  /** Contact shadow all around an axis-aligned footprint. */
  private aoFootprint(x0: number, x1: number, z0: number, z1: number, width: number): void {
    this.aoStrip(x0, z0, x1, z0, 0, -1, width)
    this.aoStrip(x0, z1, x1, z1, 0, 1, width)
    this.aoStrip(x0, z0, x0, z1, -1, 0, width)
    this.aoStrip(x1, z0, x1, z1, 1, 0, width)
  }

  /** Solid box (bottom at y0) with a matching collider. */
  private box(mat: string, cx: number, y0: number, cz: number, w: number, h: number, d: number, opts: { tile?: number; collide?: boolean; surface?: Surface; rotY?: number } = {}): void {
    const geo = worldBox(w, h, d, opts.tile ?? 4)
    const m = new THREE.Matrix4().makeRotationY(opts.rotY ?? 0).setPosition(cx, y0 + h / 2, cz)
    this.queue(mat, geo, m)
    if (opts.collide !== false) this.collider(cx, y0 + h / 2, cz, w, h, d, opts.surface ?? 'concrete')
  }

  private collider(cx: number, cy: number, cz: number, w: number, h: number, d: number, surface: Surface): RAPIER.Collider {
    const c = this.physics.addStaticBox(new THREE.Vector3(cx + this.origin.x, cy + this.lift, cz + this.origin.z), new THREE.Vector3(w, h, d))
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
        // Keep the view toward the sea open on maps that look north over the city.
        if (this.style.viewNorth && Math.sin((i / segs) * Math.PI * 2) > -0.25) continue
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
    if (this.def.terrain) this.buildHillside()
    else for (const [x0, x1, z0, z1] of [[-400, 400, -400, -this.HZ], [-400, 400, this.HZ, 400], [-400, -this.HX, -this.HZ, this.HZ], [this.HX, 400, -this.HZ, this.HZ]]) {
      const sea = this.style.sea && z1 <= -this.HZ
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0)
      g.rotateX(-Math.PI / 2)
      this.queue(sea ? 'sea' : 'grass', g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, sea ? -0.4 : -0.05, (z0 + z1) / 2))
      // A strip of sand between the sea wall and the water.
      if (sea) this.flat('floor', -400, 400, -this.HZ - 7, -this.HZ - 1, -0.02, 4)
    }
    this.collider(0, -0.5, 0, this.HX * 2 + 6, 1, this.HZ * 2 + 6, 'concrete')
  }

  /** Town wall: stucco with pilasters, a cap and a terracotta coping. */
  private buildPerimeter(): void {
    const h = 9
    const t = 2
    if (this.def.perimeter === 'invisible') {
      // Hillside: the houses outside are the edge; tall invisible walls keep players in.
      const H = 60
      this.collider(0, H / 2, -this.HZ - t / 2, this.HX * 2 + 2 * t, H, t, 'concrete')
      this.collider(0, H / 2, this.HZ + t / 2, this.HX * 2 + 2 * t, H, t, 'concrete')
      this.collider(-this.HX - t / 2, H / 2, 0, t, H, this.HZ * 2, 'concrete')
      this.collider(this.HX + t / 2, H / 2, 0, t, H, this.HZ * 2, 'concrete')
      return
    }
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
    // Contact shadow along the inner faces of the town wall.
    this.aoStrip(-this.HX, -this.HZ + 1, this.HX, -this.HZ + 1, 0, 1, 2.8)
    this.aoStrip(-this.HX, this.HZ - 1, this.HX, this.HZ - 1, 0, -1, 2.8)
    this.aoStrip(-this.HX + 1, -this.HZ, -this.HX + 1, this.HZ, 1, 0, 2.8)
    this.aoStrip(this.HX - 1, -this.HZ, this.HX - 1, this.HZ, -1, 0, 2.8)
    if (this.style.sea) {
      // Sea side: a low promenade wall you can look over (an invisible wall keeps players in).
      const cz = -this.HZ - t / 2 + 1
      this.box('perimeter', 0, 0, cz, this.HX * 2 + 2 * t, 1.1, t, { tile: 6, collide: false })
      this.box('white', 0, 1.1, cz, this.HX * 2 + 2 * t + 0.3, 0.18, t + 0.3, { collide: false, tile: 2 })
      this.collider(0, h / 2, cz, this.HX * 2 + 2 * t, h, t, 'concrete')
    } else wall(0, -this.HZ - t / 2 + 1, this.HX * 2 + 2 * t, t)
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
    if (this.style.favela) {
      this.lajeRoof(cx, cz, w, d, h, style, index)
    } else if (this.style.roof === 'flat') {
      // Flat roof: slab, parapet and a few rooftop units (water tanks, AC boxes).
      this.box(`roof${(style + index) % 3}`, cx, h - 0.05, cz, w - 0.2, 0.2, d - 0.2, { collide: false, tile: 3 })
      this.box(`stucco${style}`, cx, h, cz - d / 2 + 0.15, w + 0.3, 0.9, 0.3, { collide: false, tile: 4 })
      this.box(`stucco${style}`, cx, h, cz + d / 2 - 0.15, w + 0.3, 0.9, 0.3, { collide: false, tile: 4 })
      this.box(`stucco${style}`, cx - w / 2 + 0.15, h, cz, 0.3, 0.9, d, { collide: false, tile: 4 })
      this.box(`stucco${style}`, cx + w / 2 - 0.15, h, cz, 0.3, 0.9, d, { collide: false, tile: 4 })
      if (w * d > 120) {
        this.box('metal', cx + w * 0.2, h, cz - d * 0.15, 2.2, 1.4, 1.6, { collide: false, tile: 2 })
        this.box('metal', cx - w * 0.22, h, cz + d * 0.18, 1.4, 1, 1.4, { collide: false, tile: 2 })
      }
    } else {
      // Pitched roof, ridge along the long side.
      const roof = roofGeometry(w + 1, d + 1, Math.min(4, Math.min(w, d) * 0.3), w >= d)
      const rm = new THREE.Matrix4().makeTranslation(cx, h, cz)
      this.queue(`roof${(style + index) % 3}`, roof.slopes, rm)
      this.queue(`stucco${style}`, roof.gables, rm)
      // Chimney on bigger blocks.
      if (w * d > 200) this.box('base', cx + w * 0.22, h, cz - d * 0.18, 1, 3.2, 1, { collide: false, tile: 2 })
    }
    // Upper floors: one row of windows per storey on tall blocks, a single row on houses.
    const rows: number[] = []
    if (h < 10) rows.push(h * 0.5 + 1.6)
    else for (let y = 5.1; y + 1.1 < h - 0.6; y += 3.2) rows.push(y)
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
        // Upper floor windows always; ground floor gets a door or a window.
        for (const y of rows) this.facade(f.along, f.at, t, y, 1.3, 1.7, f.normal, false, style, i)
        if (door) this.facade(f.along, f.at, t, 1.35, 1.6, 2.7, f.normal, true, style, i)
        else if (i % 2 === 0) this.facade(f.along, f.at, t, 1.9, 1.3, 1.5, f.normal, false, style, i + 1)
      }
    }
    this.aoFootprint(x0, x1, z0, z1, 2.3)
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
    if (this.style.windows === 'modern') return
    // Shutters in the trim colour.
    for (const sx of [-1, 1]) put(`trim${(style + 1) % this.def.look.trim.length}`, worldBox(w * 0.48, h + 0.1, 0.06, 2), sx * (w / 2 + w * 0.26 + 0.12), 0, 0.07)
    if ((i + style) % 3 === 0) {
      put('crate', worldBox(w + 0.2, 0.28, 0.32, 1), 0, -h / 2 - 0.2, 0.22)
      for (let b = 0; b < 4; b += 1) put(`bloom${(b + i) % 4}`, new THREE.IcosahedronGeometry(0.13, 0), -w / 2 + 0.2 + b * ((w - 0.4) / 3), -h / 2 - 0.02, 0.24)
    }
  }

  /** Cover piece: crates (planks), stone planters with shrubs, metal generators, the Mid fountain. */
  private cover(x: number, z: number, w: number, d: number, h: number, kind: number): void {
    if (h > 0.4) this.aoFootprint(x - w / 2, x + w / 2, z - d / 2, z + d / 2, Math.min(1.5, 0.5 + h * 0.4))
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
    if (this.style.tree === 'palm') return this.palm(x, z, s)
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

  // ─── hillside terrain ──────────────────────────────────────────────────
  /** Terrace height at a map-local point (0 on flat maps and on the street). */
  private groundY(x: number, z: number): number {
    let y = 0
    const K = this.K
    for (const [x0, x1, z0, z1, h] of this.def.terrain?.levels ?? []) if (x >= x0 * K && x <= x1 * K && z >= z0 * K && z <= z1 * K) y = Math.max(y, h)
    return y
  }

  /** Terraces with retaining walls, stair alleys and ramps. */
  private buildTerrain(): void {
    const T = this.def.terrain!
    const K = this.K
    for (const [x0, x1, z0, z1, y] of T.levels) {
      const X0 = x0 * K, X1 = x1 * K, Z0 = z0 * K, Z1 = z1 * K
      const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2, w = X1 - X0, d = Z1 - Z0
      this.box('retain', cx, 0, cz, w, y, d, { tile: 3 })
      this.flat('floor', X0, X1, Z0, Z1, y + 0.01, 4)
      // Concrete lip on the front edge and a contact shade at the foot of the wall.
      this.box('base', cx, y - 0.2, Z1 - 0.16, w, 0.32, 0.32, { collide: false, tile: 2 })
      this.lift = this.groundY(cx, Z1 + 0.5)
      if (this.lift < y) this.aoStrip(X0, Z1, X1, Z1, 0, 1, 1.6)
      this.lift = 0
    }
    // Stair flights climb toward −z; the bottom step is the longest (steps the controller can take).
    for (const [x0, x1, ez, lo, hi] of T.stairs ?? []) {
      const n = Math.max(2, Math.ceil((hi - lo) / 0.32))
      const sh = (hi - lo) / n
      const dep = 0.45
      const w = (x1 - x0) * K
      const cx = ((x0 + x1) / 2) * K
      const z = ez * K
      for (let i = 0; i < n; i += 1) {
        const len = (n - i) * dep
        this.box('retain', cx, lo, z + len / 2, w, sh * (i + 1), len, { tile: 1 })
        // Worn edge on each tread.
        this.box('base', cx, lo + sh * (i + 1) - 0.04, z + len - 0.06, w, 0.06, 0.12, { collide: false, tile: 1 })
      }
      // A rusty handrail on one side.
      this.box('dark', x0 * K + 0.12, lo + 0.9, z + (n * dep) / 2, 0.06, 0.06, n * dep + 0.4, { collide: false, tile: 1 })
    }
    for (const [x0, x1, ez, lo, hi] of T.ramps ?? []) this.ramp(x0 * K, x1 * K, ez * K, lo, hi)
  }

  /** Solid concrete ramp (≈20°) from `lo` at the +z end up to `hi` at the terrace edge `ez`. */
  private ramp(x0: number, x1: number, ez: number, lo: number, hi: number): void {
    const rise = hi - lo
    const run = rise / Math.tan((20 * Math.PI) / 180)
    const zl = ez + run
    const top = new THREE.BufferGeometry()
    top.setAttribute('position', new THREE.Float32BufferAttribute([x0, lo, zl, x1, lo, zl, x1, hi, ez, x0, lo, zl, x1, hi, ez, x0, hi, ez], 3))
    top.setAttribute('uv', new THREE.Float32BufferAttribute([x0 / 4, zl / 4, x1 / 4, zl / 4, x1 / 4, ez / 4, x0 / 4, zl / 4, x1 / 4, ez / 4, x0 / 4, ez / 4], 2))
    top.computeVertexNormals()
    this.queue('floor', top, new THREE.Matrix4())
    const sides = new THREE.BufferGeometry()
    sides.setAttribute('position', new THREE.Float32BufferAttribute([x0, lo, zl, x0, hi, ez, x0, lo, ez, x1, lo, zl, x1, lo, ez, x1, hi, ez], 3))
    sides.setAttribute('uv', new THREE.Float32BufferAttribute([zl / 3, lo / 3, ez / 3, hi / 3, ez / 3, lo / 3, zl / 3, lo / 3, ez / 3, lo / 3, ez / 3, hi / 3], 2))
    sides.computeVertexNormals()
    this.queue('retain', sides, new THREE.Matrix4())
    // Collider: a thick slab under the slope.
    const a = Math.atan2(rise, run)
    const L = Math.hypot(rise, run)
    const t = 0.6
    const n = new THREE.Vector3(0, Math.cos(a), Math.sin(a))
    const c = new THREE.Vector3((x0 + x1) / 2, lo + rise / 2, ez + run / 2).addScaledVector(n, -t / 2).add(this.origin)
    const col = this.physics.addStaticBox(c, new THREE.Vector3(x1 - x0, t, L), new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)))
    this.tags.set(col.handle, { kind: 'world', surface: 'concrete' })
  }

  /** Hillside height outside the playable area: rises uphill (south) and to the sides, falls toward the city. */
  private hillY(x: number, z: number): number {
    let y = z > 20 ? -Math.max(0, z - this.HZ) * 0.06 : Math.min(9.6, (20 - z) * 0.137)
    if (z < -this.HZ) y += (-this.HZ - z) * 0.32
    return Math.max(-12, y + Math.max(0, Math.abs(x) - this.HX) * 0.18)
  }

  /** Green hillside around the map (sunk out of sight inside the walls). */
  private buildHillside(): void {
    const N = 80
    const S = 640
    const g = new THREE.PlaneGeometry(S, S, N, N)
    g.rotateX(-Math.PI / 2)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const inside = Math.abs(x) < this.HX + 1 && Math.abs(z) < this.HZ + 1
      pos.setY(i, inside ? -0.3 : this.hillY(x, z) - 0.4)
      uv.setXY(i, x / 6, z / 6)
    }
    g.computeVertexNormals()
    this.queue('hill', g, new THREE.Matrix4())
  }

  /** The favela keeps going outside the walls; below to the north, the city and the sea. */
  private buildFavelaBackdrop(): void {
    let s = 913
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const nStucco = this.def.look.stucco.length
    for (let i = 0; i < 900; i += 1) {
      const x = (rnd() - 0.5) * 300
      const z = -210 + rnd() * 262
      const out = Math.abs(x) > this.HX + 3 || z < -this.HZ - 3
      if (!out || (Math.abs(x) < this.HX + 3 && z > -this.HZ)) continue
      const dist = Math.max(Math.abs(x) - this.HX, -this.HZ - z, 0)
      if (rnd() < dist / 160) continue
      const w = 3.5 + rnd() * 4
      const d = 3.5 + rnd() * 4
      const h = 3 + Math.floor(rnd() * 3) * 2.8 + rnd()
      const base = this.hillY(x, z)
      const style = rnd() < 0.45 ? 0 : 1 + Math.floor(rnd() * (nStucco - 1))
      const rot = (rnd() - 0.5) * 0.25
      const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, base - 3 + (h + 3) / 2, z)
      this.queue(`stucco${style}`, worldBox(w, h + 3, d, 5), m)
      this.queue(`roof${i % 3}`, worldBox(w + 0.2, 0.22, d + 0.2, 3), new THREE.Matrix4().makeRotationY(rot).setPosition(x, base + h + 0.1, z))
      if (rnd() < 0.35) this.queue('accent0', new THREE.CylinderGeometry(0.5, 0.5, 0.8, 8), new THREE.Matrix4().makeTranslation(x + w * 0.2, base + h + 0.6, z - d * 0.2))
      // A few lit-window specks on the street-facing side.
      if (rnd() < 0.6) this.queue('window', worldBox(0.9, 1.1, 0.06, 1), new THREE.Matrix4().makeRotationY(rot).setPosition(x - w * 0.15, base + h * 0.55, z + d / 2 + 0.02))
    }
    // The city below: low blocks, then towers along the beach, then the sea.
    for (let i = 0; i < 260; i += 1) {
      const x = (rnd() - 0.5) * 520
      const z = 75 + rnd() * 130
      const base = this.hillY(x, z)
      const beach = z > 175
      const w = 8 + rnd() * 14
      const d = 8 + rnd() * 14
      const h = beach ? 18 + rnd() * 30 : 5 + rnd() * 16
      this.queue(beach || rnd() < 0.5 ? 'tower' : `far${i % 4}`, worldBox(w, h + 4, d, 12), new THREE.Matrix4().setPosition(x, base - 4 + (h + 4) / 2, z))
    }
    const sea = new THREE.PlaneGeometry(1400, 700)
    sea.rotateX(-Math.PI / 2)
    this.queue('sea', sea, new THREE.Matrix4().makeTranslation(0, -12.2, 205 + 350))
  }

  /** Slab roof of an unfinished house: water tank, rebar at the corners, a dish, sometimes an extra room. */
  private lajeRoof(cx: number, cz: number, w: number, d: number, h: number, style: number, index: number): void {
    this.box(`roof${(style + index) % 3}`, cx, h - 0.06, cz, w + 0.3, 0.26, d + 0.3, { collide: false, tile: 3 })
    const r = () => this.rand()
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (r() < 0.35) continue
      for (let k = 0; k < 2; k += 1) this.box('dark', cx + sx * (w / 2 - 0.15 - k * 0.12), h + 0.2, cz + sz * (d / 2 - 0.15), 0.035, 0.5 + r() * 0.8, 0.035, { collide: false, tile: 1 })
    }
    const tx = cx + (r() - 0.5) * w * 0.5
    const tz = cz + (r() - 0.5) * d * 0.5
    this.queue('accent0', new THREE.CylinderGeometry(0.55, 0.55, 0.95, 10), new THREE.Matrix4().makeTranslation(tx, h + 0.68, tz))
    this.queue('accent0', new THREE.CylinderGeometry(0.6, 0.6, 0.08, 10), new THREE.Matrix4().makeTranslation(tx, h + 1.19, tz))
    if (r() < 0.45) {
      const dish = new THREE.SphereGeometry(0.42, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.8)
      const m = new THREE.Matrix4().compose(new THREE.Vector3(cx - w * 0.3, h + 0.9, cz + d * 0.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(-2.2, 0.4, 0)), new THREE.Vector3(1, 1, 1))
      this.queue('white', dish, m)
      this.box('metal', cx - w * 0.3, h + 0.13, cz + d * 0.3, 0.06, 0.7, 0.06, { collide: false, tile: 1 })
    }
    if (w * d > 34 && r() < 0.5) {
      // "Puxadinho": a smaller room built on the slab later.
      const ew = w * 0.5
      const ed = d * 0.55
      const ex = cx + (r() < 0.5 ? -1 : 1) * (w - ew) / 2
      const ez = cz + (r() < 0.5 ? -1 : 1) * (d - ed) / 2
      this.box(r() < 0.6 ? 'stucco0' : `stucco${style}`, ex, h + 0.2, ez, ew, 2.6, ed, { tile: 5 })
      this.box(`roof${index % 3}`, ex, h + 2.74, ez, ew + 0.3, 0.22, ed + 0.3, { collide: false, tile: 3 })
    }
  }

  /** Wires sagging between consecutive utility poles (a tangle of three per span). */
  private stringWires(): void {
    const tops = this.poleTops
    const seg = new THREE.BoxGeometry(0.03, 0.03, 1)
    const span = (a: THREE.Vector3, b: THREE.Vector3, off: number, sagK: number) => {
      const dist = a.distanceTo(b)
      const side = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(off)
      const sag = dist * sagK
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 6; i += 1) {
        const t = i / 6
        pts.push(a.clone().lerp(b, t).add(side).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)))
      }
      for (let i = 0; i < 6; i += 1) {
        const p = pts[i]
        const q = pts[i + 1]
        const m = new THREE.Matrix4().lookAt(p, q, new THREE.Vector3(0, 1, 0))
        m.scale(new THREE.Vector3(1, 1, p.distanceTo(q)))
        m.setPosition(p.clone().add(q).multiplyScalar(0.5))
        this.queue('dark', seg, m)
      }
    }
    for (let i = 0; i < tops.length; i += 1) {
      for (const j of [i + 1, i + 2]) {
        const a = tops[i]
        const b = tops[j]
        if (!b || a.distanceTo(b) > 30 || (j === i + 2 && this.rand() < 0.5)) continue
        for (const [off, k] of [[-0.6, 0.035], [0, 0.05], [0.6, 0.042]] as const) span(a, b, off, k)
      }
    }
  }

  /** Palm: a gently curving segmented trunk and a crown of drooping fronds. */
  private palm(x: number, z: number, s: number): void {
    const H = 7.5 * s
    const lean = (this.rand() - 0.5) * 0.5
    const dir = this.rand() * Math.PI * 2
    const segs = 5
    let px = x
    let pz = z
    let y = 0
    for (let i = 0; i < segs; i += 1) {
      const h = H / segs
      const k = (i + 1) / segs
      const nx = x + Math.cos(dir) * lean * k * k * 4
      const nz = z + Math.sin(dir) * lean * k * k * 4
      const g = new THREE.CylinderGeometry(0.17 * s * (1 - k * 0.25), 0.22 * s * (1 - (k - 0.2) * 0.25), h * 1.04, 6)
      const mid = new THREE.Vector3((px + nx) / 2, y + h / 2, (pz + nz) / 2)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx - px, h, nz - pz).normalize())
      this.queue('trunk', g, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)))
      px = nx
      pz = nz
      y += h
    }
    this.collider(x, 1.5, z, 0.45 * s, 3, 0.45 * s, 'wood')
    for (let f = 0; f < 8; f += 1) {
      const a = (f / 8) * Math.PI * 2 + this.rand() * 0.3
      const len = (2.6 + this.rand() * 0.8) * s
      const g = new THREE.BoxGeometry(len, 0.06, 0.55 * s)
      g.translate(len / 2, 0, 0)
      const m = new THREE.Matrix4().compose(new THREE.Vector3(px, y, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, -0.35 - this.rand() * 0.25, 'YXZ')), new THREE.Vector3(1, 1, 1))
      this.queue(`leaf${f % 2}`, g, m)
    }
    this.minimap.push({ x0: x - 0.4, x1: x + 0.4, z0: z - 0.4, z1: z + 0.4, kind: 'cover' })
  }

  /** Canal or pool: sunken-looking water between stone curbs; an invisible low wall keeps players out. */
  private canal(x0: number, x1: number, z0: number, z1: number): void {
    const w = x1 - x0
    const d = z1 - z0
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    const g = new THREE.PlaneGeometry(w, d)
    g.rotateX(-Math.PI / 2)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * w) / 4, (uv.getY(i) * d) / 4)
    this.queue('water', g, new THREE.Matrix4().makeTranslation(cx, 0.05, cz))
    const c = 0.35
    this.box('stone', cx, 0, z0 + c / 2, w, 0.32, c, { collide: false, tile: 2 })
    this.box('stone', cx, 0, z1 - c / 2, w, 0.32, c, { collide: false, tile: 2 })
    // End curbs frame the bridges (skipped where the canal runs into the town wall).
    if (Math.abs(x0 + this.HX) > 1) this.box('stone', x0 + c / 2, 0, cz, c, 0.32, d, { collide: false, tile: 2 })
    if (Math.abs(x1 - this.HX) > 1) this.box('stone', x1 - c / 2, 0, cz, c, 0.32, d, { collide: false, tile: 2 })
    this.collider(cx, 0.35, cz, w, 0.7, d, 'concrete')
    this.minimap.push({ x0, x1, z0, z1, kind: 'water' })
  }

  /** Map props: parasols, torii gates, stone lanterns, market stalls, taxis, gondolas, benches, hydrants. */
  private prop(kind: PropKind, x: number, z: number, rot: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
    const at = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(x, 0, z))
    /** Box in prop-local coordinates (bottom at ly). */
    const part = (mat: string, lx: number, ly: number, lz: number, w: number, h: number, d: number, collide = false) => {
      const p = at(lx, ly + h / 2, lz)
      this.queue(mat, worldBox(w, h, d, 1), new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)))
      if (collide) {
        // Colliders are axis-aligned: use the rotated footprint's bounds.
        const c = Math.abs(Math.cos(rot))
        const sn = Math.abs(Math.sin(rot))
        this.collider(p.x, p.y, p.z, w * c + d * sn, h, w * sn + d * c, mat === 'crate' ? 'wood' : 'metal')
      }
    }
    const accent = (i: number) => `accent${i % this.accentCount}`
    const n = Math.abs(Math.round(x * 3.1 + z * 1.7))
    switch (kind) {
      case 'parasol': {
        part('metal', 0, 0, 0, 0.08, 2.4, 0.08, true)
        const cone = new THREE.ConeGeometry(1.5, 0.55, 10, 1, true)
        this.queue(accent(n), cone, new THREE.Matrix4().makeTranslation(x, 2.55, z))
        part('white', 0.9, 0, 0.3, 1.8, 0.35, 0.7)
        return
      }
      case 'torii': {
        for (const sx of [-2.6, 2.6]) {
          const post = new THREE.CylinderGeometry(0.26, 0.3, 5, 10)
          const p = at(sx, 2.5, 0)
          this.queue(accent(0), post, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z))
          this.collider(p.x, 2.5, p.z, 0.6, 5, 0.6, 'wood')
          part('dark', sx, 0, 0, 0.75, 0.45, 0.75)
        }
        part(accent(0), 0, 4.1, 0, 6.4, 0.34, 0.34)
        part(accent(0), 0, 4.95, 0, 7.4, 0.4, 0.55)
        part('dark', 0, 5.35, 0, 8, 0.28, 0.7)
        this.minimap.push({ x0: x - 0.4, x1: x + 0.4, z0: z - 0.4, z1: z + 0.4, kind: 'cover' })
        return
      }
      case 'lantern': {
        part('stone', 0, 0, 0, 0.75, 0.25, 0.75, true)
        part('stone', 0, 0.25, 0, 0.32, 0.75, 0.32, true)
        part('stone', 0, 1.0, 0, 0.62, 0.48, 0.62)
        part('lampGlow', 0, 1.1, 0, 0.36, 0.28, 0.66)
        part('stone', 0, 1.48, 0, 0.95, 0.16, 0.95)
        part('stone', 0, 1.64, 0, 0.3, 0.22, 0.3)
        this.aoFootprint(x - 0.4, x + 0.4, z - 0.4, z + 0.4, 0.6)
        return
      }
      case 'stall': {
        part('crate', 0, 0, 0, 2.6, 1.0, 1.0, true)
        for (const [sx, sz] of [[-1.3, -0.6], [1.3, -0.6], [-1.3, 1.1], [1.3, 1.1]]) part('metal', sx, 0, sz, 0.08, 2.4, 0.08)
        const aw = new THREE.PlaneGeometry(3.0, 2.2)
        const m = new THREE.Matrix4().compose(at(0, 2.35, 0.25), q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.18, 0, 0))), new THREE.Vector3(1, 1, 1))
        this.queue(accent(n), aw, m)
        for (let i = 0; i < 5; i += 1) part(`bloom${(i + n) % 4}`, -1.0 + i * 0.5, 1.0, 0, 0.36, 0.3, 0.5)
        this.aoFootprint(x - 1.4, x + 1.4, z - 0.7, z + 0.7, 0.8)
        this.minimap.push({ x0: x - 1.3, x1: x + 1.3, z0: z - 0.6, z1: z + 0.6, kind: 'cover' })
        return
      }
      case 'taxi': {
        part(accent(0), 0, 0.28, 0, 1.9, 0.78, 4.5, true)
        part('window', 0, 1.06, -0.2, 1.7, 0.62, 2.3, true)
        part(accent(0), 0, 1.68, -0.2, 1.72, 0.06, 2.32)
        part('white', 0, 1.74, -0.2, 0.6, 0.22, 0.3)
        for (const [sx, sz] of [[-0.86, -1.45], [0.86, -1.45], [-0.86, 1.45], [0.86, 1.45]]) part('dark', sx, 0, sz, 0.3, 0.62, 0.66)
        part('lampGlow', 0, 0.62, 2.26, 1.5, 0.16, 0.04)
        this.aoFootprint(x - 1.3, x + 1.3, z - 1.3, z + 1.3, 0.9)
        this.minimap.push({ x0: x - 1, x1: x + 1, z0: z - 1, z1: z + 1, kind: 'cover' })
        return
      }
      case 'gondola': {
        part('dark', 0, 0.05, 0, 5.6, 0.42, 1.0)
        part('dark', 3.0, 0.2, 0, 0.6, 0.9, 0.5)
        part('dark', -3.0, 0.2, 0, 0.6, 1.3, 0.3)
        part('gold', -3.05, 1.3, 0, 0.2, 0.5, 0.36)
        part('red', 0.4, 0.45, 0, 1.6, 0.12, 0.8)
        return
      }
      case 'bench': {
        part('crate', 0, 0.42, 0, 2.0, 0.1, 0.5, true)
        part('crate', 0, 0.6, -0.22, 2.0, 0.42, 0.08)
        for (const sx of [-0.85, 0.85]) part('metal', sx, 0, 0, 0.1, 0.42, 0.44)
        return
      }
      case 'pole': {
        const post = new THREE.CylinderGeometry(0.13, 0.2, 8, 8)
        this.queue('stone', post, new THREE.Matrix4().makeTranslation(x, 4, z))
        this.collider(x, 4, z, 0.4, 8, 0.4, 'concrete')
        part('dark', 0, 7.3, 0, 1.6, 0.12, 0.12)
        part('dark', 0.25, 5.8, 0, 0.45, 0.75, 0.45)
        this.poleTops.push(new THREE.Vector3(x, this.lift + 7.42, z))
        this.minimap.push({ x0: x - 0.3, x1: x + 0.3, z0: z - 0.3, z1: z + 0.3, kind: 'cover' })
        return
      }
      case 'clothesline': {
        for (const sx of [-1.7, 1.7]) part('metal', sx, 0, 0, 0.06, 1.9, 0.06)
        part('white', 0, 1.86, 0, 3.4, 0.02, 0.02)
        for (let i = 0; i < 5; i += 1) {
          const cloth = new THREE.PlaneGeometry(0.5, 0.65 + (i % 2) * 0.2)
          const m = new THREE.Matrix4().compose(at(-1.2 + i * 0.6, 1.5 - (i % 2) * 0.1, 0), q, new THREE.Vector3(1, 1, 1))
          this.queue(accent(n + i), cloth, m)
        }
        return
      }
      case 'moto': {
        part(accent(n), 0, 0.32, 0, 0.32, 0.42, 1.25, true)
        part('dark', 0, 0.74, -0.1, 0.3, 0.12, 0.62)
        part('metal', 0, 0.78, 0.55, 0.7, 0.05, 0.05)
        for (const wz of [-0.62, 0.62]) {
          const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12)
          wheel.rotateZ(Math.PI / 2)
          const p = at(0, 0.3, wz)
          this.queue('dark', wheel, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)))
        }
        return
      }
      case 'tank': {
        const body = new THREE.CylinderGeometry(0.7, 0.7, 1.3, 12)
        this.queue('accent0', body, new THREE.Matrix4().makeTranslation(x, 0.65, z))
        this.queue('accent0', new THREE.CylinderGeometry(0.75, 0.75, 0.1, 12), new THREE.Matrix4().makeTranslation(x, 1.33, z))
        this.collider(x, 0.65, z, 1.4, 1.3, 1.4, 'metal')
        this.aoFootprint(x - 0.7, x + 0.7, z - 0.7, z + 0.7, 0.7)
        this.minimap.push({ x0: x - 0.7, x1: x + 0.7, z0: z - 0.7, z1: z + 0.7, kind: 'cover' })
        return
      }
      case 'hydrant': {
        const body = new THREE.CylinderGeometry(0.17, 0.2, 0.75, 10)
        this.queue('red', body, new THREE.Matrix4().makeTranslation(x, 0.375, z))
        part('red', 0, 0.75, 0, 0.26, 0.12, 0.26)
        part('red', 0, 0.42, 0, 0.56, 0.12, 0.12)
        this.collider(x, 0.45, z, 0.45, 0.9, 0.45, 'metal')
        return
      }
    }
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
    const sd = this.def.sites!
    const [hx, hz] = sd.half ?? [9.5, 8.5]
    const defs: [SiteId, number, number, string][] = [['A', sd.a[0] * this.K, sd.a[1] * this.K, '#ff6b5a'], ['B', sd.b[0] * this.K, sd.b[1] * this.K, '#ffb648']]
    for (const [id, x, z, color] of defs) {
      this.lift = this.groundY(x, z)
      const site: Site = { id, center: new THREE.Vector3(x, 0, z).add(this.origin), halfX: hx * this.K * 0.95, halfZ: hz * this.K * 0.95, color }
      this.sites.push(site)
      const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, 0.02, z)
      const g = new THREE.PlaneGeometry(site.halfX * 2, site.halfZ * 2)
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      this.queue('paint', g, m)
      // Big site letter: on a wall when the map names one, else on a post at the site's back edge.
      const sign = new THREE.PlaneGeometry(4, 4)
      const suv = sign.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < suv.count; i += 1) suv.setX(i, suv.getX(i) * 0.5 + (id === 'A' ? 0 : 0.5))
      const wall = sd.signs?.[id]
      let pos: THREE.Vector3
      let rot = 0
      if (wall) {
        rot = wall[2]
        pos = new THREE.Vector3(wall[0] * this.K - Math.sin(-rot) * 0.1, 4.4, wall[1] * this.K)
      } else {
        const px = x + (id === 'A' ? -1 : 1) * site.halfX * 0.6
        const pz = z - site.halfZ * 0.9
        this.box('metal', px, 0, pz, 0.22, 5.4, 0.22, { surface: 'metal', tile: 1 })
        this.box('dark', px, 3.2, pz - 0.08, 4.3, 4.3, 0.1, { collide: false, tile: 1 })
        pos = new THREE.Vector3(px, 5.35, pz + 0.01)
      }
      const sm = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1))
      this.queue('paint', sign, sm)
      this.lift = 0
    }
  }

  /** Town skyline outside the walls: hazy houses with roofs and cypress trees (no colliders). */
  private buildBackdrop(): void {
    if (this.style.favela) return this.buildFavelaBackdrop()
    let s = 77
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 70; i += 1) {
      const a = rnd() * Math.PI * 2
      const r = 95 + rnd() * 70
      const x = Math.cos(a) * r * 1.05
      const z = Math.sin(a) * r
      if (Math.abs(x) < this.HX + 8 && Math.abs(z) < this.HZ + 8) continue
      if (this.style.sea && z < 0) continue
      if (this.style.backdrop === 'towers') {
        // City block towers with window grids (lit at night).
        const w = 10 + rnd() * 14
        const d = 10 + rnd() * 14
        const h = 30 + rnd() * 70
        const m = new THREE.Matrix4().makeRotationY(Math.round(rnd() * 3) * (Math.PI / 2)).setPosition(x, h / 2, z)
        this.queue('tower', worldBox(w, h, d, 12), m)
        continue
      }
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
      if ((this.style.sea && z < 0) || this.style.backdrop === 'towers') continue
      const h = 9 + rnd() * 7
      const g = new THREE.ConeGeometry(1.4 + rnd() * 0.6, h, 6)
      this.queue('cypress', g, new THREE.Matrix4().makeTranslation(x, h / 2, z))
    }
  }

  /** A recognisable silhouette of the place, far beyond the walls (no colliders). */
  private buildLandmark(): void {
    const lm = this.style.landmark
    if (!lm) return
    // The view can face north (behind the attackers) instead of south.
    const f = this.style.viewNorth ? -1 : 1
    // Hillside maps look down on the sea, 12 m below the foot of the hill.
    const base = this.def.terrain ? -12.2 : 0
    const put = (mat: string, g: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, ry = 0) =>
      this.queue(mat, g, new THREE.Matrix4().compose(new THREE.Vector3(x, y + base, z * f), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz)))
    const box = (mat: string, x: number, y0: number, z: number, w: number, h: number, d: number) => put(mat, worldBox(w, h, d, 6), x, y0 + h / 2, z)
    switch (lm) {
      case 'sugarloaf': {
        // Sugarloaf rising from the bay, Urca hill beside it, Corcovado with the statue far right.
        put('rock', new THREE.SphereGeometry(1, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2), -120, -2, -230, 42, 105, 38)
        put('rock', new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), -175, -2, -205, 48, 46, 40)
        put('leaf0', new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), -175, -1, -205, 49, 30, 41)
        put('rock', new THREE.ConeGeometry(70, 150, 9), 190, 73, -250, 1, 1, 0.8)
        box('white', 190, 146, -250, 3, 14, 2.5)
        box('white', 190, 155, -250, 18, 2.6, 2.5)
        return
      }
      case 'campanile': {
        // St Mark's bell tower and the basilica domes over the lagoon.
        box('brick', 120, 0, -170, 13, 82, 13)
        box('white', 120, 82, -170, 15, 12, 15)
        box('dark', 120, 85, -170, 15.2, 6, 9)
        box('dark', 120, 85, -170, 9, 6, 15.2)
        box('brick', 120, 94, -170, 13, 6, 13)
        put('verdigris', new THREE.ConeGeometry(9.5, 24, 4), 120, 112, -170, 1, 1, 1, Math.PI / 4)
        put('gold', new THREE.SphereGeometry(1.6, 8, 6), 120, 125, -170)
        for (const [dx, dz, r] of [[70, -150, 11], [90, -150, 9], [80, -165, 10], [60, -165, 8]]) {
          box('white', dx, 0, dz, r * 1.6, 22, r * 1.6)
          put('verdigris', new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), dx, 22, dz)
        }
        return
      }
      case 'pagoda': {
        // Five-storey pagoda among the hills.
        let y = 0
        for (let i = 0; i < 5; i += 1) {
          const w = 16 - i * 2.2
          box('brick', -130, y, -165, w, 8, w)
          box('dark', -130, y + 8, -165, w + 8, 1.4, w + 8)
          y += 9.4
        }
        put('gold', new THREE.CylinderGeometry(0.6, 0.6, 16, 6), -130, y + 8, -165)
        put('rock', new THREE.ConeGeometry(120, 90, 10), -60, 40, -330, 1.6, 1, 1)
        return
      }
      case 'minaret': {
        // Koutoubia-style minaret with its lantern and three golden spheres.
        box('brick', 140, 0, -180, 13, 70, 13)
        box('white', 140, 62, -180, 13.6, 3, 13.6)
        box('brick', 140, 70, -180, 15, 2, 15)
        box('brick', 140, 72, -180, 7, 12, 7)
        put('verdigris', new THREE.ConeGeometry(5, 6, 4), 140, 87, -180, 1, 1, 1, Math.PI / 4)
        for (let i = 0; i < 3; i += 1) put('gold', new THREE.SphereGeometry(1.5 - i * 0.3, 10, 8), 140, 91 + i * 3, -180)
        return
      }
      case 'skyline': {
        // A stepped art-deco tower with a spire towers over the city.
        box('tower', 60, 0, -250, 34, 150, 30)
        box('tower', 60, 150, -250, 24, 40, 22)
        box('tower', 60, 190, -250, 14, 26, 13)
        box('white', 60, 216, -250, 7, 10, 7)
        put('white', new THREE.CylinderGeometry(0.6, 1.6, 40, 8), 60, 246, -250)
        box('tower', -90, 0, -230, 30, 120, 30)
        put('white', new THREE.CylinderGeometry(0.5, 1, 34, 6), -90, 137, -230)
        return
      }
      case 'church': {
        // Hilltop cathedral: twin towers and a dome.
        box('white', -140, 0, -190, 50, 30, 30)
        box('white', -162, 0, -175, 12, 52, 12)
        box('white', -118, 0, -175, 12, 52, 12)
        put('dark', new THREE.ConeGeometry(8, 14, 4), -162, 59, -175, 1, 1, 1, Math.PI / 4)
        put('dark', new THREE.ConeGeometry(8, 14, 4), -118, 59, -175, 1, 1, 1, Math.PI / 4)
        box('white', -140, 30, -200, 18, 10, 18)
        put('verdigris', new THREE.SphereGeometry(10, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), -140, 40, -200)
        return
      }
    }
  }

  // ─── spawn barriers (buy phase) ────────────────────────────────────────
  private barrier(side: TeamSide, z: number): void {
    this.lift = this.def.barrierY?.[side === 'attack' ? 0 : 1] ?? 0
    const w = this.HX * 2
    const h = 6
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.barrierMat)
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * w) / 3, (uv.getY(i) * h) / 3)
    mesh.position.set(0, h / 2 + this.lift, z)
    mesh.visible = false
    mesh.renderOrder = 3
    this.group.add(mesh)
    const collider = this.collider(0, h / 2, z, w, h, 0.3, 'metal')
    collider.setEnabled(false)
    this.barriers.push({ side, collider, mesh })
    this.lift = 0
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
    // Stair flights rise ~0.6 m per 1 m cell.
    if (this.def.terrain) nav.maxStep = 0.7
    const world = this.physics.world
    // Hillside maps: sample from high up and accept any terrace height; stair risers are steps.
    const hill = !!this.def.terrain
    const top = hill ? 40 : 4.5
    const maxH = hill ? 30 : 0.5
    const maxStep = hill ? 0.45 : 0.3
    const ray = new RAPIER.Ray({ x: 0, y: top, z: 0 }, { x: 0, y: -1, z: 0 })
    const sample = (x: number, z: number): { h: number; ny: number } => {
      ray.origin = { x, y: top, z }
      const hit = world.castRayAndGetNormal(ray, top + 1.5, true)
      if (!hit) return { h: BLOCKED, ny: 0 }
      return { h: top - hit.timeOfImpact, ny: hit.normal.y }
    }
    const r = 0.5
    for (let cz = 0; cz < nav.rows; cz += 1) {
      for (let cx = 0; cx < nav.cols; cx += 1) {
        const x = -this.HX + cx + 0.5
        const z = -this.HZ + cz + 0.5
        const c = sample(x + ox, z + oz)
        let ok = c.h !== BLOCKED && c.h < maxH && c.ny > 0.8 && Math.abs(x) < this.HX - 1.2 && Math.abs(z) < this.HZ - 1.2
        if (ok) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
            const s = sample(x + ox + dx, z + oz + dz)
            if (Math.abs(s.h - c.h) > maxStep) {
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

/** Contact-shadow ramp: opaque at the base (v = 0) easing out to clear (v = 1). */
function aoTexture(): THREE.CanvasTexture {
  const t = canvasTex(4, (g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, 64)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.72)')
    grad.addColorStop(0.6, 'rgba(255,255,255,0.26)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, s, 64)
  }, false, 64)
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.flipY = false
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

/** Beach / dusty ground: warm speckles and faint wind ripples (multiplied by the floor colour). */
function sandTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#f2ece2'
    g.fillRect(0, 0, s, s)
    const r = seeded(31)
    g.strokeStyle = 'rgba(190,170,140,0.22)'
    g.lineWidth = 3
    for (let y = 0; y < s; y += 22) {
      g.beginPath()
      for (let x = 0; x <= s; x += 8) g.lineTo(x, y + Math.sin((x / s) * Math.PI * 4 + y) * 4)
      g.stroke()
    }
    for (let i = 0; i < 1600; i += 1) {
      const v = 200 + Math.floor(r() * 55)
      g.fillStyle = `rgba(${v},${v - 12},${v - 30},0.5)`
      g.fillRect(r() * s, r() * s, 1.5, 1.5)
    }
  })
}

/** Rounded cobblestones in dark joints (old towns). */
function cobbleTexture(street: boolean): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = street ? '#8f877c' : '#a59c90'
    g.fillRect(0, 0, s, s)
    const r = seeded(street ? 41 : 43)
    const n = 10
    const c = s / n
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n + 1; x += 1) {
        const v = 205 + Math.floor(r() * 45)
        g.fillStyle = `rgb(${v},${v - 4},${v - 12})`
        const ox = (y % 2) * c * 0.5
        g.beginPath()
        g.ellipse(x * c + ox - c / 2, y * c + c / 2, c * (0.42 + r() * 0.06), c * (0.4 + r() * 0.06), r() * 0.6, 0, Math.PI * 2)
        g.fill()
      }
    }
  })
}

/** Raked temple gravel: fine grey grain with combed lines. */
function gravelTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#ecebe6'
    g.fillRect(0, 0, s, s)
    const r = seeded(51)
    for (let i = 0; i < 2600; i += 1) {
      const v = 190 + Math.floor(r() * 65)
      g.fillStyle = `rgba(${v},${v},${v - 6},0.7)`
      g.fillRect(r() * s, r() * s, 2, 2)
    }
    g.strokeStyle = 'rgba(160,156,148,0.35)'
    g.lineWidth = 2
    for (let y = 8; y < s; y += 16) {
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(s, y)
      g.stroke()
    }
  })
}

/** Copacabana promenade: black-and-white wave mosaic (tiles seamlessly). */
function wavesTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, s, s)
    g.fillStyle = '#3c3c3c'
    for (let band = 0; band < 2; band += 1) {
      const y0 = band * (s / 2)
      g.beginPath()
      for (let x = 0; x <= s; x += 4) g.lineTo(x, y0 + s * 0.16 + Math.sin((x / s) * Math.PI * 2) * s * 0.12)
      for (let x = s; x >= 0; x -= 4) g.lineTo(x, y0 + s * 0.34 + Math.sin((x / s) * Math.PI * 2) * s * 0.12)
      g.closePath()
      g.fill()
    }
    const r = seeded(61)
    for (let i = 0; i < 900; i += 1) {
      g.fillStyle = `rgba(128,128,128,${0.08 + r() * 0.1})`
      g.fillRect(r() * s, r() * s, 3, 3)
    }
  })
}

/** Exposed hollow-brick wall (multiplied by the brick colour): darker bricks, light mortar. */
function brickTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, s, s)
    const r = seeded(101)
    const rows = 12
    const rh = s / rows
    const bw = s / 6
    for (let y = 0; y < rows; y += 1) {
      for (let x = -1; x < 7; x += 1) {
        const v = 178 + Math.floor(r() * 50)
        g.fillStyle = `rgb(${v},${v - 10},${v - 22})`
        g.fillRect(x * bw + (y % 2) * (bw / 2) + 2, y * rh + 2, bw - 4, rh - 4)
      }
    }
    // Mortar smears and stains.
    for (let i = 0; i < 18; i += 1) {
      g.fillStyle = `rgba(230,225,215,${0.15 + r() * 0.2})`
      g.fillRect(r() * s, r() * s, 10 + r() * 40, 6 + r() * 20)
    }
  })
}

/** Water ripples: soft light streaks (multiplied by the water colour). */
function rippleTexture(): THREE.CanvasTexture {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#cfd8d8'
    g.fillRect(0, 0, s, s)
    const r = seeded(91)
    for (let i = 0; i < 70; i += 1) {
      g.strokeStyle = `rgba(255,255,255,${0.25 + r() * 0.35})`
      g.lineWidth = 1 + r() * 1.5
      const x = r() * s
      const y = r() * s
      g.beginPath()
      g.moveTo(x, y)
      g.quadraticCurveTo(x + 8, y - 3, x + 16 + r() * 10, y)
      g.stroke()
    }
  })
}

/** Asphalt: speckled, slightly patched (multiplied by a dark street colour). */
function asphaltTexture(): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#d8d8d8'
    g.fillRect(0, 0, s, s)
    const r = seeded(71)
    for (let i = 0; i < 6; i += 1) {
      g.fillStyle = `rgba(150,150,150,${0.15 + r() * 0.15})`
      g.fillRect(r() * s, r() * s, 30 + r() * 60, 20 + r() * 40)
    }
    for (let i = 0; i < 2400; i += 1) {
      const v = 160 + Math.floor(r() * 95)
      g.fillStyle = `rgba(${v},${v},${v},0.6)`
      g.fillRect(r() * s, r() * s, 1.5, 1.5)
    }
  })
}

/** Office-tower facade: a window grid, lit at random at night. */
function towerTexture(night: boolean): THREE.CanvasTexture {
  const t = canvasTex(128, (g, s) => {
    g.fillStyle = night ? '#0a0c12' : '#e8ebef'
    g.fillRect(0, 0, s, s)
    const r = seeded(81)
    const n = 8
    const c = s / n
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const lit = r() < 0.38
        g.fillStyle = night ? (lit ? (r() < 0.5 ? '#ffd890' : '#bfe0ff') : '#141824') : lit ? '#7a90a8' : '#4a5a6e'
        g.fillRect(x * c + 2, y * c + 3, c - 4, c - 6)
      }
    }
  })
  return t
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
