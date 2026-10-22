/**
 * Tactical arsenal: the fifteen guns of the buy menu (pistols, mid-tier, rifles), with stats
 * modelled on a competitive tactical shooter. Pure data (no three.js): the client simulation,
 * the buy rules (tactical.ts) and the online server's hit validation all read it.
 *
 * Units: damage in HP (100 HP players, shields 25/50); `armorPen` is the share of damage that
 * reaches health while a shield is up (the rest is soaked by the shield); `rangeMod` is the
 * damage kept every 12.7 m of distance; spreads are cone half-angles in radians; `speed`
 * scales movement speed while the gun is in hand; `zoom` lists scope magnifications.
 */
export type GunId =
  | 'glock' | 'dualies' | 'p250' | 'tec9' | 'deagle'
  | 'nova' | 'xm1014' | 'mp7' | 'p90' | 'mac10'
  | 'galil' | 'ak47' | 'ssg08' | 'sg553' | 'awp'
export type PistolId = 'glock' | 'dualies' | 'p250' | 'tec9' | 'deagle'
export type PrimaryId = Exclude<GunId, PistolId>
export type GunClass = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper'
/** Buy-menu column. */
export type GunTier = 'pistols' | 'mid' | 'rifles'

export type GunSpec = {
  id: GunId
  /** Shown in the buy menu and HUD. */
  name: string
  /** Type line under the name. */
  kind: string
  cls: GunClass
  tier: GunTier
  price: number
  killReward: number
  damage: number
  pellets: number
  headMul: number
  armorPen: number
  rangeMod: number
  range: number
  /** Seconds between shots. */
  interval: number
  auto: boolean
  mag: number
  reserve: number
  reload: number
  /** Shotguns that load shell by shell. */
  perShell?: boolean
  /** Pump action (rack after every shot). */
  pump?: boolean
  /** Bolt action: the scope comes off while the bolt is cycled. */
  bolt?: boolean
  /** Two pistols, firing alternately. */
  dual?: boolean
  speed: number
  spread: {
    /** First shot, standing still, from the hip. */
    stand: number
    /** Added at full running speed. */
    move: number
    /** Added while airborne. */
    air: number
    /** Added per shot (spray inaccuracy) and its cap. */
    bloom: number
    bloomMax: number
  }
  recoil: {
    /** Upward kick per shot early in a spray (radians). */
    pitch: number
    /** Peak sideways drift of the spray pattern. */
    yaw: number
    /** Seconds for the pattern to recover once you stop firing. */
    recover: number
    /** Pattern seed (sideways drift direction). */
    seed: number
  }
  sight: 'iron' | 'dot' | 'scope'
  /** Scope magnification levels (right click cycles them); none for iron sights / red dots. */
  zoom?: number[]
  /** Spread while scoped and still (snipers are only accurate scoped). */
  scoped?: number
  /** Movement speed multiplier while scoped. */
  scopedSpeed?: number
}

const g = (s: GunSpec): GunSpec => s

export const GUNS: Record<GunId, GunSpec> = {
  // ─── pistols ──────────────────────────────────────────────────────────
  glock: g({
    id: 'glock', name: 'Pistola 9mm', kind: 'Pistola inicial · 20 tiros', cls: 'pistol', tier: 'pistols', price: 200, killReward: 300,
    damage: 30, pellets: 1, headMul: 4, armorPen: 0.47, rangeMod: 0.75, range: 120, interval: 0.15, auto: false, mag: 20, reserve: 120, reload: 2.27,
    speed: 0.96, spread: { stand: 0.008, move: 0.022, air: 0.14, bloom: 0.012, bloomMax: 0.05 },
    recoil: { pitch: 0.018, yaw: 0.006, recover: 0.35, seed: 1 }, sight: 'iron',
  }),
  dualies: g({
    id: 'dualies', name: 'Pistolas Duplas', kind: 'Duas 9mm · 30 tiros', cls: 'pistol', tier: 'pistols', price: 300, killReward: 300,
    damage: 38, pellets: 1, headMul: 4, armorPen: 0.575, rangeMod: 0.79, range: 120, interval: 0.12, auto: false, mag: 30, reserve: 120, reload: 3.8,
    dual: true, speed: 0.96, spread: { stand: 0.011, move: 0.024, air: 0.15, bloom: 0.012, bloomMax: 0.055 },
    recoil: { pitch: 0.02, yaw: 0.008, recover: 0.35, seed: 2 }, sight: 'iron',
  }),
  p250: g({
    id: 'p250', name: 'Pistola Compacta', kind: 'Pistola · 13 tiros', cls: 'pistol', tier: 'pistols', price: 300, killReward: 300,
    damage: 38, pellets: 1, headMul: 4, armorPen: 0.64, rangeMod: 0.85, range: 120, interval: 0.15, auto: false, mag: 13, reserve: 26, reload: 2.2,
    speed: 0.96, spread: { stand: 0.007, move: 0.02, air: 0.14, bloom: 0.016, bloomMax: 0.055 },
    recoil: { pitch: 0.024, yaw: 0.007, recover: 0.38, seed: 3 }, sight: 'iron',
  }),
  tec9: g({
    id: 'tec9', name: 'Pistola Automática', kind: 'Pistola leve · 18 tiros', cls: 'pistol', tier: 'pistols', price: 500, killReward: 300,
    damage: 33, pellets: 1, headMul: 4, armorPen: 0.906, rangeMod: 0.83, range: 120, interval: 0.12, auto: false, mag: 18, reserve: 90, reload: 2.5,
    speed: 0.96, spread: { stand: 0.009, move: 0.012, air: 0.13, bloom: 0.014, bloomMax: 0.06 },
    recoil: { pitch: 0.022, yaw: 0.01, recover: 0.36, seed: 4 }, sight: 'iron',
  }),
  deagle: g({
    id: 'deagle', name: 'Pistola .50', kind: 'Pistola pesada · 7 tiros', cls: 'pistol', tier: 'pistols', price: 700, killReward: 300,
    damage: 53, pellets: 1, headMul: 4, armorPen: 0.932, rangeMod: 0.81, range: 140, interval: 0.225, auto: false, mag: 7, reserve: 35, reload: 2.2,
    speed: 0.92, spread: { stand: 0.005, move: 0.05, air: 0.2, bloom: 0.04, bloomMax: 0.09 },
    recoil: { pitch: 0.06, yaw: 0.012, recover: 0.55, seed: 5 }, sight: 'iron',
  }),
  // ─── mid-tier ─────────────────────────────────────────────────────────
  nova: g({
    id: 'nova', name: 'Escopeta Pump', kind: 'Escopeta · 8 cartuchos', cls: 'shotgun', tier: 'mid', price: 1050, killReward: 900,
    damage: 26, pellets: 9, headMul: 4, armorPen: 0.5, rangeMod: 0.7, range: 40, interval: 0.88, auto: false, mag: 8, reserve: 32, reload: 0.5,
    perShell: true, pump: true, speed: 0.88, spread: { stand: 0.062, move: 0.01, air: 0.06, bloom: 0, bloomMax: 0 },
    recoil: { pitch: 0.06, yaw: 0.015, recover: 0.5, seed: 6 }, sight: 'iron',
  }),
  xm1014: g({
    id: 'xm1014', name: 'Escopeta Automática', kind: 'Escopeta semiautomática · 7 cartuchos', cls: 'shotgun', tier: 'mid', price: 2000, killReward: 600,
    damage: 20, pellets: 6, headMul: 4, armorPen: 0.8, rangeMod: 0.7, range: 40, interval: 0.35, auto: true, mag: 7, reserve: 32, reload: 0.45,
    perShell: true, speed: 0.86, spread: { stand: 0.07, move: 0.012, air: 0.06, bloom: 0.004, bloomMax: 0.02 },
    recoil: { pitch: 0.05, yaw: 0.016, recover: 0.45, seed: 7 }, sight: 'iron',
  }),
  mp7: g({
    id: 'mp7', name: 'Submetralhadora MP', kind: 'SMG · 30 tiros', cls: 'smg', tier: 'mid', price: 1500, killReward: 600,
    damage: 29, pellets: 1, headMul: 4, armorPen: 0.625, rangeMod: 0.85, range: 110, interval: 0.08, auto: true, mag: 30, reserve: 120, reload: 3.1,
    speed: 0.88, spread: { stand: 0.009, move: 0.016, air: 0.12, bloom: 0.0035, bloomMax: 0.03 },
    recoil: { pitch: 0.0105, yaw: 0.008, recover: 0.3, seed: 8 }, sight: 'iron',
  }),
  p90: g({
    id: 'p90', name: 'Submetralhadora Bullpup', kind: 'SMG · 50 tiros', cls: 'smg', tier: 'mid', price: 2350, killReward: 300,
    damage: 26, pellets: 1, headMul: 4, armorPen: 0.69, rangeMod: 0.86, range: 110, interval: 0.07, auto: true, mag: 50, reserve: 100, reload: 3.35,
    speed: 0.92, spread: { stand: 0.011, move: 0.016, air: 0.12, bloom: 0.003, bloomMax: 0.032 },
    recoil: { pitch: 0.0085, yaw: 0.007, recover: 0.3, seed: 9 }, sight: 'dot',
  }),
  mac10: g({
    id: 'mac10', name: 'Micro SMG', kind: 'SMG compacta · 30 tiros', cls: 'smg', tier: 'mid', price: 1050, killReward: 600,
    damage: 29, pellets: 1, headMul: 4, armorPen: 0.575, rangeMod: 0.8, range: 100, interval: 0.075, auto: true, mag: 30, reserve: 100, reload: 2.6,
    speed: 0.96, spread: { stand: 0.012, move: 0.014, air: 0.1, bloom: 0.004, bloomMax: 0.036 },
    recoil: { pitch: 0.0115, yaw: 0.011, recover: 0.3, seed: 10 }, sight: 'iron',
  }),
  // ─── rifles ───────────────────────────────────────────────────────────
  galil: g({
    id: 'galil', name: 'Fuzil Leve', kind: 'Fuzil de assalto · 35 tiros', cls: 'rifle', tier: 'rifles', price: 1800, killReward: 300,
    damage: 30, pellets: 1, headMul: 4, armorPen: 0.775, rangeMod: 0.98, range: 180, interval: 0.09, auto: true, mag: 35, reserve: 90, reload: 3.0,
    speed: 0.86, spread: { stand: 0.0045, move: 0.06, air: 0.16, bloom: 0.004, bloomMax: 0.04 },
    recoil: { pitch: 0.016, yaw: 0.011, recover: 0.38, seed: 11 }, sight: 'iron',
  }),
  ak47: g({
    id: 'ak47', name: 'Fuzil AK', kind: 'Fuzil de assalto · 30 tiros', cls: 'rifle', tier: 'rifles', price: 2700, killReward: 300,
    damage: 36, pellets: 1, headMul: 4, armorPen: 0.775, rangeMod: 0.98, range: 200, interval: 0.1, auto: true, mag: 30, reserve: 90, reload: 2.43,
    speed: 0.86, spread: { stand: 0.0035, move: 0.065, air: 0.17, bloom: 0.0045, bloomMax: 0.045 },
    recoil: { pitch: 0.021, yaw: 0.014, recover: 0.4, seed: 12 }, sight: 'iron',
  }),
  ssg08: g({
    id: 'ssg08', name: 'Rifle de Ferrolho', kind: 'Rifle de precisão leve · 10 tiros', cls: 'sniper', tier: 'rifles', price: 1700, killReward: 300,
    damage: 88, pellets: 1, headMul: 4, armorPen: 0.85, rangeMod: 0.98, range: 240, interval: 1.25, auto: false, mag: 10, reserve: 90, reload: 3.7,
    bolt: true, speed: 0.92, spread: { stand: 0.03, move: 0.06, air: 0.2, bloom: 0, bloomMax: 0 },
    recoil: { pitch: 0.045, yaw: 0.008, recover: 0.6, seed: 13 }, sight: 'scope', zoom: [2.25, 6], scoped: 0.0007, scopedSpeed: 0.92,
  }),
  sg553: g({
    id: 'sg553', name: 'Fuzil com Luneta', kind: 'Fuzil de assalto com luneta · 30 tiros', cls: 'rifle', tier: 'rifles', price: 3000, killReward: 300,
    damage: 30, pellets: 1, headMul: 4, armorPen: 1, rangeMod: 0.98, range: 200, interval: 0.089, auto: true, mag: 30, reserve: 90, reload: 2.8,
    speed: 0.84, spread: { stand: 0.004, move: 0.065, air: 0.17, bloom: 0.004, bloomMax: 0.042 },
    recoil: { pitch: 0.019, yaw: 0.012, recover: 0.4, seed: 14 }, sight: 'scope', zoom: [2], scoped: 0.0018, scopedSpeed: 0.6,
  }),
  awp: g({
    id: 'awp', name: 'Rifle de Precisão', kind: 'Rifle de precisão .338 · 5 tiros', cls: 'sniper', tier: 'rifles', price: 4750, killReward: 100,
    damage: 115, pellets: 1, headMul: 4, armorPen: 0.975, rangeMod: 0.99, range: 300, interval: 1.46, auto: false, mag: 5, reserve: 30, reload: 3.67,
    bolt: true, speed: 0.8, spread: { stand: 0.07, move: 0.12, air: 0.3, bloom: 0, bloomMax: 0 },
    recoil: { pitch: 0.07, yaw: 0.01, recover: 0.7, seed: 15 }, sight: 'scope', zoom: [2.25, 9], scoped: 0.0004, scopedSpeed: 0.6,
  }),
}

export const GUN_IDS = Object.keys(GUNS) as GunId[]
export const PISTOL_IDS: PistolId[] = ['glock', 'dualies', 'p250', 'tec9', 'deagle']
export const DEFAULT_PISTOL: PistolId = 'glock'
export const isPistol = (id: GunId): id is PistolId => GUNS[id].cls === 'pistol'
export const isGunId = (v: unknown): v is GunId => typeof v === 'string' && v in GUNS

/** Damage after distance falloff (one pellet). */
export function damageAt(gun: GunSpec, distance: number): number {
  return gun.damage * Math.pow(gun.rangeMod, distance / 12.7)
}

/**
 * Deterministic spray pattern: shot `i` of a spray (0-based) → recoil step [pitch, yaw] in
 * radians. The first shots climb straight up, then the spray drifts side to side, like the
 * learnable patterns of competitive shooters.
 */
export function recoilStep(gun: GunSpec, i: number): [number, number] {
  const r = gun.recoil
  const climb = i < 9 ? 1 : i < 16 ? 0.45 : 0.2
  const ramp = Math.min(1, Math.max(0, (i - 5) / 5))
  const dir = r.seed % 2 === 0 ? 1 : -1
  const yaw = r.yaw * ramp * Math.sin(i * 0.42 + r.seed) * dir
  return [r.pitch * climb, yaw]
}

/**
 * Health and shield after a hit: while a shield is up only `armorPen` of the damage reaches
 * health and the shield soaks the rest (until it runs out).
 */
export function applyHit(hp: number, shield: number, amount: number, armorPen: number): { hp: number; shield: number } {
  if (shield <= 0) return { hp: Math.max(0, hp - amount), shield: 0 }
  const soak = Math.min(shield, amount * (1 - armorPen))
  return { hp: Math.max(0, hp - (amount - soak)), shield: shield - soak }
}
