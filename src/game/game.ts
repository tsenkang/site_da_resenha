import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import { RAPIER, Physics } from '../engine/physics'
import type { Renderer } from '../engine/renderer'
import { Arena, type ColliderTag } from './arena'
import { MAP_ORIGIN, MAPS, MODE_MAP, type MapId } from './maps'
import { Bot, type BrainContext, type ItemInfo, type Target } from './bots'
import type { CombatWorld, DamageInfo, DamageResult, DamageSource, Hit, ProjectileKind } from './combat'
import { BOT_ROSTER, CONFIG, setWeaponProfile, WEAPONS, type BotKind, type WeaponId } from './config'
import { Effects } from './fx'
import { Hound } from './hound'
import type { Library } from './library'
import {
  awardStyle, decayStyle, hurtStyle, MAX_ALIVE, newStyle, offerPerks, perkEffects, RANK_MULT, RANKS, spawnOrder, WAVES, waveSize,
  type EnemyKind, type Perk, type PerkLevels, type StyleEvent, type StyleState,
} from './onslaught'
import { Player } from './player'
import { Pickups, Props } from './props'
import { addOutline, tintCharacter, wornPaint, type RobotLook } from './robot'
import { PlayerBody } from './playerbody'
import { computeScore, createMatch, leader, placement, recordShot, registerKill, splashDamage, standings, tick, type MatchState, type Medal } from './rules'
import type { Staged, StageId } from './stages'
import { tuning } from './tuning'
import { Arsenal, type HitKind } from './weapons'
import { TacticalMatch, type MinimapState, type TacticalHud } from './tacticalMatch'
import type { LoadoutWeapon, TeamIndex, TeamSize } from './tactical'
import { GUN_IDS, GUNS, isGunId, type GunSpec } from './gunSpecs'
import type { NetLink } from '../net/link'

export type Mode = 'attract' | 'countdown' | 'playing' | 'paused' | 'ended'
export type GameMode = 'onslaught' | 'deathmatch' | 'tactical'

export type KillFeedEntry = { killer: string; victim: string; weapon: string; headshot: boolean; killerIsPlayer: boolean; victimIsPlayer: boolean; killerColor: string; victimColor: string }
export type StylePop = { label: string; points: number; rank: number; rankedUp: boolean }
export type WaveBanner = { title: string; subtitle: string; kind: 'intro' | 'clear' | 'boss' | 'phase' | 'victory' }
export type RunSummary = { mode: GameMode; won: boolean; wave: number; waves: number; score: number; kills: number; headshots: number; accuracy: number; bestRank: string; time: number; unranked: boolean }

export type GameEvents = {
  hitmarker(kind: HitKind, damage: number): void
  damage(angle: number, amount: number): void
  killfeed(e: KillFeedEntry): void
  medals(list: Medal[]): void
  message(text: string, tone?: 'info' | 'good' | 'warn'): void
  pickup(label: string, color: string): void
  died(killer: string, weapon: string): void
  respawned(): void
  countdown(n: number): void
  ended(match: MatchState, summary?: RunSummary): void
  style(p: StylePop): void
  wave(b: WaveBanner): void
  perks(offer: Perk[] | null): void
  overdrive(on: boolean): void
  shard(kind: ShardKind): void
  loading(text: string | null): void
  perkChosen?(i: number): void
  /** Tactical: buy phase ended, close the shop if open. */
  closeBuy?(): void
}

export type HudState = {
  health: number
  maxHealth: number
  armor: number
  maxArmor: number
  /** Armor is actively recharging. */
  armorRegen: boolean
  /** 0..1 progress through the no-damage delay before recharge. */
  armorWait: number
  weapon: WeaponId
  weaponName: string
  /** Silhouette icon of a tactical gun (data URL). */
  weaponIcon?: string
  mag: number
  magSize: number
  reserve: number
  owned: Partial<Record<WeaponId, boolean>>
  /** Sight of the gun in hand (tactical guns): iron sights, red dot or scope. */
  sight?: GunSpec['sight']
  /** Looking through a scope (the HUD draws the scope overlay). */
  scoped: boolean
  /** Scope magnification (1 when not scoped). */
  zoom: number
  spread: number
  ads: number
  reloading: number
  timeLeft: number
  kills: number
  fragLimit: number
  leaderName: string
  leaderKills: number
  place: number
  alive: boolean
  respawnIn: number
  streak: number
  sprinting: boolean
  lowAmmo: boolean
  protect: number
  // Onslaught
  gameMode: GameMode
  wave: number
  waves: number
  enemiesLeft: number
  rank: number
  rankName: string
  rankFill: number
  mult: number
  score: number
  overdrive: number
  overdriveActive: number
  grenades: number
  grenadesUnlocked: boolean
  boss: { name: string; health: number; phase: number } | null
  sliding: boolean
  runTime: number
  /** Tactical mode only. */
  tactical: TacticalHud | null
}

type Rocket = { pos: THREE.Vector3; vel: THREE.Vector3; owner: number; exclude: number; life: number; mesh: THREE.Group; loop?: { set(p: THREE.Vector3): void; stop(): void }; trail: number }
type Projectile = { pos: THREE.Vector3; vel: THREE.Vector3; owner: number; kind: ProjectileKind; life: number }
type Grenade = { pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; mesh: THREE.Group; spin: THREE.Vector3; bounceCd: number }
export type ShardKind = 'health' | 'armor' | 'ammo'
type Shard = { kind: ShardKind; pos: THREE.Vector3; vel: THREE.Vector3; life: number; phase: number; grounded: boolean }
type PendingSpawn = { kind: EnemyKind; pos: THREE.Vector3; yaw: number; t: number }
type WavePhase = 'none' | 'loading' | 'intro' | 'fight' | 'clear' | 'perk' | 'next'

const SOURCE_LABEL: Record<DamageSource, string> = {
  rifle: 'M4', shotgun: 'M870', rocket: 'RPG-X', pistol: 'P9', spike: 'SPIKE', pulse: 'PULSE', scatter: 'SCATTER', barrel: 'BARREL', fall: 'FALL',
  grenade: 'FRAG', plasma: 'PLASMA', cannon: 'CANNON', minigun: 'MINIGUN', slam: 'SLAM', kamikaze: 'KAMIKAZE',
  ...(Object.fromEntries(GUN_IDS.map(id => [id, GUNS[id].name.toUpperCase()])) as Record<(typeof GUN_IDS)[number], string>),
}
const SHARD_COLOR: Record<ShardKind, [number, number, number]> = { health: [0.4, 3.2, 0.9], armor: [0.5, 1.8, 4], ammo: [4, 2.6, 0.5] }
const PROJ = {
  plasma: { speed: 30, damage: 13, radius: 1.4, color: [1.2, 3.4, 6, 1] as [number, number, number, number], size: 0.14 },
  cannon: { speed: 34, damage: 30, radius: 4, color: [6, 2.6, 0.8, 1] as [number, number, number, number], size: 0.3 },
}
const ENEMY_NAME: Record<string, string> = { scrapper: 'WOLF', breacher: 'BOAR', juggernaut: 'EXO', titan: 'THE WARDEN', hornet: 'HOUND' }
const POOL = { scrapper: 10, juggernaut: 2, titan: 1, hornet: 8 }
/** Every third wave rifleman slot is a shotgun Breacher. */
const BREACHER_EVERY = 3
const WAVE_ID0 = 30
const KIND_LOOK: Record<BotKind, RobotLook> = { striker: 'operator', warden: 'breacher', scrapper: 'operator', breacher: 'breacher', juggernaut: 'exo', titan: 'warden' }
/** Sentinel robots join the Scrapper rotation once stage 2 is in. */
const SENTINEL_SCRAPPERS = 4

const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()
const tmp3 = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

let rocketTemplate: THREE.Group | undefined
function rocketMesh(): THREE.Group {
  rocketTemplate ??= buildRocketMesh()
  return rocketTemplate.clone()
}
function buildRocketMesh(): THREE.Group {
  const g = new THREE.Group()
  const olive = wornPaint('#4d5438', { chip: 0.4, grime: 0.4, scale: 30 }, { metalness: 0.35, roughness: 0.55 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 12), olive)
  body.rotation.x = Math.PI / 2
  g.add(body)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 12), olive)
  nose.rotation.x = -Math.PI / 2
  nose.position.z = -0.29
  g.add(nose)
  for (let i = 0; i < 4; i += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.07, 0.09), olive)
    fin.position.set(0, 0, 0.17)
    fin.rotation.z = (i * Math.PI) / 2
    fin.translateY(0.07)
    g.add(fin)
  }
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.4, 0.8), toneMapped: false }))
  glow.position.z = 0.24
  g.add(glow)
  return g
}

let grenadeTemplate: THREE.Group | undefined
let grenadeScan: THREE.Object3D | undefined
function grenadeMesh(): THREE.Group {
  grenadeTemplate ??= grenadeScan ? buildTripoGrenade(grenadeScan) : buildGrenadeMesh()
  return grenadeTemplate.clone()
}
/** Tripo M67 scan scaled to 11 cm, centred, plus the armed-fuse LED the game blinks. */
function buildTripoGrenade(scan: THREE.Object3D): THREE.Group {
  const g = new THREE.Group()
  const m = scan.clone(true)
  const box = new THREE.Box3().setFromObject(m)
  const s = 0.11 / box.getSize(new THREE.Vector3()).y
  m.scale.setScalar(s)
  m.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-s))
  g.add(m)
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.4, 0.2), toneMapped: false }))
  led.position.set(0, 0.045, 0.02)
  led.name = 'led'
  g.add(led)
  g.traverse(o => (o.castShadow = true))
  return g
}
function buildGrenadeMesh(): THREE.Group {
  const g = new THREE.Group()
  const olive = wornPaint('#3f4a2e', { chip: 0.5, grime: 0.5, scale: 40 }, { metalness: 0.3, roughness: 0.6 })
  const steel = new THREE.MeshStandardMaterial({ color: '#8a8c8f', metalness: 0.8, roughness: 0.35 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 12), olive)
  body.scale.y = 1.25
  g.add(body)
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.03, 10), steel)
  top.position.y = 0.058
  g.add(top)
  const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.006), steel)
  spoon.position.set(0.028, 0.03, 0)
  spoon.rotation.z = -0.25
  g.add(spoon)
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.4, 0.2), toneMapped: false }))
  led.position.set(0, 0.04, 0.036)
  led.name = 'led'
  g.add(led)
  g.traverse(o => (o.castShadow = true))
  return g
}

function launcherPickup(): THREE.Group {
  const g = new THREE.Group()
  const olive = wornPaint('#4d5438', { chip: 0.5, grime: 0.5, scale: 12 }, { metalness: 0.3, roughness: 0.58 })
  const metal = new THREE.MeshStandardMaterial({ color: '#2d2f33', metalness: 0.6, roughness: 0.45 })
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 20), olive)
  tube.rotation.z = Math.PI / 2
  g.add(tube)
  for (const x of [-0.6, 0.62]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 20), metal)
    ring.rotation.z = Math.PI / 2
    ring.position.x = x
    g.add(ring)
  }
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.06), metal)
  grip.position.set(0.1, -0.18, 0)
  g.add(grip)
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.07), metal)
  sight.position.set(-0.05, 0.14, 0.06)
  g.add(sight)
  return g
}

export type StageGate = { isReady(s: StageId): boolean; ensure(s: StageId): Promise<void>; onStageReady?: (s: StageId) => void }

/** Deathmatch roster slots (WRAITH, NOVA) played by Sentinel robots, and their bot ids (clear of the DM 1..7 and wave ranges). */
const DM_SENTINEL_SLOTS = [2, 4]
const DM_SENTINEL_ID0 = 900

export class Game implements CombatWorld {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly physics: Physics
  /** The map in play; every mode has its own (built on first use, side by side in one world). */
  arena: Arena
  private readonly arenas = new Map<MapId, Arena>()
  private readonly mapItems = new Map<MapId, { props: Props; pickups: Pickups; hotspots: THREE.Vector3[] }>()
  readonly fx: Effects
  readonly player: Player
  readonly arsenal: Arsenal
  /** Every robot (deathmatch roster + Onslaught pool). */
  readonly bots: Bot[] = []
  private readonly dmBots: Bot[] = []
  private readonly waveBots: Record<'scrapper' | 'juggernaut' | 'titan', Bot[]> = { scrapper: [], juggernaut: [], titan: [] }
  private readonly botById = new Map<number, Bot>()
  readonly hornets: Hound[] = []
  props: Props
  pickups: Pickups
  private readonly tags = new Map<number, ColliderTag>()
  private rockets: Rocket[] = []
  private projectiles: Projectile[] = []
  private grenadesLive: Grenade[] = []
  private shards: Shard[] = []
  private readonly shardMesh: THREE.InstancedMesh
  private readonly rocketLight = new THREE.PointLight('#ff8a3a', 0, 12, 1.6)
  private readonly projLight = new THREE.PointLight('#5cc8ff', 0, 9, 1.6)
  mode: Mode = 'attract'
  gameMode: GameMode = 'onslaught'
  /** Tactical (Spike) round director, alive while a tactical match runs. */
  tactical: TacticalMatch | null = null
  /** Team size for the next tactical match (2..5). */
  teamSize: TeamSize = 5
  private readonly tacBots = new Map<number, Bot>()
  match: MatchState = createMatch(BOT_ROSTER.slice(0, CONFIG.bots.count).map(b => b.name))
  time = 0
  private countdownT = 0
  private lastCount = 0
  private trauma = 0
  private slowmo = 1
  private slowmoT = 0
  private hitstop = 0
  private endT = 0
  private respawnT = 0
  private hurtT = 0
  private footDist = 0
  private botFoot = new Map<number, number>()
  private heartbeatT = 0
  private lowAmmoWarned = false
  private killerId = -1
  private deathYaw = 0
  private deathPitch = 0
  private attractT = 0
  private strafeTilt = 0
  private slideTilt = 0
  private lastLook = { x: 0, y: 0 }
  private hotspots: THREE.Vector3[]
  reducedMotion = false
  fovSetting = 100
  private readonly eyePos = new THREE.Vector3()
  // Onslaught state.
  private wave = 0
  private wavePhase: WavePhase = 'none'
  private phaseT = 0
  private spawnQueue: EnemyKind[] = []
  private spawnT = 0
  private pending: PendingSpawn[] = []
  style: StyleState = newStyle()
  private perks: PerkLevels = {}
  private perkOffer: Perk[] | null = null
  private grenades = 2
  private grenadeCd = 0
  private overdriveT = 0
  private runTime = 0
  private kills = 0
  private headshots = 0
  private shots = 0
  private hits = 0
  private lastKillT = -9
  private lastKillWeapons: string[] = []
  private weakPopT = 0
  private boss: Bot | null = null
  private stageGate: StageGate
  private rocketUpgraded = false

  constructor(
    readonly renderer: Renderer,
    readonly input: Input,
    readonly audio: Audio,
    private readonly lib: Library,
    private readonly staged: Staged,
    gate: StageGate,
    readonly events: GameEvents,
  ) {
    this.stageGate = gate
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 600)
    this.scene.add(this.camera)
    // Soft warm key from the player's view: keeps nearby enemies readable against the backlit sky
    // (a common FPS readability trick). Short range, so it never flattens the arena lighting.
    const fill = new THREE.PointLight('#ffd6b0', 5, 16, 2)
    fill.position.set(0.3, 0.4, 0.2)
    this.camera.add(fill)
    this.physics = new Physics(-22)
    const pmrem = new THREE.PMREMGenerator(renderer.gl)
    this.scene.environment = pmrem.fromEquirectangular(lib.envHdr).texture
    pmrem.dispose()
    this.arena = this.buildArena('aurora')
    this.arena.setActive(true)
    grenadeScan = lib.models.frag_grenade.scene
    this.fx = new Effects((x, z, y) => this.arena.groundAt(x, z, y), this.scene.fog as THREE.FogExp2, staged.fx)
    this.renderer.setHalfResSmoke(this.fx.smokeMesh)
    // Every streamed stage can add materials (drones, heavies, the upgraded launcher, V3 characters):
    // compile them as soon as they land so the first spawn or shot never builds a shader mid-fight.
    const prevReady = gate.onStageReady
    gate.onStageReady = s => {
      prevReady?.(s)
      // Later enemy types arrive with their stage; build their pools as soon as the assets land.
      if (this.waveBots.scrapper.length) this.ensureStagePools()
      // Deathmatch started before the Sentinel rig landed: swap the robots in while the countdown runs.
      if (this.gameMode === 'deathmatch' && this.mode === 'countdown' && !this.dmRobots && this.staged.chars.sentinel) {
        this.ensureDmSentinels()
        for (const i of DM_SENTINEL_SLOTS) {
          const b = this.dmBots[i]
          if (!b || i >= CONFIG.bots.count) continue
          const bs = this.chooseSpawn(b.id)
          b.spawn(bs.pos, bs.yaw)
        }
      }
      window.clearTimeout(this.prewarmTimer)
      this.prewarmTimer = window.setTimeout(() => this.prewarm(), 50)
    }
    this.fx.density = renderer.particleDensity
    this.fx.onShellBounce = pos => {
      if (pos.distanceToSquared(this.eyePos) < 36) this.audio.play('shell_casing', { volume: 0.35, pos, jitter: 0.2 })
    }
    this.scene.add(this.fx.group)
    this.scene.add(this.rocketLight, this.projLight)
    this.player = new Player(this.physics)
    this.tags.set(this.player.collider.handle, { kind: 'player' })
    this.arsenal = new Arsenal(
      this,
      this.player,
      this.camera,
      {
        hit: (kind, damage) => this.events.hitmarker(kind, damage),
        fired: (_id, shake) => {
          this.trauma = Math.min(1, this.trauma + shake)
          this.netShots += 1
        },
        message: key => this.events.message(key === 'msg.noAmmo' ? 'SEM MUNIÇÃO' : key, 'warn'),
      },
      () => this.staged.vm,
    )
    this.arsenal.isHead = (id, point) => this.botById.get(id)?.isHead(point) ?? false
    this.arsenal.weakMult = (id, point) => {
      const b = this.botById.get(id)
      const m = b ? b.weakMultiplier(point) : 1
      if (m > 1 && this.weakPopT <= 0 && this.gameMode === 'onslaught') {
        this.weakPopT = 0.6
        this.awardStyle('weakpoint')
      }
      return m
    }
    BOT_ROSTER.forEach((r, i) => {
      const bot = this.makeBot(i + 1, r.name, r.kind, r.color, r.visor)
      this.dmBots.push(bot)
    })
    const items = this.mapItemsFor(this.arena)
    this.props = items.props
    this.pickups = items.pickups
    this.hotspots = items.hotspots
    // Rift shards: instanced crystals with HDR instance colours (bloom picks them up).
    const shardGeo = new THREE.OctahedronGeometry(0.11, 0)
    shardGeo.scale(0.7, 1.25, 0.7)
    this.shardMesh = new THREE.InstancedMesh(shardGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), 80)
    this.shardMesh.count = 0
    this.shardMesh.frustumCulled = false
    this.shardMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(80 * 3), 3)
    this.scene.add(this.shardMesh)
    this.physics.world.step()
    this.enterAttract()
  }

  private makeBot(id: number, name: string, kind: BotKind, color: string, visor: string, lookOverride?: RobotLook): Bot {
    const look = lookOverride ?? KIND_LOOK[kind]
    const bot = new Bot(id, name, kind, color, visor, this.physics, this.arena.nav, this, this.staged.chars[look]!, this.staged.vm, lookOverride)
    this.tags.set(bot.collider.handle, { kind: 'bot', id })
    this.scene.add(bot.parts.root)
    this.bots.push(bot)
    this.botById.set(id, bot)
    return bot
  }

  /**
   * Tactical bots are built once and reused across matches: allies wear the operator rig with a
   * cyan visor, enemies the breacher rig with a red visor, both carrying rifles.
   */
  createTacticalBot(id: number, name: string, team: TeamIndex): Bot {
    let b = this.tacBots.get(id)
    if (!b) {
      b = team === 0 ? this.makeBot(id, name, 'striker', '#1f6f73', '#48f0d8', 'operator') : this.makeBot(id, name, 'striker', '#7a2a2a', '#ff4655', 'breacher')
      tintCharacter(b.parts.root, team === 0 ? '#3ce0c4' : '#ff4655')
      if (team === 1) addOutline(b.parts.root, '#ff4655')
      this.tacBots.set(id, b)
    }
    b.team = team
    b.hide()
    return b
  }

  // ─── online (tactical over the network) ──────────────────────────────
  private netShots = 0
  /** Hits on remote players this step, merged per target (shotgun pellets become one claim). */
  private readonly netHits = new Map<number, { damage: number; headshot: boolean; distance: number; weapon: LoadoutWeapon }>()

  /** Weapon in hand as the rules know it (the launcher never appears in tactical). */
  heldLoadoutWeapon(): LoadoutWeapon {
    const c = this.arsenal.current
    return isGunId(c) ? c : 'glock'
  }

  takeNetShots(): number {
    const n = this.netShots
    this.netShots = 0
    return Math.min(20, n)
  }

  /** Send this step's hit claims; the server validates them and answers with damage/kill. */
  flushNetHits(net: NetLink): void {
    for (const [local, h] of this.netHits) {
      const target = net.net(local)
      if (target) net.client.send({ t: 'hit', h: { target, damage: Math.round(h.damage), headshot: h.headshot, weapon: h.weapon, distance: Math.round(h.distance * 10) / 10 } })
    }
    this.netHits.clear()
  }

  /** Server damage report: sync health/shield and play the hurt feedback when it is you. */
  netDamage(target: number, by: number, hp: number, shield: number): void {
    if (target !== 0) {
      const b = this.botById.get(target)
      if (b?.alive) {
        b.health = hp
        b.armor = shield
      }
      return
    }
    if (!this.player.alive) return
    const dealt = this.player.health - hp + Math.max(0, this.player.armor - shield)
    const hadArmor = this.player.armor > 0
    this.player.health = hp
    this.player.armor = shield
    if (dealt <= 0) return
    const from = by === 0 ? this.player.position : this.botById.get(by)?.pos ?? this.player.position
    this.events.damage(Math.atan2(-(from.x - this.player.position.x), -(from.z - this.player.position.z)) - this.player.yaw, dealt)
    this.renderer.fx.damage = Math.min(1, this.renderer.fx.damage + dealt / 40)
    this.trauma = Math.min(1, this.trauma + dealt / 90)
    this.arsenal.punch.pitch += 0.012 * Math.min(2, dealt / 10)
    if (this.hurtT <= 0) {
      this.audio.play('player_hurt', { volume: 0.75 })
      this.hurtT = 0.45
    }
    if (hadArmor && shield <= 0) this.audio.play('armor_break', { volume: 0.8 })
  }

  /** Server kill report: the usual death presentation, killfeed and stats. */
  netKill(killer: number, victim: number, headshot: boolean, source: DamageSource): void {
    const from = (killer === 0 ? this.player.position : this.botById.get(killer)?.pos ?? this.player.position).clone()
    const info: DamageInfo = { attacker: killer === victim ? -1 : killer, amount: 999, source, from, headshot }
    if (victim === 0) {
      if (!this.player.alive) return
      this.player.health = 0
      this.playerDied(info)
      return
    }
    const b = this.botById.get(victim)
    if (!b?.alive) return
    b.health = 0
    b.alive = false
    this.botDied(b, info)
  }

  setGrenades(n: number): void {
    this.grenades = n
  }

  /** New tactical round: clear leftovers from the previous one. */
  onTacticalRound(): void {
    this.rockets.forEach(r => {
      r.loop?.stop()
      this.scene.remove(r.mesh)
    })
    this.rockets = []
    for (const g of this.grenadesLive) this.scene.remove(g.mesh)
    this.grenadesLive = []
    this.fx.clearDecals()
    this.renderer.fx.damage = 0
    this.renderer.fx.lowHealth = 0
    this.killerId = -1
    this.respawnT = 0
    this.events.respawned()
  }

  /** Spike detonation kills (no killfeed credit). */
  killPlayerSilently(): void {
    if (!this.player.alive) return
    this.player.health = 0
    this.playerDied({ attacker: -1, amount: 999, source: 'spike', from: this.player.position.clone() })
  }
  killBotSilently(b: Bot): void {
    if (!b.alive) return
    b.health = 0
    b.alive = false
    this.botDied(b, { attacker: -1, amount: 999, source: 'spike', from: b.pos.clone(), splash: true })
  }

  /** Tactical match over: results screen with the round score. */
  endTactical(won: boolean): void {
    if (this.mode === 'ended' || !this.tactical) return
    const t = this.tactical
    const me = t.state.players.find(p => p.id === 0)!
    this.match = { ...this.match, phase: won ? 'won' : 'lost' }
    this.mode = 'ended'
    this.endT = 0
    this.slowmo = 0.35
    this.audio.silenceWorld(0.3)
    this.audio.play(won ? 'victory' : 'defeat', { volume: 1, jitter: 0, force: true })
    this.events.wave({ title: won ? 'VITÓRIA' : 'DERROTA', subtitle: `${t.state.score[0]} — ${t.state.score[1]}`, kind: won ? 'victory' : 'phase' })
    this.input.unlockPointer()
    const summary: RunSummary = {
      mode: 'tactical', won, wave: t.state.score[0], waves: t.state.score[1], score: me.kills * 200 + (won ? 3000 : 0),
      kills: me.kills, headshots: this.headshots, accuracy: this.shots ? this.hits / this.shots : 0, bestRank: `${t.state.score[0]}-${t.state.score[1]}`,
      time: this.runTime, unranked: true,
    }
    window.setTimeout(() => this.events.ended(this.match, summary), 2600)
  }

  /** Build the Onslaught rifle pool once (after stage 1); later enemy pools follow their stages. */
  private ensurePool(): void {
    if (this.waveBots.scrapper.length) return
    let id = WAVE_ID0
    for (let i = 0; i < POOL.scrapper; i += 1) {
      const breacher = i % BREACHER_EVERY === BREACHER_EVERY - 1
      const b = breacher ? this.makeBot(id++, 'BOAR', 'breacher', '#3a3a3a', '#ff5a2a') : this.makeBot(id++, 'WOLF', 'scrapper', '#3a3a3a', '#ff4a2a')
      b.wave = true
      this.waveBots.scrapper.push(b)
    }
    this.nextWaveId = id
    this.ensureStagePools()
    this.prewarm()
  }
  private nextWaveId = WAVE_ID0
  private body?: PlayerBody
  private readonly bodyFeet = new THREE.Vector3()
  private sentinelsAdded = false
  private dmRobots = false
  /** Deathmatch: once the Sentinel rig is streamed in (stage 2), two of the five rivals become humanoid robots. */
  private ensureDmSentinels(): void {
    if (this.dmRobots || !this.staged.chars.sentinel) return
    this.dmRobots = true
    for (const i of DM_SENTINEL_SLOTS) {
      const old = this.dmBots[i]
      if (!old) continue
      const r = BOT_ROSTER[i]
      old.hide()
      const b = this.makeBot(DM_SENTINEL_ID0 + i, r.name, r.kind, '#3a3d42', r.visor, 'sentinel')
      b.hide()
      this.dmBots[i] = b
    }
  }
  /** Hounds + Sentinel robots (stage 2), Exo heavies (stage 3) and the Warden (stage 4), each built once its assets are in. */
  private ensureStagePools(): void {
    if (!this.hornets.length && this.staged.hound) {
      for (let i = 0; i < POOL.hornet; i += 1) {
        const h = new Hound(i, this.physics, this, this.staged.hound)
        this.tags.set(h.collider.handle, { kind: 'drone', id: i })
        this.scene.add(h.root)
        this.hornets.push(h)
      }
    }
    if (!this.sentinelsAdded && this.staged.chars.sentinel && this.waveBots.scrapper.length) {
      this.sentinelsAdded = true
      for (let i = 0; i < SENTINEL_SCRAPPERS; i += 1) {
        const b = this.makeBot(this.nextWaveId++, 'SENTINEL', 'scrapper', '#3a3d42', '#ff9a2e', 'sentinel')
        b.wave = true
        // Interleave so free-slot picks alternate masked operators and robots.
        this.waveBots.scrapper.splice(Math.min(this.waveBots.scrapper.length, 1 + i * 3), 0, b)
      }
    }
    if (!this.waveBots.juggernaut.length && this.staged.chars.exo) {
      for (let i = 0; i < POOL.juggernaut; i += 1) {
        const b = this.makeBot(this.nextWaveId++, 'EXO', 'juggernaut', '#3a3d42', '#ff9a2e')
        b.wave = true
        this.waveBots.juggernaut.push(b)
      }
    }
    if (!this.waveBots.titan.length && this.staged.chars.warden) {
      const t = this.makeBot(this.nextWaveId++, 'THE WARDEN', 'titan', '#3a3d42', '#ff3a1a')
      t.wave = true
      this.waveBots.titan.push(t)
    }
  }

  private prewarmTimer = 0

  private buildArena(id: MapId): Arena {
    const a = new Arena(this.scene, this.physics, this.lib, MAPS[id], MAP_ORIGIN[id], this.tags)
    a.sun.shadow.mapSize.set(this.renderer.shadowMapSize, this.renderer.shadowMapSize)
    a.sun.shadow.radius = this.renderer.shadowMapSize >= 2048 ? 2.4 : 1.4
    this.arenas.set(id, a)
    return a
  }

  private mapItemsFor(a: Arena): { props: Props; pickups: Pickups; hotspots: THREE.Vector3[] } {
    let items = this.mapItems.get(a.def.id)
    if (!items) {
      items = {
        props: new Props(this.scene, this.physics, this.tags, a.nav, this.lib, a.props),
        pickups: new Pickups(this.scene, this.lib, a.pickups, launcherPickup()),
        hotspots: [...a.hotspots, ...a.spawns, ...a.pickups.map(p => p.pos)],
      }
      this.mapItems.set(a.def.id, items)
    }
    return items
  }

  /** Minimap extents and world offset of the active map. */
  minimapFrame(): { hx: number; hz: number; ox: number; oz: number } {
    return { hx: this.arena.HX, hz: this.arena.HZ, ox: this.arena.origin.x, oz: this.arena.origin.z }
  }

  /** Switch the world to a map: show it (sky, fog, light), swap props/pickups and re-point bot navigation. */
  useMap(id: MapId): void {
    if (this.arena.def.id === id) return
    this.props.setActive(false)
    this.pickups.setActive(false)
    this.arena.setActive(false)
    const a = this.arenas.get(id) ?? this.buildArena(id)
    a.setActive(true)
    this.arena = a
    const items = this.mapItemsFor(a)
    this.props = items.props
    this.pickups = items.pickups
    this.hotspots = items.hotspots
    for (const b of this.bots) b.nav = a.nav
    this.attractT = 0
    this.prewarm()
  }
  /**
   * Compile every material in the scene, hidden ones included (three's compile walks invisible
   * objects: pooled bots and drones, inactive viewmodels, pickups, gibs), plus lazily created
   * projectiles. compileAsync links in parallel where KHR_parallel_shader_compile exists instead of
   * blocking the frame. Cheap to repeat: already-built programs are cache hits.
   */
  private prewarm(): void {
    const temps = [rocketMesh(), grenadeMesh()]
    for (const t of temps) {
      t.visible = false
      this.scene.add(t)
    }
    try {
      this.renderer.gl.compileAsync(this.scene, this.camera).catch(() => {})
    } catch {
      /* compile is an optimisation only */
    }
    for (const t of temps) this.scene.remove(t)
  }

  // ─── CombatWorld ──────────────────────────────────────────────────────
  get onslaught(): boolean {
    return this.gameMode === 'onslaught' && this.mode !== 'attract'
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, excludeHandle?: number, worldOnly = false): Hit | null {
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z })
    const hit = this.physics.world.castRayAndGetNormal(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, c => {
      if (c.handle === excludeHandle) return false
      const t = this.tags.get(c.handle)
      if (worldOnly) return t?.kind === 'world'
      if (t?.kind === 'bot' && !this.botById.get(t.id)?.alive) return false
      if (t?.kind === 'drone' && !this.hornets[t.id]?.alive) return false
      if (t?.kind === 'player' && !this.player.alive) return false
      return true
    })
    if (!hit) return null
    const d = hit.timeOfImpact
    return {
      point: new THREE.Vector3(origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: d,
      tag: this.tags.get(hit.collider.handle),
      colliderHandle: hit.collider.handle,
    }
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dir = tmp.subVectors(b, a)
    const len = dir.length()
    if (len < 1e-3) return true
    dir.divideScalar(len)
    const ray = new RAPIER.Ray({ x: a.x, y: a.y, z: a.z }, { x: dir.x, y: dir.y, z: dir.z })
    const hit = this.physics.world.castRay(ray, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, c => this.tags.get(c.handle)?.kind === 'world')
    if (hit) return false
    return !this.tactical?.smokeBlocks(a, b)
  }

  groundAt(x: number, z: number, fromY: number): number {
    return this.arena.groundAt(x, z, fromY)
  }

  noise(pos: THREE.Vector3, source: number, radius: number): void {
    const team = this.tactical ? this.tactical.teamOf(source) : -1
    for (const b of this.bots) if (b.alive && b.id !== source && (team < 0 || b.team !== team) && b.pos.distanceTo(pos) < radius) b.hear(pos, source)
  }

  private get live(): boolean {
    return this.mode === 'playing' || this.mode === 'attract'
  }

  isHuman(target: number): boolean {
    return this.botById.get(target)?.parts.human ?? false
  }
  private nameOf(id: number): string {
    if (id === 0) return this.tactical ? 'VOCÊ' : 'YOU'
    if (id <= -100) return 'HOUND'
    if (id > 0) return this.botById.get(id)?.name ?? '?'
    return 'WORLD'
  }
  private colorOf(id: number): string {
    if (id === 0) return '#ffffff'
    if (id <= -100) return '#3fb8ff'
    return id > 0 ? (this.botById.get(id)?.visor ?? '#ccc') : '#ccc'
  }

  damage(target: number, info: DamageInfo): DamageResult {
    if (!this.live) return { dealt: 0, killed: false, armor: false }
    // Tactical: no friendly fire (self-damage from your own grenade still applies).
    if (this.tactical && info.attacker >= 0 && info.attacker !== target && this.tactical.teamOf(info.attacker) === this.tactical.teamOf(target)) return { dealt: 0, killed: false, armor: false }
    if (target === 0) {
      if (this.mode !== 'playing' || !this.player.alive) return { dealt: 0, killed: false, armor: false }
      const hadArmor = this.player.armor > 0
      let amount = info.attacker === 0 ? info.amount * 0.5 : info.amount
      // Bot hits on the player read through the tactical loadout multiplier already; headshots hurt more.
      if (this.tactical && info.headshot) amount *= 1.6
      if (this.onslaught && info.attacker !== 0) amount *= 0.85
      const r = this.player.damage(amount)
      if (r.dealt <= 0) return { dealt: 0, killed: false, armor: false }
      const dx = info.from.x - this.player.position.x
      const dz = info.from.z - this.player.position.z
      const worldAngle = Math.atan2(-dx, -dz)
      this.events.damage(worldAngle - this.player.yaw, r.dealt)
      this.renderer.fx.damage = Math.min(1, this.renderer.fx.damage + r.dealt / 40)
      this.trauma = Math.min(1, this.trauma + r.dealt / 90)
      this.arsenal.punch.pitch += 0.012 * Math.min(2, r.dealt / 10)
      this.arsenal.punch.roll += (Math.random() - 0.5) * 0.04
      if (this.hurtT <= 0) {
        this.audio.play('player_hurt', { volume: 0.75 })
        this.hurtT = 0.45
      }
      if (hadArmor && this.player.armor <= 0) {
        this.audio.play('armor_break', { volume: 0.8 })
        this.events.message('ARMADURA QUEBRADA', 'warn')
      } else if (hadArmor) this.audio.cue('armorHit', 0.6)
      if (this.onslaught && r.dealt >= 8) this.style = hurtStyle(this.style)
      const killed = this.player.health <= 0
      if (killed) this.playerDied(info)
      return { dealt: r.dealt, killed, armor: this.player.armor > 0 }
    }
    const bot = this.botById.get(target)
    if (!bot || !bot.alive) return { dealt: 0, killed: false, armor: false }
    if (bot.remote) {
      // Online: our shots become claims for the server (explosions are resolved there).
      if (info.attacker !== 0 || info.splash) return { dealt: 0, killed: false, armor: false }
      const h = this.netHits.get(target) ?? { damage: 0, headshot: false, distance: this.player.position.distanceTo(bot.pos), weapon: this.heldLoadoutWeapon() }
      h.damage += info.amount
      h.headshot ||= !!info.headshot
      this.netHits.set(target, h)
      return { dealt: info.amount, killed: false, armor: bot.armor > 0 }
    }
    if (info.attacker === 0 && !this.tactical) info = { ...info, amount: info.amount * CONFIG.player.damageScale }
    const r = bot.takeDamage(info)
    if (info.attacker === 0 && this.mode === 'playing' && !this.onslaught) this.match = recordShot(this.match, 0, 0, r.dealt)
    if (r.killed) this.botDied(bot, info)
    return r
  }

  damageDrone(id: number, info: DamageInfo): DamageResult {
    const h = this.hornets[id]
    if (!h || !h.alive || !this.live) return { dealt: 0, killed: false, armor: false }
    if (info.attacker === 0) info = { ...info, amount: info.amount * CONFIG.player.damageScale }
    const r = h.takeDamage(info)
    if (r.killed) this.enemyKilled(h.pos.clone(), 'hornet', info, 1)
    return r
  }

  damageProp(index: number, info: DamageInfo): void {
    this.props.damage(index, info, this)
  }

  explode(pos: THREE.Vector3, radius: number, damage: number, attacker: number, source: DamageSource, normal?: THREE.Vector3): void {
    const scale = radius / 6
    this.fx.explosion(pos, scale, normal ?? new THREE.Vector3(0, 1, 0))
    this.fx.debrisBurst(pos, 14 * scale, 8)
    this.audio.play('explosion', { volume: 1.25 * Math.min(1, 0.5 + scale), pos, jitter: 0.08, ref: 7 })
    const d = pos.distanceTo(this.eyePos)
    if (this.mode === 'playing' || this.mode === 'attract') {
      this.trauma = Math.min(1, this.trauma + Math.max(0, 1 - d / 28) * 0.9 * Math.min(1, scale * 1.4))
      if (d < radius * 1.7 && this.mode === 'playing') {
        this.audio.deafen(Math.min(1, 1.2 - d / (radius * 1.7)))
        this.renderer.fx.flash = Math.max(this.renderer.fx.flash, 0.35 * (1 - d / (radius * 1.7)))
      }
    }
    const hitOne = (id: number, feet: THREE.Vector3, h: number, heavy: boolean) => {
      const center = tmp2.copy(feet).setY(feet.y + h)
      const dist = Math.max(0, center.distanceTo(pos) - (heavy ? h * 0.5 : 0))
      if (dist > radius + 0.5) return
      if (dist > 1.5 && !this.lineOfSight(pos, center)) return
      const dmg = splashDamage(damage, radius + 0.5, dist)
      if (dmg <= 0) return
      this.damage(id, { attacker, amount: dmg, source, from: pos.clone(), point: center.clone(), splash: true })
      if (id === 0 && this.player.alive) {
        const push = center.clone().sub(pos).normalize().multiplyScalar(dmg * 0.14 + 2)
        push.y = Math.max(push.y, 0) + 3 + dmg * 0.05
        this.player.impulse(push)
      }
    }
    if (this.player.alive && this.mode === 'playing') hitOne(0, this.player.position, 0.9, false)
    const friendly = this.onslaught && attacker !== 0 && attacker !== -1
    for (const b of this.bots) if (b.alive && !(friendly && b.wave)) hitOne(b.id, b.pos, 0.9 * b.scale, b.heavy)
    for (const h of this.hornets) {
      if (!h.alive || friendly) continue
      const dist = h.pos.distanceTo(pos)
      if (dist < radius + 0.5) this.damageDrone(h.id, { attacker, amount: splashDamage(damage, radius + 0.5, dist), source, from: pos.clone(), splash: true })
    }
    this.props.list.forEach((p, i) => {
      if (!p.alive) return
      const dist = p.spot.pos.distanceTo(pos)
      if (dist < radius * 0.9) this.props.damage(i, { attacker, amount: 200, source, from: pos.clone() }, this)
    })
  }

  fireRocket(owner: number, origin: THREE.Vector3, dir: THREE.Vector3, excludeHandle: number): void {
    const mesh = rocketMesh()
    mesh.position.copy(origin)
    mesh.lookAt(origin.clone().add(dir))
    mesh.rotateY(Math.PI)
    this.scene.add(mesh)
    const speed = WEAPONS.rocket.projectileSpeed ?? 44
    this.rockets.push({ pos: origin.clone(), vel: dir.clone().multiplyScalar(owner === 0 ? speed : speed * 0.62), owner, exclude: excludeHandle, life: 5, mesh, loop: this.audio.loop('rocket_loop', 0.5, origin), trail: 0 })
  }

  fireProjectile(owner: number, origin: THREE.Vector3, dir: THREE.Vector3, kind: ProjectileKind): void {
    this.projectiles.push({ pos: origin.clone(), vel: dir.clone().multiplyScalar(PROJ[kind].speed), owner, kind, life: 4 })
  }

  bossPhase(phase: number, at: THREE.Vector3): void {
    this.slowmoT = 1.3
    this.trauma = Math.min(1, this.trauma + 0.6)
    this.audio.play('boss_roar', { volume: 1.2, pos: at, ref: 12 })
    this.fx.slamWave(at, 8)
    this.events.wave(phase === 2
      ? { title: 'FASE II', subtitle: 'O GUARDIÃO ESTÁ FURIOSO · DRONES LANÇADOS', kind: 'phase' }
      : { title: 'FASE III', subtitle: 'NÚCLEO EXPOSTO · MIRE NO PEITO', kind: 'phase' })
  }

  bossSlam(at: THREE.Vector3, radius: number, damage: number, attacker: number): void {
    this.fx.slamWave(at, radius)
    this.audio.play('boss_slam', { volume: 1.3, pos: at, ref: 10 })
    const d = this.player.position.distanceTo(at)
    this.trauma = Math.min(1, this.trauma + Math.max(0, 1 - d / 30))
    if (this.player.alive && this.mode === 'playing' && d < radius && this.player.grounded) {
      const dmg = damage * (1 - d / radius) + 8
      this.damage(0, { attacker, amount: dmg, source: 'slam', from: at.clone(), splash: true })
      const push = this.player.position.clone().sub(at).setY(0).normalize().multiplyScalar(9)
      push.y = 5
      this.player.impulse(push)
    }
  }

  summonDrones(at: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const h = this.hornets.find(x => !x.alive && !x.falling)
      if (!h) return
      const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6))
      this.fx.spawnPortal(p, 0.6)
      h.spawn(p)
    }
    this.audio.play('spawn_in', { volume: 0.9, pos: at })
  }

  stomp(at: THREE.Vector3, weight: number): void {
    this.fx.stompDust(at, weight * 1.6)
    const d = at.distanceTo(this.player.position)
    if (d < 40) {
      this.audio.play('mech_stomp', { volume: 0.5 + weight * 0.6, pos: at, jitter: 0.08, ref: 6 })
      this.trauma = Math.min(1, this.trauma + Math.max(0, 1 - d / 26) * 0.18 * weight)
    }
  }

  // ─── match flow ───────────────────────────────────────────────────────
  private chooseSpawn(forId: number, minDist = 0): { pos: THREE.Vector3; yaw: number } {
    const enemies: THREE.Vector3[] = []
    if (forId !== 0 && this.player.alive && this.mode !== 'attract') enemies.push(this.player.position)
    for (const b of this.bots) if (b.alive && b.id !== forId) enemies.push(b.pos)
    for (const h of this.hornets) if (h.alive && forId === 0) enemies.push(h.pos)
    const scored = this.arena.spawns.map(s => {
      let min = Infinity
      for (const e of enemies) min = Math.min(min, e.distanceTo(s))
      let visible = false
      for (const e of enemies) {
        if (e.distanceTo(s) < 40 && this.lineOfSight(tmp.copy(s).setY(s.y + 1.6), tmp2.copy(e).setY(e.y + 1.5))) {
          visible = true
          break
        }
      }
      const tooClose = min < minDist ? -60 : 0
      return { s, score: min + (visible ? -25 : 0) + tooClose + Math.random() * 8 }
    })
    scored.sort((a, b) => b.score - a.score)
    const pos = scored[0].s.clone()
    return { pos, yaw: Math.atan2(pos.x - this.arena.origin.x, pos.z - this.arena.origin.z) }
  }

  /** Onslaught: spawn somewhere 14–40 m from the player, preferably out of sight. */
  private waveSpawnPoint(): THREE.Vector3 {
    const pp = this.player.position
    const eye = tmp3.copy(pp).setY(pp.y + 1.6)
    const cands = this.arena.spawns.map(s => {
      const d = s.distanceTo(pp)
      const vis = d < 45 && this.lineOfSight(tmp.copy(s).setY(s.y + 1.4), eye)
      const taken = this.pending.some(p => p.pos.distanceTo(s) < 2.5) || this.bots.some(b => b.alive && b.pos.distanceTo(s) < 2.5)
      return { s, score: (d < 14 ? -80 : 0) + (d > 40 ? -20 : 0) + (vis ? -15 : 0) + (taken ? -50 : 0) + Math.random() * 20 }
    })
    cands.sort((a, b) => b.score - a.score)
    return cands[0].s.clone()
  }

  private enterAttract(): void {
    this.mode = 'attract'
    this.audio.restoreWorld()
    this.audio.setPaused(false)
    this.clearWorld()
    this.player.alive = false
    this.player.body.setNextKinematicTranslation({ x: 0, y: -80, z: 0 })
    this.player.body.setTranslation({ x: 0, y: -80, z: 0 }, true)
    this.arsenal.holder.visible = false
    for (const b of this.dmBots.slice(0, 6)) {
      const s = this.chooseSpawn(b.id)
      b.spawn(s.pos, s.yaw)
    }
  }

  private clearWorld(): void {
    for (const r of this.rockets) {
      r.loop?.stop()
      this.scene.remove(r.mesh)
    }
    this.rockets = []
    this.projectiles = []
    for (const g of this.grenadesLive) this.scene.remove(g.mesh)
    this.grenadesLive = []
    this.shards = []
    this.pending = []
    this.spawnQueue = []
    this.fx.clear()
    this.fx.clearDecals()
    this.props.reset()
    this.pickups.reset()
    for (const b of this.bots) b.hide()
    for (const h of this.hornets) h.hide()
    this.boss = null
    this.endOverdrive(true)
  }

  /** `net`: play the tactical mode online, with the server as the authority. */
  /** `map`: play on another map (practice; never ranked). */
  start(mode: GameMode = this.gameMode, net: NetLink | null = null, map: MapId | null = null): void {
    tuning.activate('run')
    this.audio.restoreWorld()
    this.audio.setPaused(false)
    this.tactical?.dispose()
    this.tactical = null
    this.useMap(net ? net.map : (map ?? MODE_MAP[mode]))
    this.clearWorld()
    this.gameMode = mode
    const tac = mode === 'tactical'
    setWeaponProfile(tac ? 'tactical' : 'arcade')
    this.props.setActive(!tac)
    this.pickups.setActive(!tac)
    this.player.regen = !tac
    this.player.absorb = tac ? 1 : CONFIG.player.armorAbsorb
    this.player.speedScale = 1
    this.player.maxHealth = CONFIG.player.maxHealth
    if (mode === 'deathmatch') this.ensureDmSentinels()
    const count = Math.min(CONFIG.bots.count, this.dmBots.length)
    this.match = { ...createMatch(this.dmBots.slice(0, count).map(b => b.name)), unranked: tuning.unranked || !!map }
    this.renderer.fx.damage = 0
    this.renderer.fx.lowHealth = 0
    this.perks = {}
    this.applyPerks()
    this.player.maxArmor = CONFIG.player.maxArmor
    this.arsenal.reset()
    this.style = newStyle()
    this.kills = this.headshots = this.shots = this.hits = 0
    this.runTime = 0
    this.wave = 0
    this.wavePhase = 'none'
    this.lastKillWeapons = []
    this.grenades = 2
    if (tac) {
      this.tactical = new TacticalMatch(this, net ? net.state.cfg.teamSize : this.teamSize, net)
      // Compile the tactical bots, outlines, spike and smoke now (buy phase) instead of on first sight.
      this.prewarm()
    } else if (mode === 'onslaught') {
      this.ensurePool()
      if (this.arsenal.slots.rocket.owned) this.arsenal.slots.rocket.owned = false
      const s = this.chooseSpawn(0)
      this.player.spawn(s.pos, s.yaw)
      this.player.armor = this.player.maxArmor
    } else {
      if (this.stageGate.isReady(3)) this.upgradeRocket()
      const s = this.chooseSpawn(0)
      this.player.spawn(s.pos, s.yaw)
      // Out of attract now, so bot spawns score against the player's position too.
      this.mode = 'countdown'
      for (const b of this.dmBots.slice(0, count)) {
        const bs = this.chooseSpawn(b.id)
        b.spawn(bs.pos, bs.yaw)
      }
    }
    this.player.protect = 0
    this.slowmo = 1
    this.mode = 'countdown'
    this.countdownT = 3.2
    this.lastCount = 4
    // Tactical rounds have their own buy-phase countdown.
    if (tac) {
      this.mode = 'playing'
      this.countdownT = 0
    }
    this.killerId = -1
    this.audio.startAmbience()
    this.audio.playMusic('combat', 2.5, true)
    // Current + next stage first; everything else streams in the background.
    void this.stageGate.ensure(2)
  }

  private upgradeRocket(): void {
    if (this.rocketUpgraded) return
    this.arsenal.upgradeRocket()
    this.rocketUpgraded = true
  }

  pause(): void {
    if (this.mode === 'playing' || this.mode === 'countdown') {
      this.mode = 'paused'
      this.audio.setPaused(true)
    }
  }
  resume(): void {
    if (this.mode === 'paused') this.mode = this.countdownT > 0 ? 'countdown' : 'playing'
    this.audio.setPaused(false)
  }
  toTitle(): void {
    this.tactical?.dispose()
    this.tactical = null
    setWeaponProfile('arcade')
    this.useMap('aurora')
    this.props.setActive(true)
    this.pickups.setActive(true)
    this.player.regen = true
    this.player.absorb = CONFIG.player.armorAbsorb
    this.audio.stopAmbience()
    this.audio.playMusic('title', 1.5)
    this.events.perks(null)
    this.enterAttract()
  }

  private playerDied(info: DamageInfo): void {
    this.player.alive = false
    this.player.deadTime = 0
    this.killerId = info.attacker
    this.deathYaw = this.player.yaw
    this.deathPitch = this.player.pitch
    this.respawnT = CONFIG.player.respawnDelay
    this.player.body.setNextKinematicTranslation({ x: 0, y: -80, z: 0 })
    const killer = info.attacker === 0 ? 'YOURSELF' : this.nameOf(info.attacker)
    this.events.died(killer, SOURCE_LABEL[info.source])
    this.renderer.fx.damage = 1
    // Onslaught death is game over: cut the music and every world sound right away, then let
    // only the death sting (and later the defeat sting) play.
    if (this.onslaught) this.audio.silenceWorld(0.2)
    this.audio.play('robot_death', { volume: 0.5, rate: 0.6, force: true })
    this.slowmoT = 1.2
    if (this.tactical) {
      if (info.source !== 'spike') this.events.killfeed(this.feedEntry(info.attacker, 0, info))
      this.tactical.onDeath(0, info.attacker, this.player.position.clone())
      return
    }
    if (this.onslaught) {
      this.events.killfeed(this.feedEntry(info.attacker, 0, info))
      window.setTimeout(() => {
        if (this.mode === 'playing') this.endMatch(false)
      }, 1800)
      return
    }
    this.recordKill(info.attacker, 0, info)
  }

  private botDied(bot: Bot, info: DamageInfo): void {
    const at = bot.pos.clone().setY(bot.pos.y + 1.1 * bot.scale)
    bot.shatter(info.from, info.splash ? 1.8 : 1)
    bot.respawnIn = bot.wave ? 1e9 : CONFIG.bots.respawnDelay
    const big = bot.kind === 'juggernaut' || bot.kind === 'titan'
    if (bot.parts.human) {
      // Soldiers drop; no detonation.
      this.fx.humanHit(at, tmp.copy(at).sub(info.from).setY(0).normalize(), true)
      this.audio.play('human_death', { volume: 0.9, pos: at, ref: 5, jitter: 0.08 })
    } else {
      this.fx.explosion(at, big ? (bot.kind === 'titan' ? 1.6 : 0.9) : 0.42, UP)
      this.fx.sparks(at, UP, big ? 80 : 40, 12)
      this.audio.play('robot_death', { volume: 1, pos: at, ref: 6 })
      this.audio.play('explosion', { volume: big ? 1.2 : 0.55, pos: at, rate: big ? 0.8 : 1.3 })
    }
    if (info.attacker === 0) {
      this.audio.cue(info.headshot ? 'head' : 'kill', 1)
      this.audio.play(info.headshot ? 'headshot' : 'kill_confirm', { volume: 0.8 })
      this.trauma = Math.min(1, this.trauma + (big ? 0.5 : 0.12))
    }
    if (this.tactical && bot.team >= 0) {
      bot.respawnIn = 1e9
      if (info.source !== 'spike') this.events.killfeed(this.feedEntry(info.attacker, bot.id, info))
      if (info.attacker === 0) {
        this.kills += 1
        if (info.headshot) this.headshots += 1
      }
      this.tactical.onDeath(bot.id, info.attacker, bot.pos.clone())
      return
    }
    if (bot.wave) {
      this.enemyKilled(at, (bot.kind === 'breacher' ? 'scrapper' : bot.kind) as EnemyKind, info, big ? (bot.kind === 'titan' ? 1 : 2.5) : 1, bot.name)
      if (bot === this.boss) this.bossDown(at)
      return
    }
    this.recordKill(info.attacker, bot.id, info)
  }

  /** Onslaught kill: style, shards, hit-stop, killfeed. */
  private enemyKilled(at: THREE.Vector3, kind: EnemyKind, info: DamageInfo, scale: number, name?: string): void {
    if (!this.onslaught || this.mode !== 'playing') return
    this.events.killfeed(this.feedEntry(info.attacker, -2, info, name ?? ENEMY_NAME[kind]))
    this.dropShards(at, kind, info)
    if (info.attacker !== 0) return
    this.kills += 1
    if (info.headshot) this.headshots += 1
    this.hitstop = kind === 'titan' ? 0.25 : scale > 1 ? 0.09 : 0.045
    const e = perkEffects(this.perks)
    if (e.vampire) this.player.health = Math.min(this.player.maxHealth, this.player.health + e.vampire)
    const evs: StyleEvent[] = kind === 'titan' ? ['boss'] : ['kill']
    const dist = at.distanceTo(this.player.position)
    if (info.headshot) evs.push('headshot')
    if (this.time - this.lastKillT < 1.3) evs.push('multi')
    if (!this.player.grounded && this.player.airTime > 0.25) evs.push('airborne')
    if (this.player.sliding > 0) evs.push('slide')
    if (info.source === 'grenade') evs.push('grenade')
    else if (info.source === 'rocket' || info.source === 'barrel') evs.push('explosive')
    if (info.source === 'shotgun' && dist < 3.2) evs.push('overkill')
    if (dist > 30) evs.push('longshot')
    const w = info.source
    if (this.lastKillWeapons.length >= 2 && !this.lastKillWeapons.includes(w)) evs.push('arsenal')
    this.lastKillWeapons = [w, ...this.lastKillWeapons].slice(0, 2)
    this.lastKillT = this.time
    for (const ev of evs) this.awardStyle(ev, ev === 'kill' ? scale : 1)
  }

  private awardStyle(ev: StyleEvent, scale = 1): void {
    const g = awardStyle(this.style, ev, perkEffects(this.perks).overclock * (this.overdriveT > 0 ? 0 : 1), scale * (this.overdriveT > 0 ? 1.5 : 1))
    const wasReady = this.style.overdrive >= 1
    this.style = g.state
    this.events.style({ label: g.label, points: Math.round(g.points * RANK_MULT[this.style.rank]), rank: this.style.rank, rankedUp: g.rankedUp })
    if (g.rankedUp) this.audio.play('rank_up', { volume: 0.7, rate: 0.9 + this.style.rank * 0.05, jitter: 0 })
    if (!wasReady && this.style.overdrive >= 1) this.events.message('OVERDRIVE PRONTO · APERTE F', 'good')
  }

  private bossDown(at: THREE.Vector3): void {
    this.slowmoT = 2.2
    this.boss = null
    this.renderer.fx.flash = 0.6
    for (let i = 0; i < 5; i += 1) {
      window.setTimeout(() => {
        const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5))
        this.fx.explosion(p, 0.9, UP)
        this.audio.play('explosion', { volume: 1, pos: p, rate: 0.8 + Math.random() * 0.4 })
        this.trauma = Math.min(1, this.trauma + 0.35)
      }, 180 + i * 260)
    }
    // Remaining minions collapse with their master.
    window.setTimeout(() => {
      for (const b of this.bots) if (b.alive && b.wave) this.damage(b.id, { attacker: -1, amount: 9999, source: 'slam', from: at.clone(), splash: true })
      for (const h of this.hornets) if (h.alive) this.damageDrone(h.id, { attacker: -1, amount: 9999, source: 'slam', from: at.clone() })
    }, 900)
  }

  private recordKill(killer: number, victim: number, info: DamageInfo): void {
    if (this.mode !== 'playing') {
      if (this.mode === 'attract') this.events.killfeed(this.feedEntry(killer, victim, info))
      return
    }
    const k = killer < 0 ? victim : killer
    const res = registerKill(this.match, { killer: k, victim, headshot: info.headshot, weapon: info.source })
    this.match = res.state
    this.events.killfeed(this.feedEntry(killer, victim, info))
    if (res.medals.length) {
      this.events.medals(res.medals)
      this.audio.cue('medal', 0.9)
    }
    if (this.match.phase !== 'playing') this.endMatch()
  }

  private feedEntry(killer: number, victim: number, info: DamageInfo, victimName?: string): KillFeedEntry {
    return {
      killer: killer < 0 && victim >= 0 ? this.nameOf(victim) : this.nameOf(killer),
      victim: victimName ?? this.nameOf(victim),
      weapon: SOURCE_LABEL[info.source],
      headshot: !!info.headshot,
      killerIsPlayer: killer === 0,
      victimIsPlayer: victim === 0,
      killerColor: this.colorOf(killer < 0 && victim >= 0 ? victim : killer),
      victimColor: victimName ? '#ff7a4a' : this.colorOf(victim),
    }
  }

  private endMatch(won?: boolean): void {
    if (this.mode === 'ended') return
    this.mode = 'ended'
    this.endT = 0
    this.slowmo = 0.25
    this.endOverdrive(true)
    this.events.perks(null)
    let summary: RunSummary | undefined
    if (this.gameMode === 'onslaught') {
      const w = !!won
      this.match = { ...this.match, phase: w ? 'won' : 'lost' }
      summary = {
        mode: 'onslaught', won: w, wave: this.wave + 1, waves: WAVES.length, score: this.style.score + (w ? 5000 : 0),
        kills: this.kills, headshots: this.headshots, accuracy: this.shots ? this.hits / this.shots : 0,
        bestRank: RANKS[this.style.best], time: this.runTime, unranked: tuning.unranked,
      }
    } else this.match = { ...this.match, score: computeScore(this.match) }
    // Results screen: no music, no lingering gunfire/explosions/footsteps from the slow-mo world.
    this.audio.silenceWorld(0.3)
    const victory = this.match.phase === 'won'
    this.audio.play(victory ? 'victory' : 'defeat', { volume: 1, jitter: 0, force: true })
    if (victory && this.gameMode === 'onslaught') this.events.wave({ title: 'RIFT SELADA', subtitle: 'TODAS AS ONDAS LIMPARAS', kind: 'victory' })
    this.input.unlockPointer()
    window.setTimeout(() => this.events.ended(this.match, summary), victory ? 2600 : 1600)
  }

  // ─── Onslaught director ───────────────────────────────────────────────
  private get plan() {
    return WAVES[Math.min(this.wave, WAVES.length - 1)]
  }

  private beginWave(i: number): void {
    this.wave = i
    const plan = this.plan
    if (!this.stageGate.isReady(plan.stage as StageId)) {
      this.wavePhase = 'loading'
      this.events.loading('TRANSMISSÃO RECEBIDA · SINCRONIZANDO ONDA')
      void this.stageGate.ensure(plan.stage as StageId)
      return
    }
    this.events.loading(null)
    this.wavePhase = 'intro'
    this.phaseT = plan.boss ? 3.4 : 2.6
    this.spawnQueue = spawnOrder(plan)
    this.spawnT = 1.4
    this.events.wave({ title: plan.title, subtitle: plan.subtitle, kind: plan.boss ? 'boss' : 'intro' })
    this.audio.play(plan.boss ? 'boss_roar' : 'wave_start', { volume: plan.boss ? 0.8 : 0.9, jitter: 0 })
    if (plan.boss) this.audio.playMusic('boss', 2, true)
    if (i === 1) this.events.message('GRANADAS ATIVAS · APERTE G', 'good')
    if (plan.stage >= 3 && !this.arsenal.slots.rocket.owned) {
      this.upgradeRocket()
      this.arsenal.give('rocket')
      this.events.pickup('LANÇADOR RPG-X · APERTE 3', '#ff4a2a')
      this.audio.play('weapon_switch', { volume: 0.8 })
    }
    // Keep the next stage warm while this wave is still calm.
    const next = WAVES[i + 1]
    if (next) void this.stageGate.ensure(next.stage as StageId)
  }

  private aliveEnemies(): number {
    let n = 0
    for (const b of this.bots) if (b.alive && b.wave) n += 1
    for (const h of this.hornets) if (h.alive) n += 1
    return n
  }

  get enemiesLeft(): number {
    return this.aliveEnemies() + this.pending.length + this.spawnQueue.length
  }

  private stepDirector(dt: number): void {
    switch (this.wavePhase) {
      case 'loading':
        if (this.stageGate.isReady(this.plan.stage as StageId)) this.beginWave(this.wave)
        return
      case 'intro':
        this.phaseT -= dt
        if (this.phaseT <= 0) this.wavePhase = 'fight'
        this.stepSpawns(dt, this.phaseT < 1.2)
        return
      case 'fight':
        this.stepSpawns(dt, true)
        if (!this.spawnQueue.length && !this.pending.length && this.aliveEnemies() === 0) this.waveCleared()
        return
      case 'clear':
        this.phaseT -= dt
        if (this.phaseT <= 0) {
          if (this.wave >= WAVES.length - 1) {
            this.endMatch(true)
            return
          }
          const offer = offerPerks(this.perks)
          if (!offer.length) {
            this.wavePhase = 'next'
            this.phaseT = 1.5
            return
          }
          this.perkOffer = offer
          this.wavePhase = 'perk'
          this.events.perks(offer)
        }
        return
      case 'perk':
        if (this.input.consume('slot1')) this.choosePerk(0)
        else if (this.input.consume('slot2')) this.choosePerk(1)
        else if (this.input.consume('slot3')) this.choosePerk(2)
        return
      case 'next':
        this.phaseT -= dt
        if (this.phaseT <= 0) this.beginWave(this.wave + 1)
        return
    }
  }

  get choosingPerk(): boolean {
    return this.wavePhase === 'perk'
  }

  choosePerk(i: number): void {
    if (this.wavePhase !== 'perk' || !this.perkOffer?.[i]) return
    const p = this.perkOffer[i]
    this.perks = { ...this.perks, [p.id]: (this.perks[p.id] ?? 0) + 1 }
    this.applyPerks()
    if (p.id === 'plated') this.player.armor = this.player.maxArmor
    if (p.id === 'demolitions') this.grenades = perkEffects(this.perks).grenades
    this.events.perkChosen?.(i)
    this.audio.play('perk_pick', { volume: 0.9, jitter: 0 })
    this.events.pickup(p.name, '#ffc23f')
    this.events.perks(null)
    this.perkOffer = null
    this.wavePhase = 'next'
    this.phaseT = 1.6
  }

  private applyPerks(): void {
    const e = perkEffects(this.perks)
    const m = this.arsenal.mods
    m.rifleDamage = e.rifleDamage
    m.reload = e.reloadSpeed
    m.shotgunSpread = e.shotgunSpread
    m.shotgunDamage = e.shotgunDamage
    this.player.maxArmor = e.maxArmor
  }

  private waveCleared(): void {
    this.wavePhase = 'clear'
    this.phaseT = 2.6
    this.awardStyle('wave')
    const final = this.wave >= WAVES.length - 1
    this.audio.play('wave_clear', { volume: 0.9, jitter: 0 })
    if (!final) this.events.wave({ title: `ONDA ${this.wave + 1} LIMPA`, subtitle: 'REABASTECIMENTO · +25 VIDA · GRANADAS RESTAURADAS', kind: 'clear' })
    this.player.health = Math.min(this.player.maxHealth, this.player.health + 25)
    this.grenades = Math.max(this.grenades, perkEffects(this.perks).grenades)
    for (const id of ['rifle', 'shotgun', 'rocket'] as WeaponId[]) {
      const s = this.arsenal.slots[id]
      if (s.owned) s.reserve = Math.min(WEAPONS[id].reserveMax, s.reserve + Math.ceil(WEAPONS[id].reserveMax * 0.3))
    }
    for (const s of this.shards) s.life = Math.min(s.life, 3)
    this.shardVacuum = 3
    const next = WAVES[this.wave + 1]
    if (next) void this.stageGate.ensure(next.stage as StageId)
  }
  private shardVacuum = 0

  private stepSpawns(dt: number, allowed: boolean): void {
    this.spawnT -= dt
    const alive = this.aliveEnemies()
    if (allowed && this.spawnQueue.length && this.spawnT <= 0 && alive + this.pending.length < MAX_ALIVE) {
      const kind = this.spawnQueue.shift()!
      const pos = this.waveSpawnPoint()
      const air = kind === 'hornet'
      if (air) pos.y += 4 + Math.random() * 2
      const scale = kind === 'titan' ? 2.6 : kind === 'juggernaut' ? 1.6 : air ? 0.6 : 1
      this.fx.spawnPortal(air ? pos : pos.clone(), scale)
      this.audio.play('spawn_in', { volume: kind === 'titan' ? 1.3 : 0.8, pos, ref: 6 })
      this.pending.push({ kind, pos, yaw: Math.atan2(pos.x - this.player.position.x, pos.z - this.player.position.z), t: kind === 'titan' ? 1.8 : 0.85 })
      this.spawnT = kind === 'scrapper' ? 0.75 + Math.random() * 0.5 : 1.5
    }
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const p = this.pending[i]
      p.t -= dt
      if (Math.random() < 0.5) this.fx.spawnPortal(p.pos, 0.001 + (p.kind === 'titan' ? 0.5 : 0.2))
      if (p.t > 0) continue
      this.pending.splice(i, 1)
      if (!this.materialize(p)) this.spawnQueue.unshift(p.kind)
    }
  }

  private materialize(p: PendingSpawn): boolean {
    if (p.kind === 'hornet') {
      const h = this.hornets.find(x => !x.alive && !x.falling)
      if (!h) return false
      h.spawn(p.pos)
      this.fx.spawnPortal(p.pos, 0.7)
      return true
    }
    const free = this.waveBots[p.kind].find(x => !x.alive && !x.parts.root.visible) ?? this.waveBots[p.kind].find(x => !x.alive)
    if (!free) return false
    free.spawn(p.pos, p.yaw + Math.PI)
    this.fx.spawnPortal(p.pos, p.kind === 'titan' ? 2.8 : p.kind === 'juggernaut' ? 1.6 : 1)
    this.fx.slamWave(p.pos, p.kind === 'titan' ? 10 : 3)
    if (p.kind === 'titan') {
      this.boss = free
      this.trauma = Math.min(1, this.trauma + 0.8)
      this.audio.play('boss_roar', { volume: 1.3, pos: p.pos, ref: 14 })
      this.slowmoT = 1
    }
    return true
  }

  isBusy(): boolean {
    if (this.mode !== 'playing' && this.mode !== 'countdown') return false
    return this.aliveEnemies() > 5 || this.fx.particleCount > 1600 || this.rockets.length + this.projectiles.length > 6
  }

  // ─── player abilities ─────────────────────────────────────────────────
  get grenadesUnlocked(): boolean {
    if (this.tactical) return true
    return this.onslaught ? this.wave >= 1 && this.stageGate.isReady(2) : this.stageGate.isReady(2)
  }

  private throwGrenade(): void {
    if (this.grenades <= 0 || this.grenadeCd > 0 || !this.grenadesUnlocked) return
    this.grenades -= 1
    this.tactical?.usedGrenade()
    this.grenadeCd = 0.7
    const eye = this.player.eye(1, tmp).clone()
    const fwd = this.player.forward(tmp2).clone()
    const mesh = grenadeMesh()
    const pos = eye.addScaledVector(fwd, 0.5).add(new THREE.Vector3(0, -0.12, 0))
    mesh.position.copy(pos)
    this.scene.add(mesh)
    const vel = fwd.multiplyScalar(17).add(new THREE.Vector3(0, 3.6, 0)).addScaledVector(this.player.velocity, 0.5)
    this.grenadesLive.push({ pos, vel, fuse: 1.6, mesh, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12), bounceCd: 0 })
    this.audio.play('grenade_throw', { volume: 0.9 })
    this.arsenal.punch.pitch -= 0.02
    this.arsenal.punch.roll += 0.03
  }

  private activateOverdrive(): void {
    if (this.overdriveT > 0 || this.style.overdrive < 1) return
    this.overdriveT = 7
    this.style = { ...this.style, overdrive: 0 }
    const m = this.arsenal.mods
    m.damage = 1.5
    m.rate = 1.3
    m.infinite = true
    this.audio.play('overdrive_on', { volume: 1, jitter: 0 })
    this.events.overdrive(true)
    this.slowmoT = 0.5
    this.trauma = Math.min(1, this.trauma + 0.3)
    this.renderer.fx.flash = 0.35
    this.fx.slamWave(this.player.position.clone(), 6)
    this.awardStyle('overdrive')
  }

  private endOverdrive(silent = false): void {
    const m = this.arsenal.mods
    m.damage = 1
    m.rate = 1
    m.infinite = false
    if (this.overdriveT > 0 && !silent) this.events.overdrive(false)
    this.overdriveT = 0
    this.renderer.fx.overdrive = 0
  }

  // ─── simulation ───────────────────────────────────────────────────────
  step(rawDt: number): void {
    if (this.mode === 'paused') return
    let dt = rawDt
    if (this.mode === 'ended') {
      this.endT += dt
      this.slowmo = Math.min(1, this.slowmo + dt * 0.5)
      dt *= this.slowmo
    }
    // Juice: hit-stop on kills, slow-mo on big moments (arcade modes only: tactical stays real-time).
    if (this.tactical) this.hitstop = this.slowmoT = 0
    if (this.hitstop > 0) {
      this.hitstop -= rawDt
      dt *= 0.12
    } else if (this.slowmoT > 0) {
      this.slowmoT -= rawDt
      dt *= 0.4
    }
    this.time += dt
    this.hurtT = Math.max(0, this.hurtT - dt)
    this.grenadeCd = Math.max(0, this.grenadeCd - dt)
    this.weakPopT = Math.max(0, this.weakPopT - dt)
    const input = this.input
    if (this.mode === 'countdown') {
      this.countdownT -= dt
      const n = Math.ceil(this.countdownT)
      if (n !== this.lastCount && n >= 0) {
        this.lastCount = n
        if (n > 0) {
          this.events.countdown(n)
          this.audio.cue('beep')
        }
      }
      if (this.countdownT <= 0) {
        this.mode = 'playing'
        this.events.countdown(0)
        this.audio.play('match_start', { volume: 0.9, jitter: 0 })
        this.audio.cue('go')
        if (this.gameMode === 'onslaught') this.beginWave(0)
      }
    }
    const playing = this.mode === 'playing'
    const controllable = playing && this.player.alive
    if (this.mode !== 'attract') {
      // Tactical movement: no sprint or slide; Shift walks quietly at half speed.
      const tac = !!this.tactical
      if (tac) this.player.speedScale = (controllable && input.held('sprint') ? 0.55 : 1) * this.arsenal.speedScale
      const intent = {
        x: controllable ? input.move.x : 0,
        y: controllable ? input.move.y : 0,
        jump: controllable && input.consume('jump'),
        sprint: controllable && !tac && input.held('sprint'),
        ads: controllable && input.held('ads'),
        slide: controllable && !tac && input.consume('slide'),
        crouch: controllable && input.held('slide'),
      }
      const res = this.player.step(dt, intent)
      if (res.jumped) this.audio.play('footstep', { volume: 0.4, rate: 1.1 })
      if (res.landed > 3) {
        this.audio.play('land', { volume: Math.min(1, res.landed / 12), jitter: 0.08 })
        if (res.landed > 9) this.fx.stompDust(this.player.position, 0.5)
      }
      if (res.slid) {
        this.audio.play('slide', { volume: 0.8, jitter: 0.05 })
        this.fx.stompDust(this.player.position, 0.4)
      }
      if (this.player.sliding > 0 && Math.random() < 0.5) this.fx.stompDust(this.player.position, 0.2)
      if (this.player.grounded && this.player.alive && this.player.sliding <= 0) {
        this.footDist += this.player.speed2d * dt
        const stride = this.player.sprinting ? 2.7 : 2.1
        if (this.footDist > stride) {
          this.footDist = 0
          this.audio.play('footstep', { volume: this.player.sprinting ? 0.5 : 0.35, jitter: 0.12 })
        }
      }
    }
    if (controllable) {
      const perk = this.wavePhase === 'perk'
      if (!perk && this.tactical) {
        // 1 = primary (if bought), 2 = pistol.
        const owned = (Object.keys(this.arsenal.slots) as WeaponId[]).filter(id => this.arsenal.slots[id].owned)
        const sidearm = (id: WeaponId) => id === 'pistol' || WEAPONS[id].gun?.cls === 'pistol'
        if (input.consume('slot1')) {
          const primary = owned.find(id => !sidearm(id) && id !== 'rocket')
          if (primary) this.arsenal.select(primary)
        }
        if (input.consume('slot2')) {
          const side = owned.find(sidearm)
          if (side) this.arsenal.select(side)
        }
        input.consume('slot3')
        if (input.consume('smoke')) this.tactical.throwSmoke()
      } else if (!perk) {
        if (input.consume('slot1')) this.arsenal.select('rifle')
        if (input.consume('slot2')) this.arsenal.select('shotgun')
        if (input.consume('slot3')) this.arsenal.select('rocket')
      }
      if (input.consume('nextWeapon')) this.arsenal.cycle(1)
      if (input.consume('prevWeapon')) this.arsenal.cycle(-1)
      if (input.consume('lastWeapon')) this.arsenal.quickSwitch()
      if (input.consume('grenade')) this.throwGrenade()
      if (input.consume('overdrive')) this.activateOverdrive()
      const eye = this.player.eye(1, tmp).clone()
      // Holding F to plant/defuse puts the gun away.
      const channel = !!this.tactical && input.held('interact')
      this.arsenal.step(dt, { fire: !channel && input.held('fire'), firePressed: input.consume('fire') && !channel, ads: input.held('ads'), adsPressed: input.consume('ads'), reload: input.consume('reload') }, eye, this.player.sprinting)
      if (this.arsenal.shotsThisStep) {
        this.shots += this.arsenal.shotsThisStep
        this.hits += this.arsenal.hitsThisStep
        if (!this.onslaught) this.match = recordShot(this.match, this.arsenal.shotsThisStep, this.arsenal.hitsThisStep)
      }
      const s = this.arsenal.slot
      const low = s.mag <= Math.ceil(this.arsenal.def.mag * 0.25)
      if (low && !this.lowAmmoWarned && s.reserve > 0) this.lowAmmoWarned = true
      if (!low) this.lowAmmoWarned = false
    } else {
      // Dead in a tactical round: click to cycle the spectated teammate.
      if (this.tactical && playing && !this.player.alive && input.consume('fire')) this.tactical.nextSpectate()
      input.consume('fire')
      input.consume('reload')
      input.consume('grenade')
      input.consume('overdrive')
      if (this.mode === 'countdown' && this.player.alive) {
        this.arsenal.step(dt, { fire: false, firePressed: false, ads: false, reload: false }, this.player.eye(1, tmp).clone(), false)
      }
    }
    // Overdrive + style.
    if (this.overdriveT > 0) {
      this.overdriveT -= dt
      this.renderer.fx.overdrive = Math.min(1, this.overdriveT * 2) * (0.85 + Math.sin(this.time * 9) * 0.15)
      if (this.overdriveT <= 0) this.endOverdrive()
    }
    if (this.onslaught && playing) {
      this.runTime += dt
      if (this.overdriveT <= 0) this.style = decayStyle(this.style, dt)
      this.stepDirector(dt)
    }
    // Deathmatch respawn.
    if (playing && !this.player.alive && !this.onslaught && !this.tactical) {
      this.respawnT -= dt
      if (this.respawnT <= 0) {
        const s = this.chooseSpawn(0)
        this.player.spawn(s.pos, s.yaw)
        this.arsenal.reset()
        this.renderer.fx.damage = 0
        this.events.respawned()
      }
    }
    // Robots.
    const targets: Target[] = []
    const tac = this.tactical
    if (this.mode !== 'attract') targets.push({ id: 0, pos: this.player.position, vel: this.player.velocity, alive: this.player.alive && this.player.protect <= 0, isPlayer: true, h: 1 - this.player.crouch * 0.45, team: tac ? 0 : undefined })
    if (tac) for (const b of tac.bots) targets.push({ id: b.id, pos: b.pos, vel: b.vel, alive: b.alive, isPlayer: false, team: b.team })
    else if (!this.onslaught) for (const b of this.dmBots) targets.push({ id: b.id, pos: b.pos, vel: b.vel, alive: b.alive, isPlayer: false })
    const items: ItemInfo[] = this.onslaught || tac ? [] : this.pickups.list.map(p => ({ pos: p.spot.pos, kind: p.spot.kind, available: p.available }))
    const frozen = this.mode === 'countdown' || this.mode === 'ended' || (!!tac && tac.state.phase === 'buy')
    const ctx: BrainContext = { targets, items, hotspots: this.hotspots, playerEye: this.eyePos, playerId: 0, frozen, objective: tac?.objective }
    const activeDm = this.mode === 'attract' ? 6 : this.onslaught || tac ? 0 : Math.min(CONFIG.bots.count, this.dmBots.length)
    for (let i = 0; i < this.dmBots.length; i += 1) {
      const b = this.dmBots[i]
      if (i >= activeDm) continue
      if (!b.alive) {
        b.respawnIn -= dt
        if (b.respawnIn <= 0 && this.mode !== 'ended') {
          const s = this.chooseSpawn(b.id)
          b.spawn(s.pos, s.yaw)
          this.fx.spawnPortal(s.pos, 1)
        }
        continue
      }
      b.update(dt, ctx, this.dmBots)
      this.botFootsteps(b, dt)
    }
    if (tac) {
      const list = tac.bots
      for (const b of list) {
        if (!b.alive) continue
        // Remote players are posed by the director from network frames.
        if (!b.remote) b.update(dt, ctx, list)
        this.botFootsteps(b, dt)
      }
    }
    if (this.onslaught) {
      const wave = this.bots.filter(b => b.wave)
      for (const b of wave) {
        if (!b.alive) continue
        b.update(dt, ctx, wave)
        if (b.kind === 'scrapper') this.botFootsteps(b, dt)
      }
      const pt = { pos: this.player.position, vel: this.player.velocity, alive: this.player.alive }
      for (const h of this.hornets) if (h.alive || h.falling) h.update(dt, pt, ctx.frozen)
    }
    this.stepRockets(dt)
    this.stepProjectiles(dt)
    this.stepGrenades(dt)
    this.stepShards(dt)
    this.props.update(dt, this, pos => {
      if (this.player.alive && this.player.position.distanceTo(pos) < 1.4) return true
      return this.bots.some(b => b.alive && b.pos.distanceTo(pos) < 1.4 * b.scale)
    })
    this.pickups.update(dt, this.time)
    this.collectPickups()
    if (playing && tac) {
      this.runTime += dt
      tac.step(dt)
    } else if (playing && !this.onslaught) {
      this.match = tick(this.match, dt)
      if (this.match.phase !== 'playing') this.endMatch()
    }
    this.physics.step(dt)
  }

  private botFootsteps(b: Bot, dt: number): void {
    if (this.mode === 'attract') return
    const d = b.pos.distanceTo(this.player.position)
    if (d > 20) return
    const acc = (this.botFoot.get(b.id) ?? 0) + Math.hypot(b.vel.x, b.vel.z) * dt
    if (acc > 1.9) {
      this.audio.play(b.parts.human ? 'footstep' : 'robot_step', { volume: b.parts.human ? 0.4 : 0.55, pos: b.pos.clone().setY(b.pos.y + 0.1), jitter: 0.1, ref: 3 })
      this.botFoot.set(b.id, 0)
    } else this.botFoot.set(b.id, acc)
  }

  // ─── rift shards ──────────────────────────────────────────────────────
  private dropShards(at: THREE.Vector3, kind: EnemyKind, info: DamageInfo): void {
    const base = { scrapper: 3, hornet: 2, juggernaut: 8, titan: 26 }[kind]
    const missing = 1 - this.player.health / this.player.maxHealth
    const lowAmmo = this.arsenal.slot.reserve < this.arsenal.def.mag
    let n = base
    // Doom-style: a point-blank shotgun kill ("overkill") showers health.
    const glory = info.attacker === 0 && info.source === 'shotgun' && at.distanceTo(this.player.position) < 3.2
    if (glory) n += 3
    for (let i = 0; i < n; i += 1) {
      const r = Math.random()
      const hW = 0.25 + missing * 0.8 + (glory ? 0.5 : 0)
      const aW = 0.3
      const mW = lowAmmo ? 0.6 : 0.3
      const k: ShardKind = r * (hW + aW + mW) < hW ? 'health' : r * (hW + aW + mW) < hW + aW ? 'armor' : 'ammo'
      const a = Math.random() * Math.PI * 2
      this.shards.push({ kind: k, pos: at.clone(), vel: new THREE.Vector3(Math.cos(a) * (1.5 + Math.random() * 2.5), 4 + Math.random() * 3, Math.sin(a) * (1.5 + Math.random() * 2.5)), life: 14, phase: Math.random() * 6, grounded: false })
    }
    if (this.shards.length > 80) this.shards.splice(0, this.shards.length - 80)
  }

  private stepShards(dt: number): void {
    const e = perkEffects(this.perks)
    this.shardVacuum = Math.max(0, this.shardVacuum - dt)
    const chest = tmp3.copy(this.player.position).setY(this.player.position.y + 0.9)
    const magnet = 3.4 * e.magnet
    for (let i = this.shards.length - 1; i >= 0; i -= 1) {
      const s = this.shards[i]
      s.life -= dt
      s.phase += dt
      if (s.life <= 0) {
        this.shards.splice(i, 1)
        continue
      }
      const d = s.pos.distanceTo(chest)
      const pull = this.player.alive && (d < magnet || this.shardVacuum > 0) && s.phase > 0.45
      if (pull) {
        const dir = tmp.subVectors(chest, s.pos).normalize()
        const sp = Math.max(s.vel.length(), 6) + dt * 40
        s.vel.lerp(dir.multiplyScalar(sp), Math.min(1, dt * 10))
        s.grounded = false
      } else if (!s.grounded) {
        s.vel.y -= 16 * dt
        s.vel.multiplyScalar(Math.exp(-0.6 * dt))
      }
      s.pos.addScaledVector(s.vel, dt)
      const g = this.arena.groundAt(s.pos.x, s.pos.z, s.pos.y + 0.5) + 0.25
      if (!pull && s.pos.y < g) {
        s.pos.y = g
        if (Math.abs(s.vel.y) > 1.2) s.vel.y = -s.vel.y * 0.35
        else {
          s.vel.set(0, 0, 0)
          s.grounded = true
        }
        s.vel.x *= 0.6
        s.vel.z *= 0.6
      }
      if (this.player.alive && this.mode === 'playing' && d < 0.9) {
        if (this.collectShard(s.kind, e.shardValue)) this.shards.splice(i, 1)
      }
    }
  }

  private collectShard(kind: ShardKind, value: number): boolean {
    const p = this.player
    if (kind === 'health') {
      if (p.health >= p.maxHealth) return false
      p.health = Math.min(p.maxHealth, p.health + 5 * value)
    } else if (kind === 'armor') {
      if (p.armor >= p.maxArmor) return false
      p.armor = Math.min(p.maxArmor, p.armor + 5 * value)
    } else {
      let useful = false
      for (const id of ['rifle', 'shotgun', 'rocket'] as WeaponId[]) {
        const s = this.arsenal.slots[id]
        const d = WEAPONS[id]
        if (!s.owned || s.reserve >= d.reserveMax) continue
        useful = true
        s.reserve = Math.min(d.reserveMax, s.reserve + Math.max(1, Math.round(d.mag * 0.25 * value)))
      }
      if (!useful) return false
    }
    const c = SHARD_COLOR[kind]
    this.fx.shardBurst(tmp.copy(p.position).setY(p.position.y + 1), [c[0], c[1], c[2], 1])
    this.audio.play('shard_pickup', { volume: 0.55, rate: kind === 'health' ? 1 : kind === 'armor' ? 1.12 : 0.9, jitter: 0.05 })
    this.events.shard(kind)
    return true
  }

  // ─── grenades & projectiles ───────────────────────────────────────────
  private stepGrenades(dt: number): void {
    const blast = perkEffects(this.perks).blast
    for (let i = this.grenadesLive.length - 1; i >= 0; i -= 1) {
      const g = this.grenadesLive[i]
      g.fuse -= dt
      g.bounceCd = Math.max(0, g.bounceCd - dt)
      g.vel.y -= 20 * dt
      const sp = g.vel.length()
      const dir = tmp.copy(g.vel).divideScalar(sp || 1)
      const hit = sp > 0.01 ? this.raycast(g.pos, dir, sp * dt + 0.06, this.player.collider.handle) : null
      if (hit && (hit.tag?.kind === 'bot' || hit.tag?.kind === 'drone') && g.fuse < 1.45) g.fuse = 0
      else if (hit) {
        g.pos.copy(hit.point).addScaledVector(hit.normal, 0.06)
        const vn = hit.normal.clone().multiplyScalar(g.vel.dot(hit.normal))
        g.vel.sub(vn.multiplyScalar(1.45)).multiplyScalar(0.62)
        if (sp > 2.5 && g.bounceCd <= 0) {
          this.audio.play('grenade_bounce', { volume: Math.min(1, sp / 10), pos: g.pos, jitter: 0.1 })
          g.bounceCd = 0.08
        }
        g.spin.multiplyScalar(0.6)
      } else g.pos.addScaledVector(g.vel, dt)
      // Proximity fuse against Hounds.
      for (const h of this.hornets) if (h.alive && h.pos.distanceTo(g.pos) < 1.3) g.fuse = 0
      g.mesh.position.copy(g.pos)
      g.mesh.rotation.x += g.spin.x * dt
      g.mesh.rotation.z += g.spin.z * dt
      const blink = Math.sin(this.time * (g.fuse < 0.6 ? 40 : 16)) > 0
      const led = g.mesh.getObjectByName('led')
      if (led) led.visible = blink
      if (blink) this.fx.add.emit({ pos: g.pos.clone(), life: 0.05, size: 0.18, color: [4, 0.4, 0.2, 1], frame: 213 })
      if (g.fuse <= 0) {
        const net = this.tactical?.net
        // Online the server deals the blast damage; here it is only the explosion.
        if (net) net.client.send({ t: 'grenade', at: this.tactical!.toNet(g.pos) })
        this.explode(g.pos.clone(), 5.2 * blast, net ? 0 : 125, 0, 'grenade', UP)
        this.scene.remove(g.mesh)
        this.grenadesLive.splice(i, 1)
      }
    }
  }

  private stepProjectiles(dt: number): void {
    let nearest: Projectile | undefined
    let nd = Infinity
    const chest = tmp3.copy(this.player.position).setY(this.player.position.y + 1.1)
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i]
      const def = PROJ[p.kind]
      p.life -= dt
      const sp = p.vel.length()
      const dir = tmp.copy(p.vel).divideScalar(sp)
      const hit = this.raycast(p.pos, dir, sp * dt + 0.05, undefined, true)
      const next = tmp2.copy(p.pos).addScaledVector(p.vel, dt)
      const hitPlayer = this.player.alive && this.mode === 'playing' && next.distanceTo(chest) < 0.75 + def.size
      if (hit || hitPlayer || p.life <= 0) {
        const at = hitPlayer ? next.clone() : hit ? hit.point.clone() : p.pos.clone()
        const n = hit ? hit.normal : dir.clone().negate()
        if (p.kind === 'cannon') this.explode(at, def.radius, def.damage, p.owner, 'cannon', n.y > 0.6 ? n : undefined)
        else {
          if (hitPlayer) this.damage(0, { attacker: p.owner, amount: def.damage, source: 'plasma', from: p.pos.clone(), point: at })
          this.fx.energyBurst(at, n, def.color, 0.7)
          this.audio.play('impact_metal', { volume: 0.4, pos: at, rate: 1.4, jitter: 0.1 })
        }
        this.projectiles.splice(i, 1)
        continue
      }
      p.pos.copy(next)
      this.fx.bolt(p.pos, p.vel, def.color, def.size)
      const d = p.pos.distanceTo(chest)
      if (d < nd) {
        nd = d
        nearest = p
      }
    }
    if (nearest) {
      this.projLight.position.copy(nearest.pos)
      this.projLight.color.setRGB(nearest.kind === 'plasma' ? 0.36 : 1, nearest.kind === 'plasma' ? 0.78 : 0.55, nearest.kind === 'plasma' ? 1 : 0.2)
      this.projLight.intensity = 10
    } else this.projLight.intensity = 0
  }

  private collectPickups(): void {
    for (const p of this.pickups.list) {
      if (!p.available) continue
      if (p.spot.kind === 'rocket' && this.onslaught && !this.arsenal.slots.rocket.owned) continue
      const at = p.spot.pos
      if (this.mode === 'playing' && this.player.alive) {
        const pp = this.player.position
        if (Math.hypot(pp.x - at.x, pp.z - at.z) < 1.3 && Math.abs(pp.y - at.y) < 1.6) {
          let used = false
          let label = ''
          let color = '#fff'
          if (p.spot.kind === 'health' && this.player.health < this.player.maxHealth) {
            this.player.health = Math.min(this.player.maxHealth, this.player.health + 50)
            used = true
            label = '+50 HEALTH'
            color = '#4dff7a'
            this.audio.play('pickup_health', { volume: 0.9 })
          } else if (p.spot.kind === 'armor' && this.player.armor < this.player.maxArmor) {
            this.player.armor = Math.min(this.player.maxArmor, this.player.armor + 60)
            used = true
            label = '+60 ARMOR'
            color = '#3fb8ff'
            this.audio.play('pickup_armor', { volume: 0.9 })
          } else if (p.spot.kind === 'ammo' && this.arsenal.refill()) {
            used = true
            label = 'AMMO'
            color = '#ffc23f'
            this.audio.play('pickup_ammo', { volume: 0.9 })
          } else if (p.spot.kind === 'rocket' && this.stageGate.isReady(3)) {
            this.upgradeRocket()
            const had = this.arsenal.slots.rocket.owned
            this.arsenal.give('rocket')
            used = true
            label = had ? '+ROCKETS' : 'RPG-X LAUNCHER'
            color = '#ff4a2a'
            this.audio.play('pickup_ammo', { volume: 0.9, rate: 0.85 })
            this.audio.play('weapon_switch', { volume: 0.7 })
          }
          if (used) {
            this.pickups.take(p)
            this.events.pickup(label, color)
            const c = new THREE.Color(color)
            this.fx.shardBurst(at.clone().setY(at.y + 0.8), [c.r * 3, c.g * 3, c.b * 3, 1])
            continue
          }
        }
      }
      if (this.onslaught) continue
      for (const b of this.dmBots) {
        if (!b.alive) continue
        if (Math.hypot(b.pos.x - at.x, b.pos.z - at.z) > 1.3 || Math.abs(b.pos.y - at.y) > 1.6) continue
        let used = false
        if (p.spot.kind === 'health' && b.health < b.maxHealth) {
          b.health = Math.min(b.maxHealth, b.health + 50)
          used = true
        } else if (p.spot.kind === 'armor' && b.armor < 100) {
          b.armor = Math.min(100, b.armor + 60)
          used = true
        } else if (p.spot.kind === 'rocket' && this.stageGate.isReady(3)) {
          b.rockets = 3
          used = true
        }
        if (used) {
          this.pickups.take(p)
          this.audio.play(p.spot.kind === 'health' ? 'pickup_health' : p.spot.kind === 'armor' ? 'pickup_armor' : 'pickup_ammo', { volume: 0.6, pos: at })
          break
        }
      }
    }
  }

  private stepRockets(dt: number): void {
    let brightest: Rocket | undefined
    for (let i = this.rockets.length - 1; i >= 0; i -= 1) {
      const r = this.rockets[i]
      r.life -= dt
      const speed = r.vel.length()
      const dir = tmp.copy(r.vel).divideScalar(speed)
      const stepLen = speed * dt
      const hit = this.raycast(r.pos, dir, stepLen + 0.1, r.exclude)
      let boom: THREE.Vector3 | null = null
      let normal: THREE.Vector3 | undefined
      const friendlyTag = hit && this.onslaught && r.owner !== 0 && (hit.tag?.kind === 'bot' || hit.tag?.kind === 'drone')
      if (hit && !friendlyTag) {
        boom = hit.point.clone().addScaledVector(dir, -0.15)
        normal = hit.normal
      } else if (r.life <= 0) boom = r.pos.clone()
      else {
        const next = r.pos.clone().addScaledVector(dir, stepLen)
        if (r.owner === 0 || !this.onslaught) {
          for (const b of this.bots) {
            if (b.alive && b.id !== r.owner && tmp2.copy(b.pos).setY(b.pos.y + b.scale).distanceTo(next) < 0.9 * b.scale) boom = next
          }
          for (const h of this.hornets) if (h.alive && r.owner === 0 && h.pos.distanceTo(next) < 1.1) boom = next
        }
        if (!boom && this.player.alive && r.owner !== 0 && this.mode === 'playing' && tmp2.copy(this.player.position).setY(this.player.position.y + 1).distanceTo(next) < 0.9) boom = next
        r.pos.copy(next)
      }
      if (boom) {
        const hitTag = hit?.tag
        if (!friendlyTag && (hitTag?.kind === 'bot' || hitTag?.kind === 'player')) {
          this.damage(hitTag.kind === 'bot' ? hitTag.id : 0, { attacker: r.owner, amount: 35, source: 'rocket', from: r.pos.clone(), point: boom.clone() })
        }
        this.explode(boom, WEAPONS.rocket.splashRadius ?? 6.5, WEAPONS.rocket.damage, r.owner, 'rocket', normal && normal.y > 0.6 ? normal : undefined)
        r.loop?.stop()
        this.scene.remove(r.mesh)
        this.rockets.splice(i, 1)
        continue
      }
      r.mesh.position.copy(r.pos)
      r.loop?.set(r.pos)
      r.trail += dt
      while (r.trail > 1 / 90) {
        r.trail -= 1 / 90
        this.fx.smokeTrail(r.pos.clone().addScaledVector(dir, -0.3), r.vel)
      }
      if (!brightest || r.life > brightest.life) brightest = r
    }
    if (brightest) {
      this.rocketLight.position.copy(brightest.pos)
      this.rocketLight.intensity = 14 + Math.random() * 4
    } else this.rocketLight.intensity = 0
  }

  // ─── presentation ─────────────────────────────────────────────────────
  render(alpha: number, frameDt: number): void {
    const cam = this.camera
    this.lastFrameDt = Math.max(0, Math.min(0.1, frameDt))
    const look = this.mode === 'playing' || this.mode === 'countdown' ? this.input.takeLook() : (this.input.takeLook(), { x: 0, y: 0 })
    if (this.player.alive && (this.mode === 'playing' || this.mode === 'countdown')) {
      const adsK = this.arsenal.lookScale
      this.player.yaw -= look.x * adsK
      this.player.pitch = THREE.MathUtils.clamp(this.player.pitch - look.y * adsK, -1.5, 1.5)
    }
    this.lastLook = look
    let dt = this.mode === 'paused' ? 0 : frameDt * (this.mode === 'ended' ? this.slowmo : 1)
    if (this.hitstop > 0) dt *= 0.12
    else if (this.slowmoT > 0) dt *= 0.4
    this.trauma = Math.max(0, this.trauma - frameDt * 1.5)
    const shakeK = CONFIG.camera.shake * (this.reducedMotion ? 0.3 : 1)
    const sh = this.trauma * this.trauma * shakeK
    const t = this.time * 22
    const shake = { x: (Math.sin(t * 1.3) + Math.sin(t * 2.9) * 0.5) * 0.035 * sh, y: (Math.sin(t * 1.7 + 1) + Math.sin(t * 3.3) * 0.5) * 0.035 * sh, r: Math.sin(t * 1.1 + 2) * 0.03 * sh }
    for (const b of this.bots) if (b.alive || b.parts.root.visible) b.render(alpha, dt)
    if (!this.body && this.staged.player) {
      this.body = new PlayerBody(this.staged.player, this.staged.vm)
      this.scene.add(this.body.parts.root)
    }
    if (this.body) {
      const on = this.player.alive && (this.mode === 'playing' || this.mode === 'countdown' || this.mode === 'paused')
      this.bodyFeet.lerpVectors(this.player.prevPosition, this.player.position, alpha)
      this.body.update(dt, on, this.bodyFeet, this.player.yaw, this.player.pitch, this.player.velocity, this.player.crouch)
    }
    for (const h of this.hornets) if (h.alive || h.falling || h.root.visible) h.render(alpha, dt)
    if (this.mode === 'attract') {
      this.attractT += frameDt
      const a = this.attractT * 0.05
      const R = 52
      const o = this.arena.origin
      cam.position.set(o.x + Math.cos(a) * R, 20 + Math.sin(this.attractT * 0.13) * 3, o.z + Math.sin(a) * R)
      cam.up.set(0, 1, 0)
      cam.lookAt(o.x, 1.5, o.z)
      this.fov(62)
    } else if (this.player.alive) {
      const eye = this.player.eye(alpha, this.eyePos)
      const speed = this.player.grounded ? this.player.speed2d : 0
      const bobK = CONFIG.camera.bob * (this.tactical ? 0.45 : 1) * (this.reducedMotion ? 0.3 : 1) * (1 - this.arsenal.ads * 0.8) * (this.player.sliding > 0 ? 0.2 : 1)
      eye.y += Math.sin(this.time * (5 + speed * 1.1) * 2) * 0.012 * Math.min(1.4, speed / 6) * bobK
      cam.position.copy(eye)
      const strafe = this.mode === 'playing' ? this.input.move.x : 0
      this.strafeTilt += (-strafe * 0.018 - this.strafeTilt) * Math.min(1, frameDt * 8)
      this.slideTilt += ((this.player.sliding > 0 ? 0.075 : 0) - this.slideTilt) * Math.min(1, frameDt * 10)
      const P = this.arsenal.punch
      // Spray recoil moves the view with the bullets: the crosshair always shows where they go.
      const R = this.arsenal.recoil
      cam.rotation.set(this.player.pitch + P.pitch + R.pitch + shake.y, this.player.yaw + P.yaw + R.yaw + shake.x, this.strafeTilt + this.slideTilt + P.roll + shake.r, 'YXZ')
      const moveK = this.player.sliding > 0 ? 1.1 : this.player.sprinting ? 1.06 : 1
      this.fov(this.fovSetting, this.arsenal.fovScale() * moveK * (this.overdriveT > 0 ? 1.04 : 1))
      this.arsenal.animate(dt, this.lastLook, this.reducedMotion)
    } else if (this.tactical && this.player.deadTime > 2.2 && this.tactical.spectateTarget()) {
      // Spectate a living teammate through their eyes.
      const b = this.tactical.spectateTarget()!
      for (const a of this.tactical.allies) if (a.alive) a.parts.root.visible = a !== b
      // Interpolated body position (b.eye is the fixed-step one and judders on fast displays).
      cam.position.copy(b.parts.root.position).setY(b.parts.root.position.y + 1.6 * b.scale)
      const aim = b.aimDir
      cam.rotation.set(Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1)), Math.atan2(-aim.x, -aim.z), 0, 'YXZ')
      this.fov(this.fovSetting)
      this.arsenal.holder.visible = false
    } else {
      const d = Math.min(1, this.player.deadTime / 0.8)
      const base = tmp.copy(this.player.position)
      cam.position.set(base.x, base.y + 1.62 - d * 1.25, base.z)
      let yaw = this.deathYaw
      let pitch = this.deathPitch * (1 - d)
      const k = this.killerId > 0 ? this.botById.get(this.killerId) : undefined
      if (k && k.alive) {
        const dx = k.pos.x - base.x
        const dz = k.pos.z - base.z
        const want = Math.atan2(-dx, -dz)
        let dy = want - this.deathYaw
        dy = Math.atan2(Math.sin(dy), Math.cos(dy))
        yaw = this.deathYaw + dy * d
        pitch = THREE.MathUtils.lerp(this.deathPitch, Math.atan2(k.pos.y + 1.3 * k.scale - cam.position.y, Math.hypot(dx, dz)), d)
      }
      cam.rotation.set(pitch, yaw, d * 0.45, 'YXZ')
      this.fov(this.fovSetting, 0.9)
      this.arsenal.holder.visible = false
    }
    cam.updateMatrixWorld()
    const fwd = cam.getWorldDirection(tmp2)
    this.audio.setListener(cam.position, fwd)
    const lowH = this.player.alive && this.mode === 'playing' ? Math.max(0, 1 - this.player.health / 35) : 0
    this.renderer.fx.lowHealth += (lowH - this.renderer.fx.lowHealth) * Math.min(1, frameDt * 4)
    if (lowH > 0 && this.mode === 'playing') {
      this.heartbeatT -= frameDt
      if (this.heartbeatT <= 0) {
        this.audio.cue('heartbeat', 0.8 + lowH * 0.6)
        this.heartbeatT = 1.05 - lowH * 0.35
      }
    }
    // Music ducks a little between waves.
    if (this.onslaught) this.audio.setMusicCalm(this.wavePhase === 'fight' || this.wavePhase === 'intro' ? 0 : 0.5)
    this.renderer.fx.damage = Math.max(0, this.renderer.fx.damage - frameDt * 1.6)
    this.renderer.fx.flash = Math.max(0, this.renderer.fx.flash - frameDt * 2.5)
    this.renderShards(dt)
    this.fx.update(dt)
    this.arena.update(this.time)
    for (const f of this.arena.fires) this.fx.fire(f.pos, dt, 1)
    this.cullBots()
    this.renderer.render(this.scene, cam, this.time)
    this.input.endFrame()
  }

  private readonly frustum = new THREE.Frustum()
  private readonly projView = new THREE.Matrix4()
  private readonly cullSphere = new THREE.Sphere()
  /**
   * Skinned characters have frustum culling off (their bind-pose bounds are wrong once animated),
   * so cull whole characters here with a body-sized sphere: off-screen bots cost nothing.
   */
  private cullBots(): void {
    const cam = this.camera
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projView)
    for (const b of this.bots) {
      const root = b.parts.root
      if (!root.visible) continue
      this.cullSphere.center.copy(root.position).setY(root.position.y + b.scale)
      this.cullSphere.radius = 1.7 * b.scale
      const vis = this.frustum.intersectsSphere(this.cullSphere)
      for (const c of root.children) c.visible = vis
    }
  }

  private readonly shardM = new THREE.Matrix4()
  private readonly shardQ = new THREE.Quaternion()
  private readonly shardE = new THREE.Euler()
  private readonly shardS = new THREE.Vector3()
  private renderShards(dt: number): void {
    const mesh = this.shardMesh
    const col = mesh.instanceColor!.array as Float32Array
    let n = 0
    for (const s of this.shards) {
      if (n >= 80) break
      const bob = s.grounded ? Math.sin(s.phase * 3) * 0.06 + 0.12 : 0
      const fade = s.life < 2 ? (Math.sin(s.life * 18) > 0 ? 1 : 0.25) : 1
      this.shardE.set(0.3, s.phase * 2.4, 0.2)
      this.shardQ.setFromEuler(this.shardE)
      const sc = fade * (s.phase < 0.2 ? s.phase / 0.2 : 1)
      this.shardS.setScalar(Math.max(0.01, sc))
      this.shardM.compose(tmp.copy(s.pos).setY(s.pos.y + bob), this.shardQ, this.shardS)
      mesh.setMatrixAt(n, this.shardM)
      const c = SHARD_COLOR[s.kind]
      col[n * 3] = c[0]
      col[n * 3 + 1] = c[1]
      col[n * 3 + 2] = c[2]
      if (dt > 0 && Math.random() < 0.5) this.fx.add.emit({ pos: tmp.clone(), life: 0.08, size: 0.5, color: [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, 1], frame: 213 })
      n += 1
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.needsUpdate = true
  }

  private lastFrameDt = 1 / 60
  private fov(horizontalDeg: number, scale = 1): void {
    const cam = this.camera
    const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontalDeg) / 2) / (16 / 9))
    const target = THREE.MathUtils.radToDeg(v) * scale
    if (Math.abs(cam.fov - target) > 0.01) {
      // Same easing at any frame rate (≈0.35 per frame at 60 FPS).
      cam.fov += (target - cam.fov) * (1 - Math.exp(-this.lastFrameDt * 26))
      cam.updateProjectionMatrix()
    }
  }

  hud(): HudState {
    const a = this.arsenal
    const s = a.slot
    const top = leader(this.match)
    const me = this.match.combatants[0]
    const boss = this.boss && this.boss.alive ? { name: 'O GUARDIÃO', health: this.boss.health / this.boss.maxHealth, phase: this.boss.phase } : null
    return {
      health: Math.ceil(this.player.health),
      maxHealth: this.player.maxHealth,
      armor: Math.ceil(this.player.armor),
      maxArmor: this.player.maxArmor,
      armorRegen: this.player.regenerating,
      armorWait: Math.min(1, this.player.sinceHit / CONFIG.player.armorRegenDelay),
      weapon: a.current,
      weaponName: a.def.name,
      weaponIcon: a.gun ? a.gunIcons(this.renderer.gl)[a.gun.id] : undefined,
      mag: s.mag,
      magSize: a.def.mag,
      reserve: s.reserve,
      owned: Object.fromEntries((Object.keys(a.slots) as WeaponId[]).map(id => [id, a.slots[id].owned])),
      sight: a.gun?.sight,
      scoped: a.scoped,
      zoom: a.zoom,
      spread: a.spread,
      ads: a.ads,
      reloading: a.reloading > 0 ? 1 - a.reloading / a.reloadTotal : 0,
      timeLeft: this.onslaught ? this.runTime : this.match.timeLeft,
      kills: this.onslaught ? this.kills : me.kills,
      fragLimit: this.match.fragLimit,
      leaderName: top.name,
      leaderKills: top.kills,
      place: placement(this.match),
      alive: this.player.alive,
      respawnIn: Math.max(0, this.respawnT),
      streak: me.streak,
      sprinting: this.player.sprinting,
      lowAmmo: s.mag <= Math.ceil(a.def.mag * 0.25),
      protect: this.player.protect,
      gameMode: this.gameMode,
      wave: this.wave + 1,
      waves: WAVES.length,
      enemiesLeft: this.onslaught ? (this.wavePhase === 'fight' || this.wavePhase === 'intro' ? this.enemiesLeft : 0) : 0,
      rank: this.style.rank,
      rankName: RANKS[this.style.rank],
      rankFill: this.style.fill / 100,
      mult: RANK_MULT[this.style.rank],
      score: this.style.score,
      overdrive: this.style.overdrive,
      overdriveActive: this.overdriveT > 0 ? this.overdriveT / 7 : 0,
      grenades: this.grenades,
      grenadesUnlocked: this.grenadesUnlocked,
      boss,
      sliding: this.player.sliding > 0,
      runTime: this.runTime,
      tactical: this.tactical ? this.tactical.hud() : null,
    }
  }

  minimap(): MinimapState | null {
    return this.tactical ? this.tactical.minimap() : null
  }

  get waveTotal(): number {
    return WAVES.length
  }
  get plannedEnemies(): number {
    return waveSize(this.plan)
  }

  standings(): ReturnType<typeof standings> {
    return standings(this.match)
  }

  setQuality(): void {
    for (const a of this.arenas.values()) {
      a.sun.shadow.map?.dispose()
      a.sun.shadow.map = null
      a.sun.shadow.mapSize.set(this.renderer.shadowMapSize, this.renderer.shadowMapSize)
      a.sun.shadow.radius = this.renderer.shadowMapSize >= 2048 ? 2.4 : 1.4
    }
    this.fx.density = this.renderer.particleDensity
  }
}

export type { Perk }
