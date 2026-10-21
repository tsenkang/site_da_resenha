/**
 * One online room: lobby → tactical match. Transport-agnostic (members are `Conn`s with a send
 * function) so the whole flow is unit-testable without sockets.
 *
 * The round flow, economy, buys, plants and defuses run through src/game/tactical.ts on the
 * server. Movement frames are relayed with a speed sanity check; hit claims are validated against
 * fire rate, per-weapon damage caps, range, team and life state before damage is applied.
 *
 * Empty slots (`fillBots`) are placeholder players that start every round eliminated, so 2v1 or
 * 3v2 rooms play out; host-driven bots are the next step (see docs/ONLINE.md).
 */
import {
  attackingTeam, buy, createTactical, defuseSpike, plantSpike, registerKill, setCarrier, setShield, tacticalConfig, tickTactical, useAbility,
  type LoadoutWeapon, type TacticalEvent, type TacticalState, type TeamIndex, type TeamSize,
} from '../../src/game/tactical.ts'
import {
  canStart, createLobby, fillWithBots, joinLobby, leaveLobby, lobbyView, setFillBots, setReady, switchTeam, type Lobby,
} from '../../src/net/lobby.ts'
import { NET_RATE, type ClientMessage, type ErrorCode, type PlayerFrame, type RoundView, type ServerMessage, type Vec3 } from '../../src/net/protocol.ts'

export type Conn = { id: string; name: string; send(msg: ServerMessage): void }

/** Per-weapon limits for hit validation (tactical tuning, see src/game/config.ts). */
export const WEAPON_LIMITS: Record<LoadoutWeapon, { interval: number; maxDamage: number; range: number }> = {
  pistol: { interval: 0.13, maxDamage: 78, range: 120 },
  rifle: { interval: 0.09, maxDamage: 160, range: 220 },
  shotgun: { interval: 0.26, maxDamage: 270, range: 60 },
}
const MAX_SPEED = 9.5
const POS_TOLERANCE = 6
/** Frag grenade: blast radius and peak damage (matches the client explosion). */
export const GRENADE = { radius: 5.7, damage: 125 }
/** Reach for picking up a dropped spike and for defusing a planted one. */
const PICKUP_RANGE = 1.8
const DEFUSE_RANGE = 2.6
/** Smokes/grenades must land within this distance of the thrower's last position. */
const THROW_RANGE = 45

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const distXZ = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2])

/**
 * `fireBudget`: seconds of trigger time banked (capped at FIRE_BURST). Each accepted hit spends its
 * weapon's fire interval, so two shots that reach the server inside one tick still both count.
 */
type Live = { frame: PlayerFrame | null; frameAt: number; hp: number; shield: number; fireBudget: number }
const FIRE_BURST = 0.2

export class Room {
  readonly code: string
  lobby: Lobby
  private readonly conns = new Map<string, Conn>()
  state: TacticalState | null = null
  /** Rules ids are numbers; network ids are strings. */
  private readonly toRules = new Map<string, number>()
  private readonly toNet = new Map<number, string>()
  private readonly live = new Map<string, Live>()
  private time = 0
  private tickN = 0
  private snapT = 0
  private roundSentKey = ''
  /** Where the spike lies when nobody carries it (dropped or planted); null at round start. */
  spikePos: Vec3 | null = null
  /** Random source for the spike carrier (tests make it deterministic). */
  rand: () => number = Math.random

  constructor(code: string, teamSize: TeamSize, host: Conn) {
    this.code = code
    this.lobby = createLobby(code, teamSize, host)
    this.conns.set(host.id, host)
    this.broadcastLobby()
  }

  get empty(): boolean {
    return this.conns.size === 0
  }

  join(c: Conn): ErrorCode | null {
    const r = joinLobby(this.lobby, c)
    if (!r.ok) return r.reason === 'in_match' ? 'in_match' : 'room_full'
    this.lobby = r.lobby
    this.conns.set(c.id, c)
    this.broadcastLobby()
    return null
  }

  leave(id: string): void {
    this.conns.delete(id)
    const next = leaveLobby(this.lobby, id)
    if (!next) {
      this.conns.clear()
      return
    }
    this.lobby = next
    // A player who leaves mid-match counts as dead for the round.
    const rid = this.toRules.get(id)
    if (this.state && rid !== undefined) this.kill(-1, rid)
    this.broadcastLobby()
  }

  private error(id: string, code: ErrorCode, message: string): void {
    this.conns.get(id)?.send({ t: 'error', code, message })
  }

  handle(id: string, msg: ClientMessage): void {
    switch (msg.t) {
      case 'team': {
        const r = switchTeam(this.lobby, id, msg.team)
        if (r.ok) this.lobby = r.lobby
        else this.error(id, r.reason === 'in_match' ? 'in_match' : 'room_full', 'Não foi possível trocar de time')
        return this.broadcastLobby()
      }
      case 'ready':
        this.lobby = setReady(this.lobby, id, msg.ready)
        return this.broadcastLobby()
      case 'fillBots': {
        const r = setFillBots(this.lobby, id, msg.on)
        if (r.ok) this.lobby = r.lobby
        else this.error(id, 'not_host', 'Só o anfitrião pode mudar isso')
        return this.broadcastLobby()
      }
      case 'start':
        return this.start(id)
      case 'frame':
        return this.onFrame(id, msg.f)
      case 'hit':
        return this.onHit(id, msg.h.target, msg.h.damage, msg.h.headshot, msg.h.weapon, msg.h.distance)
      case 'buy': {
        const rid = this.toRules.get(id)
        if (!this.state || rid === undefined) return
        const r = buy(this.state, rid, msg.item)
        if (r.ok) {
          this.state = r.state
          this.syncLiveFromLoadout(id)
        }
        this.conns.get(id)?.send({ t: 'buyResult', item: msg.item, ok: r.ok, reason: r.ok ? undefined : r.reason })
        return this.sendRound(true)
      }
      case 'plant': {
        const rid = this.toRules.get(id)
        const f = this.live.get(id)?.frame
        if (!this.state || rid === undefined || !f || this.state.spike.carrier !== rid) return
        const r = plantSpike(this.state, rid, msg.site)
        if (r.state.spike.planted) this.spikePos = [...f.pos]
        return this.apply(r)
      }
      case 'defuse': {
        const rid = this.toRules.get(id)
        const f = this.live.get(id)?.frame
        if (!this.state || rid === undefined || !f || !this.spikePos || distXZ(f.pos, this.spikePos) > DEFUSE_RANGE) return
        return this.apply(defuseSpike(this.state, rid))
      }
      case 'smoke':
      case 'grenade':
        return this.onThrow(id, msg.t, msg.at)
      case 'ping':
        this.conns.get(id)?.send({ t: 'pong', at: msg.at, server: Date.now() })
        return
      default:
        return
    }
  }

  private start(by: string): void {
    const r = canStart(this.lobby, by)
    if (!r.ok) return this.error(by, r.reason === 'not_host' ? 'not_host' : 'not_ready', 'Ainda não dá para começar')
    this.lobby = fillWithBots(r.lobby)
    this.lobby.members.forEach((m, i) => {
      this.toRules.set(m.id, i)
      this.toNet.set(i, m.id)
      this.live.set(m.id, { frame: null, frameAt: 0, hp: 100, shield: 0, fireBudget: FIRE_BURST })
    })
    this.state = createTactical(tacticalConfig(this.lobby.teamSize), this.lobby.members.map((m, i) => ({ id: i, name: m.name, team: m.team })))
    this.broadcastLobby()
    const roster = this.lobby.members.map(m => m.id)
    for (const m of this.lobby.members) this.conns.get(m.id)?.send({ t: 'matchStart', you: m.id, team: m.team, roster })
    this.beginRound()
    this.sendRound(true)
  }

  // ─── authority checks ─────────────────────────────────────────────────
  private onFrame(id: string, f: PlayerFrame): void {
    const l = this.live.get(id)
    if (!l || !this.state) return
    const rid = this.toRules.get(id)!
    if (!this.state.players[rid]?.alive) return
    if (l.frame && this.time - l.frameAt > 0) {
      const [x0, , z0] = l.frame.pos
      const [x1, , z1] = f.pos
      const dt = Math.max(1 / NET_RATE, this.time - l.frameAt)
      // Allow a teleport on the first frame of a round (spawn); otherwise cap horizontal speed.
      if (Math.hypot(x1 - x0, z1 - z0) / dt > MAX_SPEED * 1.6 && f.seq > l.frame.seq + 1 && this.state.phase !== 'buy') return
    }
    l.frame = f
    l.frameAt = this.time
  }

  private onHit(conn: string, target: string, damage: number, headshot: boolean, weapon: LoadoutWeapon, distance: number): void {
    const st = this.state
    if (!st || (st.phase !== 'combat' && st.phase !== 'planted')) return
    const shooter = conn
    const sr = this.toRules.get(shooter)
    const tr = this.toRules.get(target)
    if (sr === undefined || tr === undefined || sr === tr) return
    const sp = st.players[sr]
    const tp = st.players[tr]
    if (!sp.alive || !tp.alive || sp.team === tp.team) return
    if (weapon !== 'pistol' && sp.loadout.weapon !== weapon) return
    const lim = WEAPON_LIMITS[weapon]
    const sl = this.live.get(shooter)!
    if (sl.fireBudget < lim.interval - 1e-6) return
    if (distance > lim.range) return
    const sf = sl.frame
    const tf = this.live.get(target)!.frame
    if (sf && tf) {
      const real = Math.hypot(sf.pos[0] - tf.pos[0], sf.pos[1] - tf.pos[1], sf.pos[2] - tf.pos[2])
      if (Math.abs(real - distance) > POS_TOLERANCE + real * 0.15) return
    }
    sl.fireBudget -= lim.interval
    this.applyDamage(shooter, target, Math.min(lim.maxDamage, damage), headshot, weapon)
  }

  /** Server-side damage: shields soak first; at 0 hp the kill is scored. */
  private applyDamage(shooter: string, target: string, amount: number, headshot: boolean, weapon: LoadoutWeapon | 'grenade'): void {
    const st = this.state
    const sr = this.toRules.get(shooter)
    const tr = this.toRules.get(target)
    const tl = this.live.get(target)
    if (!st || sr === undefined || tr === undefined || !tl || !st.players[tr].alive || amount <= 0) return
    const soaked = Math.min(tl.shield, amount)
    tl.shield -= soaked
    tl.hp = Math.max(0, tl.hp - (amount - soaked))
    this.state = setShield(st, tr, tl.shield)
    this.broadcast({ t: 'damage', target, by: shooter, amount, hp: tl.hp, shield: tl.shield, headshot })
    if (tl.hp <= 0) {
      this.broadcast({ t: 'kill', killer: shooter, victim: target, weapon, headshot })
      this.kill(sr === tr ? -1 : sr, tr)
    }
  }

  /** A player is out: drops the spike where they stood, then scores the kill. */
  private kill(killer: number, victim: number): void {
    if (!this.state) return
    if (this.state.spike.carrier === victim) {
      const f = this.live.get(this.toNet.get(victim)!)?.frame
      if (f) this.spikePos = [...f.pos]
    }
    this.apply(registerKill(this.state, killer, victim))
  }

  /** Smoke or frag thrown by a player who owns one; frags deal splash damage here (authoritative). */
  private onThrow(id: string, kind: 'smoke' | 'grenade', at: Vec3): void {
    const st = this.state
    const rid = this.toRules.get(id)
    const f = this.live.get(id)?.frame
    if (!st || rid === undefined || !f || (st.phase !== 'combat' && st.phase !== 'planted')) return
    const p = st.players[rid]
    if (!p.alive || (kind === 'smoke' ? p.loadout.smokes : p.loadout.grenades) <= 0 || dist3(f.pos, at) > THROW_RANGE) return
    this.state = useAbility(st, rid, kind)
    this.broadcast({ t: kind, by: id, at })
    if (kind !== 'grenade') return
    for (const [target, l] of this.live) {
      const tr = this.toRules.get(target)!
      const tp = this.state.players[tr]
      if (!l.frame || !tp.alive || (tp.team === p.team && target !== id)) continue
      const d = dist3([l.frame.pos[0], l.frame.pos[1] + 0.9, l.frame.pos[2]], at)
      if (d >= GRENADE.radius) continue
      const k = 1 - d / GRENADE.radius
      const dmg = GRENADE.damage * (0.25 + 0.75 * k * k) * (target === id ? 0.5 : 1)
      this.applyDamage(id, target, Math.round(dmg), false, 'grenade')
    }
  }

  private syncLiveFromLoadout(id: string): void {
    const rid = this.toRules.get(id)
    const l = this.live.get(id)
    if (!this.state || rid === undefined || !l) return
    l.shield = this.state.players[rid].loadout.shield
  }

  private resetRoundLives(): void {
    if (!this.state) return
    for (const [id, l] of this.live) {
      const p = this.state.players[this.toRules.get(id)!]
      l.hp = 100
      l.shield = p.loadout.shield
      l.frame = null
      l.fireBudget = FIRE_BURST
    }
  }

  // ─── simulation tick ──────────────────────────────────────────────────
  tick(dt: number): void {
    this.time += dt
    if (!this.state) return
    for (const l of this.live.values()) l.fireBudget = Math.min(FIRE_BURST, l.fireBudget + dt)
    this.apply(tickTactical(this.state, dt))
    this.pickUpSpike()
    this.snapT -= dt
    if (this.snapT <= 0) {
      this.snapT = 1 / NET_RATE
      this.tickN += 1
      const players = [...this.live.entries()]
        .filter(([, l]) => l.frame)
        .map(([id, l]) => ({ id, hp: l.hp, ...(l.frame as PlayerFrame) }))
      if (players.length) this.broadcast({ t: 'snapshot', s: { tick: this.tickN, players } })
      this.sendRound(false)
    }
  }

  private apply(r: { state: TacticalState; events: TacticalEvent[] }): void {
    this.state = r.state
    if (r.events.some(e => e.type === 'roundStart')) this.beginRound()
    if (r.events.length) this.sendRound(true)
  }

  /** New round: full health, the spike goes to a random human attacker, open slots sit out. */
  private beginRound(): void {
    if (!this.state) return
    this.resetRoundLives()
    this.spikePos = null
    const atk = attackingTeam(this.state)
    const humans = this.lobby.members.filter(m => !m.bot && m.team === atk).map(m => this.toRules.get(m.id)!)
    if (humans.length) this.state = setCarrier(this.state, humans[Math.floor(this.rand() * humans.length)])
    this.eliminatePlaceholders()
  }

  /** A living attacker walking over the dropped spike picks it up. */
  private pickUpSpike(): void {
    const st = this.state
    if (!st || st.spike.carrier !== null || st.spike.planted || !this.spikePos || (st.phase !== 'combat' && st.phase !== 'buy')) return
    const atk = attackingTeam(st)
    for (const [id, l] of this.live) {
      const rid = this.toRules.get(id)!
      const p = st.players[rid]
      if (!l.frame || !p.alive || p.team !== atk || distXZ(l.frame.pos, this.spikePos) > PICKUP_RANGE) continue
      this.state = setCarrier(st, rid)
      this.spikePos = null
      return this.sendRound(true)
    }
  }

  /** Placeholder slots start each round out of play (no kill credit, no credits change). */
  private eliminatePlaceholders(): void {
    for (const m of this.lobby.members) {
      if (!m.bot || !this.state) continue
      this.state = registerKill(this.state, -1, this.toRules.get(m.id)!).state
    }
  }

  roundView(): RoundView | null {
    const st = this.state
    if (!st) return null
    const id = (n: number | null) => (n === null ? null : this.toNet.get(n) ?? null)
    return {
      round: st.round,
      phase: st.phase,
      timer: Math.round(st.timer * 10) / 10,
      score: st.score,
      attackers: attackingTeam(st),
      spike: { carrier: id(st.spike.carrier), planted: st.spike.planted, site: st.spike.site },
      players: st.players.map(p => ({ id: this.toNet.get(p.id)!, team: p.team as TeamIndex, alive: p.alive, credits: p.credits, kills: p.kills, deaths: p.deaths, weapon: p.loadout.weapon, shield: p.loadout.shield })),
    }
  }

  /** Round state goes out on every change and once a second otherwise (timer resync). */
  private sendRound(force: boolean): void {
    const v = this.roundView()
    if (!v) return
    const key = `${v.round}|${v.phase}|${Math.ceil(v.timer)}`
    if (!force && key === this.roundSentKey) return
    this.roundSentKey = key
    this.broadcast({ t: 'round', round: v })
    this.broadcast({ t: 'state', s: this.state!, spikePos: this.spikePos })
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', lobby: lobbyView(this.lobby) })
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.conns.values()) c.send(msg)
  }
}
