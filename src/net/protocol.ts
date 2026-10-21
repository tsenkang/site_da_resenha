/**
 * RiftStrike online protocol (v1): JSON messages over one WebSocket per player.
 *
 * Authority model for the first online version:
 * - The server owns rooms, teams, the round flow and the economy (src/game/tactical.ts runs only
 *   on the server): buys, plants, defuses and kills are *requests* it validates.
 * - Clients simulate their own movement and send compact state frames at 20 Hz; the server
 *   rebroadcasts them in snapshots and rejects impossible speeds or dead/unknown players.
 * - Hits are claimed by the shooter and checked against weapon fire rate, damage caps, range and
 *   the round phase. Server-side hit validation with lag compensation is the next step (see
 *   docs/ONLINE.md).
 *
 * Every message is a plain object with a `t` tag. `parseClientMessage` turns untrusted input into
 * a typed message or null; nothing else on the server touches raw JSON.
 */
import type { LoadoutWeapon, ShopItem, SiteId, TacticalPhase, TacticalState, TeamIndex, TeamSize } from '../game/tactical.ts'

export const PROTOCOL_VERSION = 1
/** Client → server state frames and server snapshots per second. */
export const NET_RATE = 20
export const MAX_NAME = 16
export const ROOM_CODE_LENGTH = 5
/** Tactical maps playable online (the host picks one in the lobby). */
export const ONLINE_MAPS = ['aurora', 'copacabana', 'pelourinho', 'veneza', 'kyoto', 'marrakech', 'manhattan'] as const
export type OnlineMapId = (typeof ONLINE_MAPS)[number]

export type Vec3 = [number, number, number]

/** Compact per-player state sent by its owner every frame tick. */
export type PlayerFrame = {
  seq: number
  pos: Vec3
  yaw: number
  pitch: number
  /** Bit flags: 1 crouch, 2 walking (silent), 4 firing, 8 aiming, 16 planting/defusing. */
  flags: number
  weapon: LoadoutWeapon
  /** Shots fired since the previous frame (remote muzzle flashes and tracers). */
  shots?: number
}

export type HitClaim = { target: string; damage: number; headshot: boolean; weapon: LoadoutWeapon; distance: number }

// ─── client → server ────────────────────────────────────────────────────
export type ClientMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'create'; teamSize: TeamSize }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'team'; team: TeamIndex }
  | { t: 'ready'; ready: boolean }
  | { t: 'fillBots'; on: boolean }
  | { t: 'map'; map: OnlineMapId }
  | { t: 'start' }
  | { t: 'frame'; f: PlayerFrame }
  | { t: 'hit'; h: HitClaim }
  | { t: 'buy'; item: ShopItem }
  | { t: 'plant'; site: SiteId }
  | { t: 'defuse' }
  | { t: 'smoke'; at: Vec3 }
  | { t: 'grenade'; at: Vec3 }
  | { t: 'ping'; at: number }

// ─── server → client ────────────────────────────────────────────────────
export type LobbyPlayer = { id: string; name: string; team: TeamIndex; ready: boolean; host: boolean; bot: boolean }
export type LobbyView = { code: string; teamSize: TeamSize; players: LobbyPlayer[]; fillBots: boolean; started: boolean; map: OnlineMapId }

export type RoundView = {
  round: number
  phase: TacticalPhase
  timer: number
  score: [number, number]
  attackers: TeamIndex
  spike: { carrier: string | null; planted: boolean; site: SiteId | null }
  players: { id: string; team: TeamIndex; alive: boolean; credits: number; kills: number; deaths: number; weapon: LoadoutWeapon; shield: number }[]
}

export type Snapshot = { tick: number; players: ({ id: string; hp: number } & PlayerFrame)[] }

export type ServerMessage =
  | { t: 'welcome'; v: number; id: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'lobby'; lobby: LobbyView }
  | { t: 'matchStart'; you: string; team: TeamIndex; roster: string[]; map: OnlineMapId }
  | { t: 'round'; round: RoundView }
  /** Full rules state (player ids are indexes into matchStart.roster) and where the spike lies. */
  | { t: 'state'; s: TacticalState; spikePos: Vec3 | null }
  | { t: 'snapshot'; s: Snapshot }
  | { t: 'damage'; target: string; by: string; amount: number; hp: number; shield: number; headshot: boolean }
  | { t: 'smoke'; by: string; at: Vec3 }
  | { t: 'grenade'; by: string; at: Vec3 }
  | { t: 'kill'; killer: string; victim: string; weapon: LoadoutWeapon | 'grenade'; headshot: boolean }
  | { t: 'buyResult'; item: ShopItem; ok: boolean; reason?: string }
  | { t: 'pong'; at: number; server: number }

/** `closed` is emitted locally by the client when the socket drops (never sent by the server). */
export type ErrorCode = 'version' | 'bad_message' | 'no_room' | 'room_full' | 'not_host' | 'not_ready' | 'in_match' | 'rate' | 'closed'

// ─── validation (untrusted input) ───────────────────────────────────────
const WEAPONS: readonly LoadoutWeapon[] = ['pistol', 'shotgun', 'rifle']
const ITEMS: readonly ShopItem[] = ['shotgun', 'rifle', 'lightShield', 'heavyShield', 'smoke', 'grenade']
const isNum = (v: unknown, min = -1e6, max = 1e6): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(x => isNum(x, -1000, 1000))
const isTeam = (v: unknown): v is TeamIndex => v === 0 || v === 1

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, MAX_NAME)
  return name.length >= 2 ? name.toUpperCase() : null
}

export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`).test(v)
}

function parseFrame(f: unknown): PlayerFrame | null {
  if (!f || typeof f !== 'object') return null
  const o = f as Record<string, unknown>
  if (!isNum(o.seq, 0, 2 ** 31) || !isVec(o.pos) || !isNum(o.yaw, -100, 100) || !isNum(o.pitch, -2, 2) || !isNum(o.flags, 0, 255)) return null
  if (!WEAPONS.includes(o.weapon as LoadoutWeapon)) return null
  if (o.shots !== undefined && !isNum(o.shots, 0, 20)) return null
  const shots = o.shots === undefined ? 0 : Math.floor(o.shots as number)
  return { seq: Math.floor(o.seq), pos: o.pos, yaw: o.yaw, pitch: o.pitch, flags: Math.floor(o.flags), weapon: o.weapon as LoadoutWeapon, shots }
}

/** Parse a raw WebSocket payload. Returns null for anything malformed or oversized. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let o: Record<string, unknown>
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    o = v as Record<string, unknown>
  } catch {
    return null
  }
  switch (o.t) {
    case 'hello': {
      const name = cleanName(o.name)
      return isNum(o.v) && name ? { t: 'hello', v: o.v, name } : null
    }
    case 'create':
      return o.teamSize === 2 || o.teamSize === 3 || o.teamSize === 4 || o.teamSize === 5 ? { t: 'create', teamSize: o.teamSize } : null
    case 'join':
      return isRoomCode(o.code) ? { t: 'join', code: o.code } : null
    case 'leave':
    case 'start':
    case 'defuse':
      return { t: o.t }
    case 'team':
      return isTeam(o.team) ? { t: 'team', team: o.team } : null
    case 'ready':
      return typeof o.ready === 'boolean' ? { t: 'ready', ready: o.ready } : null
    case 'fillBots':
      return typeof o.on === 'boolean' ? { t: 'fillBots', on: o.on } : null
    case 'map':
      return ONLINE_MAPS.includes(o.map as OnlineMapId) ? { t: 'map', map: o.map as OnlineMapId } : null
    case 'frame': {
      const f = parseFrame(o.f)
      return f ? { t: 'frame', f } : null
    }
    case 'hit': {
      const h = o.h as Record<string, unknown> | undefined
      if (!h || typeof h.target !== 'string' || h.target.length > 32 || !isNum(h.damage, 0, 1000) || typeof h.headshot !== 'boolean' || !WEAPONS.includes(h.weapon as LoadoutWeapon) || !isNum(h.distance, 0, 500)) return null
      return { t: 'hit', h: { target: h.target, damage: h.damage, headshot: h.headshot, weapon: h.weapon as LoadoutWeapon, distance: h.distance } }
    }
    case 'buy':
      return ITEMS.includes(o.item as ShopItem) ? { t: 'buy', item: o.item as ShopItem } : null
    case 'plant':
      return o.site === 'A' || o.site === 'B' ? { t: 'plant', site: o.site } : null
    case 'smoke':
    case 'grenade':
      return isVec(o.at) ? { t: o.t, at: o.at } : null
    case 'ping':
      return isNum(o.at, 0, 1e15) ? { t: 'ping', at: o.at } : null
    default:
      return null
  }
}
