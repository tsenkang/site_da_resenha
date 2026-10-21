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
