/**
 * Thin, vscode-free ACP client for `dsh --profile acp`.
 * One process + one connection multiplexes many sessions.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { LaunchSpec } from '../launcher/types.js'
import pkg from '../../package.json'

/**
 * Best-effort human-readable text for an ACP failure. The SDK reconstructs
 * server-side `RequestError`s with the generic wire message ("Internal error")
 * and parks the server's real detail string under `data.details` — surface it.
 */
export function acpErrorText(e: unknown): string {
  const err = e as { message?: unknown; data?: unknown } | undefined
  const message = typeof err?.message === 'string' ? err.message : String(e)
  const data = err?.data as { details?: unknown } | undefined
  if (typeof data?.details === 'string' && data.details && (message === 'Internal error' || message === '')) return data.details
  return message
}

export interface AcpClientHandlers {
  /** Every session/update notification, dispatched by sessionId upstream. */
  onUpdate: (n: acp.SessionNotification) => void
  /** Permission prompts from the agent; must settle exactly once. */
  onPermission: (r: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>
  /** Process/connection lifecycle. */
  onLog?: (line: string) => void
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void
}

export class AcpClient {
  private constructor(
    private conn: acp.ClientConnection,
    private proc: ChildProcess,
  ) {}

  get closed(): Promise<void> { return this.conn.closed }
  get isClosed(): boolean { return this.conn.signal.aborted }

  static async start(spec: LaunchSpec, h: AcpClientHandlers, opts?: { timeoutMs?: number }): Promise<AcpClient> {
    const proc = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      shell: spec.shell ?? false,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Keep a bounded stderr tail for post-mortem diagnostics.
    let stderrTail = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const s = String(d)
      h.onLog?.(s)
      stderrTail = (stderrTail + s).slice(-8192)
    })

    const app = acp
      .client({ name: 'dsh-vscode' })
      .onRequest(acp.CLIENT_METHODS.session_request_permission, ({ params }) => h.onPermission(params))
      .onNotification(acp.CLIENT_METHODS.session_update, ({ params }) => h.onUpdate(params))

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    )
    const conn = app.connect(stream)
    proc.on('exit', (code, signal) => h.onExit?.({ code, signal, stderrTail }))
    conn.closed.catch(() => undefined) // handled via onExit / isClosed

    const client = new AcpClient(conn, proc)

    // Race the handshake against a timeout and an early process exit, so a
    // dead-on-arrival agent (bad command, missing node, wrong distro) fails
    // fast with actionable diagnostics instead of hanging the UI.
    const timeoutMs = opts?.timeoutMs ?? 60_000
    const init = conn.agent.request(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-vscode', version: pkg.version },
    })
    const outcome = await Promise.race([
      init.then(r => ({ ok: true as const, r })),
      new Promise<{ ok: false; reason: string }>(res => {
        const timer = setTimeout(() => res({ ok: false, reason: `no response within ${timeoutMs / 1000}s` }), timeoutMs)
        init.finally(() => clearTimeout(timer)).catch(() => undefined)
        proc.once('exit', (code, signal) => res({ ok: false, reason: `process exited during startup (code=${code ?? signal})` }))
      }),
    ])
    if (!('ok' in outcome) || !outcome.ok) {
      const reason = 'reason' in outcome ? outcome.reason : 'handshake failed'
      try { conn.close() } catch { /* noop */ }
      if (proc.exitCode === null) proc.kill('SIGTERM')
      const tail = stderrTail.trim().slice(-600)
      const npxHint = /\bnpx\b/.test(spec.args.join(' ')) || /\bnpx\b/.test(spec.command)
        ? '\nHint: first-time `npx @deepseek-ai/dsh` downloads the package and can exceed the timeout; install it once (npm i -g @deepseek-ai/dsh) or point dsh.command at a repo checkout.'
        : ''
      throw new Error(`dsh ACP startup failed: ${reason}.${tail ? `\n--- stderr ---\n${tail}` : ''}\n(spawned: ${spec.command} ${spec.args.join(' ')})${npxHint}`)
    }
    client.agentInfo = outcome.r.agentInfo ?? undefined
    client.agentCapabilities = outcome.r.agentCapabilities ?? undefined
    return client
  }

  agentInfo?: acp.Implementation
  agentCapabilities?: acp.AgentCapabilities

  newSession(cwd: string, mcpServers: acp.McpServer[] = []): Promise<acp.NewSessionResponse> {
    return this.conn.agent.request(acp.AGENT_METHODS.session_new, { cwd, mcpServers })
  }

  listSessions(cwd?: string, cursor?: string): Promise<acp.ListSessionsResponse> {
    return this.conn.agent.request(acp.AGENT_METHODS.session_list, { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) })
  }

  resumeSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[] = []): Promise<acp.ResumeSessionResponse> {
    return this.conn.agent.request(acp.AGENT_METHODS.session_resume, { sessionId, cwd, mcpServers })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.conn.agent.request(acp.AGENT_METHODS.session_close, { sessionId })
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
    return this.conn.agent.request(acp.AGENT_METHODS.session_set_config_option, { sessionId, configId, value })
  }

  prompt(sessionId: string, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.conn.agent.request(acp.AGENT_METHODS.session_prompt, { sessionId, prompt: blocks })
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn.agent.notify(acp.AGENT_METHODS.session_cancel, { sessionId })
  }

  dispose(): void {
    try { this.conn.close() } catch { /* already closed */ }
    const pid = this.proc.pid
    if (this.proc.exitCode !== null || pid === undefined) return
    if (process.platform === 'win32') {
      // The launch spec goes through `cmd.exe /c`, so the real dsh is a CHILD of
      // the process we spawned. Killing cmd.exe leaves that child running, and a
      // surviving dsh keeps the session write lock — which is exactly what
      // produces "会话 xxx 正被另一个 dsh 实例占用" after a window reload.
      // taskkill /T walks the whole tree.
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        this.proc.kill('SIGTERM')
      }
      return
    }
    this.proc.kill('SIGTERM')
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill('SIGKILL') }, 3000).unref()
  }
}
