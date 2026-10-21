/**
 * Browser client for the match server: typed send/receive over one WebSocket, hello handshake,
 * latency probe and a 20 Hz frame sender. Gameplay code subscribes with `on(type, fn)`.
 */
import { NET_RATE, PROTOCOL_VERSION, type ClientMessage, type PlayerFrame, type ServerMessage } from './protocol.ts'

type Handler<T extends ServerMessage['t']> = (msg: Extract<ServerMessage, { t: T }>) => void

export class NetClient {
  id = ''
  /** Smoothed round-trip time in ms. */
  rtt = 0
  private ws: WebSocket | null = null
  private readonly handlers = new Map<string, Set<(msg: ServerMessage) => void>>()
  private pingTimer = 0
  private frameTimer = 0
  private seq = 0

  /** Open the socket and complete the hello handshake. Rejects on error or protocol mismatch. */
  connect(url: string, name: string): Promise<string> {
    this.close()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      const fail = (why: string) => {
        reject(new Error(why))
        this.close()
      }
      ws.onopen = () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name })
      ws.onerror = () => fail('connection_failed')
      ws.onclose = () => this.emit({ t: 'error', code: 'bad_message', message: 'Conexão encerrada' })
      ws.onmessage = ev => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage
        } catch {
          return
        }
        if (msg.t === 'welcome') {
          this.id = msg.id
          this.pingTimer = globalThis.setInterval(() => this.send({ t: 'ping', at: Date.now() }), 2000) as unknown as number
          resolve(msg.id)
        } else if (msg.t === 'error' && msg.code === 'version') fail('version')
        else if (msg.t === 'pong') this.rtt = this.rtt ? this.rtt * 0.8 + (Date.now() - msg.at) * 0.2 : Date.now() - msg.at
        this.emit(msg)
      }
    })
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  on<T extends ServerMessage['t']>(type: T, fn: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(fn as (msg: ServerMessage) => void)
    this.handlers.set(type, set)
    return () => set.delete(fn as (msg: ServerMessage) => void)
  }

  private emit(msg: ServerMessage): void {
    for (const fn of this.handlers.get(msg.t) ?? []) fn(msg)
  }

  /** Stream the local player's state at NET_RATE; `read` returns null while dead/spectating. */
  streamFrames(read: () => Omit<PlayerFrame, 'seq'> | null): void {
    globalThis.clearInterval(this.frameTimer)
    this.frameTimer = globalThis.setInterval(() => {
      const f = read()
      if (f) this.send({ t: 'frame', f: { ...f, seq: this.seq++ } })
    }, 1000 / NET_RATE) as unknown as number
  }

  close(): void {
    globalThis.clearInterval(this.pingTimer)
    globalThis.clearInterval(this.frameTimer)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
    }
    this.ws = null
  }
}
