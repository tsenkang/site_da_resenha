/**
 * One online match from the client's side: the id mapping, the latest server state (already in the
 * local frame, see view.ts), the spike position and a short snapshot buffer that remote avatars
 * are posed from ~100 ms in the past, so movement stays smooth between 20 Hz updates.
 */
import type { TacticalState, TeamIndex } from '../game/tactical.ts'
import type { NetClient } from './client.ts'
import { NET_RATE, type OnlineMapId, type PlayerFrame, type Vec3 } from './protocol.ts'
import { netIds, toLocalState, type NetIds } from './view.ts'

/** How far behind the newest snapshot remote players are drawn (two network ticks). */
export const INTERP_DELAY = 2 / NET_RATE

type Snap = { at: number; frames: Map<string, PlayerFrame> }
export type RemotePose = { pos: Vec3; yaw: number; pitch: number; crouch: boolean }

export class NetLink {
  readonly ids: NetIds
  readonly roster: string[]
  readonly me: string
  /** Map the host picked. */
  readonly map: OnlineMapId
  state: TacticalState
  spikePos: Vec3 | null
  private snaps: Snap[] = []
  /** Shots each remote player fired that have not been drawn yet. */
  private readonly shots = new Map<string, number>()
  private readonly off: (() => void)[] = []

  constructor(
    readonly client: NetClient,
    start: { you: string; roster: string[]; map: OnlineMapId },
    first: { s: TacticalState; spikePos: Vec3 | null },
    ally0: number,
    enemy0: number,
  ) {
    this.me = start.you
    this.map = start.map
    this.roster = start.roster
    const teams = start.roster.map((_, i) => first.s.players[i]?.team ?? (0 as TeamIndex))
    this.ids = netIds(start.roster, teams, start.you, ally0, enemy0)
    this.state = toLocalState(first.s, this.roster, this.ids)
    this.spikePos = first.spikePos
    this.off.push(
      client.on('snapshot', m => {
        const frames = new Map<string, PlayerFrame>()
        for (const p of m.s.players) {
          frames.set(p.id, p)
          if (p.id !== this.me && p.shots) this.shots.set(p.id, (this.shots.get(p.id) ?? 0) + p.shots)
        }
        this.snaps.push({ at: performance.now() / 1000, frames })
        if (this.snaps.length > 12) this.snaps.shift()
      }),
    )
  }

  /** Local id of a network id (−1 when unknown). */
  local(netId: string): number {
    return this.ids.toLocal.get(netId) ?? -1
  }

  /** Network id of a local id. */
  net(localId: number): string | undefined {
    return this.ids.toNet.get(localId)
  }

  /** Server state message → local state (the caller diffs it against the previous one). */
  accept(s: TacticalState, spikePos: Vec3 | null): TacticalState {
    this.state = toLocalState(s, this.roster, this.ids)
    this.spikePos = spikePos
    return this.state
  }

  /** Interpolated pose of a remote player, or null before their first frame. */
  pose(netId: string, now = performance.now() / 1000): RemotePose | null {
    const t = now - INTERP_DELAY
    let a: PlayerFrame | undefined
    let b: PlayerFrame | undefined
    let ta = 0
    let tb = 0
    for (const s of this.snaps) {
      const f = s.frames.get(netId)
      if (!f) continue
      if (s.at <= t) {
        a = f
        ta = s.at
      } else {
        b = f
        tb = s.at
        break
      }
    }
    const f0 = a ?? b
    if (!f0) return null
    const f1 = b ?? f0
    const k = a && b && tb > ta ? Math.min(1, (t - ta) / (tb - ta)) : 1
    const lerp = (x: number, y: number) => x + (y - x) * k
    let dy = f1.yaw - f0.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    return {
      pos: [lerp(f0.pos[0], f1.pos[0]), lerp(f0.pos[1], f1.pos[1]), lerp(f0.pos[2], f1.pos[2])],
      yaw: f0.yaw + dy * k,
      pitch: lerp(f0.pitch, f1.pitch),
      crouch: ((k < 0.5 ? f0 : f1).flags & 1) !== 0,
    }
  }

  /** Shots a remote player fired since the last call (drawn as muzzle flashes and tracers). */
  takeShots(netId: string): number {
    const n = this.shots.get(netId) ?? 0
    this.shots.delete(netId)
    return n
  }

  /** New round: forget poses from the previous one so nobody slides across the map. */
  clearPoses(): void {
    this.snaps = []
    this.shots.clear()
  }

  dispose(): void {
    for (const f of this.off) f()
    this.off.length = 0
  }
}
