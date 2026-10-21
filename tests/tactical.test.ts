import { describe, expect, it } from 'vitest'
import {
  attackingTeam, botBuyPlan, buy, createTactical, defuseSpike, ECONOMY, plantSpike, registerKill, sideOf, tacticalConfig,
  tickTactical, type Roster, type TacticalState, type TeamSize,
} from '../src/game/tactical'

function roster(size: number): Roster {
  const r: Roster = []
  for (let i = 0; i < size; i += 1) r.push({ id: i, name: `A${i}`, team: 0 })
  for (let i = 0; i < size; i += 1) r.push({ id: 10 + i, name: `B${i}`, team: 1 })
  return r
}

function toCombat(s: TacticalState): TacticalState {
  return tickTactical(s, s.timer + 0.01).state
}

describe('tactical rules', () => {
  it('supports 2v2 through 5v5 and rejects uneven teams', () => {
    for (const n of [2, 3, 4, 5] as TeamSize[]) {
      const s = createTactical(tacticalConfig(n), roster(n))
      expect(s.players).toHaveLength(n * 2)
      expect(s.round).toBe(1)
      expect(s.phase).toBe('buy')
    }
    expect(() => createTactical(tacticalConfig(3), roster(2))).toThrow()
  })

  it('gives the spike to an attacker and swaps sides at halftime', () => {
    const cfg = tacticalConfig(2)
    const s = createTactical(cfg, roster(2))
    expect(attackingTeam(s)).toBe(0)
    expect(s.players.find(p => p.id === s.spike.carrier)?.team).toBe(0)
    expect(sideOf(0, cfg.halftime, cfg)).toBe('attack')
    expect(sideOf(0, cfg.halftime + 1, cfg)).toBe('defend')
    expect(sideOf(1, cfg.halftime + 1, cfg)).toBe('attack')
  })

  it('buy phase turns into combat, and a time-out is a defender win', () => {
    let s = toCombat(createTactical(tacticalConfig(2), roster(2)))
    expect(s.phase).toBe('combat')
    const r = tickTactical(s, s.cfg.roundTime + 1)
    s = r.state
    expect(s.phase).toBe('roundEnd')
    expect(s.score).toEqual([0, 1])
    expect(r.events[0]).toMatchObject({ type: 'roundEnd', result: { winner: 1, reason: 'time' } })
  })

  it('eliminating every defender wins the round and pays kills, win and loss bonus', () => {
    let s = toCombat(createTactical(tacticalConfig(2), roster(2)))
    s = registerKill(s, 0, 10).state
    expect(s.players.find(p => p.id === 0)?.credits).toBe(800 + ECONOMY.kill)
    s = registerKill(s, 1, 11).state
    expect(s.phase).toBe('roundEnd')
    expect(s.score).toEqual([1, 0])
    expect(s.players.find(p => p.id === 1)?.credits).toBe(800 + ECONOMY.kill + ECONOMY.win)
    expect(s.players.find(p => p.id === 10)?.credits).toBe(800 + ECONOMY.lossBase)
  })

  it('attackers all dead after a plant does not end the round; defuse does', () => {
    let s = toCombat(createTactical(tacticalConfig(2), roster(2)))
    const carrier = s.spike.carrier!
    s = plantSpike(s, carrier, 'A').state
    expect(s.phase).toBe('planted')
    expect(s.players.filter(p => p.team === 0).every(p => p.credits === 800 + ECONOMY.plant)).toBe(true)
    s = registerKill(s, 10, 0).state
    s = registerKill(s, 10, 1).state
    expect(s.phase).toBe('planted')
    const r = defuseSpike(s, 11)
    expect(r.state.score).toEqual([0, 1])
    expect(r.events[0]).toMatchObject({ result: { reason: 'defused' } })
  })

  it('the spike detonates when its timer runs out', () => {
    let s = toCombat(createTactical(tacticalConfig(2), roster(2)))
    s = plantSpike(s, s.spike.carrier!, 'B').state
    const r = tickTactical(s, s.cfg.spikeTime + 0.1)
    expect(r.state.score).toEqual([1, 0])
    expect(r.events[0]).toMatchObject({ result: { reason: 'detonated' } })
  })

  it('only the carrier can plant, only defenders can defuse', () => {
    let s = toCombat(createTactical(tacticalConfig(2), roster(2)))
    const other = s.players.find(p => p.team === 0 && p.id !== s.spike.carrier)!.id
    expect(plantSpike(s, other, 'A').state.phase).toBe('combat')
    s = plantSpike(s, s.spike.carrier!, 'A').state
    expect(defuseSpike(s, 0).state.phase).toBe('planted')
  })

  it('loss bonus grows with the streak and caps', () => {
    // Raise the credit ceiling so only the loss-bonus cap is measured.
    let s = createTactical({ ...tacticalConfig(2), maxCredits: 99999 }, roster(2))
    const credits: number[] = []
    for (let i = 0; i < 4; i += 1) {
      s = toCombat(s)
      const before = s.players.find(p => p.id === 0)!.credits
      s = tickTactical(s, s.cfg.roundTime + 1).state // defenders (team 1) win on time
      credits.push(s.players.find(p => p.id === 0)!.credits - before)
      s = tickTactical(s, s.timer + 0.01).state
    }
    expect(credits).toEqual([1900, 2400, 2900, 2900])
  })

  it('buying checks phase, credits and duplicates; survivors keep gear', () => {
    let s = createTactical(tacticalConfig(2), roster(2))
    expect(buy(s, 0, 'rifle')).toEqual({ ok: false, reason: 'credits' })
    const light = buy(s, 0, 'lightShield')
    expect(light.ok).toBe(true)
    if (!light.ok) return
    s = light.state
    expect(buy(s, 0, 'lightShield')).toEqual({ ok: false, reason: 'owned' })
    expect(s.players[0].credits).toBe(400)
    s = toCombat(s)
    expect(buy(s, 0, 'smoke')).toEqual({ ok: false, reason: 'phase' })
    // Round ends on time with player 0 alive: shield carries into round 2.
    s = tickTactical(s, s.cfg.roundTime + 1).state
    s = tickTactical(s, s.timer + 0.01).state
    expect(s.round).toBe(2)
    expect(s.players[0].loadout.shield).toBe(25)
  })

  it('first to roundsToWin ends the match', () => {
    let s = createTactical(tacticalConfig(2), roster(2))
    let ended = false
    for (let i = 0; i < 20 && !ended; i += 1) {
      s = toCombat(s)
      const r = tickTactical(s, s.cfg.roundTime + 1)
      s = r.state
      ended = r.events.some(e => e.type === 'matchEnd')
      if (!ended) s = tickTactical(s, s.timer + 0.01).state
    }
    expect(s.phase).toBe('matchEnd')
    expect(Math.max(...s.score)).toBe(s.cfg.roundsToWin)
    expect(s.winner).not.toBeNull()
  })

  it('bots save on low credits and full-buy when rich', () => {
    const s = createTactical(tacticalConfig(2), roster(2))
    const poor = { ...s.players[0], credits: 800 }
    expect(botBuyPlan(poor, 1600, 2)).toEqual(['smoke'])
    const rich = { ...s.players[0], credits: 5000 }
    expect(botBuyPlan(rich, 10000, 3)).toEqual(['rifle', 'heavyShield', 'smoke'])
  })
})
