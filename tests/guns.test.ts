import { describe, expect, it } from 'vitest'
import { applyHit, damageAt, GUN_IDS, GUNS, isPistol, recoilStep } from '../src/game/gunSpecs'
import { buy, createTactical, mainGun, ownsGun, tacticalConfig, type TacticalState } from '../src/game/tactical'

describe('gun catalog', () => {
  it('has the 15 guns of the buy menu, five per column', () => {
    expect(GUN_IDS).toHaveLength(15)
    for (const tier of ['pistols', 'mid', 'rifles'] as const) expect(GUN_IDS.filter(id => GUNS[id].tier === tier)).toHaveLength(5)
    expect(GUN_IDS.filter(isPistol)).toEqual(['glock', 'dualies', 'p250', 'tec9', 'deagle'])
  })

  it('damage falls off with distance', () => {
    const ak = GUNS.ak47
    expect(damageAt(ak, 0)).toBe(ak.damage)
    expect(damageAt(ak, 50)).toBeLessThan(ak.damage)
    expect(damageAt(GUNS.awp, 50)).toBeGreaterThan(100)
    // Shotguns lose damage much faster than rifles.
    expect(damageAt(GUNS.nova, 25) / GUNS.nova.damage).toBeLessThan(damageAt(ak, 25) / ak.damage)
  })

  it('AK headshot kills through a full shield, the AWP one-taps the body', () => {
    const ak = GUNS.ak47
    expect(applyHit(100, 50, damageAt(ak, 10) * ak.headMul, ak.armorPen).hp).toBe(0)
    expect(applyHit(100, 0, damageAt(GUNS.awp, 20), GUNS.awp.armorPen).hp).toBe(0)
    // A pistol body shot into a shield mostly hits the shield.
    const r = applyHit(100, 50, GUNS.glock.damage, GUNS.glock.armorPen)
    expect(r.hp).toBeGreaterThan(80)
    expect(r.shield).toBeLessThan(50)
  })

  it('spray pattern climbs first, then drifts sideways (deterministic)', () => {
    const ak = GUNS.ak47
    const first = [0, 1, 2, 3, 4].map(i => recoilStep(ak, i))
    for (const [p, y] of first) {
      expect(p).toBeGreaterThan(0)
      expect(Math.abs(y)).toBe(0)
    }
    const late = recoilStep(ak, 12)
    expect(Math.abs(late[1])).toBeGreaterThan(0)
    expect(recoilStep(ak, 12)).toEqual(late)
  })
})

describe('loadout with the gun catalog', () => {
  const state = (): TacticalState => {
    const s = createTactical(tacticalConfig(2), [
      { id: 0, name: 'A', team: 0 },
      { id: 1, name: 'B', team: 0 },
      { id: 2, name: 'C', team: 1 },
      { id: 3, name: 'D', team: 1 },
    ])
    return { ...s, players: s.players.map(p => ({ ...p, credits: 9000 })) }
  }

  it('pistols replace the sidearm, other guns the primary', () => {
    let s = state()
    expect(s.players[0].loadout.sidearm).toBe('glock')
    const d = buy(s, 0, 'deagle')
    expect(d.ok).toBe(true)
    if (!d.ok) return
    s = d.state
    const a = buy(s, 0, 'awp')
    if (!a.ok) throw new Error('awp')
    const l = a.state.players[0].loadout
    expect(l).toMatchObject({ primary: 'awp', sidearm: 'deagle' })
    expect(mainGun(l)).toBe('awp')
    expect(ownsGun(l, 'glock')).toBe(false)
    expect(buy(a.state, 0, 'deagle')).toEqual({ ok: false, reason: 'owned' })
  })
})
