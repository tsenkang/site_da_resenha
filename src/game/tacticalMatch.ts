import * as THREE from 'three'
import { MAP_SCALE, type Site, type SiteId, type TeamSide } from './arena'
import type { Bot, Objective } from './bots'
import type { Game } from './game'
import type { NetLink } from '../net/link'
import type { ServerMessage, Vec3 } from '../net/protocol'
import { diffEvents } from '../net/view'
import {
  aliveCount, attackingTeam, botBuyPlan, buy, createTactical, defuseSpike, plantSpike, registerKill, setCarrier, setShield, sideOf, SHOP,
  startRound, tacticalConfig, tickTactical, useAbility, type BuyResult, type Loadout, type RoundEndReason, type ShopItem,
  type Side, type TacticalEvent, type TacticalPhase, type TacticalState, type TeamIndex, type TeamSize,
} from './tactical'

/**
 * Runtime director for the tactical mode: owns the rules state (tactical.ts), places both teams,
 * gives bots goals (stage → execute → plant / anchor → retake → defuse), runs plant/defuse
 * channels for the player and bots, the spike entity, smokes and the spectator camera.
 *
 * Team 0 is always the player's team (allies drawn cyan), team 1 the enemy team (red).
 * Ids: player 0, allies 201–204, enemies 211–215.
 */
export const ALLY_NAMES = ['FAÍSCA', 'NÉVOA', 'TRAVA', 'BRISA']
export const ENEMY_NAMES = ['CORVO', 'LÂMINA', 'PRISMA', 'ÔNIX', 'VULTO']
export const ALLY_ID0 = 201
export const ENEMY_ID0 = 211

export type TacticalHud = {
  round: number
  phase: TacticalPhase
  timer: number
  /** Our score first. */
  score: [number, number]
  roundsToWin: number
  side: Side
  credits: number
  loadout: Loadout
  allies: { name: string; alive: boolean; hp: number; shield: number; isPlayer: boolean; credits: number }[]
  enemies: { name: string; alive: boolean }[]
  spike: { carried: boolean; dropped: boolean; planted: boolean; site: SiteId | null; timer: number; teamHasIt: boolean }
  progress: { kind: 'plant' | 'defuse'; t: number } | null
  inSite: SiteId | null
  canBuy: boolean
  hint: string | null
  lastResult: { win: boolean; reason: RoundEndReason } | null
}

export type MinimapState = {
  player: { x: number; z: number; yaw: number; alive: boolean }
  allies: { x: number; z: number; alive: boolean }[]
  enemies: { x: number; z: number }[]
  spike: { x: number; z: number; planted: boolean } | null
}

type Smoke = { mesh: THREE.Mesh; pos: THREE.Vector3; r: number; life: number }
/** `mine`: thrown by the local player (online: reported to the server when it lands). */
type Thrown = { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; mine: boolean }

/** Defensive anchor spots per site: where to stand and which entrance to watch. */
const S = MAP_SCALE
const ANCHORS: Record<SiteId, Objective[]> = {
  A: [
    { x: -38 * S, z: -30 * S, lookX: -34 * S, lookZ: -6 * S },
    { x: -24 * S, z: -28 * S, lookX: -14 * S, lookZ: -10 * S },
    { x: -33 * S, z: -36 * S, lookX: -34 * S, lookZ: -6 * S },
  ],
  B: [
    { x: 38 * S, z: -30 * S, lookX: 34 * S, lookZ: -6 * S },
    { x: 24 * S, z: -28 * S, lookX: 14 * S, lookZ: -10 * S },
    { x: 33 * S, z: -36 * S, lookX: 34 * S, lookZ: -6 * S },
  ],
}
/** Attacker staging points before the execute (end of each main) and the mid push. */
const STAGING: Record<SiteId, { x: number; z: number }> = { A: { x: -34 * S, z: 2 * S }, B: { x: 34 * S, z: 2 * S } }
const MID = { x: 0, z: -8 * S }
const EXECUTE_AFTER = 22

const tmp = new THREE.Vector3()

export class TacticalMatch {
  state: TacticalState
  readonly teamSize: TeamSize
  readonly allies: Bot[] = []
  readonly enemies: Bot[] = []
  private readonly byId = new Map<number, Bot>()
  /** Where the spike lies when nobody carries it (dropped or planted). */
  readonly spikePos = new THREE.Vector3()
  private readonly spikeMesh: THREE.Group
  private readonly spikeGlow: THREE.MeshBasicMaterial
  private targetSite: SiteId = 'A'
  private roundT = 0
  private plantT = 0
  private plantBy = -1
  private defuseT = 0
  private defuseBy = -1
  private beepT = 0
  private smokes: Smoke[] = []
  private thrown: Thrown[] = []
  private lastResult: { win: boolean; reason: RoundEndReason } | null = null
  private spectateIndex = 0
  private seenEnemies = new Set<number>()
  private seenT = 0
  private hint: string | null = null
  private detonated = false
  private readonly smokeWarm: THREE.Mesh
  /** Online: the server owns the rules; this director only presents them (null offline). */
  readonly net: NetLink | null
  private readonly netOff: (() => void)[] = []

  constructor(private readonly game: Game, teamSize: TeamSize, net: NetLink | null = null) {
    this.teamSize = teamSize
    this.net = net
    if (net) {
      // Everyone else is a network-driven avatar (no AI); open slots stay out of play.
      for (const p of net.state.players) {
        if (p.id === 0 || p.id < 0) continue
        const b = game.createTacticalBot(p.id, p.name, p.team)
        b.remote = true
        ;(p.team === 0 ? this.allies : this.enemies).push(b)
      }
      this.state = net.state
    } else {
      for (let i = 0; i < teamSize - 1; i += 1) this.allies.push(game.createTacticalBot(ALLY_ID0 + i, ALLY_NAMES[i], 0))
      for (let i = 0; i < teamSize; i += 1) this.enemies.push(game.createTacticalBot(ENEMY_ID0 + i, ENEMY_NAMES[i], 1))
      const roster = [
        { id: 0, name: 'VOCÊ', team: 0 as TeamIndex },
        ...this.allies.map(b => ({ id: b.id, name: b.name, team: 0 as TeamIndex })),
        ...this.enemies.map(b => ({ id: b.id, name: b.name, team: 1 as TeamIndex })),
      ]
      this.state = createTactical(tacticalConfig(teamSize), roster)
    }
    for (const b of [...this.allies, ...this.enemies]) this.byId.set(b.id, b)
    const built = buildSpike()
    this.spikeMesh = built.group
    this.spikeGlow = built.glow
    this.spikeMesh.visible = false
    game.scene.add(this.spikeMesh)
    // A hidden smoke dome so its material compiles with the match, not on the first throw.
    this.smokeWarm = new THREE.Mesh(smokeGeometry(), smokeMaterial())
    this.smokeWarm.visible = false
    game.scene.add(this.smokeWarm)
    this.setupRound()
    if (net) this.listen(net)
  }

  // ─── online ───────────────────────────────────────────────────────────
  private listen(net: NetLink): void {
    const c = net.client
    const g = this.game
    this.netOff.push(
      c.on('state', m => this.onServerState(m)),
      c.on('damage', m => g.netDamage(net.local(m.target), net.local(m.by), m.hp, m.shield)),
      c.on('kill', m => g.netKill(net.local(m.killer), net.local(m.victim), m.headshot, m.weapon)),
      c.on('smoke', m => {
        if (m.by !== net.me) this.spawnSmoke(this.fromNet(m.at))
      }),
      c.on('grenade', m => {
        if (m.by !== net.me) g.explode(this.fromNet(m.at), 5.2, 0, -1, 'grenade')
      }),
    )
    // Our own state goes out at the network rate while alive.
    c.streamFrames(() => {
      const p = g.player
      if (!p.alive || g.mode === 'ended') return null
      return { pos: this.toNet(p.position), yaw: p.yaw, pitch: p.pitch, flags: p.crouch > 0.5 ? 1 : 0, weapon: g.heldLoadoutWeapon(), shots: g.takeNetShots() }
    })
  }

  /** New authoritative state: diff it into the usual events and follow loadout changes. */
  private onServerState(m: Extract<ServerMessage, { t: 'state' }>): void {
    const net = this.net!
    const prev = this.state
    const before = this.me.loadout
    const next = net.accept(m.s, m.spikePos)
    this.state = next
    if (m.spikePos) this.spikePos.copy(this.fromNet(m.spikePos))
    const events = diffEvents(prev, next)
    for (const e of events) this.onEvent(e)
    if (prev.spike.carrier !== 0 && next.spike.carrier === 0 && !events.some(e => e.type === 'roundStart')) this.game.events.message('VOCÊ PEGOU A SPIKE', 'good')
    // The spike on the ground: dropped (nobody carries it) or planted.
    const dropped = !next.spike.planted && next.spike.carrier === null && !!m.spikePos
    if (next.spike.planted || dropped) {
      this.spikeMesh.position.copy(this.spikePos)
      this.spikeMesh.visible = this.state.phase !== 'roundEnd' || next.spike.planted
    } else this.spikeMesh.visible = false
    if (events.some(e => e.type === 'roundStart')) return
    const l = this.me.loadout
    const g = this.game
    if (l.weapon !== before.weapon) g.arsenal.setLoadout(l.weapon === 'pistol' ? null : l.weapon, false)
    if (l.shield > before.shield && next.phase === 'buy') g.player.armor = l.shield
    if (l.grenades !== before.grenades) g.setGrenades(l.grenades)
  }

  /** Remote avatars follow their interpolated network pose and replay their shots. */
  private poseRemotes(dt: number): void {
    const net = this.net!
    for (const b of this.bots) {
      if (!b.alive) continue
      const id = net.net(b.id)
      const pose = id ? net.pose(id) : null
      if (!id || !pose) continue
      b.puppet(dt, this.fromNet(pose.pos, tmp), pose.yaw, pose.pitch)
      for (let n = Math.min(3, net.takeShots(id)); n > 0; n -= 1) b.remoteShot()
    }
  }

  /**
   * Positions travel map-relative: maps sit far apart in one world, the protocol keeps
   * coordinates small and the server never needs to know where a map was built.
   */
  toNet(p: THREE.Vector3): Vec3 {
    const o = this.game.arena.origin
    return [p.x - o.x, p.y, p.z - o.z]
  }
  fromNet(v: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
    const o = this.game.arena.origin
    return out.set(v[0] + o.x, v[1], v[2] + o.z)
  }

  /** Attacking team in the local frame (online you may be on the server's second team). */
  private get atk(): TeamIndex {
    return (attackingTeam(this.state) ^ (this.net?.ids.flip ?? 0)) as TeamIndex
  }

  get bots(): Bot[] {
    return [...this.allies, ...this.enemies]
  }

  teamOf(id: number): TeamIndex | -1 {
    if (id === 0) return 0
    const b = this.byId.get(id)
    return b ? (b.team as TeamIndex) : -1
  }

  private get playerSide(): Side {
    return this.sideOfTeam(0)
  }

  private sideOfTeam(team: TeamIndex): Side {
    return sideOf((team ^ (this.net?.ids.flip ?? 0)) as TeamIndex, this.state.round, this.state.cfg)
  }

  // ─── round setup ──────────────────────────────────────────────────────
  /** Place both teams, apply loadouts, bots shop, raise the spawn barriers. */
  private setupRound(): void {
    const g = this.game
    const st = this.state
    this.roundT = 0
    this.plantT = this.defuseT = 0
    this.plantBy = this.defuseBy = -1
    this.detonated = false
    this.spikeMesh.visible = false
    this.clearSmokes()
    this.targetSite = Math.random() < 0.5 ? 'A' : 'B'
    g.arena.setBarriers(true)
    this.net?.clearPoses()
    // Offline: the spike goes to a random attacker and bots shop (online the server decides both).
    if (!this.net) {
      const atkIds = st.players.filter(p => p.team === this.atk).map(p => p.id)
      this.state = setCarrier(this.state, atkIds[Math.floor(Math.random() * atkIds.length)])
    }
    // Bots shop first (team credits drive whether they full-buy together).
    for (const team of this.net ? [] : ([0, 1] as TeamIndex[])) {
      const teamCredits = st.players.filter(p => p.team === team).reduce((n, p) => n + p.credits, 0)
      for (const p of st.players) {
        if (p.team !== team || p.id === 0) continue
        for (const item of botBuyPlan(p, teamCredits, st.round)) {
          const r = buy(this.state, p.id, item)
          if (r.ok) this.state = r.state
        }
      }
    }
    const spawnFor = (team: TeamIndex): THREE.Vector3[] => g.arena.teamSpawns[this.sideOfTeam(team) as TeamSide]
    const yawFor = (team: TeamIndex) => (this.sideOfTeam(team) === 'attack' ? 0 : Math.PI)
    const s0 = spawnFor(0)
    // Online the roster order picks spawn slots so teammates never stack.
    const slot = this.net ? Math.max(0, this.state.players.filter(p => p.team === 0).findIndex(p => p.id === 0)) : 0
    g.player.spawn(s0[slot % s0.length], yawFor(0))
    g.player.protect = 0
    g.player.maxHealth = 100
    g.player.health = 100
    g.player.maxArmor = 50
    this.applyPlayerLoadout()
    this.allies.forEach((b, i) => this.spawnBot(b, s0[(i < slot ? i : i + 1) % s0.length], yawFor(0)))
    const s1 = spawnFor(1)
    this.enemies.forEach((b, i) => this.spawnBot(b, s1[i % s1.length], yawFor(1)))
    // Online open slots sit the round out.
    if (this.net) for (const b of this.bots) if (!this.state.players.find(p => p.id === b.id)?.alive) b.hide()
    g.onTacticalRound()
    const atk = this.atk
    g.events.wave({ title: `RODADA ${st.round}`, subtitle: atk === 0 ? 'ATAQUE · PLANTE A SPIKE' : 'DEFESA · PROTEJA OS LOCAIS', kind: 'intro' })
    if (this.state.spike.carrier === 0) g.events.message('VOCÊ ESTÁ COM A SPIKE', 'good')
  }

  private spawnBot(b: Bot, at: THREE.Vector3, yaw: number): void {
    b.spawn(at, yaw)
    b.busy = false
    const p = this.state.players.find(q => q.id === b.id)!
    this.applyBotLoadout(b, p.loadout)
  }

  private applyBotLoadout(b: Bot, l: Loadout): void {
    b.armor = l.shield
    b.absorb = 1
    b.strafeMul = 0.3
    b.aimMul = 1.3
    // Tactical bots all carry a rifle model; the purchased weapon sets how hard and fast they hit.
    if (l.weapon === 'rifle') {
      b.dmgMul = 3.2
      b.rateMul = 0.8
    } else if (l.weapon === 'shotgun') {
      b.dmgMul = 2.6
      b.rateMul = 1.1
    } else {
      b.dmgMul = 2.2
      b.rateMul = 1.5
    }
  }

  private applyPlayerLoadout(keepAmmo = false): void {
    const g = this.game
    const me = this.me
    const l = me.loadout
    g.player.armor = l.shield
    g.arsenal.setLoadout(l.weapon === 'pistol' ? null : l.weapon, keepAmmo)
    g.setGrenades(l.grenades)
  }

  private get me() {
    return this.state.players.find(p => p.id === 0)!
  }

  // ─── shop ─────────────────────────────────────────────────────────────
  buy(item: ShopItem): BuyResult {
    const before = this.me.loadout
    const r = buy(this.state, 0, item)
    if (!r.ok) return r
    if (this.net) {
      // The server applies the purchase; its next state brings the new loadout.
      this.net.client.send({ t: 'buy', item })
      this.game.audio.play('pickup_ammo', { volume: 0.7 })
      return r
    }
    this.state = r.state
    const l = this.me.loadout
    if (l.weapon !== before.weapon) this.game.arsenal.setLoadout(l.weapon === 'pistol' ? null : l.weapon, false)
    if (l.shield !== before.shield) this.game.player.armor = l.shield
    this.game.setGrenades(l.grenades)
    this.game.audio.play('pickup_ammo', { volume: 0.7 })
    return r
  }

  get canBuy(): boolean {
    return this.state.phase === 'buy' && this.game.player.alive
  }

  // ─── events from the game ─────────────────────────────────────────────
  /** Someone died (player id 0 or a bot). Handles spike drop and round elimination. */
  onDeath(victim: number, killer: number, at: THREE.Vector3): void {
    if (this.net) {
      // Online the server scores deaths and places the dropped spike.
      if (victim === this.plantBy) this.plantT = 0
      if (victim === this.defuseBy) this.defuseT = 0
      return
    }
    if (this.state.spike.carrier === victim) {
      this.spikePos.copy(at).setY(this.game.arena.groundAt(at.x, at.z, at.y + 1))
      this.spikeMesh.position.copy(this.spikePos)
      this.spikeMesh.visible = true
      this.state = setCarrier(this.state, null)
      if (this.teamOf(victim) === 0) this.game.events.message('SPIKE CAIU', 'warn')
    }
    if (victim === this.plantBy) this.plantT = 0
    if (victim === this.defuseBy) this.defuseT = 0
    const r = registerKill(this.state, killer, victim)
    this.apply(r)
  }

  /** Player shield after damage is kept so survivors carry partial shields. */
  syncShields(): void {
    if (this.net) return
    let s = this.state
    if (this.game.player.alive) s = setShield(s, 0, this.game.player.armor)
    for (const b of this.bots) if (b.alive) s = setShield(s, b.id, b.armor)
    this.state = s
  }

  private apply(r: { state: TacticalState; events: TacticalEvent[] }): void {
    this.state = r.state
    for (const e of r.events) this.onEvent(e)
  }

  private onEvent(e: TacticalEvent): void {
    const g = this.game
    switch (e.type) {
      case 'combatStart':
        g.arena.setBarriers(false)
        g.events.closeBuy?.()
        g.events.message('COMBATE!', 'info')
        g.audio.play('match_start', { volume: 0.8, jitter: 0 })
        break
      case 'planted': {
        this.spikeMesh.visible = true
        this.spikeMesh.position.copy(this.spikePos)
        const ours = this.teamOf(e.by) === 0
        g.events.wave({ title: 'SPIKE PLANTADA', subtitle: `LOCAL ${e.site} · ${ours ? 'DEFENDA A SPIKE' : 'DESARME A SPIKE'}`, kind: 'boss' })
        g.audio.play('wave_start', { volume: 0.9, jitter: 0 })
        break
      }
      case 'roundEnd': {
        const win = e.result.winner === 0
        this.lastResult = { win, reason: e.result.reason }
        this.syncShields()
        if (e.result.reason === 'detonated') this.detonate()
        const reasons: Record<RoundEndReason, string> = { elimination: 'TIME ELIMINADO', detonated: 'SPIKE DETONADA', defused: 'SPIKE DESARMADA', time: 'TEMPO ESGOTADO' }
        if (this.state.phase !== 'matchEnd') {
          g.events.wave({ title: win ? 'RODADA VENCIDA' : 'RODADA PERDIDA', subtitle: reasons[e.result.reason], kind: win ? 'clear' : 'phase' })
          g.audio.play(win ? 'victory' : 'defeat', { volume: 0.6, jitter: 0 })
        }
        this.plantT = this.defuseT = 0
        for (const b of this.bots) b.busy = false
        break
      }
      case 'halftime':
        g.events.message('TROCA DE LADO', 'info')
        break
      case 'roundStart':
        this.setupRound()
        break
      case 'matchEnd':
        g.endTactical(e.winner === 0)
        break
    }
  }

  private detonate(): void {
    if (this.detonated) return
    this.detonated = true
    const g = this.game
    const at = this.spikePos.clone().setY(this.spikePos.y + 0.5)
    g.fx.explosion(at, 2.2, new THREE.Vector3(0, 1, 0))
    g.audio.play('explosion', { volume: 1.4, pos: at, rate: 0.7 })
    g.renderer.fx.flash = 0.7
    this.spikeMesh.visible = false
    if (this.net) return
    if (g.player.alive && g.player.position.distanceTo(at) < 14) g.killPlayerSilently()
    for (const b of this.bots) if (b.alive && b.pos.distanceTo(at) < 14) g.killBotSilently(b)
  }

  // ─── per-step director ────────────────────────────────────────────────
  step(dt: number): void {
    const g = this.game
    this.roundT += dt
    const before = this.state.phase
    if (this.net) {
      g.flushNetHits(this.net)
      // Count down locally between server updates; the server's next state corrects it.
      const st = this.state
      if (st.phase !== 'matchEnd') this.state = { ...st, timer: Math.max(0, st.timer - dt), spike: st.spike.planted ? { ...st.spike, timer: Math.max(0, st.spike.timer - dt) } : st.spike }
      this.poseRemotes(dt)
    } else this.apply(tickTactical(this.state, dt))
    const phase = this.state.phase
    if (phase === 'matchEnd' || phase !== before) return
    this.stepThrown(dt)
    this.stepSmokes(dt)
    this.hint = null
    if (phase === 'combat') {
      if (!this.net) this.stepPickup()
      this.stepPlant(dt)
    } else if (phase === 'planted') {
      this.stepDefuse(dt)
      this.beepT -= dt
      if (this.beepT <= 0) {
        const left = this.state.spike.timer
        this.beepT = left < 10 ? 0.25 : left < 20 ? 0.5 : 1
        g.audio.cue('beep', 0.55)
        this.spikeGlow.color.setRGB(6, 0.4, 0.3)
      } else this.spikeGlow.color.lerp(new THREE.Color(1.2, 0.1, 0.08), Math.min(1, dt * 6))
    }
    this.seenT -= dt
    if (this.seenT <= 0) {
      this.seenT = 0.2
      this.updateSeen()
    }
  }

  private stepPickup(): void {
    const g = this.game
    const st = this.state
    if (st.spike.carrier !== null || st.spike.planted) return
    const atk = this.atk
    const near = (p: THREE.Vector3) => Math.hypot(p.x - this.spikePos.x, p.z - this.spikePos.z) < 1.6
    if (atk === 0 && g.player.alive && near(g.player.position)) {
      this.state = setCarrier(st, 0)
      this.spikeMesh.visible = false
      g.events.message('VOCÊ PEGOU A SPIKE', 'good')
      return
    }
    for (const b of this.bots) {
      if (b.alive && b.team === atk && near(b.pos)) {
        this.state = setCarrier(st, b.id)
        this.spikeMesh.visible = false
        return
      }
    }
  }

  /** Plant channel: player holds F/4 inside a site; carrier bots plant when the area looks clear. */
  private stepPlant(dt: number): void {
    const g = this.game
    const carrier = this.state.spike.carrier
    if (carrier === null) return
    let site: Site | undefined
    let channel = false
    if (carrier === 0) {
      site = g.player.alive ? g.arena.siteAt(g.player.position) : undefined
      if (site) this.hint = 'SEGURE F PARA PLANTAR'
      channel = !!site && g.player.grounded && g.input.held('interact') && g.player.speed2d < 1.5
    } else if (!this.net) {
      const b = this.byId.get(carrier)
      site = b?.alive ? g.arena.siteAt(b.pos) : undefined
      const near = b && site ? Math.hypot(b.pos.x - site.center.x, b.pos.z - site.center.z) < 5 : false
      channel = !!b && !!site && near && !b.seesEnemy
      if (b) b.busy = channel
    }
    if (!channel || !site) {
      if (this.plantBy === carrier) this.plantT = Math.max(0, this.plantT - dt * 3)
      return
    }
    this.plantBy = carrier
    this.plantT += dt
    if (this.plantT >= this.state.cfg.plantTime) {
      if (this.net) {
        this.plantT = 0
        this.net.client.send({ t: 'plant', site: site.id })
        return
      }
      const pos = carrier === 0 ? g.player.position : this.byId.get(carrier)!.pos
      this.spikePos.copy(pos).setY(g.arena.groundAt(pos.x, pos.z, pos.y + 1))
      this.plantT = 0
      const b = this.byId.get(carrier)
      if (b) b.busy = false
      this.apply(plantSpike(this.state, carrier, site.id))
    }
  }

  /** Defuse channel: player holds F next to the spike; the closest defending bot defuses when clear. */
  private stepDefuse(dt: number): void {
    const g = this.game
    const def: TeamIndex = this.atk === 0 ? 1 : 0
    const dist = (p: THREE.Vector3) => Math.hypot(p.x - this.spikePos.x, p.z - this.spikePos.z)
    let who = -1
    if (def === 0 && g.player.alive && dist(g.player.position) < 2.2) {
      this.hint = 'SEGURE F PARA DESARMAR'
      if (g.input.held('interact') && g.player.speed2d < 1.5) who = 0
    }
    let best = 1.8
    let bot: Bot | undefined
    for (const b of this.net ? [] : this.bots) {
      b.busy = false
      if (who >= 0 || !b.alive || b.team !== def || b.seesEnemy) continue
      const d = dist(b.pos)
      if (d < best) {
        best = d
        bot = b
      }
    }
    if (bot) {
      bot.busy = true
      who = bot.id
    }
    if (who < 0) {
      this.defuseT = Math.max(0, this.defuseT - dt * 2)
      return
    }
    if (this.defuseBy !== who) {
      this.defuseT = 0
      this.defuseBy = who
    }
    this.defuseT += dt
    if (this.defuseT >= this.state.cfg.defuseTime) {
      this.defuseT = 0
      if (this.net) {
        this.net.client.send({ t: 'defuse' })
        return
      }
      if (bot) bot.busy = false
      this.apply(defuseSpike(this.state, who))
    }
  }

  /** Enemies currently spotted by the player or any living ally (for the minimap). */
  private updateSeen(): void {
    const g = this.game
    this.seenEnemies.clear()
    const eyes: THREE.Vector3[] = []
    if (g.player.alive) eyes.push(g.player.position.clone().setY(g.player.position.y + 1.6))
    for (const a of this.allies) if (a.alive) eyes.push(a.pos.clone().setY(a.pos.y + 1.6))
    for (const e of this.enemies) {
      if (!e.alive) continue
      const chest = tmp.copy(e.pos).setY(e.pos.y + 1.3)
      for (const eye of eyes) {
        if (eye.distanceTo(chest) < 60 && g.lineOfSight(eye, chest)) {
          this.seenEnemies.add(e.id)
          break
        }
      }
    }
  }

  // ─── bot goals ────────────────────────────────────────────────────────
  objective = (b: Bot): Objective | null => {
    const st = this.state
    if (st.phase === 'buy' || st.phase === 'matchEnd') return null
    const team = b.team as TeamIndex
    const side = this.sideOfTeam(team)
    const mates = team === 0 ? this.allies : this.enemies
    const idx = mates.indexOf(b) + (team === 0 ? 1 : 0)
    const spread = (o: { x: number; z: number }, r: number) => {
      const a = idx * 2.3
      return { x: o.x + Math.cos(a) * r, z: o.z + Math.sin(a) * r }
    }
    const siteCenter = (id: SiteId) => this.game.arena.sites.find(s => s.id === id)!.center
    if (side === 'attack') {
      if (st.spike.planted) {
        const p = spread(this.spikePos, 6)
        return { ...p, lookX: p.x * 2 - this.spikePos.x, lookZ: p.z * 2 - this.spikePos.z }
      }
      if (st.spike.carrier === null) {
        // Closest living attacker fetches the dropped spike; the rest hold the staging point.
        const atk = mates.filter(m => m.alive)
        atk.sort((a, c) => a.pos.distanceTo(this.spikePos) - c.pos.distanceTo(this.spikePos))
        if (atk[0] === b) return { x: this.spikePos.x, z: this.spikePos.z }
      }
      const execute = this.roundT > EXECUTE_AFTER + idx * 1.5 || st.spike.carrier === b.id && this.roundT > EXECUTE_AFTER + 4
      const lurk = this.teamSize >= 4 && idx === this.teamSize - 1
      const target: SiteId = lurk ? (this.targetSite === 'A' ? 'B' : 'A') : this.targetSite
      if (!execute) {
        if (idx === 2 && this.teamSize >= 3) return { ...MID, lookX: 0, lookZ: -30 * S }
        const s = spread(STAGING[target], 1.8)
        return { ...s, lookX: siteCenter(target).x, lookZ: siteCenter(target).z }
      }
      const c = siteCenter(target)
      return st.spike.carrier === b.id ? { x: c.x + 1.5, z: c.z + 1.5 } : { ...spread(c, 5.5), lookX: c.x, lookZ: c.z + 26 }
    }
    // Defenders.
    if (st.spike.planted) return spread(this.spikePos, idx === 0 ? 0.6 : 3)
    const site: SiteId = idx % 2 === 0 ? 'A' : 'B'
    const anchors = ANCHORS[site]
    return anchors[Math.floor(idx / 2) % anchors.length]
  }

  // ─── abilities: smokes ────────────────────────────────────────────────
  throwSmoke(): boolean {
    const g = this.game
    const me = this.me
    if (!g.player.alive || me.loadout.smokes <= 0 || this.state.phase === 'buy' || this.state.phase === 'roundEnd') return false
    // Online the server spends the smoke when it lands (see stepThrown); offline it is spent now.
    this.state = useAbility(this.state, 0, 'smoke')
    const eye = g.player.eye(1, new THREE.Vector3())
    const fwd = g.player.forward(new THREE.Vector3())
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshLambertMaterial({ color: '#9fb7c9' }))
    mesh.position.copy(eye)
    g.scene.add(mesh)
    this.thrown.push({ mesh, pos: eye.clone().addScaledVector(fwd, 0.5), vel: fwd.multiplyScalar(18).add(new THREE.Vector3(0, 4, 0)), fuse: 1.6, mine: true })
    g.audio.play('grenade_throw', { volume: 0.8 })
    return true
  }

  private stepThrown(dt: number): void {
    for (let i = this.thrown.length - 1; i >= 0; i -= 1) {
      const t = this.thrown[i]
      t.fuse -= dt
      t.vel.y -= 20 * dt
      const step = t.vel.length() * dt
      const dir = tmp.copy(t.vel).normalize()
      const hit = this.game.raycast(t.pos, dir, step + 0.05, undefined, true)
      if (hit) {
        t.pos.copy(hit.point).addScaledVector(hit.normal, 0.05)
        t.vel.reflect(hit.normal).multiplyScalar(0.35)
      } else t.pos.addScaledVector(t.vel, dt)
      t.mesh.position.copy(t.pos)
      if (t.fuse <= 0 || (hit && hit.normal.y > 0.7 && t.vel.length() < 2.5)) {
        this.game.scene.remove(t.mesh)
        this.thrown.splice(i, 1)
        this.spawnSmoke(t.pos.clone())
        if (t.mine && this.net) this.net.client.send({ t: 'smoke', at: this.toNet(t.pos) })
      }
    }
  }

  private spawnSmoke(at: THREE.Vector3): void {
    const r = 4.6
    at.y = this.game.arena.groundAt(at.x, at.z, at.y + 1)
    const mesh = new THREE.Mesh(smokeGeometry(), smokeMaterial())
    mesh.position.copy(at)
    mesh.scale.setScalar(0.1)
    mesh.renderOrder = 5
    this.game.scene.add(mesh)
    this.smokes.push({ mesh, pos: at.clone().setY(at.y + r * 0.45), r, life: 15 })
    this.game.audio.play('slide', { volume: 0.6, pos: at, rate: 0.6 })
  }

  private stepSmokes(dt: number): void {
    for (let i = this.smokes.length - 1; i >= 0; i -= 1) {
      const s = this.smokes[i]
      s.life -= dt
      const grow = Math.min(1, (15 - s.life) / 0.6)
      const fade = Math.min(1, s.life / 1)
      s.mesh.scale.setScalar(s.r * grow * (0.85 + 0.15 * fade))
      if (s.life <= 0) {
        this.game.scene.remove(s.mesh)
        this.smokes.splice(i, 1)
      }
    }
  }

  private clearSmokes(): void {
    for (const s of this.smokes) this.game.scene.remove(s.mesh)
    for (const t of this.thrown) this.game.scene.remove(t.mesh)
    this.smokes = []
    this.thrown = []
  }

  /** True when the segment a→b passes through an active smoke (bots cannot see through). */
  smokeBlocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const s of this.smokes) {
      if (s.life < 0.6) continue
      const r = s.r * 0.95
      const ab = tmp.subVectors(b, a)
      const len2 = ab.lengthSq()
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((s.pos.x - a.x) * ab.x + (s.pos.y - a.y) * ab.y + (s.pos.z - a.z) * ab.z) / len2)) : 0
      const cx = a.x + ab.x * t - s.pos.x
      const cy = a.y + ab.y * t - s.pos.y
      const cz = a.z + ab.z * t - s.pos.z
      if (cx * cx + cy * cy + cz * cz < r * r) return true
    }
    return false
  }

  /** Grenade thrown by the player: keep the economy in sync. */
  usedGrenade(): void {
    if (this.net) return
    this.state = useAbility(this.state, 0, 'grenade')
  }

  // ─── spectator ────────────────────────────────────────────────────────
  spectateTarget(): Bot | undefined {
    const alive = this.allies.filter(b => b.alive)
    if (!alive.length) return undefined
    return alive[this.spectateIndex % alive.length]
  }
  nextSpectate(): void {
    this.spectateIndex += 1
  }

  // ─── HUD ──────────────────────────────────────────────────────────────
  hud(): TacticalHud {
    const g = this.game
    const st = this.state
    const me = this.me
    const carrier = st.spike.carrier
    const atk = this.atk
    let progress: TacticalHud['progress'] = null
    if (this.plantT > 0 && this.plantBy === 0) progress = { kind: 'plant', t: this.plantT / st.cfg.plantTime }
    else if (this.defuseT > 0 && this.defuseBy === 0) progress = { kind: 'defuse', t: this.defuseT / st.cfg.defuseTime }
    const site = g.player.alive ? g.arena.siteAt(g.player.position) : undefined
    return {
      round: st.round,
      phase: st.phase,
      timer: st.phase === 'planted' ? st.spike.timer : st.timer,
      score: [st.score[0], st.score[1]],
      roundsToWin: st.cfg.roundsToWin,
      side: this.playerSide,
      credits: me.credits,
      loadout: me.loadout,
      allies: [
        { name: 'VOCÊ', alive: g.player.alive, hp: Math.ceil(g.player.health), shield: Math.ceil(g.player.armor), isPlayer: true, credits: me.credits },
        ...this.allies.map(b => ({ name: b.name, alive: b.alive, hp: Math.ceil(b.health), shield: Math.ceil(b.armor), isPlayer: false, credits: st.players.find(p => p.id === b.id)?.credits ?? 0 })),
      ],
      enemies: this.enemies.map(b => ({ name: b.name, alive: b.alive })),
      spike: {
        carried: carrier === 0,
        dropped: carrier === null && !st.spike.planted,
        planted: st.spike.planted,
        site: st.spike.site,
        timer: st.spike.timer,
        teamHasIt: atk === 0,
      },
      progress,
      inSite: site?.id ?? null,
      canBuy: this.canBuy,
      hint: this.hint,
      lastResult: st.phase === 'roundEnd' || st.phase === 'matchEnd' ? this.lastResult : null,
    }
  }

  minimap(): MinimapState {
    const g = this.game
    const st = this.state
    const showSpike = st.spike.planted || (st.spike.carrier === null && this.atk === 0)
    let spike: MinimapState['spike'] = showSpike ? { x: this.spikePos.x, z: this.spikePos.z, planted: st.spike.planted } : null
    if (!spike && st.spike.carrier !== null && this.atk === 0) {
      const c = st.spike.carrier === 0 ? g.player.position : this.byId.get(st.spike.carrier)?.pos
      if (c) spike = { x: c.x, z: c.z, planted: false }
    }
    return {
      player: { x: g.player.position.x, z: g.player.position.z, yaw: g.player.yaw, alive: g.player.alive },
      allies: this.allies.map(b => ({ x: b.pos.x, z: b.pos.z, alive: b.alive })),
      enemies: this.enemies.filter(e => e.alive && this.seenEnemies.has(e.id)).map(e => ({ x: e.pos.x, z: e.pos.z })),
      spike,
    }
  }

  /** Scoreboard rows (Tab): our team first. */
  scoreboard(): { name: string; team: TeamIndex; kills: number; deaths: number; credits: number; alive: boolean; isPlayer: boolean }[] {
    return [...this.state.players]
      .sort((a, b) => a.team - b.team || b.kills - a.kills)
      .map(p => ({ name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, credits: p.credits, alive: p.alive, isPlayer: p.id === 0 }))
  }

  dispose(): void {
    for (const f of this.netOff) f()
    this.netOff.length = 0
    if (this.net) {
      this.net.client.streamFrames(() => null)
      this.net.dispose()
    }
    this.clearSmokes()
    this.game.scene.remove(this.spikeMesh)
    this.game.scene.remove(this.smokeWarm)
    this.game.arena.setBarriers(false)
    for (const b of this.bots) b.hide()
  }

  get alive(): [number, number] {
    return [aliveCount(this.state, 0), aliveCount(this.state, 1)]
  }
  static price(item: ShopItem): number {
    return SHOP[item].price
  }
  /** Restart the round flow from scratch (used by tests/debug). */
  forceRound(): void {
    this.apply(startRound(this.state, null))
  }
}

// ─── meshes ─────────────────────────────────────────────────────────────

function buildSpike(): { group: THREE.Group; glow: THREE.MeshBasicMaterial } {
  const g = new THREE.Group()
  const dark = new THREE.MeshLambertMaterial({ color: '#2b2f36' })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.42, 8), dark)
  body.position.y = 0.21
  g.add(body)
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.1, 0.08), toneMapped: false })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 6, 16), glow)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.3
  g.add(ring)
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), glow)
  core.position.y = 0.52
  g.add(core)
  for (let i = 0; i < 4; i += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.2), dark)
    fin.position.set(Math.cos((i * Math.PI) / 2) * 0.2, 0.15, Math.sin((i * Math.PI) / 2) * 0.2)
    fin.rotation.y = -(i * Math.PI) / 2
    g.add(fin)
  }
  return { group: g, glow }
}

let smokeGeo: THREE.BufferGeometry | undefined
let smokeMat: THREE.Material | undefined
/** Opaque dome like a tactical shooter's smoke: readable, cheap, and you cannot see through it. */
function smokeGeometry(): THREE.BufferGeometry {
  smokeGeo ??= new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62)
  return smokeGeo
}
function smokeMaterial(): THREE.Material {
  smokeMat ??= new THREE.MeshLambertMaterial({ color: '#b9c9d6', emissive: '#4a5a66', side: THREE.DoubleSide, transparent: true, opacity: 0.97, depthWrite: true })
  return smokeMat
}
