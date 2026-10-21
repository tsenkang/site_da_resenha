/**
 * Room lobby rules (pure, shared by the server and tests): join with auto-balance, team switching,
 * ready checks, host migration and bot fill, for team sizes 2v2 … 5v5.
 */
import type { TeamIndex, TeamSize } from '../game/tactical.ts'
import type { LobbyView } from './protocol.ts'

export type LobbyMember = { id: string; name: string; team: TeamIndex; ready: boolean; bot: boolean }
export type Lobby = { code: string; teamSize: TeamSize; hostId: string; members: LobbyMember[]; fillBots: boolean; started: boolean }
export type LobbyResult = { ok: true; lobby: Lobby } | { ok: false; reason: 'room_full' | 'in_match' | 'not_host' | 'not_ready' | 'team_full' | 'unknown' }

export const BOT_NAMES = ['FAÍSCA', 'NÉVOA', 'TRAVA', 'BRISA', 'CORVO', 'LÂMINA', 'PRISMA', 'ÔNIX', 'VULTO', 'RAIO']

export function createLobby(code: string, teamSize: TeamSize, host: { id: string; name: string }): Lobby {
  return { code, teamSize, hostId: host.id, members: [{ id: host.id, name: host.name, team: 0, ready: true, bot: false }], fillBots: true, started: false }
}

const count = (l: Lobby, team: TeamIndex) => l.members.filter(m => m.team === team).length

export function joinLobby(l: Lobby, p: { id: string; name: string }): LobbyResult {
  if (l.started) return { ok: false, reason: 'in_match' }
  if (l.members.some(m => m.id === p.id)) return { ok: true, lobby: l }
  if (l.members.length >= l.teamSize * 2) return { ok: false, reason: 'room_full' }
  // Auto-balance: the smaller team, team 0 on ties.
  const team: TeamIndex = count(l, 0) <= count(l, 1) ? 0 : 1
  return { ok: true, lobby: { ...l, members: [...l.members, { id: p.id, name: p.name, team, ready: false, bot: false }] } }
}

/** Remove a member; the host role passes to the next human. Returns null when no humans remain. */
export function leaveLobby(l: Lobby, id: string): Lobby | null {
  const members = l.members.filter(m => m.id !== id)
  if (!members.some(m => !m.bot)) return null
  const hostId = l.hostId === id ? members.find(m => !m.bot)!.id : l.hostId
  return { ...l, members: members.map(m => (m.id === hostId ? { ...m, ready: true } : m)), hostId }
}

export function switchTeam(l: Lobby, id: string, team: TeamIndex): LobbyResult {
  if (l.started) return { ok: false, reason: 'in_match' }
  const m = l.members.find(x => x.id === id)
  if (!m) return { ok: false, reason: 'unknown' }
  if (m.team === team) return { ok: true, lobby: l }
  if (count(l, team) >= l.teamSize) return { ok: false, reason: 'team_full' }
  return { ok: true, lobby: { ...l, members: l.members.map(x => (x.id === id ? { ...x, team, ready: x.id === l.hostId } : x)) } }
}

export function setReady(l: Lobby, id: string, ready: boolean): Lobby {
  return { ...l, members: l.members.map(m => (m.id === id ? { ...m, ready: m.id === l.hostId ? true : ready } : m)) }
}

export function setFillBots(l: Lobby, by: string, on: boolean): LobbyResult {
  if (by !== l.hostId) return { ok: false, reason: 'not_host' }
  return { ok: true, lobby: { ...l, fillBots: on } }
}

/** Host starts when every human is ready, each team has someone, and teams are full or slots may stay open. */
export function canStart(l: Lobby, by: string): LobbyResult {
  if (l.started) return { ok: false, reason: 'in_match' }
  if (by !== l.hostId) return { ok: false, reason: 'not_host' }
  if (l.members.some(m => !m.bot && !m.ready)) return { ok: false, reason: 'not_ready' }
  if (!l.fillBots && (count(l, 0) < l.teamSize || count(l, 1) < l.teamSize)) return { ok: false, reason: 'not_ready' }
  // Every team needs at least one person (empty slots are filled but start each round out of play).
  if (count(l, 0) === 0 || count(l, 1) === 0) return { ok: false, reason: 'not_ready' }
  return { ok: true, lobby: { ...l, started: true } }
}

/** Members plus bots so both teams have exactly `teamSize` players. */
export function fillWithBots(l: Lobby): Lobby {
  const members = [...l.members]
  let n = 0
  for (const team of [0, 1] as TeamIndex[]) {
    while (members.filter(m => m.team === team).length < l.teamSize) {
      members.push({ id: `bot${n}`, name: BOT_NAMES[n % BOT_NAMES.length], team, ready: true, bot: true })
      n += 1
    }
  }
  return { ...l, members }
}

export function lobbyView(l: Lobby): LobbyView {
  return {
    code: l.code,
    teamSize: l.teamSize,
    fillBots: l.fillBots,
    started: l.started,
    players: l.members.map(m => ({ id: m.id, name: m.name, team: m.team, ready: m.ready, host: m.id === l.hostId, bot: m.bot })),
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** Five-character room code without ambiguous glyphs (no O/0, I/1). `rand` returns [0, 1). */
export function roomCode(rand: () => number): string {
  let s = ''
  for (let i = 0; i < 5; i += 1) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]
  return s
}
