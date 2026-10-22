/**
 * Online tactical maps inspired by real places. Same skeleton as Base Aurora (design units at
 * scale 1.3, attackers spawn north at +z, defenders south at −z, buy-phase barriers on the same
 * lines) so rounds play the same; each has its own streets, sites, cover, palette, sky, paving,
 * trees, props and a landmark on the horizon.
 */
import type { MapDef, MapId } from './maps'

type TacticalBase = Omit<MapDef, 'scale' | 'halfX' | 'halfZ' | 'barriers' | 'teamSpawnZ' | 'ffaSpawns' | 'hotspots' | 'barrels' | 'pickups' | 'lamps' | 'streets' | 'plazas'> &
  Partial<Pick<MapDef, 'lamps' | 'streets' | 'plazas' | 'hotspots'>>

const tactical = (m: TacticalBase): MapDef => ({
  scale: 1.3,
  halfX: 46,
  halfZ: 50,
  barriers: [34.5, -37.5],
  teamSpawnZ: [44, -45],
  ffaSpawns: [[-40, 40], [40, 40], [0, 44], [-40, -44], [40, -44], [0, -45], [-30, 0], [30, 0]],
  hotspots: [],
  barrels: [],
  pickups: [],
  lamps: [],
  streets: [],
  plazas: [],
  ...m,
})

/** Rio de Janeiro: tall flat-roofed blocks, the wavy black-and-white promenade, sites on the sand. */
const COPACABANA = tactical({
  id: 'copacabana',
  name: 'Copacabana',
  place: 'Rio de Janeiro · Brasil',
  buildings: [
    [-46, -26, 12, 30, 15, 0], [-18, -6, 10, 30, 18, 1], [6, 18, 10, 30, 17, 2], [26, 46, 12, 30, 14, 1],
    [-6, 6, -32, -20, 4.5, 2], [-46, -40, -24, -12, 5, 0], [40, 46, -36, -24, 5, 2],
  ],
  cover: [
    [-30, -22, 2, 2, 1.6, 0], [-30, -20, 2, 2, 3.2, 0], [-20, -31, 4, 1.2, 1.1, 1], [-34, -31, 1.6, 1.6, 1.6, 0], [-24, -18, 1.4, 1.4, 1.1, 0],
    [26, -26, 3.2, 3.2, 2.2, 2], [32, -20, 2, 2, 1.6, 0], [20, -32, 5, 1.2, 1.1, 1], [21, -20, 1.6, 1.6, 1.6, 0],
    [-12, -4, 2, 2, 1.6, 0], [12, -4, 2, 2, 1.6, 0], [0, -6, 6, 1.2, 1.1, 1], [-36, -4, 4, 1.2, 1.1, 1], [36, -4, 4, 1.2, 1.1, 1],
    [-22, 22, 1.6, 1.6, 1.6, 0], [22, 24, 1.6, 1.6, 1.6, 0], [0, 20, 2, 2, 1.6, 0], [-3, 24, 1.4, 1.4, 1.1, 0],
    [-30, 38, 5, 1.2, 1.1, 1], [30, 38, 5, 1.2, 1.1, 1], [-20, -44, 2, 2, 1.6, 0], [20, -44, 2, 2, 1.6, 0],
  ],
  trees: [[-42, 1, 1.1], [-32, 1, 1], [-12, 3, 1], [12, 3, 1], [32, 1, 1], [42, 1, 1.1], [-40, -40, 1], [40, -42, 1], [-14, -40, 0.9], [14, -40, 0.9]],
  props: [
    [-38, -26, 'parasol'], [-28, -34, 'parasol'], [-14, -24, 'parasol'], [14, -28, 'parasol'], [36, -18, 'parasol'], [32, -33, 'parasol'],
    [0, -38, 'parasol'], [-8, -14, 'parasol'], [8, -14, 'parasol'], [-24, -4, 'bench'], [24, -4, 'bench'],
  ],
  lamps: [[-24, -9], [24, -9], [-8, 1], [8, 1], [-40, -9], [40, -9], [-22, 32], [22, 32]],
  streets: [[-46, 46, -10, 2], [-26, -18, 2, 34], [-6, 6, 2, 34], [18, 26, 2, 34]],
  sites: { a: [-26, -26], b: [26, -26] },
  style: { roof: 'flat', windows: 'modern', tree: 'palm', floorTex: 'sand', streetTex: 'waves', landmark: 'sugarloaf', sea: true, leaf: ['#3f8f35', '#5fae43'], accent: ['#ff5a4e', '#ffd23f', '#2fb6d8', '#ffffff'] },
  look: {
    sky: [[0, '#2f7fe0'], [0.3, '#6fb3f0'], [0.46, '#c6e6f6'], [0.5, '#eef6f4'], [0.56, '#7fc6d6'], [1, '#2f8fb0']],
    fog: '#cfe8f4', fogDensity: 0.0028,
    sunDir: [0.35, 0.86, 0.38], sunColor: '#fff4dc', sunIntensity: 2.7,
    hemiSky: '#cfe6ff', hemiGround: '#d8c09a', hemiIntensity: 1.05,
    ridge: ['#4f7a6a', '#7aa092'], cloud: '#ffffff', cloudGlow: '#d8eaf4', sunGlow: '#fff6dc',
    stucco: ['#f4efe6', '#f1d9c4', '#d8eef0'], trim: ['#2a7fa8', '#e07a3f', '#3aa37a'], roof: ['#d9d2c5', '#c9c0b0', '#e0d6c8'],
    floor: '#ead7b0', street: '#f2eee6', grass: '#9cc06a', night: false,
  },
})

/** Salvador's old town: pastel colonial houses, cobblestones, a twin-towered church between the sites. */
const PELOURINHO = tactical({
  id: 'pelourinho',
  name: 'Pelourinho',
  place: 'Salvador · Brasil',
  buildings: [
    [-46, -32, 8, 30, 9, 0], [-24, -10, 6, 30, 10, 1], [10, 24, 6, 30, 10, 2], [32, 46, 8, 30, 9, 1],
    [-8, 8, -32, -18, 12, 0], [-9, -4, -18, -13, 17, 1], [4, 9, -18, -13, 17, 1],
    [-46, -40, -34, -16, 8, 2], [38, 46, -32, -12, 8, 0], [16, 22, -48, -40, 7, 1],
  ],
  cover: [
    [0, 0, 5, 5, 1.1, 3],
    [-32, -20, 5, 1.2, 1.1, 1], [-22, -30, 2, 2, 1.6, 0], [-24, -30, 2, 2, 3.2, 0], [-34, -31, 1.6, 1.6, 1.6, 0], [-27, -24, 3, 3, 2.2, 2],
    [27, -24, 2, 2, 1.6, 0], [27, -22, 2, 2, 3.2, 0], [20, -16, 4, 1.2, 1.1, 1], [33, -30, 1.6, 1.6, 1.6, 0], [22, -30, 1.4, 1.4, 1.1, 0],
    [-28, 2, 2, 2, 1.6, 0], [28, 4, 2, 2, 1.6, 0], [-14, -8, 4, 1.2, 1.1, 1], [14, -8, 4, 1.2, 1.1, 1],
    [-28, 34, 1.6, 1.6, 1.6, 0], [28, 34, 1.6, 1.6, 1.6, 0], [0, 26, 2, 2, 1.6, 0], [-14, -42, 2, 2, 1.6, 0],
  ],
  trees: [[-16, -12, 0.9], [16, -12, 0.9], [-40, 2, 1], [40, 2, 1], [-30, 44, 0.9], [30, 44, 0.9]],
  props: [[-36, -10, 'bench'], [36, -8, 'bench', Math.PI / 2], [-8, 6, 'bench'], [8, 6, 'bench']],
  lamps: [[-28, -12], [28, -10], [-6, 4], [6, -4], [-28, 20], [28, 20], [-12, -36], [12, -36]],
  streets: [[-32, -24, 6, 34], [24, 32, 6, 34], [-46, 46, -12, 4]],
  plazas: [[-12, 12, -8, 6]],
  sites: { a: [-28, -26], b: [27, -24] },
  style: { roof: 'pitched', windows: 'shutters', tree: 'round', floorTex: 'cobble', streetTex: 'cobble', landmark: 'church', accent: ['#ffffff'] },
  look: {
    sky: [[0, '#2f78d0'], [0.3, '#76b0ea'], [0.46, '#cfe2ef'], [0.5, '#f6ead2'], [0.56, '#cfd2b4'], [1, '#8a9a6a']],
    fog: '#d8e4ea', fogDensity: 0.003,
    sunDir: [-0.5, 0.78, -0.35], sunColor: '#fff0d0', sunIntensity: 2.6,
    hemiSky: '#d4e4ff', hemiGround: '#b8946a', hemiIntensity: 1.08,
    ridge: ['#86a0a8', '#aec0c6'], cloud: '#ffffff', cloudGlow: '#d0dce6', sunGlow: '#fff2d0',
    stucco: ['#f2a7b5', '#f7d66a', '#8fd1e8'], trim: ['#ffffff', '#2a5ea8', '#d94a3a'], roof: ['#b5533c', '#a5482f', '#c2603f'],
    floor: '#c9bba6', street: '#b8a993', grass: '#8fb05f', night: false,
  },
})

/** Venice at golden hour: a canal across the map with three bridges, ochre palazzi, a bell tower. */
const VENEZA = tactical({
  id: 'veneza',
  name: 'Veneza',
  place: 'Veneza · Itália',
  buildings: [
    [-46, -36, 6, 30, 11, 0], [-24, -8, 6, 30, 12, 1], [8, 22, 6, 30, 12, 2], [36, 46, 6, 30, 11, 1],
    [-10, 10, -34, -16, 10, 2], [-46, -40, -36, -14, 10, 1], [40, 46, -36, -14, 10, 0],
  ],
  water: [[-46, -34, -6, -1], [-28, -4, -6, -1], [4, 28, -6, -1], [34, 46, -6, -1]],
  cover: [
    [-30, -20, 2, 2, 1.6, 0], [-30, -18, 2, 2, 3.2, 0], [-22, -30, 4, 1.2, 1.1, 1], [-36, -28, 1.6, 1.6, 1.6, 0], [-24, -22, 3, 3, 2.2, 2],
    [26, -25, 3.2, 3.2, 1.1, 3], [32, -18, 2, 2, 1.6, 0], [20, -30, 5, 1.2, 1.1, 1], [34, -31, 1.6, 1.6, 1.6, 0],
    [-30, 4, 2, 2, 1.6, 0], [30, 4, 2, 2, 1.6, 0], [-3, 6, 1.4, 1.4, 1.1, 0], [3, -10, 2, 2, 1.6, 0], [-14, -11, 4, 1.2, 1.1, 1], [14, -11, 4, 1.2, 1.1, 1],
    [-30, 36, 5, 1.2, 1.1, 1], [30, 36, 5, 1.2, 1.1, 1], [0, 22, 2, 2, 1.6, 0], [-18, -44, 2, 2, 1.6, 0], [18, -44, 2, 2, 1.6, 0],
  ],
  trees: [[-42, -42, 0.9], [42, -42, 0.9], [-30, 44, 0.8], [30, 44, 0.8]],
  props: [[-16, -3.5, 'gondola'], [16, -3.5, 'gondola', Math.PI], [40, -3.5, 'gondola'], [-40, -3.5, 'gondola', Math.PI]],
  lamps: [[-36, 2], [-24, 2], [24, 2], [36, 2], [-6, -8], [6, -8], [-26, -12], [26, -12]],
  streets: [[-34, -28, -8, 1], [-4, 4, -8, 1], [28, 34, -8, 1], [-36, -24, 1, 34], [22, 36, 1, 34]],
  plazas: [[-8, 8, 2, 30]],
  sites: { a: [-27, -24], b: [26, -25] },
  style: { roof: 'pitched', windows: 'shutters', tree: 'round', floorTex: 'cobble', streetTex: 'tile', landmark: 'campanile', water: '#3f8f86', accent: ['#1b1b1b'] },
  look: {
    sky: [[0, '#3a4f8a'], [0.25, '#7a7fb0'], [0.4, '#e8a888'], [0.48, '#ffcf96'], [0.5, '#ffe2b4'], [0.56, '#c4a88a'], [1, '#7a6a58']],
    fog: '#f0cfa8', fogDensity: 0.0045,
    sunDir: [-0.82, 0.32, 0.45], sunColor: '#ffc88a', sunIntensity: 2.6,
    hemiSky: '#e8d0c0', hemiGround: '#8c705c', hemiIntensity: 1.0,
    ridge: ['#a88a8a', '#c8a8a0'], cloud: '#ffe0cc', cloudGlow: '#e8a890', sunGlow: '#ffd09a',
    stucco: ['#e8b98a', '#e9a48f', '#efd3a8'], trim: ['#7a3b2a', '#2f5e5a', '#a8603a'], roof: ['#a8442f', '#b8553a', '#9a3d2a'],
    floor: '#d6c6ac', street: '#c9b79a', grass: '#8a9a5a', night: false,
  },
})

/** Kyoto temple district: plaster and dark timber, vermilion torii gates, stone lanterns, cherry blossom. */
const KYOTO = tactical({
  id: 'kyoto',
  name: 'Kyoto',
  place: 'Kyoto · Japão',
  buildings: [
    [-46, -30, 10, 30, 8, 0], [-20, -8, 8, 30, 8, 1], [8, 20, 8, 30, 8, 2], [30, 46, 10, 30, 8, 1],
    [-10, 10, -34, -18, 10, 0], [-46, -38, -30, -12, 7, 2], [38, 46, -26, -8, 7, 0],
  ],
  cover: [
    [-30, -22, 2, 2, 1.6, 0], [-22, -30, 2, 2, 1.6, 0], [-22, -32, 2, 2, 3.2, 0], [-32, -32, 4, 1.2, 1.1, 1], [-26, -26, 3, 3, 1.1, 3],
    [26, -22, 3, 3, 2.2, 2], [32, -16, 2, 2, 1.6, 0], [20, -28, 5, 1.2, 1.1, 1], [33, -28, 1.6, 1.6, 1.6, 0],
    [-26, 2, 2, 2, 1.6, 0], [26, 0, 2, 2, 1.6, 0], [-12, -10, 4, 1.2, 1.1, 1], [12, -10, 4, 1.2, 1.1, 1],
    [-28, 36, 5, 1.2, 1.1, 1], [28, 36, 5, 1.2, 1.1, 1], [0, 24, 2, 2, 1.6, 0], [-18, -44, 2, 2, 1.6, 0], [18, -44, 2, 2, 1.6, 0],
  ],
  trees: [[-40, -4, 1], [40, -2, 1], [-14, 4, 0.9], [14, 4, 0.9], [-36, -40, 1], [36, -40, 1], [-28, 46, 0.9], [28, 46, 0.9]],
  props: [
    [0, 4, 'torii'], [0, -8, 'torii'], [-25, 2, 'torii'], [25, 0, 'torii'],
    [-14, -15, 'lantern'], [14, -15, 'lantern'], [-4, -15, 'lantern'], [4, -15, 'lantern'], [-34, -18, 'lantern'], [30, -32, 'lantern'],
  ],
  lamps: [[-24, -12], [24, -12], [-26, 22], [26, 22]],
  streets: [[-3, 3, -18, 34], [-30, -20, 2, 34], [20, 30, 2, 34]],
  plazas: [[-14, 14, -16, -4]],
  sites: { a: [-26, -26], b: [26, -22] },
  style: { roof: 'pitched', windows: 'modern', tree: 'cherry', floorTex: 'gravel', streetTex: 'tile', landmark: 'pagoda', leaf: ['#f2b5c8', '#f8cfdc'], accent: ['#d2382b'] },
  look: {
    sky: [[0, '#4f86c6'], [0.3, '#8fb8e0'], [0.46, '#d8e6ee'], [0.5, '#f3ece4'], [0.56, '#b8c4b0'], [1, '#6f8060']],
    fog: '#dde6ec', fogDensity: 0.0036,
    sunDir: [0.5, 0.74, 0.45], sunColor: '#fff2e2', sunIntensity: 2.4,
    hemiSky: '#d8e6ff', hemiGround: '#a89a82', hemiIntensity: 1.1,
    ridge: ['#5f7a6a', '#8aa092'], cloud: '#ffffff', cloudGlow: '#d8e2ea', sunGlow: '#fff4e4',
    stucco: ['#efe6d6', '#e8dcc6', '#d9cbb4'], trim: ['#3b2a20', '#5a3a28', '#a8332a'], roof: ['#4a4d55', '#3f4248', '#55585f'],
    floor: '#d6d2c8', street: '#bdb7aa', grass: '#7f9a5a', night: false,
  },
})

/** Marrakech medina at dusk: terracotta walls, narrow souk alleys with stalls, palms, a minaret. */
const MARRAKECH = tactical({
  id: 'marrakech',
  name: 'Marrakech',
  place: 'Marrakech · Marrocos',
  buildings: [
    [-46, -32, 6, 30, 8, 0], [-24, -8, 4, 30, 9, 1], [8, 24, 4, 30, 9, 2], [32, 46, 6, 30, 8, 1], [-3, 3, 14, 26, 7, 0],
    [-12, 12, -30, -16, 8, 1], [-46, -38, -36, -14, 8, 2], [38, 46, -36, -18, 8, 0],
  ],
  cover: [
    [-30, -22, 2, 2, 1.6, 0], [-24, -32, 2, 2, 1.6, 0], [-24, -30, 2, 2, 3.2, 0], [-34, -30, 1.6, 1.6, 1.6, 0], [-20, -22, 4, 1.2, 1.1, 1],
    [27, -26, 3.2, 3.2, 1.1, 3], [32, -20, 2, 2, 1.6, 0], [21, -32, 5, 1.2, 1.1, 1], [34, -32, 1.6, 1.6, 1.6, 0],
    [-28, 2, 2, 2, 1.6, 0], [28, 0, 2, 2, 1.6, 0], [0, -6, 4, 1.2, 1.1, 1], [-6, 8, 1.4, 1.4, 1.1, 0],
    [-28, 36, 5, 1.2, 1.1, 1], [28, 36, 5, 1.2, 1.1, 1], [-18, -44, 2, 2, 1.6, 0], [18, -44, 2, 2, 1.6, 0],
  ],
  trees: [[-20, -9, 1.1], [20, -9, 1.1], [-42, -42, 1], [42, -42, 1], [-36, 42, 1], [36, 42, 1], [-42, 0, 1]],
  props: [
    [-14, -3, 'stall'], [14, -3, 'stall', Math.PI], [-36, -6, 'stall'], [36, -6, 'stall', Math.PI], [-33, -18, 'stall', Math.PI / 2],
    [20, -18, 'stall', -Math.PI / 2], [-28, 22, 'stall', Math.PI / 2], [28, 22, 'stall', -Math.PI / 2],
  ],
  lamps: [[-6, -10], [6, -10], [-28, -10], [28, -10], [-28, 14], [28, 14]],
  streets: [[-32, -24, 4, 34], [24, 32, 4, 34], [-8, 8, 4, 34]],
  plazas: [[-24, 24, -12, 4]],
  sites: { a: [-27, -27], b: [27, -26] },
  style: { roof: 'flat', windows: 'modern', tree: 'palm', floorTex: 'sand', streetTex: 'tile', landmark: 'minaret', leaf: ['#4f8a3a', '#6aa04a'], accent: ['#e8483b', '#f2b134', '#2f8fd8', '#7a3fb0'] },
  look: {
    sky: [[0, '#40406e'], [0.25, '#8a6a8a'], [0.4, '#e89070'], [0.48, '#ffbe80'], [0.5, '#ffd8a8'], [0.56, '#c8946a'], [1, '#8a5a3a']],
    fog: '#f0c09a', fogDensity: 0.005,
    sunDir: [0.8, 0.28, 0.4], sunColor: '#ffb070', sunIntensity: 2.6,
    hemiSky: '#f0c8b0', hemiGround: '#8a5a40', hemiIntensity: 1.0,
    ridge: ['#9a6a5a', '#c08a70'], cloud: '#ffd8c0', cloudGlow: '#e89070', sunGlow: '#ffc080',
    stucco: ['#d98a5a', '#e0a070', '#c9764a'], trim: ['#2f6f8f', '#e8d6b8', '#1f8a6a'], roof: ['#c47a4f', '#b86e46', '#d08a5a'],
    floor: '#d9b48a', street: '#c48a5f', grass: '#8a9a50', night: false,
  },
})

/** New York at night: tower blocks with lit windows, an avenue of taxis, a skyline on the horizon. */
const MANHATTAN = tactical({
  id: 'manhattan',
  name: 'Manhattan',
  place: 'Nova York · EUA',
  buildings: [
    [-46, -30, 12, 32, 22, 0], [-20, -6, 12, 32, 26, 1], [6, 20, 12, 32, 24, 2], [30, 46, 12, 32, 20, 1],
    [-46, -38, -36, -14, 18, 2], [-12, 12, -32, -16, 16, 0], [38, 46, -34, -12, 18, 1],
  ],
  cover: [
    [-30, -32, 4, 1.2, 1.1, 1], [-20, -22, 2, 2, 1.6, 0], [-20, -24, 2, 2, 3.2, 0], [-33, -22, 1.6, 1.6, 1.6, 0],
    [25, -24, 3.2, 3.2, 2.2, 2], [30, -32, 1.6, 1.6, 1.6, 0], [19, -18, 4, 1.2, 1.1, 1],
    [-24, 8, 2, 2, 1.6, 0], [24, 8, 2, 2, 1.6, 0], [0, -12, 4, 1.2, 1.1, 1],
    [-28, 38, 5, 1.2, 1.1, 1], [28, 38, 5, 1.2, 1.1, 1], [0, 26, 2, 2, 1.6, 0], [-18, -44, 2, 2, 1.6, 0], [18, -44, 2, 2, 1.6, 0],
  ],
  trees: [[-24, -10, 0.8], [24, -10, 0.8]],
  props: [
    [-34, -2, 'taxi'], [14, -4, 'taxi', 0.1], [-10, 1, 'taxi', Math.PI], [36, 0, 'taxi', Math.PI], [-28, -18, 'taxi', Math.PI / 2], [22, -30, 'taxi', 0.3],
    [-16, -9, 'hydrant'], [16, -9, 'hydrant'], [-36, 10, 'hydrant'],
  ],
  lamps: [[-40, -9], [-24, 5], [-8, -9], [8, 5], [24, -9], [40, 5], [-26, -36], [26, -36], [-25, 24], [25, 24]],
  streets: [[-46, 46, -8, 4], [-30, -20, 4, 34], [-6, 6, 4, 34], [20, 30, 4, 34]],
  sites: { a: [-25, -26], b: [25, -24] },
  style: { roof: 'flat', windows: 'modern', tree: 'round', floorTex: 'tile', streetTex: 'asphalt', landmark: 'skyline', backdrop: 'towers', accent: ['#ffcc1f'] },
  look: {
    sky: [[0, '#05081a'], [0.3, '#101a3a'], [0.45, '#27325a'], [0.5, '#4a4a6e'], [0.56, '#191c2a'], [1, '#0c0e16']],
    fog: '#1a2236', fogDensity: 0.0062,
    sunDir: [-0.3, 0.8, 0.5], sunColor: '#a8b8ff', sunIntensity: 1.0,
    hemiSky: '#6a7ab4', hemiGround: '#3a342e', hemiIntensity: 1.45,
    ridge: ['#141a2c', '#1e2640'], cloud: '#4a5270', cloudGlow: '#1c2234', sunGlow: '#c0ccff',
    stucco: ['#9a8a80', '#a89c90', '#7a7472'], trim: ['#3a3d44', '#c9b38a', '#4a4f58'], roof: ['#55585f', '#4a4d55', '#5f6268'],
    floor: '#a8a4a0', street: '#4a4c52', grass: '#3e5a3a', night: true,
  },
})

/**
 * A Rio favela on a hillside (in the spirit of the classic shooter map): attackers start on the
 * street at the foot of the hill, defenders hold the top. Four terrace levels with retaining walls,
 * narrow stair alleys and a steep main ramp; brick and painted houses with slab roofs, water
 * tanks, dishes and rebar; tangled wiring on concrete poles; the city, the sea, Sugarloaf and the
 * Christ statue below. Metres (scale 1), heights in metres.
 */
const FAVELA: MapDef = {
  id: 'favela',
  name: 'Morro',
  place: 'Favela · Rio de Janeiro',
  scale: 1,
  halfX: 44,
  halfZ: 50,
  perimeter: 'invisible',
  terrain: {
    levels: [
      [-44, -14, -50, 20, 2.4], [-44, -14, -50, 4, 4.8], [-44, -14, -50, -10, 7.2], [-44, -14, -50, -28, 9.6],
      [-14, 14, -50, 16, 2.4], [-14, 14, -50, 2, 4.8], [-14, 14, -50, -14, 7.2], [-14, 14, -50, -30, 9.6],
      [14, 44, -50, 22, 2.4], [14, 44, -50, 8, 4.8], [14, 44, -50, -8, 7.2], [14, 44, -50, -26, 9.6],
    ],
    stairs: [
      [-38, -35, 20, 0, 2.4], [-22, -19, 20, 0, 2.4], [30, 33, 22, 0, 2.4],
      [-30, -27, 4, 2.4, 4.8], [6, 9, 2, 2.4, 4.8], [20, 23, 8, 2.4, 4.8], [38, 41, 8, 2.4, 4.8],
      [-40, -37, -10, 4.8, 7.2], [-6, -3, -14, 4.8, 7.2], [8, 11, -14, 4.8, 7.2], [15, 18, -8, 4.8, 7.2], [39, 42, -8, 4.8, 7.2],
      [-42, -39, -28, 7.2, 9.6], [-18, -15, -28, 7.2, 9.6], [18, 21, -26, 7.2, 9.6], [34, 37, -26, 7.2, 9.6],
    ],
    ramps: [[-4, 4, 16, 0, 2.4], [-8, -2, 2, 2.4, 4.8], [-3, 3, -30, 7.2, 9.6]],
  },
  barrierY: [0, 9.6],
  buildings: [
    // Street at the foot of the hill.
    [-44, -30, 26, 34, 6, 1], [-24, -12, 25, 32, 7, 0], [12, 24, 27, 34, 6, 2], [30, 44, 28, 36, 7, 3],
    // Terrace 1.
    [-44, -34, 8, 18, 7, 2], [-30, -20, 10, 18, 6, 0], [9.5, 13.5, 6, 14, 7, 4], [16, 24, 12, 20, 6, 1], [34, 44, 12, 20, 8, 0],
    // Terrace 2.
    [-44, -36, -5, 2, 6, 0], [-26, -16, -8, 2, 7, 3], [-13, -7, -9, 0, 8, 2], [4, 12, -10, -2, 6, 0], [38, 44, -3, 6, 7, 4],
    // Terrace 3.
    [-44, -39, -23, -12, 6, 2], [-20, -15, -23, -15, 6, 1], [-11, -4, -28, -19, 9, 0], [4, 12, -27, -18, 7, 3], [24, 32, -21, -11, 8, 0], [38, 44, -22, -12, 6, 2],
    // The top.
    [-44, -30, -46, -36, 7, 1], [-36, -26, -34, -30, 5, 4], [-26, -14, -48, -40, 6, 0], [14, 26, -48, -40, 7, 2], [32, 44, -46, -36, 6, 3],
  ],
  cover: [
    // Site A (upper west terrace).
    [-31, -16, 2, 2, 1.6, 0], [-31, -14, 2, 2, 3.2, 0], [-27, -22, 2, 2, 1.6, 0], [-35, -22, 4, 1.2, 1.1, 1],
    // Site B (middle east terrace).
    [26, 3, 2, 2, 1.6, 0], [32, -3, 2, 2, 1.6, 0], [32, -1, 2, 2, 3.2, 0], [24, -4, 1.6, 1.6, 1.6, 0],
    // Street and alleys.
    [-30, 40, 2, 2, 1.6, 0], [26, 40, 2, 2, 1.6, 0], [-12, 22, 1.6, 1.6, 1.6, 0], [18, 24, 2, 2, 1.6, 0],
    [-36, 0, 1.6, 1.6, 1.6, 0], [0, -6, 2, 2, 1.6, 0], [20, -16, 2, 2, 1.6, 0], [-2, -40, 4, 1.2, 1.1, 1], [8, -36, 2, 2, 1.6, 0],
  ],
  trees: [[0, -17, 1.2], [36, 16, 1], [-40, 26, 1], [-8, 10, 0.9]],
  props: [
    [-24, -15, 'tank'], [34, 3, 'tank'], [-6, 30, 'tank'], [19, 5, 'tank'],
    [-33, -22, 'moto', 0.4], [25, 2, 'moto', -0.6], [-8, 30, 'moto', 1.2], [10, 28, 'moto', -0.3], [-30, 4, 'moto', 1.6],
    [-16, 22, 'pole'], [6, 20, 'pole'], [26, 24, 'pole'], [18, 10, 'pole'], [0, 0, 'pole'], [-24, -10, 'pole'], [-32, 6, 'pole'],
    [4, -16, 'pole'], [28, -24, 'pole'], [-8, -34, 'pole'], [10, -34, 'pole'],
    [-18, 12, 'clothesline', Math.PI / 2], [20, -14, 'clothesline'], [-30, -32, 'clothesline'], [2, 12, 'clothesline', 0.3],
  ],
  lamps: [[-26, 22], [8, 24], [36, 24], [-14, 4], [14, 0], [-20, -12], [20, -24], [0, -36]],
  streets: [[-44, 44, 20, 50]],
  plazas: [],
  water: [],
  sites: { a: [-29, -19], b: [29, 0], half: [8, 6.5] },
  barriers: [34.5, -37.5],
  teamSpawnZ: [44, -45],
  ffaSpawns: [[-30, 42], [30, 42], [0, 44], [-30, -44], [30, -44], [0, -45]],
  hotspots: [],
  barrels: [],
  pickups: [],
  style: {
    roof: 'flat', windows: 'modern', tree: 'round', floorTex: 'concrete', streetTex: 'asphalt', landmark: 'sugarloaf',
    brick: true, favela: true, viewNorth: true, sea: true, leaf: ['#4a7f35', '#5f9a42'], accent: ['#2b5fb8', '#e8483b', '#f2c12e', '#3aa35a', '#ffffff'],
  },
  look: {
    sky: [[0, '#4a78c0'], [0.3, '#8ab0de'], [0.44, '#e8d2b8'], [0.5, '#ffd9a8'], [0.56, '#c9a888'], [1, '#7a6a52']],
    fog: '#e8cfb0', fogDensity: 0.0042,
    sunDir: [-0.55, 0.42, 0.72], sunColor: '#ffd2a0', sunIntensity: 2.6,
    hemiSky: '#d8d4e8', hemiGround: '#8a6e52', hemiIntensity: 1.05,
    ridge: ['#4f6e52', '#7a9478'], cloud: '#fff0e0', cloudGlow: '#e8b898', sunGlow: '#ffd8a8',
    stucco: ['#c97a52', '#ee9fb4', '#7fbadc', '#f2d36a', '#9fd08c'], trim: ['#8a4a30', '#ffffff', '#2a5e8a', '#c0503a', '#3a7a4a'], roof: ['#a8a29a', '#9a948c', '#b4aea4'],
    floor: '#b8b2a8', street: '#4a4a4e', grass: '#5f8a45', night: false,
  },
}

export const REAL_MAPS: Partial<Record<MapId, MapDef>> & Record<'favela' | 'copacabana' | 'pelourinho' | 'veneza' | 'kyoto' | 'marrakech' | 'manhattan', MapDef> = {
  favela: FAVELA,
  copacabana: COPACABANA,
  pelourinho: PELOURINHO,
  veneza: VENEZA,
  kyoto: KYOTO,
  marrakech: MARRAKECH,
  manhattan: MANHATTAN,
}
