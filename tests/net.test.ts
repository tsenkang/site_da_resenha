import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Room, type Conn } from '../server/match/room'
import { startMatchServer, type MatchServer } from '../server/match/server'
import { NetClient } from '../src/net/client'
import { canStart, createLobby, fillWithBots, joinLobby, leaveLobby, roomCode, setFillBots, setReady, switchTeam } from '../src/net/lobby'
import { cleanName, parseClientMessage, type ServerMessage } from '../src/net/protocol'

describe('protocol', () => {
  it('parses valid messages and rejects malformed ones', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, name: 'joão' }))).toEqual({ t: 'hello', v: 1, name: 'JOÃO' })
    expect(parseClientMessage(JSON.stringify({ t: 'create', teamSize: 3 }))).toEqual({ t: 'create', teamSize: 3 })
    expect(parseClientMessage(JSON.stringify({ t: 'create', teamSize: 6 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'join', code: 'abcde' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'buy', item: 'nuke' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'frame', f: { seq: 1, pos: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, weapon: 'ak47' } }))?.t).toBe('frame')
    expect(parseClientMessage(JSON.stringify({ t: 'frame', f: { seq: 1, pos: [0, 0], yaw: 0, pitch: 0, flags: 0, weapon: 'ak47' } }))).toBeNull()
    expect(parseClientMessage('{not json')).toBeNull()
    expect(parseClientMessage('x'.repeat(5000))).toBeNull()
  })

  it('cleans player names', () => {
    expect(cleanName('  <b>Ana</b>  ')).toBe('BANAB')
    expect(cleanName('a')).toBeNull()
    expect(cleanName('x'.repeat(40))).toHaveLength(16)
  })
})

describe('lobby', () => {
  const host = { id: 'h', name: 'HOST' }
  it('auto-balances joins and enforces size', () => {
    let l = createLobby('ABCDE', 2, host)
    for (const id of ['a', 'b', 'c']) {
      const r = joinLobby(l, { id, name: id })
      expect(r.ok).toBe(true)
      if (r.ok) l = r.lobby
    }
    expect(l.members.map(m => m.team)).toEqual([0, 1, 0, 1])
    expect(joinLobby(l, { id: 'd', name: 'd' })).toEqual({ ok: false, reason: 'room_full' })
    expect(switchTeam(l, 'b', 1)).toEqual({ ok: false, reason: 'team_full' })
  })

  it('needs ready players and someone on each team; fills open slots', () => {
    let l = createLobby('ABCDE', 5, host)
    expect(canStart(l, 'h').ok).toBe(false) // nobody on team 1
    const r = joinLobby(l, { id: 'a', name: 'A' })
    if (!r.ok) throw new Error()
    l = r.lobby
    expect(canStart(l, 'h')).toEqual({ ok: false, reason: 'not_ready' })
    l = setReady(l, 'a', true)
    expect(canStart(l, 'a')).toEqual({ ok: false, reason: 'not_host' })
    const off = setFillBots(l, 'h', false)
    if (!off.ok) throw new Error()
    expect(canStart(off.lobby, 'h').ok).toBe(false)
    expect(canStart(l, 'h').ok).toBe(true)
    for (const n of [2, 3, 4, 5] as const) {
      const full = fillWithBots(createLobby('ABCDE', n, host))
      expect(full.members.filter(m => m.team === 0)).toHaveLength(n)
      expect(full.members.filter(m => m.team === 1)).toHaveLength(n)
    }
  })

  it('migrates host and closes when empty', () => {
    let l = createLobby('ABCDE', 2, host)
    const r = joinLobby(l, { id: 'a', name: 'A' })
    if (!r.ok) throw new Error()
    l = leaveLobby(r.lobby, 'h')!
    expect(l.hostId).toBe('a')
    expect(leaveLobby(l, 'a')).toBeNull()
  })

  it('room codes avoid ambiguous characters', () => {
    let s = 7
    const code = roomCode(() => ((s = (s * 16807) % 2147483647) / 2147483647))
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/)
  })
})

function fakeConn(id: string): Conn & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = []
  return { id, name: id.toUpperCase(), inbox, send: m => inbox.push(m) }
}

describe('room (server authority)', () => {
  it('runs a 2v2 with open slots: buys, validated hits, elimination', () => {
    const a = fakeConn('a')
    const b = fakeConn('b')
    const room = new Room('ROOMA', 2, a)
    expect(room.join(b)).toBeNull()
    room.handle('b', { t: 'ready', ready: true })
    room.handle('a', { t: 'start' })
    expect(a.inbox.some(m => m.t === 'matchStart')).toBe(true)
    const v = room.roundView()!
    expect(v.players).toHaveLength(4)
    // Open slots start out of play: one human per side remains.
    expect(v.players.filter(p => p.alive).map(p => p.id).sort()).toEqual(['a', 'b'])
    room.handle('a', { t: 'buy', item: 'lightShield' })
    expect(a.inbox.find(m => m.t === 'buyResult')).toMatchObject({ ok: true })
    room.handle('a', { t: 'buy', item: 'ak47' })
    expect(a.inbox.filter(m => m.t === 'buyResult').at(-1)).toMatchObject({ ok: false, reason: 'credits' })
    // Buy phase → combat.
    for (let i = 0; i < 25 * 20; i += 1) room.tick(1 / 20)
    expect(room.roundView()!.phase).toBe('combat')
    room.handle('a', { t: 'frame', f: { seq: 1, pos: [0, 0, 10], yaw: 0, pitch: 0, flags: 0, weapon: 'glock' } })
    room.handle('b', { t: 'frame', f: { seq: 1, pos: [0, 0, 0], yaw: 0, pitch: 0, flags: 0, weapon: 'glock' } })
    // Rifle not owned → ignored; implausible distance → ignored.
    room.handle('a', { t: 'hit', h: { target: 'b', damage: 160, headshot: true, weapon: 'ak47', distance: 10 } })
    room.handle('a', { t: 'hit', h: { target: 'b', damage: 78, headshot: true, weapon: 'glock', distance: 60 } })
    expect(b.inbox.some(m => m.t === 'damage')).toBe(false)
    // Valid pistol shots: a short burst fits the fire budget, a third shot inside it is dropped.
    for (let i = 0; i < 3; i += 1) room.handle('a', { t: 'hit', h: { target: 'b', damage: 40, headshot: false, weapon: 'glock', distance: 10 } })
    const dmg = b.inbox.filter(m => m.t === 'damage')
    expect(dmg).toHaveLength(2)
    expect(dmg[1]).toMatchObject({ amount: 40, hp: 20 })
    room.tick(0.2)
    // Claimed damage is capped at the gun's max (a pistol headshot, 30 × 4).
    room.handle('a', { t: 'hit', h: { target: 'b', damage: 999, headshot: true, weapon: 'glock', distance: 10 } })
    expect(b.inbox.some(m => m.t === 'kill')).toBe(true)
    const after = room.roundView()!
    expect(after.phase).toBe('roundEnd')
    expect(after.score[0]).toBe(1)
  })
})

describe('match server over WebSocket', () => {
  let server: MatchServer
  beforeAll(async () => {
    server = await startMatchServer(0)
  })
  afterAll(async () => {
    await server.close()
  })

  it('two clients create, join and start a room', async () => {
    const url = `ws://127.0.0.1:${server.port}`
    const host = new NetClient()
    const guest = new NetClient()
    await host.connect(url, 'Host')
    await guest.connect(url, 'Guest')
    const lobbyCode = new Promise<string>(r => host.on('lobby', m => r(m.lobby.code)))
    host.send({ t: 'create', teamSize: 2 })
    const code = await lobbyCode
    const joined = new Promise<void>(r => host.on('lobby', m => m.lobby.players.length === 2 && r()))
    guest.send({ t: 'join', code })
    await joined
    const started = Promise.all([
      new Promise(r => host.on('matchStart', r)),
      new Promise(r => guest.on('round', r)),
    ])
    guest.send({ t: 'ready', ready: true })
    await new Promise(r => setTimeout(r, 50))
    host.send({ t: 'start' })
    await started
    expect(server.rooms.get(code)?.roundView()?.players).toHaveLength(4)
    const err = new Promise<ServerMessage>(r => guest.on('error', r))
    guest.send({ t: 'join', code: 'ZZZZZ' })
    expect(await err).toMatchObject({ code: 'no_room' })
    host.close()
    guest.close()
  })
})
