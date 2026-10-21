/**
 * RiftStrike match server: `node server/match/server.ts` (Node ≥ 22.18 runs TypeScript directly).
 *
 * Env: PORT (default 8787), ORIGINS (comma-separated allowed browser origins; empty = any),
 * STATIC_DIR (built game to serve on the same origin; default `dist` when it exists).
 * One WebSocket per player; JSON messages defined in src/net/protocol.ts. Serving the game from
 * the same process lets a single web service (e.g. Render) host both the site and the matches.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { roomCode } from '../../src/net/lobby.ts'
import { ONLINE_MAPS, parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol.ts'
import { Room, type Conn } from './room.ts'

const TICK = 1 / 20
/** Messages per second a single socket may send before it is dropped (frames are 20/s). */
const RATE_LIMIT = 90

export type MatchServer = { http: Server; port: number; rooms: Map<string, Room>; close(): Promise<void> }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.hdr': 'application/octet-stream',
}

/** Static files from `root`; `/` and unknown extensionless paths fall back to index.html. */
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  let path: string
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    return false
  }
  let file = normalize(join(root, path))
  if (file !== root && !file.startsWith(root + sep)) return false
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) return false
    file = join(root, 'index.html')
    if (!existsSync(file)) return false
  }
  const ext = extname(file)
  // Hashed bundles never change; everything else revalidates.
  const immutable = /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
  return true
}

export function startMatchServer(
  port = Number(process.env.PORT ?? 8787),
  origins = (process.env.ORIGINS ?? '').split(',').filter(Boolean),
  staticDir = process.env.STATIC_DIR ?? (existsSync('dist/index.html') ? 'dist' : ''),
): Promise<MatchServer> {
  const rooms = new Map<string, Room>()
  const root = staticDir ? resolve(staticDir) : ''
  const http = createServer((req, res) => {
    // Health check for hosting platforms.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, protocol: PROTOCOL_VERSION }))
      return
    }
    if (root && serveStatic(root, req, res)) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  })
  const wss = new WebSocketServer({ server: http, maxPayload: 4096, verifyClient: (info: { origin: string }) => !origins.length || origins.includes(info.origin) })

  wss.on('connection', (ws: WebSocket) => {
    const id = randomUUID().slice(0, 8)
    let conn: Conn | null = null
    let room: Room | null = null
    let window0 = Date.now()
    let sent = 0
    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    }
    const leave = () => {
      if (!room) return
      room.leave(id)
      if (room.empty) rooms.delete(room.code)
      room = null
    }
    ws.on('message', data => {
      const now = Date.now()
      if (now - window0 > 1000) {
        window0 = now
        sent = 0
      }
      if (++sent > RATE_LIMIT) {
        send({ t: 'error', code: 'rate', message: 'Mensagens demais' })
        ws.close(1008, 'rate')
        return
      }
      const msg = parseClientMessage(data.toString())
      if (!msg) return send({ t: 'error', code: 'bad_message', message: 'Mensagem inválida' })
      if (!conn) {
        if (msg.t !== 'hello') return send({ t: 'error', code: 'bad_message', message: 'Envie hello primeiro' })
        if (msg.v !== PROTOCOL_VERSION) {
          send({ t: 'error', code: 'version', message: `Versão do protocolo: ${PROTOCOL_VERSION}` })
          ws.close(1002, 'version')
          return
        }
        conn = { id, name: msg.name, send }
        return send({ t: 'welcome', v: PROTOCOL_VERSION, id })
      }
      switch (msg.t) {
        case 'create': {
          leave()
          let code = roomCode(Math.random)
          while (rooms.has(code)) code = roomCode(Math.random)
          // A random map to start with; the host can change it in the lobby.
          room = new Room(code, msg.teamSize, conn, ONLINE_MAPS[Math.floor(Math.random() * ONLINE_MAPS.length)])
          rooms.set(code, room)
          return
        }
        case 'join': {
          const target = rooms.get(msg.code)
          if (!target) return send({ t: 'error', code: 'no_room', message: 'Sala não encontrada' })
          leave()
          const err = target.join(conn)
          if (err) return send({ t: 'error', code: err, message: err === 'in_match' ? 'Partida em andamento' : 'Sala cheia' })
          room = target
          return
        }
        case 'leave':
          return leave()
        case 'hello':
          return
        default:
          room?.handle(id, msg)
      }
    })
    ws.on('close', leave)
  })

  const timer = setInterval(() => {
    for (const r of rooms.values()) r.tick(TICK)
  }, TICK * 1000)

  return new Promise(resolve => {
    http.listen(port, () => {
      const addr = http.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        http,
        port: actual,
        rooms,
        close: () =>
          new Promise<void>(done => {
            clearInterval(timer)
            for (const c of wss.clients) c.terminate()
            wss.close(() => http.close(() => done()))
          }),
      })
    })
  })
}

// Run directly: `node server/match/server.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startMatchServer()
  const site = process.env.STATIC_DIR ?? (existsSync('dist/index.html') ? 'dist' : '')
  console.log(`RiftStrike match server on :${s.port} (protocol v${PROTOCOL_VERSION})${site ? `, serving ${site}/` : ''}`)
}
