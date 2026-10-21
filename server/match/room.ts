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
  attackingTeam, buy, createTactical, defuseSpike, plantSpike, registerKill, setShield, tacticalConfig, tickTactical,
  type LoadoutWeapon, type TacticalEvent, type TacticalState, type TeamIndex, type TeamSize,
} from '../../src/game/tactical.ts'
import {
  canStart, createLobby, fillWithBots, joinLobby, leaveLobby, lobbyView, setFillBots, setReady, switchTeam, type Lobby,
} from '../../src/net/lobby.ts'
import { NET_RATE, type ClientMessage, type ErrorCode, type PlayerFrame, type RoundView, type ServerMessage } from '../../src/net/protocol.ts'

export type Conn = { id: string; name: string; send(msg: ServerMessage): void }

/** Per-weapon limits for hit validation (tactical tuning, see src/game/config.ts). */
export const WEAPON_LIMITS: Record<LoadoutWeapon, { interval: number; maxDamage: number; range: number }> = {
  pistol: { interval: 0.13, maxDamage: 78, range: 120 },
  rifle: { interval: 0.09, maxDamage: 160, range: 220 },
  shotgun: { interval: 0.26, maxDamage: 270, range: 60 },
}
const MAX_SPEED = 9.5
const POS_TOLERANCE = 6

type Live = { frame: PlayerFrame | null; frameAt: number; hp: number; shield: number; lastShot: number }

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
    if (this.state && rid !== undefined) this.apply(registerKill(this.state, -1, rid))
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
        if (!this.state || rid === undefined) return
        return this.apply(plantSpike(this.state, rid, msg.site))
      }
      case 'defuse': {
        const rid = this.toRules.get(id)
        if (!this.state || rid === undefined) return
        return this.apply(defuseSpike(this.state, rid))
      }
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
      this.live.set(m.id, { frame: null, frameAt: 0, hp: 100, shield: 0, lastShot: -1 })
    })
    const roster = this.lobby.members.map((m, i) => ({ id: i, name: m.name, team: m.team }))
    this.state = createTactical(tacticalConfig(this.lobby.teamSize), roster)
    this.broadcastLobby()
    for (const m of this.lobby.members) this.conns.get(m.id)?.send({ t: 'matchStart', you: m.id, team: m.team })
    this.resetRoundLives()
    this.eliminatePlaceholders()
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
    if (this.time - sl.lastShot < lim.interval) return
    if (distance > lim.range) return
    const sf = sl.frame
    const tf = this.live.get(target)!.frame
    if (sf && tf) {
      const real = Math.hypot(sf.pos[0] - tf.pos[0], sf.pos[1] - tf.pos[1], sf.pos[2] - tf.pos[2])
      if (Math.abs(real - distance) > POS_TOLERANCE + real * 0.15) return
    }
    sl.lastShot = this.time
    const amount = Math.min(lim.maxDamage, damage)
    const tl = this.live.get(target)!
    const soaked = Math.min(tl.shield, amount)
    tl.shield -= soaked
    tl.hp = Math.max(0, tl.hp - (amount - soaked))
    this.state = setShield(st, tr, tl.shield)
    this.broadcast({ t: 'damage', target, by: shooter, amount, hp: tl.hp, headshot })
    if (tl.hp <= 0) {
      this.broadcast({ t: 'kill', killer: shooter, victim: target, weapon, headshot })
      this.apply(registerKill(this.state, sr, tr))
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
      l.lastShot = -1
    }
  }

  // ─── simulation tick ──────────────────────────────────────────────────
  tick(dt: number): void {
    this.time += dt
    if (!this.state) return
    this.apply(tickTactical(this.state, dt))
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
    if (r.events.some(e => e.type === 'roundStart')) {
      this.resetRoundLives()
      this.eliminatePlaceholders()
    }
    if (r.events.length) this.sendRound(true)
  }

  /** Placeholder slots start each round out of play (no kill credit, no credits change). */
  private eliminatePlaceholders(): void {
    for (const m of this.lobby.members) {
      if (!m.bot || !this.state) continue
      const r = registerKill(this.state, -1, this.toRules.get(m.id)!)
      this.state = r.state
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
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', lobby: lobbyView(this.lobby) })
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.conns.values()) c.send(msg)
  }
}
