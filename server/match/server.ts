/**
 * RiftStrike match server: `node server/match/server.ts` (Node ≥ 22.18 runs TypeScript directly).
 *
 * Env: PORT (default 8787), ORIGINS (comma-separated allowed browser origins; empty = any).
 * One WebSocket per player; JSON messages defined in src/net/protocol.ts.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { roomCode } from '../../src/net/lobby.ts'
import { parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol.ts'
import { Room, type Conn } from './room.ts'

const TICK = 1 / 20
/** Messages per second a single socket may send before it is dropped (frames are 20/s). */
const RATE_LIMIT = 90

export type MatchServer = { http: Server; port: number; rooms: Map<string, Room>; close(): Promise<void> }

export function startMatchServer(port = Number(process.env.PORT ?? 8787), origins = (process.env.ORIGINS ?? '').split(',').filter(Boolean)): Promise<MatchServer> {
  const rooms = new Map<string, Room>()
  const http = createServer((req, res) => {
    // Health check for hosting platforms.
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: req.url === '/health', rooms: rooms.size, protocol: PROTOCOL_VERSION }))
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
          room = new Room(code, msg.teamSize, conn)
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
  console.log(`RiftStrike match server on :${s.port} (protocol v${PROTOCOL_VERSION})`)
}
