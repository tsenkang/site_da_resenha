/**
 * Client view of an online match (pure, unit tested): maps server rules ids and teams into the
 * local frame the tactical director already uses (you are id 0 on team 0; teammates and enemies
 * get bot-style ids) and turns consecutive server states into the director's events.
 */
import type { RoundResult, TacticalEvent, TacticalState, TeamIndex } from '../game/tactical.ts'

export type NetIds = {
  /** Network id → local id. */
  toLocal: Map<string, number>
  /** Local id → network id. */
  toNet: Map<number, string>
  /** 1 when you are on server team 1 (teams, scores and sides are mirrored locally). */
  flip: 0 | 1
}

/**
 * `roster[i]` is the network id of server rules id `i`; `teams[i]` its server team. Teammates are
 * numbered from `ally0`, enemies from `enemy0`, in roster order.
 */
export function netIds(roster: string[], teams: TeamIndex[], me: string, ally0: number, enemy0: number): NetIds {
  const mine = teams[roster.indexOf(me)] ?? 0
  const toLocal = new Map<string, number>()
  const toNet = new Map<number, string>()
  let a = ally0
  let e = enemy0
  roster.forEach((id, i) => {
    const local = id === me ? 0 : teams[i] === mine ? a++ : e++
    toLocal.set(id, local)
    toNet.set(local, id)
  })
  return { toLocal, toNet, flip: mine === 1 ? 1 : 0 }
}

const swap = <T>(p: [T, T], flip: number): [T, T] => (flip ? [p[1], p[0]] : [p[0], p[1]])
const team = (t: TeamIndex, flip: number): TeamIndex => (t ^ flip) as TeamIndex

/** Server state (ids = roster indexes) → local state (ids from `ids`, your team = 0). */
export function toLocalState(s: TacticalState, roster: string[], ids: NetIds): TacticalState {
  const f = ids.flip
  const id = (n: number | null) => (n === null ? null : ids.toLocal.get(roster[n]) ?? null)
  return {
    ...s,
    score: swap(s.score, f),
    lossStreak: swap(s.lossStreak, f),
    winner: s.winner === null ? null : team(s.winner, f),
    history: s.history.map((h): RoundResult => ({ ...h, winner: team(h.winner, f) })),
    players: s.players.map(p => ({ ...p, id: id(p.id) ?? -1, team: team(p.team, f), loadout: { ...p.loadout } })),
    spike: { ...s.spike, carrier: id(s.spike.carrier), planter: id(s.spike.planter) },
  }
}

/** Events between two consecutive local states, in the order the director expects. */
export function diffEvents(prev: TacticalState, next: TacticalState): TacticalEvent[] {
  const ev: TacticalEvent[] = []
  const newRound = next.round > prev.round
  if (!newRound && prev.phase === 'buy' && next.phase !== 'buy') ev.push({ type: 'combatStart', round: next.round })
  if (!newRound && !prev.spike.planted && next.spike.planted && next.spike.site) ev.push({ type: 'planted', site: next.spike.site, by: next.spike.planter ?? -1 })
  for (const result of next.history.slice(prev.history.length)) ev.push({ type: 'roundEnd', result })
  if (next.phase === 'matchEnd' && prev.phase !== 'matchEnd' && next.winner !== null) ev.push({ type: 'matchEnd', winner: next.winner })
  if (newRound) {
    if (next.round === next.cfg.halftime + 1) ev.push({ type: 'halftime' })
    ev.push({ type: 'roundStart', round: next.round, attackers: 0 })
  }
  return ev
}
