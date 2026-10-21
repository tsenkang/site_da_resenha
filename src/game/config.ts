/**
 * Iron Rift gameplay configuration.
 *
 * DEFAULT_CONFIG holds the shipped source defaults. CONFIG is the active configuration read by
 * gameplay; the preview Tweak manager (tuning.ts) writes to it at the proper boundaries.
 */
export type WeaponId = 'rifle' | 'shotgun' | 'rocket' | 'pistol'

export type WeaponDef = {
  id: WeaponId
  name: string
  slot: number
  damage: number
  headMultiplier: number
  pellets: number
  /** Seconds between shots. */
  interval: number
  auto: boolean
  mag: number
  reserveStart: number
  reserveMax: number
  reload: number
  /** Shotgun loads shell by shell. */
  perShell: boolean
  /** Spread cone half-angle (radians) at rest, hip fire and aimed. */
  spread: number
  spreadAds: number
  /** Spread added per shot and its cap. */
  bloom: number
  bloomMax: number
  /** Aim recoil per shot (radians) and random horizontal component. */
  recoilPitch: number
  recoilYaw: number
  /** Visual weapon kick strength and screen shake. */
  punch: number
  shake: number
  range: number
  adsFov: number
  projectileSpeed?: number
  splashRadius?: number
}

/** Arcade tuning (Deathmatch / Onslaught): fast TTK swings, regenerating armor. */
const ARCADE_WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: {
    id: 'rifle', name: 'Rifle M4', slot: 1, damage: 21, headMultiplier: 2, pellets: 1, interval: 0.092, auto: true,
    mag: 30, reserveStart: 150, reserveMax: 270, reload: 1.85, perShell: false,
    spread: 0.012, spreadAds: 0.0022, bloom: 0.0035, bloomMax: 0.034, recoilPitch: 0.0105, recoilYaw: 0.0055,
    punch: 1, shake: 0.06, range: 220, adsFov: 52,
  },
  shotgun: {
    id: 'shotgun', name: 'Escopeta M870', slot: 2, damage: 13, headMultiplier: 1.5, pellets: 10, interval: 0.3, auto: true,
    mag: 7, reserveStart: 35, reserveMax: 56, reload: 0.48, perShell: true,
    spread: 0.072, spreadAds: 0.052, bloom: 0, bloomMax: 0, recoilPitch: 0.036, recoilYaw: 0.012,
    punch: 2.2, shake: 0.24, range: 60, adsFov: 64,
  },
  rocket: {
    id: 'rocket', name: 'Lançador RPG-X', slot: 3, damage: 125, headMultiplier: 1, pellets: 1, interval: 0.9, auto: false,
    mag: 3, reserveStart: 6, reserveMax: 9, reload: 2.3, perShell: false,
    spread: 0.004, spreadAds: 0.001, bloom: 0, bloomMax: 0, recoilPitch: 0.045, recoilYaw: 0.01,
    punch: 3.4, shake: 0.45, range: 200, adsFov: 60, projectileSpeed: 44, splashRadius: 6.5,
  },
  pistol: {
    id: 'pistol', name: 'Pistola P9', slot: 4, damage: 18, headMultiplier: 2.5, pellets: 1, interval: 0.16, auto: false,
    mag: 12, reserveStart: 48, reserveMax: 72, reload: 1.5, perShell: false,
    spread: 0.008, spreadAds: 0.004, bloom: 0.006, bloomMax: 0.03, recoilPitch: 0.012, recoilYaw: 0.004,
    punch: 0.7, shake: 0.04, range: 120, adsFov: 70,
  },
}

/**
 * Tactical tuning (Spike mode), modelled on a tactical shooter: accurate first shots, one-tap
 * headshots with the rifle, small magazines and slow reloads, so positioning and crosshair
 * placement matter more than spraying.
 */
const TACTICAL_WEAPONS: Record<WeaponId, Partial<WeaponDef>> = {
  rifle: { name: 'Rifle M4', slot: 1, damage: 40, headMultiplier: 4, interval: 0.103, mag: 25, reserveStart: 50, reserveMax: 50, reload: 2.4, spread: 0.0035, spreadAds: 0.0015, bloom: 0.0045, bloomMax: 0.045, recoilPitch: 0.011 },
  shotgun: { name: 'Escopeta M870', slot: 1, damage: 15, headMultiplier: 1.5, pellets: 12, interval: 0.29, mag: 7, reserveStart: 21, reserveMax: 21 },
  rocket: {},
  pistol: { name: 'Pistola P9', slot: 2, damage: 26, headMultiplier: 3, interval: 0.15, mag: 12, reserveStart: 36, reserveMax: 36, reload: 1.75 },
}

export type WeaponProfile = 'arcade' | 'tactical'
/** Active weapon stats; `setWeaponProfile` swaps them when a match starts. */
export const WEAPONS: Readonly<Record<WeaponId, Readonly<WeaponDef>>> = structuredClone(ARCADE_WEAPONS)
export function setWeaponProfile(profile: WeaponProfile): void {
  for (const id of Object.keys(ARCADE_WEAPONS) as WeaponId[]) {
    Object.assign(WEAPONS[id] as WeaponDef, ARCADE_WEAPONS[id], profile === 'tactical' ? TACTICAL_WEAPONS[id] : {})
  }
}
export const WEAPON_ORDER: WeaponId[] = ['rifle', 'shotgun', 'rocket', 'pistol']

export const DEFAULT_CONFIG = {
  player: {
    /** Global multiplier on all damage the player deals to enemies (bullets, pellets, rockets, grenades). */
    damageScale: 1.25,
    radius: 0.38,
    halfHeight: 0.52,
    /** Capsule half height while crouched/sliding (total height ≈ 1.26 m, so ~1.2 m cover hides you). */
    crouchHalfHeight: 0.25,
    crouchSpeed: 3.3,
    eyeHeight: 1.62,
    walkSpeed: 6.4,
    sprintSpeed: 9.6,
    adsSpeed: 3.8,
    acceleration: 70,
    airControl: 0.35,
    jumpSpeed: 7.4,
    gravity: -22,
    maxFall: -40,
    coyoteTime: 0.1,
    jumpBuffer: 0.12,
    maxHealth: 100,
    maxArmor: 150,
    /** Share of incoming damage absorbed by armor. */
    armorAbsorb: 0.75,
    /** Seconds without taking damage before armor starts recharging. */
    armorRegenDelay: 1,
    /** Armor points restored per second while recharging. */
    armorRegenRate: 55,
    respawnDelay: 3.2,
    spawnProtection: 1.6,
  },
  camera: {
    fov: 78,
    bob: 1,
    shake: 1,
  },
  bots: {
    count: 5,
    health: 100,
    /** Aim error cone in radians before movement penalties. Lower = deadlier. */
    aimError: 0.052,
    reaction: 0.42,
    damage: 7,
    fireInterval: 0.13,
    burst: 5,
    burstPause: 0.55,
    speed: 5.4,
    viewRange: 70,
    respawnDelay: 3.4,
  },
  match: {
    seconds: 360,
    fragLimit: 20,
  },
  score: {
    kill: 100,
    headshot: 50,
    multi: 75,
    win: 1000,
    placement: 150,
  },
}

type Config = typeof DEFAULT_CONFIG

/** Active, tunable configuration read by gameplay. Source defaults stay untouched. */
export const CONFIG: Config = structuredClone(DEFAULT_CONFIG)

/** striker/warden: deathmatch rivals. scrapper/juggernaut/titan: Onslaught wave enemies. */
export type BotKind = 'striker' | 'warden' | 'scrapper' | 'breacher' | 'juggernaut' | 'titan'
export const BOT_ROSTER: { name: string; color: string; visor: string; kind: BotKind }[] = [
  { name: 'VIPER', color: '#9e2a22', visor: '#ff3b2f', kind: 'striker' },
  { name: 'HAVOC', color: '#2a5caa', visor: '#3fc8ff', kind: 'warden' },
  { name: 'WRAITH', color: '#4a5058', visor: '#b8ff3a', kind: 'striker' },
  { name: 'TITAN', color: '#b87a10', visor: '#ffb020', kind: 'warden' },
  { name: 'NOVA', color: '#6b3fa0', visor: '#ff4fd8', kind: 'striker' },
  { name: 'RAZOR', color: '#2f7d4a', visor: '#5affb0', kind: 'striker' },
  { name: 'ONYX', color: '#222226', visor: '#ff7a1a', kind: 'warden' },
]
export const MAX_BOTS = BOT_ROSTER.length
