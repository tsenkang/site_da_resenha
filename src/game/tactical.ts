/**
 * Tactical ("Spike") mode rules: two teams, attack/defend rounds, a buy phase with credits, a spike
 * to plant on Site A or B and defuse, halftime side swap, first team to `roundsToWin`.
 *
 * Pure and deterministic (no three.js, no DOM, no randomness): the same module drives the local
 * match against bots today and is imported by the online match server (server/match), so a client
 * and the authoritative server always agree on round results and the economy.
 */
import { DEFAULT_PISTOL, GUN_IDS, GUNS, isPistol, type GunId, type PistolId, type PrimaryId } from './gunSpecs.ts'

export type TeamIndex = 0 | 1
export type Side = 'attack' | 'defend'
export type TacticalPhase = 'buy' | 'combat' | 'planted' | 'roundEnd' | 'matchEnd'
export type SiteId = 'A' | 'B'
/** A gun from the tactical arsenal (gunSpecs.ts). */
export type LoadoutWeapon = GunId
export type ShopItem = GunId | 'lightShield' | 'heavyShield' | 'smoke' | 'grenade'
export type RoundEndReason = 'elimination' | 'detonated' | 'defused' | 'time'

/** Supported team sizes: 2v2 … 5v5. */
export const TEAM_SIZES = [2, 3, 4, 5] as const
export type TeamSize = (typeof TEAM_SIZES)[number]

export type TacticalConfig = {
  teamSize: TeamSize
  /** First team to this many round wins takes the match. */
  roundsToWin: number
  /** Sides swap after this many rounds (credits reset). */
  halftime: number
  buyTime: number
  roundTime: number
  /** Seconds from plant to detonation. */
  spikeTime: number
  plantTime: number
  defuseTime: number
  roundEndTime: number
  startCredits: number
  maxCredits: number
}

/** Quick match (default): first to 5, sides swap after round 4. Competitive: first to 13. */
export const TACTICAL_PRESETS = {
  quick: { roundsToWin: 5, halftime: 4, buyTime: 20, roundTime: 100, spikeTime: 40, plantTime: 4, defuseTime: 7, roundEndTime: 5, startCredits: 800, maxCredits: 9000 },
  competitive: { roundsToWin: 13, halftime: 12, buyTime: 30, roundTime: 100, spikeTime: 45, plantTime: 4, defuseTime: 7, roundEndTime: 7, startCredits: 800, maxCredits: 9000 },
} satisfies Record<string, Omit<TacticalConfig, 'teamSize'>>

export function tacticalConfig(teamSize: TeamSize, preset: keyof typeof TACTICAL_PRESETS = 'quick'): TacticalConfig {
  return { teamSize, ...TACTICAL_PRESETS[preset] }
}

/** `kill` is the reward when the weapon is unknown (grenades, the spike); guns pay their own `killReward`. */
export const ECONOMY = { kill: 300, plant: 300, win: 3000, lossBase: 1900, lossStep: 500, lossMax: 2900 }

export const SHOP: Record<ShopItem, { price: number; label: string; kind: 'weapon' | 'shield' | 'ability'; max?: number }> = {
  ...(Object.fromEntries(GUN_IDS.map(id => [id, { price: GUNS[id].price, label: GUNS[id].name, kind: 'weapon' as const }])) as Record<GunId, { price: number; label: string; kind: 'weapon' }>),
  lightShield: { price: 400, label: 'Escudo leve (25)', kind: 'shield' },
  heavyShield: { price: 1000, label: 'Escudo pesado (50)', kind: 'shield' },
  smoke: { price: 200, label: 'Fumaça', kind: 'ability', max: 2 },
  grenade: { price: 300, label: 'Granada', kind: 'ability', max: 1 },
}

/** A primary gun (rifle, SMG, shotgun, sniper) if bought, always a pistol, shield and abilities. */
export type Loadout = { primary: PrimaryId | null; sidearm: PistolId; shield: 0 | 25 | 50; smokes: number; grenades: number }
export const BASE_LOADOUT: Loadout = { primary: null, sidearm: DEFAULT_PISTOL, shield: 0, smokes: 0, grenades: 0 }
/** The gun drawn at round start: the primary if there is one. */
export const mainGun = (l: Loadout): GunId => l.primary ?? l.sidearm
/** True when the loadout carries this gun. */
export const ownsGun = (l: Loadout, gun: GunId): boolean => l.primary === gun || l.sidearm === gun

export type TacticalPlayer = {
  id: number
  name: string
  team: TeamIndex
  alive: boolean
  credits: number
  kills: number
  deaths: number
  plants: number
  defuses: number
  loadout: Loadout
  /** Credits spent this buy phase (refundable). */
  spent: number
}

export type SpikeState = {
  carrier: number | null
  planted: boolean
  site: SiteId | null
  planter: number | null
  /** Seconds to detonation once planted. */
  timer: number
}

export type RoundResult = { round: number; winner: TeamIndex; reason: RoundEndReason }

export type TacticalState = {
  cfg: TacticalConfig
  round: number
  phase: TacticalPhase
  /** Seconds left in the current phase. */
  timer: number
  score: [number, number]
  lossStreak: [number, number]
  players: TacticalPlayer[]
  spike: SpikeState
  history: RoundResult[]
  winner: TeamIndex | null
}

export type TacticalEvent =
  | { type: 'roundStart'; round: number; attackers: TeamIndex }
  | { type: 'combatStart'; round: number }
  | { type: 'planted'; site: SiteId; by: number }
  | { type: 'roundEnd'; result: RoundResult }
  | { type: 'halftime' }
  | { type: 'matchEnd'; winner: TeamIndex }

export type Roster = { id: number; name: string; team: TeamIndex }[]

/** Which side a team plays in a given round (team 0 attacks first). */
export function sideOf(team: TeamIndex, round: number, cfg: TacticalConfig): Side {
  const firstHalf = round <= cfg.halftime
  const attacksFirst = team === 0
  return firstHalf === attacksFirst ? 'attack' : 'defend'
}

export function attackingTeam(state: TacticalState): TeamIndex {
  return sideOf(0, state.round, state.cfg) === 'attack' ? 0 : 1
}

export function createTactical(cfg: TacticalConfig, roster: Roster): TacticalState {
  for (const t of [0, 1] as TeamIndex[]) {
    const n = roster.filter(p => p.team === t).length
    if (n !== cfg.teamSize) throw new Error(`team ${t} has ${n} players, expected ${cfg.teamSize}`)
  }
  const players: TacticalPlayer[] = roster.map(p => ({
    id: p.id, name: p.name, team: p.team, alive: true, credits: cfg.startCredits,
    kills: 0, deaths: 0, plants: 0, defuses: 0, loadout: { ...BASE_LOADOUT }, spent: 0,
  }))
  const state: TacticalState = {
    cfg, round: 0, phase: 'buy', timer: 0, score: [0, 0], lossStreak: [0, 0], players,
    spike: { carrier: null, planted: false, site: null, planter: null, timer: 0 }, history: [], winner: null,
  }
  return startRound(state, null).state
}

/**
 * Begin the next round: everyone revives, dead players lose their loadout, the spike goes to an
 * attacker (`carrier` if valid, else the first attacker in roster order).
 */
export function startRound(prev: TacticalState, carrier: number | null): { state: TacticalState; events: TacticalEvent[] } {
  const round = prev.round + 1
  const events: TacticalEvent[] = []
  const swap = prev.round === prev.cfg.halftime
  if (swap) events.push({ type: 'halftime' })
  const players = prev.players.map(p => ({
    ...p,
    alive: true,
    spent: 0,
    credits: swap ? prev.cfg.startCredits : p.credits,
    // Survivors keep their gear (Valorant rule); the dead and everyone at halftime start fresh.
    loadout: swap || !p.alive ? { ...BASE_LOADOUT } : { ...p.loadout },
  }))
  const state: TacticalState = {
    ...prev, round, phase: 'buy', timer: prev.cfg.buyTime, players,
    lossStreak: swap ? [0, 0] : prev.lossStreak,
    spike: { carrier: null, planted: false, site: null, planter: null, timer: 0 },
  }
  const atk = attackingTeam(state)
  const valid = players.find(p => p.id === carrier && p.team === atk)
  state.spike.carrier = (valid ?? players.find(p => p.team === atk))?.id ?? null
  events.push({ type: 'roundStart', round, attackers: atk })
  return { state, events }
}

function alive(state: TacticalState, team: TeamIndex): number {
  return state.players.reduce((n, p) => n + (p.team === team && p.alive ? 1 : 0), 0)
}

export function aliveCount(state: TacticalState, team: TeamIndex): number {
  return alive(state, team)
}

function endRound(state: TacticalState, winner: TeamIndex, reason: RoundEndReason): { state: TacticalState; events: TacticalEvent[] } {
  const loser: TeamIndex = winner === 0 ? 1 : 0
  const score: [number, number] = [...state.score]
  score[winner] += 1
  const lossStreak: [number, number] = [...state.lossStreak]
  lossStreak[winner] = 0
  lossStreak[loser] += 1
  const lossBonus = Math.min(ECONOMY.lossMax, ECONOMY.lossBase + ECONOMY.lossStep * (lossStreak[loser] - 1))
  const players = state.players.map(p => ({
    ...p,
    credits: Math.min(state.cfg.maxCredits, p.credits + (p.team === winner ? ECONOMY.win : lossBonus)),
  }))
  const result: RoundResult = { round: state.round, winner, reason }
  const events: TacticalEvent[] = [{ type: 'roundEnd', result }]
  const won = score[winner] >= state.cfg.roundsToWin
  if (won) events.push({ type: 'matchEnd', winner })
  return {
    state: { ...state, score, lossStreak, players, history: [...state.history, result], phase: won ? 'matchEnd' : 'roundEnd', timer: state.cfg.roundEndTime, winner: won ? winner : null },
    events,
  }
}

/** Advance timers. Returns the new state and any phase events. */
export function tickTactical(state: TacticalState, dt: number): { state: TacticalState; events: TacticalEvent[] } {
  if (state.phase === 'matchEnd') return { state, events: [] }
  if (state.phase === 'planted') {
    const timer = state.spike.timer - dt
    const s = { ...state, spike: { ...state.spike, timer: Math.max(0, timer) }, timer: Math.max(0, timer) }
    if (timer <= 0) return endRound(s, attackingTeam(s), 'detonated')
    return { state: s, events: [] }
  }
  const timer = state.timer - dt
  if (timer > 0) return { state: { ...state, timer }, events: [] }
  switch (state.phase) {
    case 'buy':
      return { state: { ...state, phase: 'combat', timer: state.cfg.roundTime }, events: [{ type: 'combatStart', round: state.round }] }
    case 'combat':
      // Time ran out without a plant: defenders hold.
      return endRound({ ...state, timer: 0 }, attackingTeam(state) === 0 ? 1 : 0, 'time')
    case 'roundEnd':
      return startRound({ ...state, timer: 0 }, null)
  }
}

/**
 * A player died (killer -1 for world/self). Pays the kill reward (by weapon, like the real thing:
 * SMGs and shotguns pay more, the big sniper less) and checks for elimination.
 */
export function registerKill(state: TacticalState, killer: number, victim: number, weapon?: GunId | 'grenade'): { state: TacticalState; events: TacticalEvent[] } {
  if (state.phase !== 'combat' && state.phase !== 'planted' && state.phase !== 'buy') return { state, events: [] }
  const v = state.players.find(p => p.id === victim)
  if (!v || !v.alive) return { state, events: [] }
  const k = state.players.find(p => p.id === killer)
  const players = state.players.map(p => {
    if (p.id === victim) return { ...p, alive: false, deaths: p.deaths + 1 }
    const reward = weapon && weapon !== 'grenade' ? GUNS[weapon].killReward : ECONOMY.kill
    if (k && p.id === killer && k.team !== v.team) return { ...p, kills: p.kills + 1, credits: Math.min(state.cfg.maxCredits, p.credits + reward) }
    return p
  })
  const spike = state.spike.carrier === victim ? { ...state.spike, carrier: null } : state.spike
  const s = { ...state, players, spike }
  const atk = attackingTeam(s)
  const def: TeamIndex = atk === 0 ? 1 : 0
  if (alive(s, def) === 0) return endRound(s, atk, 'elimination')
  if (alive(s, atk) === 0 && !s.spike.planted) return endRound(s, def, 'elimination')
  return { state: s, events: [] }
}

/** Spike dropped on death or picked up again by an attacker (null = on the ground). */
export function setCarrier(state: TacticalState, id: number | null): TacticalState {
  if (state.spike.planted) return state
  if (id !== null) {
    const p = state.players.find(q => q.id === id)
    if (!p || !p.alive || p.team !== attackingTeam(state)) return state
  }
  return { ...state, spike: { ...state.spike, carrier: id } }
}

/** Plant finished by `by` on `site`. Every attacker earns the plant bonus. */
export function plantSpike(state: TacticalState, by: number, site: SiteId): { state: TacticalState; events: TacticalEvent[] } {
  const p = state.players.find(q => q.id === by)
  if (state.phase !== 'combat' || !p || !p.alive || state.spike.carrier !== by) return { state, events: [] }
  const atk = attackingTeam(state)
  const players = state.players.map(q => {
    const credits = q.team === atk ? Math.min(state.cfg.maxCredits, q.credits + ECONOMY.plant) : q.credits
    return q.id === by ? { ...q, credits, plants: q.plants + 1 } : { ...q, credits }
  })
  const spike: SpikeState = { carrier: null, planted: true, site, planter: by, timer: state.cfg.spikeTime }
  return { state: { ...state, players, spike, phase: 'planted', timer: state.cfg.spikeTime }, events: [{ type: 'planted', site, by }] }
}

/** Defuse finished by a living defender. */
export function defuseSpike(state: TacticalState, by: number): { state: TacticalState; events: TacticalEvent[] } {
  const p = state.players.find(q => q.id === by)
  if (state.phase !== 'planted' || !p || !p.alive || p.team === attackingTeam(state)) return { state, events: [] }
  const players = state.players.map(q => (q.id === by ? { ...q, defuses: q.defuses + 1 } : q))
  return endRound({ ...state, players }, p.team, 'defused')
}

export type BuyResult = { ok: true; state: TacticalState } | { ok: false; reason: 'phase' | 'credits' | 'owned' | 'max' | 'dead' }

/** Buy an item during the buy phase. A gun replaces the one in its slot; shields never downgrade. */
export function buy(state: TacticalState, id: number, item: ShopItem): BuyResult {
  if (state.phase !== 'buy') return { ok: false, reason: 'phase' }
  const p = state.players.find(q => q.id === id)
  if (!p || !p.alive) return { ok: false, reason: 'dead' }
  const def = SHOP[item]
  if (p.credits < def.price) return { ok: false, reason: 'credits' }
  const l = p.loadout
  const next: Loadout = { ...l }
  if (item in GUNS) {
    const gun = item as GunId
    if (ownsGun(l, gun)) return { ok: false, reason: 'owned' }
    if (isPistol(gun)) next.sidearm = gun
    else next.primary = gun as PrimaryId
  } else if (item === 'lightShield' || item === 'heavyShield') {
    const amount = item === 'lightShield' ? 25 : 50
    if (l.shield >= amount) return { ok: false, reason: 'owned' }
    next.shield = amount
  } else if (item === 'smoke') {
    if (l.smokes >= (def.max ?? 1)) return { ok: false, reason: 'max' }
    next.smokes += 1
  } else {
    if (l.grenades >= (def.max ?? 1)) return { ok: false, reason: 'max' }
    next.grenades += 1
  }
  const players = state.players.map(q => (q.id === id ? { ...q, credits: q.credits - def.price, spent: q.spent + def.price, loadout: next } : q))
  return { ok: true, state: { ...state, players } }
}

/** Abilities are consumed in play (smokes thrown, grenades used). */
export function useAbility(state: TacticalState, id: number, kind: 'smoke' | 'grenade'): TacticalState {
  return {
    ...state,
    players: state.players.map(p => {
      if (p.id !== id) return p
      const l = p.loadout
      if (kind === 'smoke' && l.smokes > 0) return { ...p, loadout: { ...l, smokes: l.smokes - 1 } }
      if (kind === 'grenade' && l.grenades > 0) return { ...p, loadout: { ...l, grenades: l.grenades - 1 } }
      return p
    }),
  }
}

/** Shield points left after damage: the game reports what remains so survivors keep partial shields. */
export function setShield(state: TacticalState, id: number, shield: number): TacticalState {
  const s: Loadout['shield'] = shield >= 50 ? 50 : shield >= 25 ? 25 : 0
  return { ...state, players: state.players.map(p => (p.id === id ? { ...p, loadout: { ...p.loadout, shield: s } } : p)) }
}

/**
 * Bot shopping list for a given balance: full buy when it can afford rifle + heavy shield, a light
 * buy (shotgun or shield) on a mid balance, otherwise save. Deterministic for a given input.
 */
export function botBuyPlan(p: TacticalPlayer, teamCredits: number, round: number): ShopItem[] {
  const plan: ShopItem[] = []
  let c = p.credits
  const take = (item: ShopItem) => {
    if (c >= SHOP[item].price) {
      plan.push(item)
      c -= SHOP[item].price
    }
  }
  const teamRich = teamCredits >= 3900 * 2
  const pick = <T>(list: T[]) => list[(p.id + round) % list.length]
  const strong: GunId[] = ['ak47', 'sg553', 'awp', 'galil', 'ssg08', 'p90']
  if (p.loadout.primary && strong.includes(p.loadout.primary)) {
    if (p.loadout.shield < 50) take('heavyShield')
  } else if (c >= 5750 && p.id % 5 === 0) {
    take('awp')
    take('heavyShield')
  } else if (c >= 3700 || (teamRich && c >= 2700)) {
    take(pick<GunId>(['ak47', 'ak47', 'sg553', 'galil']))
    take('heavyShield')
  } else if (round === 1 || c < 2000) {
    if (round === 1) take(p.id % 2 === 0 ? 'lightShield' : pick<GunId>(['p250', 'tec9', 'dualies']))
    else if (c >= 1100) take(pick<GunId>(['deagle', 'p250']))
  } else {
    take(pick<GunId>(['mp7', 'mac10', 'nova', 'galil']))
    take('lightShield')
  }
  if (p.loadout.smokes === 0) take('smoke')
  return plan
}
