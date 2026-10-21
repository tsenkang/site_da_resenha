/**
 * Map definitions. Each game mode plays on its own map; layouts are in design units (scaled by
 * `scale`) and every map has its own palette, sky and light so they read as different places.
 *
 * - aurora    · Tactical (Spike): sunny two-site town, A/B plant zones, spawn barriers.
 * - mercado   · Deathmatch: compact market square at sunset, four lanes into a covered hall.
 * - fortaleza · Survival: wide night courtyard around a keep, lit by lanterns and windows.
 */
import type { GameMode } from './game'

export type MapId = 'aurora' | 'mercado' | 'fortaleza'
type Rect = [number, number, number, number]

export type MapLook = {
  sky: [number, string][]
  fog: string
  fogDensity: number
  sunDir: [number, number, number]
  sunColor: string
  sunIntensity: number
  hemiSky: string
  hemiGround: string
  hemiIntensity: number
  ridge: [string, string]
  cloud: string
  cloudGlow: string
  sunGlow: string
  stucco: string[]
  trim: string[]
  roof: string[]
  floor: string
  street: string
  grass: string
  /** Windows and lamps glow (night maps). */
  night: boolean
}

export type MapDef = {
  id: MapId
  name: string
  scale: number
  /** Half extents in design units. */
  halfX: number
  halfZ: number
  /** [x0, x1, z0, z1, height, style]. */
  buildings: [number, number, number, number, number, number][]
  /** [x, z, w, d, h, kind] — kind 0 crate, 1 planter, 2 generator, 3 fountain (sizes in metres). */
  cover: [number, number, number, number, number, number][]
  trees: [number, number, number][]
  lamps: [number, number][]
  streets: Rect[]
  plazas: Rect[]
  /** Tactical only: A/B plant zones and buy-phase barrier lines (design z of attack, defend). */
  sites: boolean
  barriers: [number, number] | null
  teamSpawnZ: [number, number]
  ffaSpawns: [number, number][]
  hotspots: [number, number][]
  barrels: [number, number, 'barrel' | 'propane'][]
  pickups: [number, number, 'health' | 'armor' | 'ammo' | 'rocket'][]
  look: MapLook
}

const AURORA: MapDef = {
  id: 'aurora',
  name: 'Base Aurora',
  scale: 1.3,
  halfX: 46,
  halfZ: 50,
  buildings: [
    [-46, -38, -4, 20, 8, 0],
    [-30, -8, -6, 24, 9, 1],
    [8, 30, -6, 24, 9, 2],
    [38, 46, -4, 20, 8, 0],
    [-16, -3, -36, -14, 7.5, 2],
    [3, 16, -36, -14, 7.5, 1],
  ],
  cover: [
    [-31, -24, 3.2, 3.2, 2.2, 2], [-38, -16, 2, 2, 1.6, 0], [-38, -14, 2, 2, 1.6, 0], [-38, -15, 2, 2, 3.2, 0],
    [-24, -31, 2, 2, 1.6, 0], [-22, -31, 2, 2, 1.6, 0], [-41, -30, 1.2, 6, 1.1, 1], [-22, -18, 4, 1.2, 1.1, 1],
    [31, -24, 3.2, 3.2, 2.2, 2], [38, -16, 2, 2, 1.6, 0], [38, -14, 2, 2, 1.6, 0], [38, -15, 2, 2, 3.2, 0],
    [24, -31, 2, 2, 1.6, 0], [22, -31, 2, 2, 1.6, 0], [41, -30, 1.2, 6, 1.1, 1], [22, -18, 4, 1.2, 1.1, 1],
    [0, 7, 5.5, 5.5, 1.1, 3], [-4, -10, 2, 2, 1.6, 0], [4, -10, 2, 2, 1.6, 0], [0, 18, 2, 2, 1.6, 0], [1.6, 19.2, 1.4, 1.4, 1.1, 0],
    [-34, 6, 2, 2, 1.6, 0], [-35.5, 7.5, 1.4, 1.4, 1.1, 0], [34, 6, 2, 2, 1.6, 0], [35.5, 7.5, 1.4, 1.4, 1.1, 0],
    [-26, 30, 5, 1.2, 1.1, 1], [26, 30, 5, 1.2, 1.1, 1], [-40, 28, 2, 2, 1.6, 0], [40, 28, 2, 2, 1.6, 0],
    [-26, -43, 2, 2, 1.6, 0], [26, -43, 2, 2, 1.6, 0], [0, -42, 6, 1.2, 1.1, 1],
  ],
  trees: [
    [-43, -45, 1.1], [-34, -46, 0.9], [43, -45, 1.1], [34, -46, 0.9], [-21, -44, 0.8], [21, -44, 0.8],
    [-44, -9, 1], [44, -9, 1], [-19, -27, 0.9], [19, -27, 0.9],
    [-43, 26, 1.1], [43, 26, 1.1], [-20, 46, 1], [20, 46, 1], [-33, 45, 0.9], [33, 45, 0.9],
    [-5, 27, 0.75], [5, 27, 0.75],
  ],
  lamps: [[-37, 12], [37, 12], [-37, -2], [37, -2], [-7, 14], [7, 2], [-2.5, -30], [2.5, -20], [-14, 36], [14, 36], [-30, -38], [30, -38]],
  streets: [[-38, -30, -4, 24], [30, 38, -4, 24], [-8, 8, -6, 28], [-3, 3, -36, -6]],
  plazas: [[-44, -18, -36, -8], [18, 44, -36, -8]],
  sites: true,
  barriers: [34.5, -37.5],
  teamSpawnZ: [44, -45],
  ffaSpawns: [[-41, -44], [41, -44], [-34, 10], [34, 10], [-41, -22], [41, -22], [0, -44], [0, 44], [-36, 42], [36, 42], [0, 12], [-20, -10], [20, -10], [-30, 30], [30, 30], [0, -26]],
  hotspots: [[-31, -20], [31, -20], [0, 0], [0, -24], [-34, 10], [34, 10], [-12, -10], [12, -10], [-30, 32], [30, 32], [0, 30], [-30, -44], [30, -44]],
  barrels: [[-36.5, 15, 'barrel'], [36.5, 15, 'barrel'], [-6.2, 16, 'propane'], [6.2, -12, 'barrel'], [-43, -36, 'barrel'], [43, -36, 'propane']],
  pickups: [[-34, 12, 'health'], [34, 12, 'health'], [0, -30, 'health'], [0, 32, 'health'], [-30, -40, 'armor'], [30, -40, 'armor'], [-20, 32, 'ammo'], [20, 32, 'ammo'], [-12, -44, 'ammo'], [12, -44, 'ammo'], [0, -2, 'rocket']],
  look: {
    sky: [[0, '#3f86d6'], [0.3, '#7fb6ea'], [0.46, '#cfe2ef'], [0.5, '#f4e9d6'], [0.56, '#c9d4c0'], [1, '#8fa47a']],
    fog: '#d4e1ea', fogDensity: 0.0034,
    sunDir: [-0.45, 0.82, 0.38], sunColor: '#fff0d6', sunIntensity: 2.55,
    hemiSky: '#cfe2ff', hemiGround: '#b89a78', hemiIntensity: 1.1,
    ridge: ['#93abbd', '#b6c7d4'], cloud: '#ffffff', cloudGlow: '#c9d6e2', sunGlow: '#fff2d6',
    stucco: ['#f2e6cf', '#ecd2ad', '#dfe7e2'], trim: ['#c45f3f', '#2f978f', '#4a6f9e'], roof: ['#c2593b', '#3a8d86', '#55698a'],
    floor: '#e2d6c0', street: '#cfc2aa', grass: '#9cb86a', night: false,
  },
}

/** Market square: four corner blocks and four gatehouses around a covered hall; lanes on every side. */
const MERCADO: MapDef = {
  id: 'mercado',
  name: 'Mercado',
  scale: 1,
  halfX: 40,
  halfZ: 40,
  buildings: [
    [-40, -24, -40, -24, 9, 0], [24, 40, -40, -24, 8, 1], [-40, -24, 24, 40, 8, 2], [24, 40, 24, 40, 9, 0],
    [-6, 6, -40, -31, 7, 1], [-6, 6, 31, 40, 7, 2], [-40, -31, -6, 6, 7, 2], [31, 40, -6, 6, 7, 1],
    [-6, 6, -6, 6, 6, 0],
  ],
  cover: [
    // Market stalls (crate stacks) around the hall, planters on the corners of the ring.
    [-13, -12, 2.4, 1.4, 1.6, 0], [13, 12, 2.4, 1.4, 1.6, 0], [12, -13, 1.4, 2.4, 1.6, 0], [-12, 13, 1.4, 2.4, 1.6, 0],
    [-15, 0, 1.6, 1.6, 3.2, 0], [15, 0, 1.6, 1.6, 3.2, 0], [0, -15, 1.6, 1.6, 1.6, 0], [0, 15, 1.6, 1.6, 1.6, 0],
    [-19, -19, 4, 1.2, 1.1, 1], [19, 19, 4, 1.2, 1.1, 1], [19, -19, 1.2, 4, 1.1, 1], [-19, 19, 1.2, 4, 1.1, 1],
    [-24, -12, 2, 2, 1.6, 0], [24, 12, 2, 2, 1.6, 0], [12, -24, 2, 2, 1.6, 0], [-12, 24, 2, 2, 1.6, 0],
    [-30, 15, 2.2, 2.2, 2.2, 2], [30, -15, 2.2, 2.2, 2.2, 2], [-15, -30, 3, 1.2, 1.1, 1], [15, 30, 3, 1.2, 1.1, 1],
    [-35, 20, 1.6, 1.6, 1.6, 0], [35, -20, 1.6, 1.6, 1.6, 0], [20, 35, 1.6, 1.6, 1.6, 0], [-20, -35, 1.6, 1.6, 1.6, 0],
  ],
  trees: [[-20, -9, 0.9], [20, 9, 0.9], [9, -20, 0.9], [-9, 20, 0.9], [-36, -20, 1], [36, 20, 1], [20, -36, 1], [-20, 36, 1]],
  lamps: [[-9, -9], [9, 9], [9, -9], [-9, 9], [-22, 0], [22, 0], [0, -22], [0, 22], [-30, -30], [30, 30], [30, -30], [-30, 30]],
  streets: [[-40, 40, -6, 6], [-6, 6, -40, 40]],
  plazas: [[-22, 22, -22, 22]],
  sites: false,
  barriers: null,
  teamSpawnZ: [34, -34],
  ffaSpawns: [[-34, -12], [34, 12], [12, -34], [-12, 34], [-18, -22], [18, 22], [22, -18], [-22, 18], [-34, 12], [34, -12], [-12, -34], [12, 34], [-10, 0], [10, 0], [0, -10], [0, 10]],
  hotspots: [[0, -12], [0, 12], [-12, 0], [12, 0], [-18, -18], [18, 18], [18, -18], [-18, 18], [-32, 0], [32, 0], [0, -32], [0, 32]],
  barrels: [[-8.5, -18, 'barrel'], [8.5, 18, 'barrel'], [18, -8.5, 'propane'], [-18, 8.5, 'propane'], [-27, -27, 'barrel'], [27, 27, 'barrel']],
  pickups: [[-21, 0, 'health'], [21, 0, 'health'], [0, -21, 'armor'], [0, 21, 'armor'], [-27, 27, 'ammo'], [27, -27, 'ammo'], [-27, -27, 'ammo'], [27, 27, 'ammo'], [0, -27, 'rocket']],
  look: {
    sky: [[0, '#38306b'], [0.25, '#8a5a8f'], [0.4, '#e8907a'], [0.48, '#ffc488'], [0.5, '#ffe0b0'], [0.56, '#c7a48a'], [1, '#8a6a58']],
    fog: '#f0c3a6', fogDensity: 0.0058,
    sunDir: [0.78, 0.3, -0.55], sunColor: '#ffb57a', sunIntensity: 2.7,
    hemiSky: '#e8c8c8', hemiGround: '#8c6a5c', hemiIntensity: 1.0,
    ridge: ['#9a7a8e', '#c49a9a'], cloud: '#ffd9c8', cloudGlow: '#e89a8a', sunGlow: '#ffc890',
    stucco: ['#f6d9c8', '#f2e2b0', '#eac9ba'], trim: ['#a8433a', '#3d7a8c', '#7a5aa0'], roof: ['#b8503a', '#5a7a9a', '#a85a40'],
    floor: '#e6d2bc', street: '#d2bba3', grass: '#a6a86a', night: false,
  },
}

/** Old fort at night: open courtyard around a central keep, corner towers, low walls for cover. */
const FORTALEZA: MapDef = {
  id: 'fortaleza',
  name: 'Fortaleza',
  scale: 1,
  halfX: 48,
  halfZ: 48,
  buildings: [
    [-9, 9, -9, 9, 12, 2],
    [-48, -38, -48, -38, 11, 0], [38, 48, -48, -38, 11, 0], [-48, -38, 38, 48, 11, 0], [38, 48, 38, 48, 11, 0],
    [-48, -40, -12, 12, 7, 1], [40, 48, -12, 12, 7, 1], [-12, 12, -48, -40, 7, 1], [-12, 12, 40, 48, 7, 1],
  ],
  cover: [
    [-20, -20, 5, 1.2, 1.1, 1], [20, 20, 5, 1.2, 1.1, 1], [20, -20, 1.2, 5, 1.1, 1], [-20, 20, 1.2, 5, 1.1, 1],
    [-28, 0, 1.2, 6, 1.1, 1], [28, 0, 1.2, 6, 1.1, 1], [0, -28, 6, 1.2, 1.1, 1], [0, 28, 6, 1.2, 1.1, 1],
    [-14, -30, 2, 2, 1.6, 0], [14, 30, 2, 2, 1.6, 0], [30, -14, 2, 2, 1.6, 0], [-30, 14, 2, 2, 1.6, 0],
    [-30, -30, 2.6, 2.6, 2.2, 2], [30, 30, 2.6, 2.6, 2.2, 2], [-34, 28, 2, 2, 3.2, 0], [34, -28, 2, 2, 3.2, 0],
    [-16, 16, 1.6, 1.6, 1.6, 0], [16, -16, 1.6, 1.6, 1.6, 0],
  ],
  trees: [[-22, -34, 1.1], [22, 34, 1.1], [34, -22, 1.1], [-34, 22, 1.1], [-14, 22, 0.8], [14, -22, 0.8]],
  lamps: [[-12, -12], [12, 12], [12, -12], [-12, 12], [-24, -8], [24, 8], [8, -24], [-8, 24], [-34, -34], [34, 34], [34, -34], [-34, 34]],
  streets: [[-40, 40, -14, -10], [-40, 40, 10, 14], [-14, -10, -40, 40], [10, 14, -40, 40]],
  plazas: [[-36, 36, -36, 36]],
  sites: false,
  barriers: null,
  teamSpawnZ: [34, -34],
  ffaSpawns: [[-32, -20], [32, 20], [20, -32], [-20, 32], [-36, 0], [36, 0], [0, -36], [0, 36], [-24, -24], [24, 24], [24, -24], [-24, 24], [-18, 0], [18, 0], [0, -18], [0, 18]],
  hotspots: [[-18, -18], [18, 18], [18, -18], [-18, 18], [0, -20], [0, 20], [-20, 0], [20, 0], [-32, -32], [32, 32]],
  barrels: [[-10.5, -20, 'barrel'], [10.5, 20, 'barrel'], [20, -10.5, 'propane'], [-20, 10.5, 'propane']],
  pickups: [[-24, 0, 'health'], [24, 0, 'health'], [0, -24, 'armor'], [0, 24, 'armor'], [-30, -24, 'ammo'], [30, 24, 'ammo'], [24, -30, 'ammo'], [-24, 30, 'ammo'], [0, -14, 'rocket']],
  look: {
    sky: [[0, '#070b1c'], [0.3, '#142347'], [0.45, '#2c4470'], [0.5, '#4f6a8e'], [0.56, '#1d2633'], [1, '#10141c']],
    fog: '#1f2d44', fogDensity: 0.0075,
    sunDir: [0.35, 0.78, 0.5], sunColor: '#a8c0ff', sunIntensity: 1.1,
    hemiSky: '#5a73a8', hemiGround: '#2a2622', hemiIntensity: 1.05,
    ridge: ['#1b2538', '#2a3650'], cloud: '#5c6a86', cloudGlow: '#242c3e', sunGlow: '#c8d6ff',
    stucco: ['#c2bcb0', '#b2ab9e', '#cbc3b4'], trim: ['#6a4e3a', '#3e5266', '#7a3e3a'], roof: ['#4e5a6e', '#5e4e40', '#3e4e4e'],
    floor: '#a9a296', street: '#948d82', grass: '#4e6a44', night: true,
  },
}

export const MAPS: Record<MapId, MapDef> = { aurora: AURORA, mercado: MERCADO, fortaleza: FORTALEZA }
export const MODE_MAP: Record<GameMode, MapId> = { tactical: 'aurora', deathmatch: 'mercado', onslaught: 'fortaleza' }
/** Maps live side by side in one physics world, far enough apart to never see each other. */
export const MAP_ORIGIN: Record<MapId, [number, number]> = { aurora: [0, 0], mercado: [2400, 0], fortaleza: [-2400, 0] }
