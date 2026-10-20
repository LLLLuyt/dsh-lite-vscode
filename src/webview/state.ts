/** Chat state machine for the webview: folds ACP session updates into renderable messages. */
import type { SessionConfigOption, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { ChatMessage } from '../shared/chat.js'
import type { ToWebview } from '../shared/messages.js'

export interface ChatState {
  connection: 'starting' | 'ready' | 'closed'
  connectionDetail?: string
  sessionId?: string
  configOptions: SessionConfigOption[]
  busy: boolean
  messages: ChatMessage[]
  permission?: { requestId: string; title: string; options: { optionId: string; name: string; kind: string }[] }
  planMode?: boolean
  /** Latest todo snapshot, rendered as the pinned task card (not in the message flow). */
  todos?: { content: string; status: string }[]
  /** Context usage text for the status rail (e.g. "12% · 9.2k/128k"). */
  usageText?: string
  /** Native dsh slash commands from the bridge (v0.1.3+ command.list). */
  nativeCommands?: { name: string; description?: string; inputHint?: string }[]
  /** Skill catalog from the bridge (v0.1.3+ skill.list). */
  skills?: { name: string; description?: string; whenToUse?: string }[]
  /** Line of the native command currently executing (compact can take a while). */
  commandRunning?: string
  error?: string
}

export const initialState: ChatState = { connection: 'closed', configOptions: [], busy: false, messages: [] }

function toolDetail(content: ToolCallContent[] | undefined): string | undefined {
  if (!content) return undefined
  return content.map(c => {
    if (c.type === 'content' && c.content.type === 'text') return c.content.text
    if (c.type === 'diff') return `--- ${c.path}\n${c.oldText ?? ''}\n+++ \n${c.newText}`
    return undefined
  }).filter(Boolean).join('\n\n')
}

/**
 * Human-friendly one-liner distilled from a tool call's raw input, mirroring
 * the DSH Web UI's tool rows ("Bash 阅读焊接异常定位小节"): the model-written
 * per-call description when present, then the primary target
 * (path / query / url / command).
 */
export function toolSubtitle(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const o = input as Record<string, unknown>
  for (const k of ['description', 'path', 'filePath', 'file_path', 'absPath', 'targetFile', 'target_file', 'query', 'pattern', 'url', 'uri', 'command', 'cmd', 'prompt']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) {
      const first = v.trim().split('\n')[0]
      return first.length > 120 ? `${first.slice(0, 117)}…` : first
    }
  }
  return undefined
}

export function applyUpdate(s: ChatState, u: SessionUpdate): ChatState {
  const messages = [...s.messages]
  const appendToLast = (kind: 'assistant' | 'thought', text: string): ChatState => {
    const last = messages[messages.length - 1]
    if (last && last.kind === kind) messages[messages.length - 1] = { ...last, text: last.text + text }
    else messages.push({ kind, text })
    return { ...s, messages }
  }
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return u.content.type === 'text' ? appendToLast('assistant', u.content.text) : s
    case 'agent_thought_chunk':
      return u.content.type === 'text' ? appendToLast('thought', u.content.text) : s
    case 'tool_call':
      messages.push({ kind: 'tool', id: u.toolCallId, title: u.title ?? 'tool', subtitle: toolSubtitle(u.rawInput), toolKind: u.kind ?? undefined, status: u.status ?? undefined, input: u.rawInput, output: u.rawOutput, detail: toolDetail(u.content ?? undefined) })
      return { ...s, messages }
    case 'tool_call_update': {
      const i = messages.findIndex(m => m.kind === 'tool' && m.id === u.toolCallId)
      if (i < 0) return s
      const prev = messages[i] as Extract<ChatMessage, { kind: 'tool' }>
      const detail = toolDetail(u.content ?? undefined)
      messages[i] = {
        ...prev,
        status: u.status ?? prev.status,
        title: u.title ?? prev.title,
        subtitle: toolSubtitle(u.rawInput) ?? prev.subtitle,
        input: u.rawInput ?? prev.input,
        output: u.rawOutput ?? prev.output,
        detail: detail ? (prev.detail ? prev.detail + '\n' + detail : detail) : prev.detail,
      }
      return { ...s, messages }
    }
    default:
      return s
  }
}

/** Tool-call detail pretty-printer: dsh dumps tool args as XML-ish blocks
 *  (`<path>…</path><type>…</type>`). Convert a fully-XML detail into key/value
 *  rows; anything mixed or prose stays raw text. */
export type ToolDetail = { kind: 'kv'; rows: { k: string; v: string }[] } | { kind: 'text'; text: string }

export function formatToolDetail(detail: string): ToolDetail {
  const trimmed = detail.trim()
  const rows: { k: string; v: string }[] = []
  const re = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g
  let pos = 0
  for (const m of trimmed.matchAll(re)) {
    if (m.index === undefined) break
    if (trimmed.slice(pos, m.index).trim()) return { kind: 'text', text: detail }
    rows.push({ k: m[1], v: m[2].trim() })
    pos = m.index + m[0].length
  }
  if (rows.length === 0 || trimmed.slice(pos).trim()) return { kind: 'text', text: detail }
  return { kind: 'kv', rows }
}

export type ChatAction =
  | { m: ToWebview }
  | { userSend: string }
  | { clearError: undefined }

export function reduce(s: ChatState, a: ChatAction): ChatState {
  if ('userSend' in a) return { ...s, messages: [...s.messages, { kind: 'user', text: a.userSend }], error: undefined }
  if ('clearError' in a) return { ...s, error: undefined }
  const m = a.m
  switch (m.type) {
    case 'connectionState': return { ...s, connection: m.state, connectionDetail: m.detail }
    case 'sessionStarted': return { ...s, sessionId: m.sessionId, configOptions: m.configOptions, messages: m.resumed ? s.messages : [], todos: undefined, usageText: undefined, nativeCommands: undefined, skills: undefined, commandRunning: undefined }
    case 'configOptions': return { ...s, configOptions: m.configOptions }
    case 'sessionEnded': return { ...s, sessionId: undefined, messages: [], todos: undefined, nativeCommands: undefined, skills: undefined, commandRunning: undefined }
    case 'transcript': {
      if (m.sessionId !== s.sessionId) return s
      // Older transcripts carry todo cards inline; lift the latest one into the pinned card.
      const lastTodo = [...m.messages].reverse().find(x => x.kind === 'todo')
      return { ...s, messages: m.messages, todos: lastTodo?.kind === 'todo' ? lastTodo.items : undefined }
    }
    case 'update': return m.sessionId === s.sessionId ? applyUpdate(s, m.update) : s
    case 'busy': return { ...s, busy: m.busy }
    case 'promptSettled': {
      // A round that ended for a reason other than a clean turn (token cap,
      // refusal, cancellation) used to look identical to success, so the user
      // never learned their answer had been truncated.
      const reason = m.stopReason
      const notice = reason === 'max_tokens'
        ? { kind: 'system' as const, text: '⚠ 已达输出上限，本轮回复被截断。' }
        : reason === 'refusal'
          ? { kind: 'system' as const, text: '⚠ 模型拒绝了本轮请求。' }
          : reason === 'cancelled' || reason === 'canceled'
            ? { kind: 'system' as const, text: '已取消。' }
            : undefined
      return {
        ...s,
        busy: false,
        messages: notice ? [...s.messages, notice] : s.messages,
      }
    }
    case 'permissionRequest': return { ...s, permission: { requestId: m.requestId, title: m.title, options: m.options } }
    case 'permissionResolved': return { ...s, permission: undefined }
    case 'todo': return { ...s, todos: m.todos }
    case 'usage': return m.sessionId === s.sessionId ? { ...s, usageText: m.text } : s
    case 'nativeCommands': return { ...s, nativeCommands: m.commands }
    case 'skills': return { ...s, skills: m.skills }
    case 'commandRunning': return m.sessionId === s.sessionId ? { ...s, commandRunning: m.running ? m.line : undefined } : s
    case 'commandResult': {
      if (m.sessionId !== s.sessionId) return s
      const text = m.text ?? (m.kind === 'success' ? 'Command completed.' : 'Command failed.')
      return { ...s, messages: [...s.messages, { kind: 'system', text: `${m.kind === 'success' ? '✓' : '✖'} ${text}` }] }
    }
    case 'planMode': return { ...s, planMode: m.active }
    // Do NOT clear busy here: an unrelated failure (e.g. switching model) used
    // to flip the composer's send button back to ➤ while the agent was still
    // running. Busy is owned by the explicit 'busy' messages.
    case 'error': return { ...s, error: m.message }
    default: return s
  }
}
