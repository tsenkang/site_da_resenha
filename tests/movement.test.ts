import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { initPhysics, Physics } from '../src/engine/physics'
import { Player, type MoveIntent } from '../src/game/player'

const DT = 1 / 60
const run = (o: Partial<MoveIntent> = {}): MoveIntent => ({ x: 0, y: 1, jump: false, sprint: true, ads: false, ...o })

function world(): { ph: Physics; p: Player } {
  const ph = new Physics(-22)
  ph.addStaticBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(400, 1, 400))
  const p = new Player(ph)
  p.spawn(new THREE.Vector3(0, 0, 0), 0)
  ph.world.step()
  return { ph, p }
}
function step(ph: Physics, p: Player, intent: MoveIntent): ReturnType<Player['step']> {
  const r = p.step(DT, intent)
  ph.world.step()
  return r
}

describe('player movement', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  for (const hold of [false, true]) {
    it(`slides smoothly from start to finish (${hold ? 'holding' : 'tapping'} crouch)`, () => {
      const { ph, p } = world()
      for (let i = 0; i < 60; i += 1) step(ph, p, run())
      const speeds: number[] = []
      let slid = false
      for (let i = 0; i < 110; i += 1) {
        const r = step(ph, p, run({ slide: i === 0, crouch: hold || i < 8 }))
        slid ||= r.slid
        speeds.push(p.speed2d)
        expect(p.grounded).toBe(true)
      }
      expect(slid).toBe(true)
      // Burst first, then no step changes speed abruptly (the old slide could drop to ~0 mid-way).
      expect(Math.max(...speeds)).toBeGreaterThan(12)
      for (let i = 1; i < speeds.length; i += 1) expect(Math.abs(speeds[i] - speeds[i - 1])).toBeLessThan(0.7)
      expect(speeds.at(-1)).toBeCloseTo(hold ? 3.3 : 9.6, 1)
      expect(p.crouching).toBe(hold)
    })
  }

  it('keeps sliding along a wall it runs into at an angle', () => {
    const { ph, p } = world()
    ph.addStaticBox(new THREE.Vector3(3, 2, 0), new THREE.Vector3(1, 4, 200))
    p.yaw = -Math.PI / 4 // forward = +x, −z: into the wall and along it
    for (let i = 0; i < 90; i += 1) step(ph, p, run())
    expect(p.position.x).toBeLessThan(2.6)
    expect(p.speed2d).toBeGreaterThan(5)
  })

  it('climbs a stair flight (0.3 m risers) and a 20° ramp like the hillside map', () => {
    const { ph, p } = world()
    // Stairs up to a 2.4 m terrace at z < −4 (eight 0.3 m steps, 0.45 m deep), climbing toward −z.
    for (let i = 0; i < 8; i += 1) {
      const len = (8 - i) * 0.45
      ph.addStaticBox(new THREE.Vector3(0, (0.3 * (i + 1)) / 2, -4 + len / 2), new THREE.Vector3(3, 0.3 * (i + 1), len))
    }
    ph.addStaticBox(new THREE.Vector3(0, 1.2, -24), new THREE.Vector3(40, 2.4, 40))
    ph.world.step()
    for (let i = 0; i < 180; i += 1) step(ph, p, run({ sprint: false }))
    expect(p.position.y).toBeGreaterThan(2.3)
    expect(p.position.z).toBeLessThan(-6)
    // A 20° ramp from the terrace up another 2.4 m.
    const rise = 2.4
    const runLen = rise / Math.tan((20 * Math.PI) / 180)
    const a = Math.atan2(rise, runLen)
    const n = new THREE.Vector3(0, Math.cos(a), Math.sin(a))
    const c = new THREE.Vector3(0, 2.4 + rise / 2, -14 + runLen / 2).addScaledVector(n, -0.3)
    ph.addStaticBox(c, new THREE.Vector3(3, 0.6, Math.hypot(rise, runLen)), new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)))
    ph.addStaticBox(new THREE.Vector3(0, 2.4 + 1.2, -34), new THREE.Vector3(40, 2.4, 40))
    ph.world.step()
    p.spawn(new THREE.Vector3(0, 2.4, -6), 0)
    ph.world.step()
    for (let i = 0; i < 240; i += 1) step(ph, p, run({ sprint: false }))
    expect(p.position.y).toBeGreaterThan(4.7)
  })

  it('still jumps and lands', () => {
    const { ph, p } = world()
    for (let i = 0; i < 10; i += 1) step(ph, p, run())
    let top = 0
    let landed = false
    expect(step(ph, p, run({ jump: true })).jumped).toBe(true)
    for (let i = 0; i < 90; i += 1) {
      top = Math.max(top, p.position.y)
      landed ||= p.grounded && i > 5
    }
    for (let i = 0; i < 90; i += 1) {
      step(ph, p, run())
      top = Math.max(top, p.position.y)
      if (i > 5 && p.grounded) landed = true
    }
    expect(top).toBeGreaterThan(0.8)
    expect(landed).toBe(true)
  })
})
