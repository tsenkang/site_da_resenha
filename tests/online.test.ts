import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Room, type Conn } from '../server/match/room'
import { startMatchServer, type MatchServer } from '../server/match/server'
import { attackingTeam, createTactical, tacticalConfig, type TacticalState } from '../src/game/tactical'
import type { PlayerFrame, ServerMessage, Vec3 } from '../src/net/protocol'
import { diffEvents, netIds, toLocalState } from '../src/net/view'

type Fake = Conn & { inbox: ServerMessage[] }
const fakeConn = (id: string): Fake => {
  const inbox: ServerMessage[] = []
  return { id, name: id.toUpperCase(), inbox, send: m => inbox.push(m) }
}
const frame = (pos: Vec3, seq = 1): PlayerFrame => ({ seq, pos, yaw: 0, pitch: 0, flags: 0, weapon: 'glock' })
const last = <T extends ServerMessage['t']>(c: Fake, t: T) => c.inbox.filter(m => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined

/** 2v2 room with one human per team (a attacks first) in combat. */
function combatRoom(): { room: Room; a: Fake; b: Fake } {
  const a = fakeConn('a')
  const b = fakeConn('b')
  const room = new Room('ROOMB', 2, a)
  room.join(b)
  room.handle('b', { t: 'ready', ready: true })
  room.handle('a', { t: 'start' })
  for (let i = 0; i < 25 * 20; i += 1) room.tick(1 / 20)
  return { room, a, b }
}

describe('online room rules', () => {
  it('sends the roster and full state; the spike goes to a human attacker', () => {
    const { room, a } = combatRoom()
    const start = a.inbox.find(m => m.t === 'matchStart')!
    expect(start).toMatchObject({ you: 'a', team: 0 })
    expect((start as Extract<ServerMessage, { t: 'matchStart' }>).roster).toHaveLength(4)
    const st = last(a, 'state')!
    expect(st.s.phase).toBe('combat')
    expect(st.s.spike.carrier).toBe(0)
    expect(room.state!.spike.carrier).toBe(0)
  })

  it('drops the spike where the carrier died and lets an attacker pick it up', () => {
    const a = fakeConn('a')
    const c = fakeConn('c')
    const b = fakeConn('b')
    const room = new Room('ROOMC', 2, a)
    room.join(b)
    room.join(c)
    room.handle('c', { t: 'team', team: 0 })
    room.handle('b', { t: 'ready', ready: true })
    room.handle('c', { t: 'ready', ready: true })
    room.rand = () => 0
    room.handle('a', { t: 'start' })
    for (let i = 0; i < 25 * 20; i += 1) room.tick(1 / 20)
    const carrierId = room.state!.spike.carrier
    expect(carrierId).not.toBeNull()
    const carrier = carrierId === 0 ? 'a' : 'c'
    const mate = carrier === 'a' ? 'c' : 'a'
    room.handle(carrier, { t: 'frame', f: frame([5, 0, 5]) })
    room.handle(mate, { t: 'frame', f: frame([20, 0, 20]) })
    room.handle('b', { t: 'frame', f: frame([5, 0, 12]) })
    room.handle('b', { t: 'hit', h: { target: carrier, damage: 78, headshot: true, weapon: 'glock', distance: 7 } })
    room.tick(0.3)
    room.handle('b', { t: 'hit', h: { target: carrier, damage: 78, headshot: true, weapon: 'glock', distance: 7 } })
    expect(room.state!.spike.carrier).toBeNull()
    expect(room.spikePos).toEqual([5, 0, 5])
    // The defender cannot take it; the attacking teammate can.
    room.handle('b', { t: 'frame', f: frame([5, 0, 5.5], 2) })
    room.tick(0.05)
    expect(room.state!.spike.carrier).toBeNull()
    room.handle(mate, { t: 'frame', f: frame([5.5, 0, 5], 2) })
    room.tick(0.05)
    expect(room.state!.spike.carrier).toBe(mate === 'a' ? 0 : room.lobby.members.findIndex(m => m.id === 'c'))
  })

  it('plants only from the carrier and defuses only next to the spike', () => {
    const { room, a, b } = combatRoom()
    room.handle('b', { t: 'plant', site: 'A' })
    expect(room.state!.spike.planted).toBe(false)
    room.handle('a', { t: 'plant', site: 'A' })
    expect(room.state!.spike.planted).toBe(false) // no position yet
    room.handle('a', { t: 'frame', f: frame([-40, 0, -31]) })
    room.handle('a', { t: 'plant', site: 'A' })
    expect(room.state!.phase).toBe('planted')
    expect(last(a, 'state')!.spikePos).toEqual([-40, 0, -31])
    room.handle('b', { t: 'frame', f: frame([-30, 0, -31]) })
    room.handle('b', { t: 'defuse' })
    expect(room.state!.phase).toBe('planted')
    room.handle('b', { t: 'frame', f: frame([-38.5, 0, -31], 2) })
    room.handle('b', { t: 'defuse' })
    expect(room.state!.phase).toBe('roundEnd')
    expect(room.state!.history.at(-1)).toMatchObject({ reason: 'defused', winner: 1 })
    void b
  })

  it('resolves frag damage on the server and needs a grenade in the loadout', () => {
    const a = fakeConn('a')
    const b = fakeConn('b')
    const room = new Room('ROOMD', 2, a)
    room.join(b)
    room.handle('b', { t: 'ready', ready: true })
    room.handle('a', { t: 'start' })
    room.handle('a', { t: 'buy', item: 'grenade' })
    for (let i = 0; i < 25 * 20; i += 1) room.tick(1 / 20)
    room.handle('a', { t: 'frame', f: frame([0, 0, 10]) })
    room.handle('b', { t: 'frame', f: frame([0, 0, 0]) })
    room.handle('a', { t: 'grenade', at: [0, 0.9, 1] })
    const dmg = last(b, 'damage')!
    expect(dmg.by).toBe('a')
    expect(dmg.amount).toBeGreaterThan(90)
    expect(b.inbox.some(m => m.t === 'grenade')).toBe(true)
    // Second throw: none left.
    const before = b.inbox.length
    room.handle('a', { t: 'grenade', at: [0, 0.9, 1] })
    expect(b.inbox.length).toBe(before)
  })

  it('caps hits that land in the same server tick at the fire budget', () => {
    const { room, a, b } = combatRoom()
    room.handle('a', { t: 'frame', f: frame([0, 0, 10]) })
    room.handle('b', { t: 'frame', f: frame([0, 0, 0]) })
    room.tick(0.2)
    for (let i = 0; i < 4; i += 1) room.handle('a', { t: 'hit', h: { target: 'b', damage: 20, headshot: false, weapon: 'glock', distance: 10 } })
    expect(b.inbox.filter(m => m.t === 'damage')).toHaveLength(2)
    void a
  })
})

describe('client view of the server state', () => {
  const cfg = tacticalConfig(2)
  const server = (): TacticalState => createTactical(cfg, [
    { id: 0, name: 'ANA', team: 0 },
    { id: 1, name: 'BIA', team: 1 },
    { id: 2, name: 'CAU', team: 0 },
    { id: 3, name: 'DUDA', team: 1 },
  ])
  const roster = ['ana', 'bia', 'cau', 'duda']

  it('puts you at id 0 on team 0 and mirrors teams and score when you are on team 1', () => {
    const ids = netIds(roster, [0, 1, 0, 1], 'bia', 201, 211)
    expect(ids.flip).toBe(1)
    expect(ids.toLocal.get('bia')).toBe(0)
    expect(ids.toLocal.get('duda')).toBe(201)
    expect(ids.toLocal.get('ana')).toBe(211)
    const s = { ...server(), score: [3, 1] as [number, number] }
    const local = toLocalState(s, roster, ids)
    expect(local.score).toEqual([1, 3])
    expect(local.players.find(p => p.id === 0)).toMatchObject({ name: 'BIA', team: 0 })
    expect(local.players.find(p => p.id === 211)).toMatchObject({ name: 'ANA', team: 1 })
    // Server team 0 attacks first: locally that is team 1 for a flipped player.
    expect(attackingTeam(s) ^ ids.flip).toBe(1)
  })

  it('turns consecutive states into director events', () => {
    const a = server()
    const combat = { ...a, phase: 'combat' as const }
    expect(diffEvents(a, combat).map(e => e.type)).toEqual(['combatStart'])
    const planted = { ...combat, phase: 'planted' as const, spike: { ...combat.spike, planted: true, site: 'B' as const, planter: 0 } }
    expect(diffEvents(combat, planted)).toEqual([{ type: 'planted', site: 'B', by: 0 }])
    const ended = { ...planted, phase: 'roundEnd' as const, history: [{ round: 1, winner: 0 as const, reason: 'detonated' as const }] }
    expect(diffEvents(planted, ended).map(e => e.type)).toEqual(['roundEnd'])
    const next = { ...ended, round: 2, phase: 'buy' as const }
    expect(diffEvents(ended, next).map(e => e.type)).toEqual(['roundStart'])
    // A missed roundEnd (late join of updates) is still reported before the new round.
    expect(diffEvents(planted, next).map(e => e.type)).toEqual(['roundEnd', 'roundStart'])
  })
})

describe('server hosts the game files', () => {
  let server: MatchServer
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rs-static-'))
    writeFileSync(join(dir, 'index.html'), '<title>ok</title>')
    writeFileSync(join(dir, 'game-AbCdEf12.js'), 'x')
    server = await startMatchServer(0, [], dir)
  })
  afterAll(async () => {
    await server.close()
  })

  it('serves index, hashed bundles with long cache, and refuses paths outside the folder', async () => {
    const base = `http://127.0.0.1:${server.port}`
    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('ok')
    expect((await fetch(`${base}/?sala=ABCDE`)).status).toBe(200)
    const js = await fetch(`${base}/game-AbCdEf12.js`)
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(js.headers.get('content-type')).toContain('javascript')
    // Dot segments never escape the folder: at worst the request falls back to the game page.
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).not.toContain('root:')
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd.txt`)).status).toBe(404)
    expect((await fetch(`${base}/missing.png`)).status).toBe(404)
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true })
  })
})

describe('online map choice', () => {
  it('lets only the host pick a valid map before the start, and sends it with matchStart', async () => {
    const { ONLINE_MAPS, parseClientMessage } = await import('../src/net/protocol')
    expect(parseClientMessage(JSON.stringify({ t: 'map', map: 'kyoto' }))).toEqual({ t: 'map', map: 'kyoto' })
    expect(parseClientMessage(JSON.stringify({ t: 'map', map: 'atlantis' }))).toBeNull()
    expect(ONLINE_MAPS.length).toBeGreaterThanOrEqual(7)
    const a = fakeConn('a')
    const b = fakeConn('b')
    const room = new Room('ROOMM', 2, a)
    room.join(b)
    expect(last(a, 'lobby')!.lobby.map).toBe('aurora')
    room.handle('b', { t: 'map', map: 'veneza' })
    expect(room.lobby.map).toBe('aurora')
    expect(last(b, 'error')).toMatchObject({ code: 'not_host' })
    room.handle('a', { t: 'map', map: 'veneza' })
    expect(last(b, 'lobby')!.lobby.map).toBe('veneza')
    room.handle('b', { t: 'ready', ready: true })
    room.handle('a', { t: 'start' })
    expect(last(b, 'matchStart')).toMatchObject({ map: 'veneza' })
    room.handle('a', { t: 'map', map: 'kyoto' })
    expect(room.lobby.map).toBe('veneza')
  })

  it('every online map is a tactical map with A/B sites, barriers and spawns', async () => {
    const { ONLINE_MAPS } = await import('../src/net/protocol')
    const { MAPS, MAP_ORIGIN } = await import('../src/game/maps')
    const origins = new Set<string>()
    for (const id of ONLINE_MAPS) {
      const m = MAPS[id]
      expect(m.id).toBe(id)
      expect(m.sites).not.toBeNull()
      expect(m.barriers).not.toBeNull()
      origins.add(MAP_ORIGIN[id].join(','))
      // Sites sit inside the walls and clear of every building footprint.
      const [hx, hz] = m.sites!.half ?? [9.5, 8.5]
      for (const [sx, sz] of [m.sites!.a, m.sites!.b]) {
        expect(Math.abs(sx) + hx).toBeLessThan(m.halfX)
        expect(Math.abs(sz) + hz).toBeLessThan(m.halfZ)
        for (const [x0, x1, z0, z1] of m.buildings) {
          const overlap = sx + hx > x0 && sx - hx < x1 && sz + hz > z0 && sz - hz < z1
          expect(overlap, `${id}: site at ${sx},${sz} overlaps building ${x0},${x1},${z0},${z1}`).toBe(false)
        }
      }
      // Spawn yards stay open (team spawns are at x ≈ ±5 design units).
      for (const [x0, x1, z0, z1] of m.buildings) {
        const inYard = (z: number) => x1 > -10 && x0 < 10 && z1 > z - 4 && z0 < z + 4
        expect(inYard(m.teamSpawnZ[0]) || inYard(m.teamSpawnZ[1]), `${id}: building in a spawn yard`).toBe(false)
      }
    }
    expect(origins.size).toBe(ONLINE_MAPS.length)
  })
})
