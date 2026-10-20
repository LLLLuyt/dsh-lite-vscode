import React, { useEffect, useReducer, useRef, useState } from 'react'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { ToWebview } from '../shared/messages.js'
import type { ChatMessage } from '../shared/chat.js'
import { flattenOptions, findModelOption, effortOptionsWithoutDefault } from '../shared/model.js'
import { formatToolDetail, initialState, reduce } from './state.js'
import { post } from './vscode.js'
import { Markdown } from './Markdown.js'
import { RailSelect } from './RailSelect.js'
import { SessionsPanel, type SessionRow } from './SessionsPanel.js'
import { PermissionSelect } from './PermissionSelect.js'
import { Welcome } from './Welcome.js'
import type { BridgeCapabilities } from '../bridge/client.js'
import { Composer, type FilePick } from './Composer.js'
import { NATIVE_COMMAND_BLOCKLIST, NATIVE_COMMAND_ZH, type SlashCommand } from './slash.js'
import { ChangesBar } from './ChangesBar.js'
import { ensureActive, mergeSessions, shortSessionId, toRows, type SessionOrdering } from './sessionOrder.js'


// ---------- message rendering ----------

/** execCommand fallback for webviews where the async clipboard API is blocked. */
function legacyCopy(text: string): void {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch { /* best-effort */ }
  ta.remove()
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  const copy = (): void => {
    const mark = (): void => { setDone(true); setTimeout(() => setDone(false), 1200) }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(mark, () => { legacyCopy(text); mark() })
    else { legacyCopy(text); mark() }
  }
  return (
    <button className={`copy-btn${done ? ' done' : ''}`} title="Copy to clipboard" onClick={copy}>
      {done ? '✓' : '⧉'}
    </button>
  )
}

function MessageView({ m }: { m: ChatMessage }): React.JSX.Element {
  switch (m.kind) {
    // User bubbles get the copy button below the bubble (outside, right-aligned);
    // assistant output keeps it at the bottom of the content.
    case 'user': return (
      <>
        <div className="msg user"><Markdown text={m.text} /></div>
        <div className="msg-tools user"><CopyButton text={m.text} /></div>
      </>
    )
    case 'assistant': return <div className="msg assistant"><Markdown text={m.text} /><div className="msg-tools"><CopyButton text={m.text} /></div></div>
    case 'thought': return <details className="msg thought"><summary>Thinking…</summary><Markdown text={m.text} /></details>
    case 'system': return <div className="msg system">{m.text}</div>
    case 'todo':
      return (
        <div className="msg todo">
          <div className="todo-head">Tasks</div>
          {m.items.map((t, i) => (
            <div key={i} className={`todo-item st-${t.status}`}>
              <span className="todo-icon">{t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◐' : '○'}</span>
              <span className="todo-text">{t.content}</span>
            </div>
          ))}
        </div>
      )
    case 'error': return <div className="msg error">{m.text}</div>
    case 'tool': {
      const detail = m.detail ? formatToolDetail(m.detail) : undefined
      // Raw input renders as key/value rows when it is a plain object (the
      // common case: dsh sends the parsed tool arguments); anything else is
      // shown verbatim. The card therefore has content even when the agent
      // reports no result content (e.g. offloaded output).
      const inputRows = m.input && typeof m.input === 'object' && !Array.isArray(m.input)
        ? Object.entries(m.input as Record<string, unknown>)
        : undefined
      return (
        <details className={`msg tool status-${m.status ?? 'pending'}`}>
          <summary>
            <span className="tool-status" />
            <span className="tool-title">{m.title}</span>
            {m.subtitle ? <span className="tool-subtitle">{m.subtitle}</span> : null}
            {m.toolKind && m.toolKind !== 'other' ? <span className="tool-kind">{m.toolKind}</span> : null}
            {m.status ? <span className="tool-status-text">{m.status}</span> : null}
          </summary>
          {inputRows && inputRows.length > 0 && (
            <div className="tool-section">
              <div className="tool-section-label">input</div>
              <table className="tool-kv"><tbody>
                {inputRows.map(([k, v], i) => (
                  <tr key={i}><td className="k">{k}</td><td className="v">{typeof v === 'string' ? v : JSON.stringify(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
          {m.input !== undefined && m.input !== null && !inputRows && (
            <div className="tool-section">
              <div className="tool-section-label">input</div>
              <pre>{typeof m.input === 'string' ? m.input : JSON.stringify(m.input, null, 2)}</pre>
            </div>
          )}
          {detail?.kind === 'kv' && (
            <div className="tool-section">
              <div className="tool-section-label">result</div>
              <table className="tool-kv"><tbody>
                {detail.rows.map((r, i) => <tr key={i}><td className="k">{r.k}</td><td className="v">{r.v}</td></tr>)}
              </tbody></table>
            </div>
          )}
          {detail?.kind === 'text' && (
            <div className="tool-section">
              <div className="tool-section-label">result</div>
              <pre>{detail.text}</pre>
            </div>
          )}
          {m.output !== undefined && (
            <div className="tool-section">
              <div className="tool-section-label">output</div>
              <pre>{typeof m.output === 'string' ? m.output : JSON.stringify(m.output, null, 2)}</pre>
            </div>
          )}
        </details>
      )
    }
  }
}

/** Pinned, collapsible task card: latest todo snapshot stays on top of the
 *  transcript instead of scrolling away with the message flow. */
function TaskCard({ todos }: { todos: { content: string; status: string }[] }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const done = todos.filter(t => t.status === 'completed').length
  return (
    <div className={`taskcard${open ? ' open' : ''}`}>
      <button className="taskcard-head" title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(v => !v)}>
        <span className="taskcard-chev">{open ? '▾' : '▸'}</span>
        <span className="taskcard-title">Tasks</span>
        <span className="taskcard-progress">{done}/{todos.length}</span>
      </button>
      {open && (
        <div className="taskcard-body">
          {todos.map((t, i) => (
            <div key={i} className={`todo-item st-${t.status}`}>
              <span className="todo-icon">{t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◐' : '○'}</span>
              <span className="todo-text">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type ContextChipLite = { path: string; label: string; selection?: { startLine: number; endLine: number } }

// ---------- app ----------

export default function App(): React.JSX.Element {
  const [s, dispatch] = useReducer(reduce, initialState)
  const [chips, setChips] = useState<ContextChipLite[]>([])
  const [topology, setTopology] = useState('')
  const [workspaceName, setWorkspaceName] = useState<string | undefined>(undefined)
  const [logoUri, setLogoUri] = useState<string | undefined>(undefined)
  const [showSessions, setShowSessions] = useState(false)
  const [ordering, setOrdering] = useState<SessionOrdering>({ order: [], byId: new Map() })
  const [fileResults, setFileResults] = useState<{ reqId: number; files: FilePick[] }>({ reqId: -1, files: [] })
  const [changedFiles, setChangedFiles] = useState<{ path: string; label: string; kind: 'created' | 'modified' }[]>([])
  const [imageCapable, setImageCapable] = useState(false)
  const [bridgeCaps, setBridgeCaps] = useState<BridgeCapabilities | undefined>(undefined)
  const [presets, setPresets] = useState<{ id: string; name?: string; isDefault?: boolean; broken?: string | boolean }[]>([])
  const [presetCurrent, setPresetCurrent] = useState<string | null>(null)
  const [permOptions, setPermOptions] = useState<{ value: string; name: string; description?: string }[]>([])
  const [permCurrent, setPermCurrent] = useState<string | undefined>(undefined)
  const [imageChips, setImageChips] = useState<{ name: string; size: number }[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  /** Sticky-bottom: only auto-scroll while the user is already at the bottom.
   *  The old unconditional scrollTo ran on EVERY token (state.ts rebuilds the
   *  messages array per chunk), so scrolling up to reread an answer yanked the
   *  view back down immediately. */
  const stickRef = useRef(true)
  const onMessagesScroll = (): void => {
    const el = listRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const sessionIdRef = useRef<string | undefined>(undefined)
  sessionIdRef.current = s.sessionId

  useEffect(() => {
    const onMsg = (e: MessageEvent<ToWebview>) => {
      const m = e.data
      if (m.type === 'bootstrap') { setTopology(m.topology); setWorkspaceName(m.workspaceName); setLogoUri(m.logoUri) }
      else if (m.type === 'chips') setChips(m.chips)
      else if (m.type === 'sessions') setOrdering(prev => mergeSessions(prev, m.sessions, sessionIdRef.current))
      else if (m.type === 'sessionDeleted') {
        // Drop the row immediately: the follow-up 'sessions' refresh can be
        // delayed (or lost when the bridge just dropped), and a deleted session
        // lingering in the sidebar looks like the delete failed.
        setOrdering(prev => {
          const byId = new Map(prev.byId)
          byId.delete(m.sessionId)
          return { order: prev.order.filter(id => id !== m.sessionId), byId }
        })
      }
      else if (m.type === 'fileSearchResults') setFileResults(prev => (m.reqId >= prev.reqId ? m : prev))
      else if (m.type === 'changedFiles') { if (m.sessionId === sessionIdRef.current) setChangedFiles(m.files) }
      else if (m.type === 'capabilities') setImageCapable(m.image)
      else if (m.type === 'imageChips') setImageChips(m.images)
      else if (m.type === 'bridge') setBridgeCaps(m.on ? (m.capabilities ?? null) as BridgeCapabilities | undefined ?? {} as BridgeCapabilities : undefined)
      else if (m.type === 'presets') { setPresets(m.presets); if (m.current !== undefined) setPresetCurrent(m.current) }
      else if (m.type === 'permission') { setPermOptions(m.options); setPermCurrent(m.current) }
      else dispatch({ m })
    }
    window.addEventListener('message', onMsg)
    post({ type: 'ready' })
    post({ type: 'listSessions' })
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (!el || !stickRef.current) return
    el.scrollTo({ top: el.scrollHeight })
  }, [s.messages, s.busy])

  // Keep the active session present in the sidebar ordering (server omits it while active).
  useEffect(() => { setOrdering(prev => ensureActive(prev, s.sessionId)) }, [s.sessionId])

  // Debounced transcript persistence: after every settled change, snapshot to the host.
  useEffect(() => {
    if (!s.sessionId || s.busy || s.messages.length === 0) return
    clearTimeout(persistTimer.current)
    const { sessionId, messages } = s
    persistTimer.current = setTimeout(() => post({ type: 'persistTranscript', sessionId, messages }), 1200)
    return () => clearTimeout(persistTimer.current)
  }, [s.messages, s.busy, s.sessionId])

  const send = (text: string): void => {
    if (!text.trim() || s.busy) return
    dispatch({ userSend: text })
    post({ type: 'prompt', text })
  }

  /** Native command lines keep the typed "/cmd args" visible as a user bubble,
   *  then execute via the bridge instead of going to the model. */
  const runCommand = (line: string): void => {
    dispatch({ userSend: line })
    post({ type: 'runCommand', line })
  }

  const model = findModelOption(s.configOptions)
  const extraSelects = s.configOptions.filter((o): o is Extract<SessionConfigOption, { type: 'select' }> => o.type === 'select' && o.id !== model?.id)
  const effortOption = s.configOptions.find(o => o.id === 'reasoning_effort' && o.type === 'select')
  // Slash menu (Web-UI style), two sections: 指令 = extension-local commands
  // plus native dsh commands from the bridge (v0.1.3+ command.list);
  // 技能 = the bridge skill catalog (v0.1.3+ skill.list). Entries whose bridge
  // capability is absent simply never appear.
  const slashCommands: SlashCommand[] = []
  slashCommands.push({ name: 'file', label: '文件', description: '附加工作区文件到对话上下文', section: '指令', run: 'local' })
  if (imageCapable) slashCommands.push({ name: 'image', label: '图片', description: '附加图片到对话', section: '指令', run: 'local' })
  if (model) slashCommands.push({ name: 'model', label: '模型', description: '选择本会话使用的模型', section: '指令', run: 'local' })
  if (effortOption) slashCommands.push({ name: 'effort', label: '推理强度', description: '调整推理强度', section: '指令', run: 'local' })
  if (bridgeCaps?.permissions && permOptions.length > 0) {
    slashCommands.push({ name: 'permission', label: '权限', description: '切换权限预设（沙箱模式与审批策略）', section: '指令', run: 'local' })
  }
  slashCommands.push({ name: 'new', label: '新会话', description: '开始一个新的会话', section: '指令', run: 'local' })
  if (bridgeCaps?.sessionExport) slashCommands.push({ name: 'export', label: '下载日志', description: '将当前会话内容导出为 ZIP', section: '指令', run: 'local' })
  if (bridgeCaps?.commands) {
    for (const c of s.nativeCommands ?? []) {
      if (NATIVE_COMMAND_BLOCKLIST.has(c.name)) continue
      if (slashCommands.some(l => l.name === c.name)) continue // local entries win name collisions
      const zh = NATIVE_COMMAND_ZH[c.name]
      slashCommands.push({
        name: c.name,
        label: zh?.label ?? '',
        description: zh?.description ?? c.description ?? '',
        section: '指令', run: 'native', hint: c.inputHint,
      })
    }
  }
  if (bridgeCaps?.skills) {
    for (const sk of s.skills ?? []) {
      slashCommands.push({ name: sk.name, label: sk.name, description: sk.description ?? sk.whenToUse ?? '', section: '技能', run: 'skill' })
    }
  }
  const sessionTitle = ordering.byId.get(s.sessionId ?? '')?.title ?? (s.sessionId ? shortSessionId(s.sessionId) : undefined)
  const sessionRows = toRows(ordering, s.sessionId)

  return (
    <div className="app">
      <header className="bar">
        {s.connection === 'closed'
          ? <button className="dot closed dot-btn" title={`${s.connectionDetail ?? 'disconnected'} — click to reconnect`} onClick={() => post({ type: 'reconnect' })} />
          : <span className={`dot ${s.connection}`} title={s.connectionDetail ?? s.connection} />}
        <span className="title">DSH</span>
        {sessionTitle && <span className="session-name" title={`${s.sessionId}\n${topology}`}>{sessionTitle}</span>}
        <span className="spacer" />
        <button className={`icon-btn panel-toggle${showSessions ? ' on' : ''}`} title="Toggle sessions sidebar"
          onClick={() => { setShowSessions(v => !v); if (!showSessions) post({ type: 'listSessions' }) }}>☰</button>
      </header>

      <div className="body">
        <div className="chat-col">
          {s.todos && s.todos.length > 0 && <TaskCard todos={s.todos} />}
          <div className="messages" ref={listRef} onScroll={onMessagesScroll}>
            {s.messages.length === 0 && s.connection === 'ready' && !s.busy && (
              <Welcome
                logoUri={logoUri}
                workspaceName={workspaceName}
                sessions={sessionRows.filter(r => !r.active)}
              />
            )}
            {s.connection !== 'ready' && s.messages.length === 0 && (
              <div className="hint">
                {s.connection === 'closed' ? 'dsh agent 未连接' : 'Starting dsh agent…'}
                {s.connection === 'closed' && (
                  <button className="reconnect" onClick={() => post({ type: 'reconnect' })}>重新连接</button>
                )}
              </div>
            )}
            {s.messages.map((m, i) => <MessageView key={i} m={m} />)}
            {s.commandRunning && <div className="busy">Running {s.commandRunning}…</div>}
            {s.busy && <div className="busy">Working…</div>}
          </div>
        </div>
        {showSessions && (
          <>
            <div className="sessions-backdrop" onClick={() => setShowSessions(false)} />
            <SessionsPanel rows={sessionRows}
              canRename={bridgeCaps?.sessionTitle === true}
              canDelete={bridgeCaps?.sessionArchive === true}
              deleteHint={bridgeCaps
                ? '删除该会话（当前 bridge 不支持归档：只清理本地记录，dsh 侧记录保留）'
                : '删除该会话（bridge 未连接：只清理本地记录，dsh 侧记录保留）'}
              onClose={() => setShowSessions(false)} />
          </>
        )}
      </div>

      {s.permission && (
        <div className="permission">
          <div className="perm-title">⚠ {s.permission.title}</div>
          <div className="perm-actions">
            {s.permission.options.map(o => (
              <button key={o.optionId} className={o.kind.startsWith('allow') ? 'allow' : 'reject'}
                onClick={() => post({ type: 'permissionResponse', requestId: s.permission!.requestId, optionId: o.optionId })}>
                {o.name}
              </button>
            ))}
            <button className="reject" onClick={() => post({ type: 'permissionResponse', requestId: s.permission!.requestId, optionId: null })}>Dismiss</button>
          </div>
        </div>
      )}

      {s.error && <div className="error-bar" onClick={() => dispatch({ clearError: undefined })}>{s.error} ✕</div>}

      {imageChips.length > 0 && (
        <div className="chips">
          {imageChips.map((img, i) => (
            <span key={`${img.name}-${i}`} className="chip">
              🖼 {img.name}
              <button className="chip-x" title="Remove" onClick={() => post({ type: 'removeImage', index: i })}>×</button>
            </span>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="chips">
          {chips.map(c => (
            <span key={c.path} className="chip">
              📄 {c.label}{c.selection ? `:${c.selection.startLine}-${c.selection.endLine}` : ''}
              <button className="chip-x" title="Remove" onClick={() => post({ type: 'removeChip', path: c.path })}>×</button>
            </span>
          ))}
        </div>
      )}

      {s.planMode && <div className="plan-mode">📋 Plan mode — the agent proposes a plan before acting</div>}
      <ChangesBar files={changedFiles} />
      <Composer
        busy={s.busy}
        sessionStarted={!!s.sessionId}
        results={fileResults.files}
        slashCommands={slashCommands}
        railLeft={<>
          {presets.length > 0 && (
            <RailSelect
              value={presetCurrent ?? presets.find(pr => pr.isDefault)?.id ?? ''}
              options={presets.map(pr => ({ value: pr.id, label: pr.name ?? pr.id, disabled: !!pr.broken, hint: pr.broken ? String(pr.broken) : undefined }))}
              onChange={v => post({ type: 'selectPreset', presetId: v })}
              title="Agent preset"
            />
          )}
          {model && model.type === 'select' && (
            <RailSelect
              value={model.currentValue}
              options={flattenOptions(model)}
              onChange={v => post({ type: 'selectConfig', configId: model.id, value: v })}
              title="Model"
            />
          )}
          {extraSelects.map(opt => (
            <RailSelect
              key={opt.id}
              value={opt.currentValue}
              options={opt.id === 'reasoning_effort' ? effortOptionsWithoutDefault(flattenOptions(opt)) : flattenOptions(opt)}
              onChange={v => post({ type: 'selectConfig', configId: opt.id, value: v })}
              title={opt.name}
            />
          ))}
        </>}
        railRightExtra={<>
          {bridgeCaps?.permissions && permOptions.length > 0 && <PermissionSelect options={permOptions} current={permCurrent} />}
          {imageCapable && <button className="icon-btn" title="Attach image" onClick={() => post({ type: 'pickImages' })}>📎</button>}
        </>}
        onQueryFiles={(reqId, query) => post({ type: 'fileSearch', reqId, query })}
        onSend={send}
        onRunCommand={runCommand}
      />
    </div>
  )
}
