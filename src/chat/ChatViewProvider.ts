/**
 * Sidebar chat webview host: current session, prompt assembly with editor
 * context and images, permission brokering, transcript persistence, reconnect
 * recovery. ACP plumbing lives in AcpService.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import type { SessionConfigOption, ContentBlock, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AcpService } from '../acp/service.js'
import type { TranscriptStore } from './TranscriptStore.js'
import type { ChangedFilesTracker } from './ChangedFilesTracker.js'
import type { BridgeManager } from '../bridge/manager.js'
import type { BridgeError, BridgeEvent } from '../bridge/client.js'
import type { ContextChip, ToHost, ToWebview } from '../shared/messages.js'
import type { ChatMessage } from '../shared/chat.js'
import { autoAttachActiveFile, readConfig } from '../config.js'
import { formatUsage } from '../shared/usage.js'
import { chooseEffort, collectEffortDefaults, flattenOptions, findModelOption, modelIdOf } from '../shared/model.js'
import { acpErrorText } from '../acp/client.js'
import { importDshTranscript } from './sessionHistory.js'
import { runTargetShell } from '../launcher/runTargetShell.js'
import { parse as parseYaml } from 'yaml'
import { deleteSessionData } from '../launcher/runTargetShell.js'

export interface ActiveSession { id: string; busy: boolean; configOptions: SessionConfigOption[]; generation: number }

/** dsh persists one writer per session: a session open in another live process
 *  (Web/Desktop UI, a second VS Code window) holds a write lock, and resuming
 *  it here fails with this signature (surfaced via the ACP error's data.details). */
function isLockContention(e: unknown): boolean {
  return /already owned by an active write handle/.test(acpErrorText(e))
}

function lockContentionError(sessionId: string): Error {
  return new Error(`会话 ${sessionId.slice(0, 8)} 正被另一个 dsh 实例占用（可能在 Web/Desktop 端打开中）。请先在对端关闭该会话，或稍后再试。`)
}

/** Same-side Windows has no POSIX shell, so `deleteSessionData()` (a bash
 *  script driven through the target shell) always throws there. Remove the
 *  persisted session directory directly instead: $DSH_HOME/sessions/<workspace>/
 *  <session dir>, with the dir named either `<id>` or `session-<id>`.
 *  Returns the removed paths (empty when nothing matched). */
async function deleteSessionDataOnWindows(sessionId: string): Promise<string[]> {
  const { promises: fs } = await import('node:fs')
  const os = await import('node:os')
  const dshHome = readConfig().env['DSH_HOME'] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const root = path.join(dshHome, 'sessions')
  const plain = sessionId.replace(/^session-/, '')
  const wanted = new Set([sessionId, plain, `session-${plain}`])
  const removed: string[] = []
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const workspaceDir = path.join(root, d.name)
    const children = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => [])
    for (const c of children) {
      if (!c.isDirectory() || !wanted.has(c.name)) continue
      const target = path.join(workspaceDir, c.name)
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      removed.push(target)
    }
  }
  return removed
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  /** Set by the webview's post-mount 'ready' message: gates the startup
   *  session kickoff so a session is only created after the panel has
   *  rendered — at window startup VS Code resolves a restored view long
   *  before its bundle paints, and agent-ready used to win that race. */
  private webviewRendered = false
  private session?: ActiveSession
  private pendingPermissions = new Map<string, (r: { optionId: string | null }) => void>()
  private chips: ContextChip[] = []
  private pendingImages: { name: string; mimeType: string; data: string }[] = []
  private disposables: vscode.Disposable[] = []

  private readonly _onDidChangeSession = new vscode.EventEmitter<ActiveSession | undefined>()
  readonly onDidChangeSession = this._onDidChangeSession.event

  constructor(
    private ctx: vscode.ExtensionContext,
    private service: AcpService,
    private transcripts: TranscriptStore,
    private tracker: ChangedFilesTracker,
    private bridge: BridgeManager,
    private getLauncher: () => import('../launcher/types.js').Launcher,
    private out: vscode.OutputChannel,
  ) {
    this.failedPresets = new Set(this.ctx.globalState.get<string[]>('dsh.brokenPresets', []))
    service.setPermissionResponder(r => this.brokerPermission(r))
    this.disposables.push(service.onUpdate(n => {
      this.post({ type: 'update', sessionId: n.sessionId, update: n.update })
      void this.tracker.ingestUpdate(n.sessionId, n.update)
      if (n.update.sessionUpdate === 'usage_update') {
        const text = formatUsage(n.update.used ?? 0, n.update.size ?? 0)
        this.recordUsage(n.sessionId, text)
        if (n.sessionId === this.session?.id) {
          this.usageText = text
          this.post({ type: 'usage', sessionId: n.sessionId, text })
          this._onDidChangeSession.fire(this.session)
        }
      }
    }))
    this.disposables.push(service.onState(e => {
      this.post({ type: 'connectionState', state: e.state, detail: e.detail })
      if (e.state === 'ready') {
        void this.pushSessions()
        // Startup kickoff restores the previous session or creates an eager
        // one, so rail pickers (model/effort/…) light up before the first
        // prompt. Gated on the rendered panel, not just view resolution:
        // creating the session the moment the agent boots makes the window
        // startup restore path spawn it behind a still-blank webview.
        if (this.webviewRendered) void this.kickoffSession()
      }
    }))
    this.disposables.push(tracker.onDidChange(({ sessionId, files }) => {
      if (sessionId === this.session?.id) this.post({ type: 'changedFiles', sessionId, files })
    }))
    this.disposables.push(bridge.onState(({ state, capabilities }) => {
      this.post({ type: 'bridge', on: state === 'on', capabilities })
      if (state === 'on') {
        // New bridge connection: workspace attaches are per-process, re-issue them.
        this.workspaceAttached.clear()
        this.workspaceAttachUnsupported = false
        void this.pushSessions()
        void this.bridgeAttach()
      } else if (state === 'off') {
        this.post({ type: 'nativeCommands', commands: [] })
        this.post({ type: 'skills', skills: [] })
        void this.pushSessions()
      }
    }))
    this.disposables.push(bridge.onEvent(e => this.onBridgeEvent(e)))
  }

  /** Sessions already filed into a workspace on this bridge connection. */
  private workspaceAttached = new Set<string>()
  /** Set when the connected bridge predates v0.1.2 (no workspace.attach method). */
  private workspaceAttachUnsupported = false

  /** File the session into its workspace through the bridge (dsh-vscode-bridge
   *  ≥ 0.1.2), so ACP-created sessions appear in workspace.list sessionIds
   *  immediately instead of staying "ungrouped" until the next registry sweep. */
  private async bridgeWorkspaceAttach(sessionId: string): Promise<void> {
    if (!this.bridge.isOn || this.workspaceAttachUnsupported) return
    if (this.bridge.capabilities?.workspaceGrouping !== true) return
    if (this.workspaceAttached.has(sessionId)) return
    try {
      const res = await this.bridge.client!.request<{ attached: boolean; workspaceId?: string; reason?: string }>('workspace.attach', { sessionId })
      this.workspaceAttached.add(sessionId)
      this.out.appendLine(res.attached
        ? `[dsh] workspace.attach: ${sessionId.slice(0, 8)} → ${res.workspaceId ?? 'workspace'}`
        : `[dsh] workspace.attach skipped for ${sessionId.slice(0, 8)}: ${res.reason ?? 'no reason given'}`)
      void this.pushSessions()
    } catch (e) {
      if ((e as { rpcCode?: number }).rpcCode === -32601) {
        this.workspaceAttachUnsupported = true
        this.out.appendLine('[dsh] bridge has no workspace.attach (needs dsh-vscode-bridge ≥ 0.1.2)')
      } else {
        this.out.appendLine(`[dsh] workspace.attach failed: ${(e as Error).message}`)
      }
    }
  }

  /** After the bridge comes up (or the session changes): subscribe + load preset/permission. */
  private bridgeAttachedSession?: string
  private async bridgeAttach(): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    const c = this.bridge.client!
    const id = this.session.id
    if (this.bridgeAttachedSession !== id) {
      await c.request('session.unsubscribe').catch(() => undefined)
      await c.request('session.subscribe', { sessionId: id }).catch(() => undefined)
      this.bridgeAttachedSession = id
    }
    await this.bridgeWorkspaceAttach(id)
    const caps = this.bridge.capabilities
    await this.pushNativeCommands()
    if (caps?.skills) {
      const sk = await c.request<{ skills: { name: string; description?: string; whenToUse?: string }[] }>('skill.list', { sessionId: id }).catch(() => undefined)
      if (sk) this.post({ type: 'skills', skills: sk.skills })
    }
    if (caps?.presets) {
      const [list, cur] = await Promise.all([
        // `broken` crosses the wire as the upstream reason string (never a
        // boolean); local marks added by presetsWithMarks stay boolean|string.
        c.request<{ presets: { id: string; name?: string; isDefault?: boolean; broken?: string }[] }>('preset.list').catch(() => undefined),
        c.request<{ preset: string | null }>('preset.current', { sessionId: id }).catch(() => undefined),
      ])
      if (list) { this.lastPresets = list.presets; this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur?.preset ?? null }) }
    }
    if (caps?.permissions) {
      const perm = await c.request<{ options: { value: string; name: string; description?: string }[]; current?: string }>('permission.get', { sessionId: id }).catch(() => undefined)
      if (perm) this.post({ type: 'permission', options: perm.options, current: perm.current })
    }
  }

  private onBridgeEvent(e: BridgeEvent): void {
    if (e.kind !== 'session/event' || !e.event) return
    const { type, data } = e.event
    if (e.sessionId !== this.session?.id && type !== 'session/title') return
    if (type === 'session/title') {
      void this.pushSessions()
    } else if (type === 'todo/write' && data && typeof data === 'object' && Array.isArray((data as { todos?: unknown }).todos)) {
      this.post({ type: 'todo', todos: (data as { todos: { content: string; status: string }[] }).todos })
    } else if (type === 'plan/mode' && data && typeof data === 'object') {
      this.post({ type: 'planMode', active: !!(data as { active?: boolean }).active })
    } else if (type === 'permission/preset' || type === 'sandbox/mode' || type === 'approval/policy') {
      const id = this.session?.id
      if (id && this.bridge.capabilities?.permissions) {
        void this.bridge.client!.request<{ options: { value: string; name: string }[]; current?: string }>('permission.get', { sessionId: id })
          .then(perm => this.post({ type: 'permission', options: perm.options, current: perm.current }))
          .catch(() => undefined)
      }
    } else if (type === 'agent-preset/selected') {
      const id = this.session?.id
      if (id && this.bridge.capabilities?.presets) {
        void this.bridge.client!.request<{ preset: string | null }>('preset.current', { sessionId: id })
          .then(cur => this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur.preset }))
          .catch(() => undefined)
      }
      void this.pushNativeCommands()
    }
  }

  private lastPresets: { id: string; name?: string; isDefault?: boolean; broken?: boolean | string }[] = []

  usageText?: string

  /** Last known context-usage text per session (persisted across window reloads). */
  private usageCache?: Map<string, string>
  private usageMap(): Map<string, string> {
    this.usageCache ??= new Map(Object.entries(this.ctx.workspaceState.get<Record<string, string>>('dsh.usageBySession', {})))
    return this.usageCache
  }
  private recordUsage(sessionId: string, text: string): void {
    const map = this.usageMap()
    map.delete(sessionId) // refresh recency order
    map.set(sessionId, text)
    while (map.size > 50) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    void this.ctx.workspaceState.update('dsh.usageBySession', Object.fromEntries(map))
  }
  private forgetUsage(sessionId: string): void {
    if (this.usageMap().delete(sessionId)) {
      void this.ctx.workspaceState.update('dsh.usageBySession', Object.fromEntries(this.usageMap()))
    }
  }

  get activeSessionId(): string | undefined { return this.session?.id }
  activeConfigOptions(): SessionConfigOption[] | undefined { return this.session?.configOptions }

  // ---------- webview plumbing ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m))
    view.onDidDispose(() => { this.view = undefined; this.webviewRendered = false })
    // Auto-start the agent as soon as the view is opened (Codex-style lazy boot).
    this.post({ type: 'connectionState', state: this.service.isReady ? 'ready' : 'starting' })
    this.service.ensureClient().catch(e => this.out.appendLine(`[dsh] auto-start failed: ${(e as Error).message}`))
  }

  /** Editor-area surface (ChatPanel). When present it receives the stream too:
   *  the panel and the sidebar share one agent session, so both stay coherent
   *  and whichever the user typed in keeps working. */
  private panelWebview?: vscode.Webview

  attachPanel(webview: vscode.Webview): void { this.panelWebview = webview }
  detachPanel(): void { this.panelWebview = undefined }

  /** Public re-exports for ChatPanel (the logic stays owned here). */
  panelHtml(webview: vscode.Webview): string { return this.html(webview) }
  panelOnMessage(m: ToHost): Promise<void> { return this.onMessage(m) }

  private post(m: ToWebview): void {
    void this.view?.webview.postMessage(m)
    void this.panelWebview?.postMessage(m)
  }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'))
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.css'))
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`
  }

  /** Whether the current session has produced any prompt activity (empty sessions are reused). */
  private sessionHasActivity = false

  private setSession(s: ActiveSession | undefined, resumed = false): void {
    // Restore the last known usage for the session so the status bar and the
    // webview rail show it before the next usage_update arrives.
    this.usageText = s ? this.usageMap().get(s.id) : undefined
    this.sessionHasActivity = false
    this.session = s
    void this.ctx.workspaceState.update('dsh.activeSessionId', s?.id)
    this._onDidChangeSession.fire(s)
    if (s) {
      this.post({ type: 'sessionStarted', sessionId: s.id, configOptions: s.configOptions, resumed })
      this.post({ type: 'usage', sessionId: s.id, text: this.usageText })
    } else {
      this.post({ type: 'sessionEnded' })
    }
  }

  /** ensureSession races are data-losing: a prompt overlapping a re-attach
   *  (reconnect, startup kickoff) used to either recreate the session or adopt
   *  it mid-activation — before the server had it in its session map, so the
   *  prompt then failed with "unknown session". Serialize the whole operation. */
  private ensureLock: Promise<unknown> = Promise.resolve()
  private ensureSession(): Promise<ActiveSession> {
    const run = this.ensureLock.then(() => this.ensureSessionInner())
    this.ensureLock = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureSessionInner(): Promise<ActiveSession> {
    // Loop instead of recursing into ensureSession() — re-entering it here
    // would chain onto our own lock and deadlock.
    for (;;) {
      // resume()/newSession() mutate this.session under the switch lock, NOT
      // the ensure lock, so the session can be swapped beneath any await below.
      // Pin the entry reference and re-validate identity after every RPC; an
      // overtaken operation closes its duplicate and re-evaluates.
      const target = this.session
      if (target) {
        if (target.generation === this.service.generation) return target
        // Agent restarted: in-process sessions died with it, but dsh persists them.
        // Re-attach via resume; fall back to a fresh session if persistence lacks it.
        try {
          const before = target.configOptions
          const res = await this.service.resumeSession(target.id)
          if (this.session !== target) {
            await this.service.closeSession(target.id).catch(() => undefined)
            continue
          }
          // Read the generation AFTER the await: the resume above may have
          // completed a client restart that bumped it mid-flight.
          this.session = { ...target, generation: this.service.generation, configOptions: res.configOptions ?? before }
          this.out.appendLine(`[dsh] re-attached session ${target.id.slice(0, 8)} after restart`)
          this.post({ type: 'sessionStarted', sessionId: target.id, configOptions: this.session.configOptions, resumed: true })
          await this.restoreSelection(before).catch(e => this.out.appendLine(`[dsh] restoring selection after restart failed: ${acpErrorText(e)}`))
          return this.session
        } catch (e) {
          if (this.session !== target) continue // a switch overtook us; the error is irrelevant now
          // "already active" means the session is live in the CURRENT process —
          // the generation mismatch was stale bookkeeping (e.g. a session created
          // while the client was still starting), not a restart. Adopt it as-is:
          // recreating would silently drop a blank session's model/effort picks.
          if (/already active/.test(acpErrorText(e))) {
            this.out.appendLine(`[dsh] session ${target.id.slice(0, 8)} is already active in-process; adopting`)
            this.session = { ...target, generation: this.service.generation }
            return this.session
          }
          // Lock contention means another dsh instance (e.g. the Web UI) owns the
          // session's write handle. Do not "start fresh" here — the pending
          // prompt would silently land in a new default-configured session.
          if (isLockContention(e)) throw lockContentionError(target.id)
          this.out.appendLine(`[dsh] resume after restart failed (${acpErrorText(e)}); starting fresh`)
          this.setSession(undefined)
        }
        continue // re-evaluate after setSession(undefined)
      }
      const res = await this.service.newSession()
      if (this.session) {
        // A session switch overtook the creation: drop the duplicate.
        await this.service.closeSession(res.sessionId).catch(() => undefined)
        continue
      }
      // Stamp the generation AFTER the await: a first-time call completes the
      // client's startup (generation increments) inside it; reading it before the
      // await pins a stale generation, and the next ensureSession() would then
      // take the re-attach path for no reason.
      const created: ActiveSession = { id: res.sessionId, busy: false, configOptions: res.configOptions ?? [], generation: this.service.generation }
      this.setSession(created)
      void this.tracker.startSession(res.sessionId)
      void this.bridgeWorkspaceAttach(res.sessionId)
      void this.bridgeAttach()
      // Awaited so "session ready" means "selection settled": a prompt sent right
      // after creation must not snapshot the default route before the replay lands.
      await this.applyRememberedSelection().catch(e => this.out.appendLine(`[dsh] applying remembered model failed: ${acpErrorText(e)}`))
      if (this.session !== created) continue // switched away mid-replay
      return created
    }
  }

  // ---------- message handling ----------

  private async onMessage(m: ToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.webviewRendered = true
          const logoSource = this.panelWebview ?? this.view?.webview
          const logoUri = logoSource ? logoSource.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'dsh-logo.svg')).toString() : undefined
          this.post({ type: 'bootstrap', topology: this.getLauncher().label, workspaceName: vscode.workspace.workspaceFolders?.[0]?.name, logoUri })
          // 'starting', not 'closed': the webview's ready message arrives after
          // resolveWebviewView has already kicked off the agent, and the ACP
          // 'starting' event fires before the webview listens. Reporting 'closed'
          // here painted a red dot + "not connected" + a reconnect button for the
          // entire cold-start window (npx can take 10-60s on first run).
          this.post({ type: 'connectionState', state: this.service.isReady ? 'ready' : 'starting' })
          this.post({ type: 'capabilities', image: this.service.imageCapable })
          this.post({ type: 'chips', chips: this.chips })
          this.postImageChips()
          if (this.session) {
            this.post({ type: 'sessionStarted', sessionId: this.session.id, configOptions: this.session.configOptions })
            this.post({ type: 'usage', sessionId: this.session.id, text: this.usageText })
            void this.sendTranscript(this.session.id)
          }
          void this.pushSessions()
          // Restore the last active session across extension-host restarts
          // (Reload Window kills memory); creates one only when nothing resumes.
          void this.kickoffSession()
          return
        case 'prompt': return await this.onPrompt(m.text)
        case 'cancel': return this.session ? await this.service.cancel(this.session.id) : undefined
        case 'newSession': return await this.newSession()
        case 'selectConfig': return await this.onSelectConfig(m.configId, m.value)
        case 'commandPicker': return await this.onCommandPicker(m.kind)
        case 'runCommand': return await this.onRunCommand(m.line)
        case 'exportSession': return await this.onExportSession()
        case 'permissionResponse': return this.onPermissionResponse(m.requestId, m.optionId)
        case 'persistTranscript': return await this.transcripts.save(m.sessionId, m.messages)
        case 'removeChip':
          this.chips = this.chips.filter(c => c.path !== m.path)
          this.post({ type: 'chips', chips: this.chips })
          return
        case 'addChip':
          if (!this.chips.some(c => c.path === m.path)) this.chips.push({ path: m.path, label: m.label })
          this.post({ type: 'chips', chips: this.chips })
          return
        case 'listSessions': return await this.pushSessions()
        case 'resumeSession': return await this.resume(m.sessionId)
        case 'reconnect': return await this.onReconnect()
        case 'renameSession': return await this.onRenameSession(m.sessionId, m.title)
        case 'deleteSession': return await this.onDeleteSession(m.sessionId)
        case 'selectPreset': return await this.onSelectPreset(m.presetId)
        case 'setPermission': return await this.onSetPermission(m.name)
        case 'pickImages': return await this.onPickImages()
        case 'pasteImage':
          this.pendingImages.push({ name: m.name, mimeType: m.mimeType, data: m.data })
          return this.postImageChips()
        case 'removeImage':
          this.pendingImages.splice(m.index, 1)
          return this.postImageChips()
        case 'fileSearch': return await this.onFileSearch(m.reqId, m.query)
        case 'openDiff': {
          const f = this.tracker.filesFor(this.session?.id ?? '').find(x => x.path === m.path)
          return await this.tracker.openDiff(f ?? { path: m.path, label: m.path, kind: 'modified' })
        }
      }
    } catch (e) {
      const msg = acpErrorText(e)
      this.post({ type: 'error', message: msg })
      // A failed REQUEST (e.g. switching to a session locked by another dsh
      // instance, or an unknown slash command) is not a dropped connection:
      // reflect the state the service actually has instead of forcing the
      // indicator red — the webview has no other way back from a stale 'closed'.
      this.post({ type: 'connectionState', state: this.service.isReady ? 'ready' : 'closed', detail: msg.split('\n')[0] })
      if (this.session) { this.session.busy = false; this.post({ type: 'busy', busy: false }) }
      // The server forgot the session without a connection drop (e.g. a plugin
      // hot-reload): mark it stale so the next ensureSession re-attaches from
      // persistence instead of failing with "unknown session" forever.
      if (this.session && /unknown session/.test(msg)) {
        this.session = { ...this.session, generation: -1 }
      }
      this.out.appendLine(`[dsh] error: ${msg}`)
      const choice = await vscode.window.showErrorMessage(`DSH: ${msg.split('\n')[0]}`, 'Open DSH Log')
      if (choice) this.out.show()
    }
  }

  // ---------- prompt ----------

  private async onPrompt(text: string): Promise<void> {
    // Optimistic busy the moment the prompt is accepted: the first prompt of a
    // cold session waits out the ACP handshake (npx can take tens of seconds),
    // and without this the user saw their bubble appear with no Working… line
    // and a still-enabled send button, so they pressed Enter again.
    this.post({ type: 'busy', busy: true })
    let settled = false
    try {
      // Wait out an in-flight startup restore first: otherwise ensureSession()
      // would create a fresh session that the still-running resume() then
      // closes and replaces, silently dropping this prompt's session.
      await this.kickoff?.catch(() => undefined)
      const session = await this.ensureSession()
    this.sessionHasActivity = true
    if (session.busy) throw new Error('A prompt is already running — cancel it first.')
    const mapper = this.getLauncher().paths
    const blocks: ContentBlock[] = []
    const chipBlocks = async (chip: ContextChip): Promise<void> => {
      const dshPath = await mapper.toDsh(chip.path)
      blocks.push({ type: 'resource_link', uri: `file://${dshPath}`, name: chip.label })
      if (chip.selection) blocks.push({ type: 'text', text: `Relevant selection in ${chip.label}: lines ${chip.selection.startLine}-${chip.selection.endLine}.` })
    }
    for (const chip of this.chips) await chipBlocks(chip)
    if (autoAttachActiveFile()) {
      const chip = this.activeEditorChip()
      if (chip && !this.chips.some(c => c.path === chip.path)) await chipBlocks(chip)
    }
    if (this.pendingImages.length > 0) {
      if (this.service.imageCapable) {
        for (const img of this.pendingImages) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
      } else {
        this.post({ type: 'error', message: 'This dsh route does not accept image prompts (image capability is off).' })
      }
    }
    blocks.push({ type: 'text', text })
    this.chips = []
    this.pendingImages = []
    this.post({ type: 'chips', chips: [] })
    this.postImageChips()

    session.busy = true
    this.post({ type: 'busy', busy: true })
    this._onDidChangeSession.fire(session)
    this.tracker.promptStarted(session.id)
    try {
      const res = await this.service.prompt(session.id, blocks)
      settled = true
      this.post({ type: 'promptSettled', sessionId: session.id, stopReason: res.stopReason })
    } finally {
      session.busy = false
      this.post({ type: 'busy', busy: false })
      this._onDidChangeSession.fire(session)
      void this.pushSessions()
      void this.tracker.promptSettled(session.id)
    }
  } catch (e) {
    // Any failure before the prompt reaches the agent (a competing prompt,
    // ensureSession failure, a rejected preamble) must clear the optimistic
    // busy flag, otherwise the composer stays disabled until the next event.
    if (!settled) this.post({ type: 'busy', busy: false })
    throw e
  }
  }

  // ---------- sessions ----------

  /** Session switches race (auto-restore vs clicks): serialize them. */
  private switchLock: Promise<void> = Promise.resolve()
  private withSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.switchLock.then(fn, fn)
    this.switchLock = next.then(() => undefined, () => undefined)
    return next
  }

  /** Startup session kickoff: resume the previously active session when dsh still
   *  has it; only create a fresh session when there is nothing to resume. Without
   *  this every launch stacked another empty session (the eager-create path raced
   *  the webview restore path and usually won). Deduped while in flight; the
   *  switch lock inside resume() serializes against user-initiated switches. */
  private kickoff?: Promise<void>
  private kickoffSession(): Promise<void> {
    this.kickoff ??= (async () => {
      try {
        if (this.session) return
        const persisted = this.ctx.workspaceState.get<string>('dsh.activeSessionId')
        if (persisted) {
          // A write-lock loser must NOT lose the pointer: the session is alive in
          // another dsh instance (Desktop / Web / a second window) and becomes
          // resumable the moment that instance lets go. Dropping it here is what
          // made every reopen look like a fresh connect.
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await this.resume(persisted)
              return
            } catch (e) {
              if (!isLockContention(e)) {
                this.out.appendLine(`[dsh] startup restore of ${persisted.slice(0, 8)} failed: ${acpErrorText(e)}`)
                void this.ctx.workspaceState.update('dsh.activeSessionId', undefined)
                break
              }
              this.out.appendLine(`[dsh] ${persisted.slice(0, 8)} held elsewhere (attempt ${attempt + 1}/3) — retrying`)
              await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
              if (this.session) return
            }
          }
          // Still locked: keep the id so a later reload can pick it back up, but
          // don't block the UI on a session we cannot have yet.
          if (this.session) return
        }
        if (!this.session) await this.ensureSession()
      } catch (e) {
        this.out.appendLine(`[dsh] startup session kickoff failed: ${(e as Error).message}`)
      } finally {
        this.kickoff = undefined
      }
    })()
    return this.kickoff
  }

  async newSession(): Promise<void> {
    return this.withSwitchLock(async () => {
      // Reuse an untouched session instead of stacking empty ones.
      if (this.session && !this.sessionHasActivity) {
        this.out.appendLine('[dsh] current session is empty — reusing it instead of creating another')
        return
      }
      if (this.session) await this.service.closeSession(this.session.id).catch(() => undefined)
      this.setSession(undefined)
      await this.ensureSession()
      void this.pushSessions()
    })
  }

  async resume(sessionId: string): Promise<void> {
    return this.withSwitchLock(async () => {
      if (this.session?.id === sessionId) return
      const previous = this.session
      let configOptions: SessionConfigOption[]
      try {
        const res = await this.service.resumeSession(sessionId)
        configOptions = res.configOptions ?? []
      } catch (e) {
        // "already active" = an earlier switch on THIS connection owns it; adopt instead of erroring.
        if (!/already active/.test(acpErrorText(e))) {
          // The previous session was deliberately NOT closed first: a failed
          // switch (e.g. the target is locked by another dsh instance) must
          // leave the current chat untouched.
          throw isLockContention(e) ? lockContentionError(sessionId) : e
        }
        this.out.appendLine(`[dsh] resume hit already-active ${sessionId.slice(0, 8)}; adopting`)
        configOptions = previous?.configOptions ?? []
      }
      if (previous) await this.service.closeSession(previous.id).catch(() => undefined)
      this.setSession({ id: sessionId, busy: false, configOptions, generation: this.service.generation }, true)
      void this.bridgeAttach()
      // Only a transcript with real activity makes the session "used"; a resumed
      // empty session stays eligible for the empty-session reuse in newSession().
      // sendTranscript may import the dsh-side history, which also counts.
      const messages = await this.sendTranscript(sessionId)
      this.sessionHasActivity = (messages ?? []).some(m => m.kind !== 'system')
      void this.pushSessions()
    })
  }

  /** Bridge path: native titles + archived-session filtering. */
  private async pushSessionsViaBridge(): Promise<boolean> {
    if (!this.bridge.isOn) return false
    const c = this.bridge.client!
    const wsCwd = vscode.workspace.workspaceFolders?.[0]
      ? await this.getLauncher().paths.toDsh(vscode.workspace.workspaceFolders![0].uri.fsPath)
      : undefined
    const [list, ws] = await Promise.all([
      c.request<{ sessions: { sessionId: string; title?: string | null; cwd?: string | null }[]; stored?: { sessionId: string; cwd?: string | null; title?: null }[] }>('session.list', { includeStored: true }),
      c.request<{ archivedSessionIds: string[] }>('workspace.list').catch(() => ({ archivedSessionIds: [] as string[] })),
    ])
    const archived = this.archivedLocal()
    for (const id of ws.archivedSessionIds) archived.add(id)
    const rows = [...list.sessions, ...(list.stored ?? [])]
      .filter(x => !archived.has(x.sessionId))
      .filter(x => !wsCwd || !x.cwd || x.cwd === wsCwd)
    // `stored` rows are header-only: their `title` is always null, so the list
    // renders as bare session ids unless each one is resolved via session.get.
    // Fire them with bounded concurrency (not one unbounded Promise.all, which
    // used to time out under ~30 sessions and swallow every title) and cache
    // results so reopening the drawer doesn't re-query titles that never change.
    const titled = await this.resolveTitles(c, rows)
    this.out.appendLine(`[dsh] sessions: ${titled.length} via bridge (${titled.filter(t => t.title).length} titled)`)
    this.post({ type: 'sessions', sessions: titled })
    return true
  }

  /** Session titles are immutable once assigned — but a MISS is emphatically
   *  not immutable: dsh only generates a title after the first prompt, so
   *  caching a failure permanently kept brand-new sessions on their id for the
   *  rest of the window. Misses expire after this TTL instead. */
  private titleCache = new Map<string, { title?: string; at: number }>()
  private static readonly TITLE_MISS_TTL_MS = 30_000

  private cachedTitle(id: string): string | undefined {
    const hit = this.titleCache.get(id)
    if (!hit) return undefined
    if (hit.title === undefined && Date.now() - hit.at > ChatViewProvider.TITLE_MISS_TTL_MS) {
      this.titleCache.delete(id)
      return undefined
    }
    return hit.title
  }

  /** dsh ids are `session-<uuid>`: slicing the raw id yields the literal
   *  "session-" prefix, which made every untitled row read the same. */
  private static shortId(id: string): string {
    const stripped = id.replace(/^session-/, '')
    return (stripped || id).slice(0, 8)
  }

  private async resolveTitles(
    c: { request: <T>(method: string, params?: unknown) => Promise<T> },
    rows: { sessionId: string; title?: string | null; cwd?: string | null }[],
  ): Promise<{ sessionId: string; cwd?: string; title?: string }[]> {
    const out: { sessionId: string; cwd?: string; title?: string }[] = rows.map(x => ({
      sessionId: x.sessionId,
      cwd: x.cwd ?? undefined,
      title: x.title?.trim() || undefined,
    }))
    const missing = out.filter(r => !r.title && this.cachedTitle(r.sessionId) === undefined)
    const LIMIT = 6
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++
        if (idx >= missing.length) return
        const row = missing[idx]
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const got = await c.request<{ title?: string | null }>('session.get', { sessionId: row.sessionId })
            this.titleCache.set(row.sessionId, { title: got?.title?.trim() || undefined, at: Date.now() })
            break
          } catch {
            if (attempt === 1) this.titleCache.set(row.sessionId, { title: undefined, at: Date.now() })
            else await new Promise(r => setTimeout(r, 120))
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LIMIT, missing.length) }, worker))
    for (const r of out) {
      if (!r.title) r.title = this.cachedTitle(r.sessionId)
    }
    for (const r of out) {
      if (!r.title) r.title = `会话 ${ChatViewProvider.shortId(r.sessionId)}`
    }
    return out
  }

  /** Push the workspace-filtered session list.
   *  When the bridge profile is configured, the bridge is the single source:
   *  while it is connecting we stay silent (onState re-triggers) instead of
   *  flashing an ACP-sourced list that the bridge list then replaces. */
  async pushSessions(): Promise<void> {
    const bridgeExpected = readConfig().profile !== 'acp'
    if (bridgeExpected && this.bridge.state === 'connecting') return
    if (await this.pushSessionsViaBridge().catch(() => false)) return
    const toRow = (x: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }): { sessionId: string; cwd?: string; title?: string; updatedAt?: string } =>
      ({ sessionId: x.sessionId, cwd: x.cwd, title: x.title?.trim() || undefined, updatedAt: x.updatedAt ?? undefined })
    try {
      const res = await this.service.listSessionsForWorkspace()
      const archived = this.archivedLocal()
      const rows = res.sessions.filter(x => !archived.has(x.sessionId)).map(toRow)
      this.out.appendLine(`[dsh] sessions: ${rows.length} for workspace (acp)`)
      this.post({ type: 'sessions', sessions: rows })
    } catch (e) {
      // Never fall back to an unfiltered list: flashing foreign or archived
      // sessions for a beat is worse than showing none.
      this.out.appendLine(`[dsh] session/list failed: ${(e as Error).message}`)
    }
  }


  private async sendTranscript(sessionId: string): Promise<ChatMessage[] | undefined> {
    let messages = await this.transcripts.load(sessionId)
    if ((!messages || messages.length === 0) && this.bridge.isOn && this.bridge.capabilities?.sessionExport === true) {
      // The session was built elsewhere (e.g. the Web UI): rebuild its
      // transcript from the durable dsh log once, then keep it in the local
      // cache like any home-grown session.
      try {
        const imported = await importDshTranscript(
          sessionId,
          this.bridge.client!,
          this.getLauncher().paths,
          async p => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(p))),
        )
        if (imported && imported.length > 0) {
          messages = imported
          void this.transcripts.save(sessionId, imported)
          this.out.appendLine(`[dsh] imported ${imported.length} transcript messages from the dsh log for ${sessionId.slice(0, 8)}`)
        }
      } catch (e) {
        this.out.appendLine(`[dsh] transcript import failed for ${sessionId.slice(0, 8)}: ${acpErrorText(e)}`)
      }
    }
    // Still empty → leave the message list empty so the webview shows the
    // welcome screen instead of a synthetic "session resumed" notice.
    this.post({ type: 'transcript', sessionId, messages: messages ?? [] })
    return messages ?? undefined
  }

  // ---------- bridge-backed session actions ----------

  private async onRenameSession(sessionId: string, title: string): Promise<void> {
    if (!this.bridge.isOn) throw new Error('Bridge plugin not connected — titles require dsh-vscode-bridge.')
    await this.bridge.client!.request('session.setTitle', { sessionId, title })
    await this.pushSessions()
  }

  private archivedLocal(): Set<string> {
    return new Set(this.ctx.globalState.get<string[]>('dsh.archivedSessionIds', []))
  }

  /** Delete a session.
   *
   *  Two paths, because the delete button must stay usable when the bridge is
   *  not connected (a plugin that is missing/down used to hide the whole
   *  feature):
   *  - archive path (bridge with `sessionArchive`): archive on the host first,
   *    then tear down locally.
   *  - local fallback: only the local facets are cleaned up — the archive
   *    marker that hides the row, the cached transcript, the usage entry and
   *    the persisted session data. The dsh-side registry is left alone, so the
   *    user is told about exactly that.
   */
  private async onDeleteSession(sessionId: string): Promise<void> {
    // A connected bridge always reports its capabilities at handshake time, so
    // `!== false` only differs from `=== true` for a driver/test that stubs the
    // client without a capability set; a bridge that explicitly lacks
    // sessionArchive still falls back to the local-only path.
    const archiveOnHost = this.bridge.isOn && this.bridge.capabilities?.sessionArchive !== false
    const wasActive = this.session?.id === sessionId
    // A running turn cannot be torn down: the bridge refuses this with
    // 'session/active' (DSH 0.1.7 WorkspaceActiveSessionError), and the local
    // fallback has no host to refuse for us — so refuse up front, before any
    // state is touched, and keep everything intact.
    if (wasActive && this.session?.busy) {
      void vscode.window.showWarningMessage('DSH: 会话正在运行，请先停止当前回合，然后再删除。')
      return
    }
    if (archiveOnHost) {
      // Archive on the host BEFORE any local teardown: on a refusal the session
      // still exists, so keep local state intact and just ask the user to stop
      // it first — tearing down first would strand the session half-deleted.
      try {
        await this.bridge.client!.request('session.delete', { sessionId })
      } catch (e) {
        if ((e as BridgeError).dataCode === 'session/active') {
          void vscode.window.showWarningMessage('DSH: 会话正在运行，请先停止。')
          return
        }
        throw e
      }
    }
    if (wasActive) {
      await this.service.closeSession(sessionId).catch(() => undefined)
      // setSession(undefined) clears the persisted active id and posts
      // 'sessionEnded', which puts the webview back on the welcome screen
      // instead of leaving the deleted session's transcript on display.
      this.setSession(undefined)
    }
    await this.transcripts.delete(sessionId)
    this.forgetUsage(sessionId)
    const archived = this.archivedLocal()
    archived.add(sessionId)
    await this.ctx.globalState.update('dsh.archivedSessionIds', [...archived])
    // Titles are immutable, so the cache would otherwise keep rendering a name
    // for a session that no longer exists.
    this.titleCache.delete(sessionId)
    // Physical removal of the persisted session data (archive is registry-level only).
    let dataRemoved = false
    try {
      const removed = await deleteSessionData(sessionId)
      dataRemoved = true
      if (removed.trim()) this.out.appendLine(`[dsh] deleted session data: ${removed.trim().split('\n').join(', ')}`)
    } catch (e) {
      // The POSIX-script path cannot run on a Windows target (no bash); fall
      // back to removing the directory natively so "delete" really deletes.
      if (process.platform === 'win32') {
        try {
          const paths = await deleteSessionDataOnWindows(sessionId)
          dataRemoved = true
          this.out.appendLine(paths.length > 0
            ? `[dsh] deleted session data: ${paths.join(', ')}`
            : `[dsh] no persisted data for ${sessionId.slice(0, 8)} (nothing to remove)`)
        } catch (e2) {
          this.out.appendLine(`[dsh] physical delete failed (archived anyway): ${(e2 as Error).message}`)
        }
      } else {
        this.out.appendLine(`[dsh] physical delete failed (archived anyway): ${(e as Error).message}`)
      }
    }
    // Tell the webview before refreshing the list: the row disappears at once
    // even when the list refresh fails (e.g. the bridge just dropped).
    this.post({ type: 'sessionDeleted', sessionId, archivedOnHost: archiveOnHost })
    if (!archiveOnHost) {
      const caveat = dataRemoved ? '' : '（持久化文件未能清理，详见 DSH 输出日志）'
      const why = this.bridge.isOn ? '当前 bridge 版本不支持归档' : 'bridge 未连接'
      void vscode.window.showInformationMessage(`DSH: 已在本地删除该会话${caveat}。${why}，dsh 侧记录未变；bridge 可用后它可能重新出现在列表里。`)
    }
    await this.pushSessions()
  }

  /** Presets that can never mount in a headless ACP host (need the Web/Desktop client plane). */
  private static readonly HOST_INCOMPATIBLE_PRESETS: Record<string, string> = {
    cordis: 'Requires the Web/Desktop client plane (Cordis plugin runtime); unavailable in headless ACP sessions.',
  }

  private failedPresets = new Set<string>()

  private presetsWithMarks(): typeof this.lastPresets {
    return this.lastPresets.map(pr => {
      const known = ChatViewProvider.HOST_INCOMPATIBLE_PRESETS[pr.id]
      if (known !== undefined) return { ...pr, broken: known }
      return this.failedPresets.has(pr.id) ? { ...pr, broken: true } : pr
    })
  }

  private async onSelectPreset(presetId: string): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    try {
      await this.bridge.client!.request('preset.select', { sessionId: this.session.id, presetId })
    } catch (e) {
      // Mount-time failures (e.g. client-plane-only presets) are not flagged by the
      // roster — mark locally so the option disables with the reason attached.
      // DSH 0.1.5 rejects with a "failed to mount" message; 0.1.7 throws
      // RemoteError('agent-preset/invalid'), which the bridge's wireError has
      // forwarded as data.code since 0.1.3. Match both.
      if ((e as BridgeError).dataCode === 'agent-preset/invalid' || /failed to mount/.test((e as Error).message)) {
        this.failedPresets.add(presetId)
        void this.ctx.globalState.update('dsh.brokenPresets', [...this.failedPresets])
        this.post({ type: 'presets', presets: this.presetsWithMarks() })
      }
      throw e
    }
    // Tolerant read: the session may have been switched/closed while the select
    // was in flight — skip the echo instead of erroring the whole operation.
    const cur = await this.bridge.client!.request<{ preset: string | null }>('preset.current', { sessionId: this.session.id }).catch(() => undefined)
    if (cur !== undefined) this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur.preset })
    // The command registry is agent-scoped: a new preset may expose different commands.
    await this.pushNativeCommands()
  }

  private async onSetPermission(name: string): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    const res = await this.bridge.client!.request<{ current: string }>('permission.set', { sessionId: this.session.id, name })
    const perm = await this.bridge.client!.request<{ options: { value: string; name: string; description?: string }[]; current?: string }>('permission.get', { sessionId: this.session.id })
    this.post({ type: 'permission', options: perm.options, current: res.current })
  }

  // ---------- reconnect & images ----------

  private async onReconnect(): Promise<void> {
    await this.service.ensureClient()
    this.post({ type: 'connectionState', state: 'ready' })
    this.post({ type: 'capabilities', image: this.service.imageCapable })
    if (this.session) {
      // Force the generation check inside ensureSession to re-attach.
      this.session = { ...this.session, generation: -1 }
      await this.ensureSession()
    }
    void this.pushSessions()
  }

  private async onPickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      openLabel: 'Attach image',
    })
    if (!uris) return
    for (const u of uris) {
      const data = await vscode.workspace.fs.readFile(u)
      this.pendingImages.push({
        name: u.path.split('/').pop() ?? 'image',
        mimeType: `image/${(u.path.split('.').pop() ?? 'png').replace('jpg', 'jpeg')}`,
        data: Buffer.from(data).toString('base64'),
      })
    }
    this.postImageChips()
  }

  private postImageChips(): void {
    this.post({ type: 'imageChips', images: this.pendingImages.map(i => ({ name: i.name, size: Math.round(i.data.length * 0.75) })) })
  }

  // ---------- reasoning effort default ----------

  private effortDefaults?: Map<string, string>

  /** model id → defaultEffort, target-side: the active profile's
   *  cordis.patch.yml (0.1.7 keeps provider config per-profile) layered over
   *  the legacy global $DSH_HOME/settings.yaml (≤ 0.1.6; 0.1.7 renames it to
   *  settings.yaml.imported, so the cat simply misses there). */
  private async loadEffortDefaults(): Promise<Map<string, string>> {
    if (this.effortDefaults) return this.effortDefaults
    const map = new Map<string, string>()
    const sources = ['settings.yaml', `profiles/${readConfig().profile}/cordis.patch.yml`]
    for (const rel of sources) {
      try {
        const r = await runTargetShell(`cat "\${DSH_HOME:-$HOME/.dsh}/${rel}" 2>/dev/null || true`, 5_000)
        if (r.stdout.trim()) collectEffortDefaults(parseYaml(r.stdout), map)
      } catch (e) {
        this.out.appendLine(`[dsh] effort defaults read failed (${rel}): ${(e as Error).message}`)
      }
    }
    this.effortDefaults = map
    return map
  }

  /** If the effort selector sits at provider-default, pin the configured/highest level. */
  private async applyEffortDefault(): Promise<void> {
    const session = this.session
    if (!session) return
    const effort = session.configOptions.find(o => o.id === 'reasoning_effort')
    const modelOpt = session.configOptions.find(o => o.category === 'model' || o.id === 'model')
    if (!effort || effort.type !== 'select' || effort.currentValue !== '') return
    const modelId = modelOpt && modelOpt.type === 'select' ? modelIdOf(modelOpt.currentValue) : undefined
    const configured = modelId ? (await this.loadEffortDefaults()).get(modelId) : undefined
    const desired = chooseEffort(effort.options as { value: string }[], configured)
    if (desired) {
      this.out.appendLine(`[dsh] pinning reasoning effort: ${desired}${configured ? ` (defaultEffort of ${modelId})` : ' (highest)'}`)
      await this.onSelectConfig('reasoning_effort', desired)
    }
  }

  // ---------- permissions ----------

  private async brokerPermission(r: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // The webview card only works when the DSH view is on screen; otherwise
    // (e.g. a @dsh chat participant request) fall back to a native modal.
    if (!this.view?.visible) {
      const allow = r.options.find(o => o.kind === 'allow_once') ?? r.options[0]
      const reject = r.options.find(o => o.kind === 'reject_once')
      const pick = await vscode.window.showWarningMessage(
        `DSH wants to run: ${r.toolCall.title ?? 'tool'}`,
        { modal: true },
        allow?.name ?? 'Allow', reject?.name ?? 'Reject',
      )
      if (pick === (allow?.name ?? 'Allow')) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      if (pick === (reject?.name ?? 'Reject') && reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } }
      return { outcome: { outcome: 'cancelled' } }
    }
    const requestId = Math.random().toString(36).slice(2)
    this.post({
      type: 'permissionRequest', requestId,
      title: r.toolCall.title ?? 'Tool call',
      options: r.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return new Promise(resolve => {
      this.pendingPermissions.set(requestId, ({ optionId }) => {
        this.post({ type: 'permissionResolved', requestId })
        resolve(optionId === null
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId } })
      })
    })
  }

  private onPermissionResponse(requestId: string, optionId: string | null): void {
    this.pendingPermissions.get(requestId)?.({ optionId })
    this.pendingPermissions.delete(requestId)
  }

  // ---------- file search (@-mentions) ----------

  private async onFileSearch(reqId: number, query: string): Promise<void> {
    const safe = query.replace(/[*?{}[\]\\]/g, '').trim()
    const EXCLUDES = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}'
    const seen = new Set<string>()
    const out: { path: string; label: string }[] = []
    const push = (u: vscode.Uri): void => {
      if (!seen.has(u.fsPath)) { seen.add(u.fsPath); out.push({ path: u.fsPath, label: vscode.workspace.asRelativePath(u) }) }
    }
    if (!safe) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined
          if (input?.uri?.scheme === 'file') push(input.uri)
        }
      }
      if (out.length < 20) {
        for (const u of await vscode.workspace.findFiles('**/*', EXCLUDES, 20 - out.length)) push(u)
      }
    } else {
      const uris = await vscode.workspace.findFiles(`**/*${safe}*`, EXCLUDES, 50)
      const lower = safe.toLowerCase()
      uris.sort((a, b) => {
        const an = a.path.split('/').pop()?.toLowerCase() ?? ''
        const bn = b.path.split('/').pop()?.toLowerCase() ?? ''
        return (an.startsWith(lower) ? 0 : 1) - (bn.startsWith(lower) ? 0 : 1) || an.localeCompare(bn)
      })
      for (const u of uris.slice(0, 20)) push(u)
    }
    this.post({ type: 'fileSearchResults', reqId, files: out })
  }

  // ---------- editor context ----------

  private activeEditorChip(): ContextChip | undefined {
    const ed = vscode.window.activeTextEditor
    if (!ed || ed.document.uri.scheme !== 'file') return undefined
    const sel = ed.selection
    return {
      path: ed.document.uri.fsPath,
      label: path.basename(ed.document.uri.fsPath),
      selection: sel && !sel.isEmpty ? { startLine: sel.start.line + 1, endLine: sel.end.line + 1 } : undefined,
    }
  }

  addActiveEditorToContext(): void {
    const chip = this.activeEditorChip()
    if (!chip) { void vscode.window.showInformationMessage('No active file to attach.'); return }
    if (!this.chips.some(c => c.path === chip.path)) this.chips.push(chip)
    this.post({ type: 'chips', chips: this.chips })
  }

  /** Push the native slash-command catalog for the current session's agent.
   *  The registry filters per agent scope, so the list differs across agent
   *  presets and must be refetched whenever the preset changes. */
  private async pushNativeCommands(): Promise<void> {
    if (!this.bridge.isOn || !this.session || this.bridge.capabilities?.commands !== true) return
    const list = await this.bridge.client!.request<{ commands: { name: string; description?: string; inputHint?: string }[] }>(
      'command.list', { sessionId: this.session.id },
    ).catch(() => undefined)
    if (list) this.post({ type: 'nativeCommands', commands: list.commands })
  }

  /** Run a native dsh slash command through the bridge (v0.1.3+ command.run). */
  private async onRunCommand(line: string): Promise<void> {
    if (!this.bridge.isOn || !this.session) throw new Error('Native commands need the bridge (≥ 0.1.3) and an active session.')
    // Pin the session id: the command may outlive a session switch (compact
    // runs up to the timeout), and its result must not leak into the next
    // session's transcript.
    const sessionId = this.session.id
    this.post({ type: 'commandRunning', sessionId, line, running: true })
    try {
      const res = await this.bridge.client!.request<{ commandId?: string; kind: 'success' | 'error'; text?: string }>(
        'command.run', { sessionId, line },
      )
      this.post({ type: 'commandResult', sessionId, kind: res.kind, text: res.text })
    } catch (e) {
      // Older bridge (< 0.1.3) has no command.* family: answer in-transcript.
      if ((e as { rpcCode?: number }).rpcCode === -32601) {
        this.post({ type: 'commandResult', sessionId, kind: 'error', text: '此功能需要 dsh-vscode-bridge ≥ 0.1.3，请运行「DSH: Install Bridge」升级。' })
        return
      }
      throw e
    } finally {
      this.post({ type: 'commandRunning', sessionId, running: false })
    }
  }

  /** Export the session log as a ZIP via the bridge (v0.1.3+ session.exportZip),
   *  then reveal/copy the host-side path (target path mapped back via fromDsh). */
  private async onExportSession(): Promise<void> {
    if (!this.bridge.isOn || !this.session) throw new Error('Session export needs the bridge (≥ 0.1.3) and an active session.')
    const res = await this.bridge.client!.request<{ path: string; fileName: string; bytes: number }>(
      'session.exportZip', { sessionId: this.session.id },
    ).catch((e: unknown) => {
      if ((e as { rpcCode?: number }).rpcCode === -32601) {
        void vscode.window.showWarningMessage('DSH: 会话导出需要 dsh-vscode-bridge ≥ 0.1.3，请运行「DSH: Install Bridge」升级。')
        return undefined
      }
      throw e
    })
    if (!res) return
    const hostPath = await this.getLauncher().paths.fromDsh(res.path).catch(() => res.path)
    const size = res.bytes > 1024 * 1024 ? `${(res.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(res.bytes / 1024))} KB`
    const pick = await vscode.window.showInformationMessage(`DSH: session log exported → ${hostPath} (${size})`, 'Reveal in Folder', 'Copy Path')
    if (pick === 'Reveal in Folder') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(hostPath))
    else if (pick === 'Copy Path') void vscode.env.clipboard.writeText(hostPath)
  }

  /** Slash-command pickers (/model, /effort, /permission): native QuickPick in
   *  front of the same selectConfig / permission.set flows the rail pickers use. */
  private async onCommandPicker(kind: 'model' | 'effort' | 'permission'): Promise<void> {
    if (kind === 'permission') {
      if (!this.bridge.isOn || !this.session) {
        void vscode.window.showInformationMessage('DSH: permission presets need the bridge and an active session.')
        return
      }
      const perm = await this.bridge.client!.request<{ options: { value: string; name: string; description?: string }[]; current?: string }>('permission.get', { sessionId: this.session.id })
      const pick = await vscode.window.showQuickPick(
        perm.options.map(o => ({ label: o.name, description: o.value === perm.current ? 'current' : '', detail: o.description, value: o.value })),
        { placeHolder: 'Permission preset (sandbox mode & approval policy)' },
      )
      if (pick) await this.onSetPermission(pick.value)
      return
    }
    const session = this.session
    if (!session) {
      void vscode.window.showInformationMessage('DSH: no active session yet — send a prompt first.')
      return
    }
    const configId = kind === 'model' ? (findModelOption(session.configOptions)?.id ?? 'model') : 'reasoning_effort'
    const opt = session.configOptions.find(o => o.id === configId)
    if (!opt || opt.type !== 'select') {
      void vscode.window.showInformationMessage(`DSH: this session exposes no ${kind} option.`)
      return
    }
    const pick = await vscode.window.showQuickPick(
      flattenOptions(opt).map(f => ({ label: f.label, description: f.group ?? (f.value === opt.currentValue ? 'current' : ''), detail: f.description, value: f.value })),
      { placeHolder: kind === 'model' ? 'Model for this session' : 'Reasoning effort for this session' },
    )
    if (pick) await this.onSelectConfig(configId, pick.value)
  }

  private async onSelectConfig(configId: string, value: string, opts?: { skipEffortDefault?: boolean }): Promise<void> {
    if (!this.session) return
    const res = await this.service.setConfigOption(this.session.id, configId, value)
    this.session.configOptions = res.configOptions ?? this.session.configOptions
    this.rememberSelection()
    // Dedicated message: sessionStarted would wipe the transcript in the webview reducer.
    this.post({ type: 'configOptions', configOptions: this.session.configOptions })
    this._onDidChangeSession.fire(this.session)
    // A model switch resets the effort to provider-default: repin the
    // configured/highest level — unless the caller is about to set one itself.
    const modelConfigId = findModelOption(this.session.configOptions)?.id ?? 'model'
    if (!opts?.skipEffortDefault && configId === modelConfigId) await this.applyEffortDefault().catch(() => undefined)
  }

  /** Persist the current model+effort as the default for future fresh sessions
   *  (ACP selections are per-session and in-memory; the server never remembers). */
  private rememberSelection(): void {
    const options = this.session?.configOptions
    if (!options) return
    const model = findModelOption(options)
    if (!model || model.type !== 'select' || !model.currentValue) return
    const effort = options.find(o => o.id === 'reasoning_effort')
    const effortValue = effort?.type === 'select' && effort.currentValue !== '' ? effort.currentValue : undefined
    void this.ctx.globalState.update('dsh.lastModelSelection', { model: model.currentValue, effort: effortValue })
  }

  /** A restart-reattach resumes the session from its last LOGGED route, so a
   *  blank session — or a model switch after the last prompt — comes back at
   *  the deployment default. Re-apply the picks this client had before the
   *  restart when they diverge; failures keep the resumed route. */
  private async restoreSelection(before: SessionConfigOption[]): Promise<void> {
    const session = this.session
    if (!session) return
    const prevModel = findModelOption(before)
    const curModel = findModelOption(session.configOptions)
    if (prevModel?.type === 'select' && curModel?.type === 'select'
      && prevModel.currentValue && prevModel.currentValue !== curModel.currentValue) {
      try {
        await this.onSelectConfig(curModel.id, prevModel.currentValue, { skipEffortDefault: true })
      } catch (e) {
        this.out.appendLine(`[dsh] pre-restart model unavailable, keeping the resumed one: ${acpErrorText(e)}`)
        return
      }
    }
    if (this.session?.id !== session.id) return
    const prevEffort = before.find(o => o.id === 'reasoning_effort')
    const curEffort = session.configOptions.find(o => o.id === 'reasoning_effort')
    if (prevEffort?.type === 'select' && curEffort?.type === 'select'
      && prevEffort.currentValue !== '' && prevEffort.currentValue !== curEffort.currentValue) {
      try {
        await this.onSelectConfig('reasoning_effort', prevEffort.currentValue)
      } catch (e) {
        this.out.appendLine(`[dsh] pre-restart effort rejected, keeping the resumed one: ${acpErrorText(e)}`)
      }
    }
  }

  /** Replay the remembered model+effort onto a freshly created session, so new
   *  sessions open with the user's last pick instead of the deployment default.
   *  Falls back to the provider defaultEffort pin when nothing is remembered or
   *  a remembered value is no longer offered. */
  private async applyRememberedSelection(): Promise<void> {
    const session = this.session
    if (!session) return
    const remembered = this.ctx.globalState.get<{ model?: string; effort?: string }>('dsh.lastModelSelection')
    const modelOpt = findModelOption(session.configOptions)
    if (remembered?.model && modelOpt?.type === 'select' && modelOpt.currentValue !== remembered.model) {
      try {
        await this.onSelectConfig(modelOpt.id, remembered.model, { skipEffortDefault: true })
      } catch (e) {
        this.out.appendLine(`[dsh] remembered model unavailable, keeping the default: ${acpErrorText(e)}`)
      }
    }
    if (this.session?.id !== session.id) return // the user switched sessions mid-apply
    const effort = this.session.configOptions.find(o => o.id === 'reasoning_effort')
    if (remembered?.effort && effort?.type === 'select') {
      if (effort.currentValue === remembered.effort) return
      try {
        await this.onSelectConfig('reasoning_effort', remembered.effort)
        return
      } catch (e) {
        this.out.appendLine(`[dsh] remembered effort rejected, pinning the default instead: ${acpErrorText(e)}`)
      }
    }
    await this.applyEffortDefault()
  }

  reset(): void {
    for (const [, resolve] of this.pendingPermissions) resolve({ optionId: null })
    this.pendingPermissions.clear()
    // Do NOT go through setSession(undefined): that path clears the persisted
    // activeSessionId, and teardown (dispose on Reload Window, config change)
    // must not forfeit the startup restore — the next host resumes the session
    // when dsh still has it. Deliberate exits (delete/switch) clear the id
    // through setSession themselves.
    this.usageText = undefined
    this.sessionHasActivity = false
    this.session = undefined
    this.post({ type: 'sessionEnded' })
    this._onDidChangeSession.fire(undefined)
    this.post({ type: 'connectionState', state: 'closed' })
  }

  dispose(): void {
    this.reset()
    this.disposables.forEach(d => d.dispose())
    this._onDidChangeSession.dispose()
  }
}
