/**
 * Extension-side client for the dsh-vscode-bridge dsh plugin.
 * ndjson JSON-RPC 2.0 over loopback TCP; token on every request; server push
 * arrives as `bridge.event` notifications. vscode-free for testability.
 */
import { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

export interface BridgeCapabilities {
  workspaceGrouping: boolean
  sessionTitle: boolean
  sessionArchive: boolean
  presets: boolean
  permissions: boolean
  eventPush: boolean
  /** v0.1.3+: native slash commands (command.list / command.run). */
  commands?: boolean
  /** v0.1.3+: skill catalog (skill.list). */
  skills?: boolean
  /** v0.1.3+: session-log ZIP export (session.exportZip). */
  sessionExport?: boolean
}

export interface BridgeDiscoveryFile {
  port: number
  token: string
  pid: number
  protocolVersion?: number
  capabilities?: Partial<BridgeCapabilities>
  /** Host DSH version (bridge ≥ 0.2.1); absent when the plugin cannot detect it. */
  dshVersion?: string
}

export interface BridgeEvent {
  kind: string
  sessionId?: string
  event?: { type: string; seq?: number; time?: number; data?: unknown }
}

export interface BridgeHandshake {
  protocolVersion: number
  plugin: string
  version: string
  pid: number
  startedAt: number
  capabilities: BridgeCapabilities
  /** Host DSH version (bridge ≥ 0.2.1); absent when the plugin cannot detect it. */
  dshVersion?: string
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number,
    readonly dataCode?: string,
  ) { super(message) }
}

export class BridgeClient {
  private sock: Socket
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  handshake?: BridgeHandshake

  onEvent: (e: BridgeEvent) => void = () => undefined
  onClose: () => void = () => undefined

  /** Incremental UTF-8 decoding: a TCP chunk boundary may split a multibyte
   *  character (CJK session titles cross this channel), and decoding chunks
   *  independently corrupts them into replacement characters — the same fix
   *  the bridge server took in 0.3.0. */
  private decoder = new StringDecoder('utf8')

  private constructor(sock: Socket) {
    this.sock = sock
    sock.on('data', d => this.feed(this.decoder.write(d)))
    sock.on('close', () => this.handleClose())
    sock.on('error', () => undefined) // close follows
  }

  static async connect(disc: BridgeDiscoveryFile, timeoutMs = 10_000): Promise<BridgeClient> {
    const sock = new Socket()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('bridge connect timeout')) }, timeoutMs)
      sock.once('error', e => { clearTimeout(timer); reject(e) })
      sock.connect(disc.port, '127.0.0.1', () => { clearTimeout(timer); resolve() })
    })
    const client = new BridgeClient(sock)
    client.setToken(disc.token)
    // The handshake used to have no timeout: a process that accepts the TCP
    // connection but never answers (port squatting, a wedged plugin) left this
    // promise pending forever, which pinned BridgeManager.reconnecting and made
    // every later poll merge into the same dead promise.
    try {
      client.handshake = await client.request<BridgeHandshake>('bridge.handshake', undefined, 5_000)
    } catch (e) {
      client.close()
      throw e
    }
    return client
  }

  get capabilities(): BridgeCapabilities | undefined { return this.handshake?.capabilities }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    const id = ++this.nextId
    const frame = { jsonrpc: '2.0', id, method, params: params ?? {}, token: this.token }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v => { clearTimeout(timer); resolve(v as T) }) as (v: unknown) => void,
        reject: (e => { clearTimeout(timer); reject(e) }) as (e: unknown) => void,
      })
      this.sock.write(JSON.stringify(frame) + '\n')
    })
  }

  private token = ''

  /** Token is set from the discovery file before any request leaves. */
  private feed(data: string): void {
    this.buf += data
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: { code?: string } }; method?: string; params?: unknown }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new BridgeError(msg.error.message, msg.error.code, msg.error.data?.code))
        else p.resolve(msg.result)
      } else if (msg.method === 'bridge.event') {
        this.onEvent(msg.params as BridgeEvent)
      }
    }
  }

  private handleClose(): void {
    for (const [, p] of this.pending) p.reject(new BridgeError('bridge connection closed', -32000))
    this.pending.clear()
    this.onClose()
  }

  close(): void { this.sock.destroy() }

  /** Internal: set token post-construction (connect() does this before handshake). */
  setToken(token: string): void { this.token = token }
}
