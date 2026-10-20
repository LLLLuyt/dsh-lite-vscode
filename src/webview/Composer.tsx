/** Composer with @-mention file completion and a Web-UI-style slash-command
 *  menu: typing "/" opens the command picker, typing "@query" the file picker. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { post } from './vscode.js'
import { filterSlashCommands, findSlashCommand, NATIVE_COMMAND_FILL, type SlashCommand } from './slash.js'

export interface FilePick { path: string; label: string }

export function Composer(props: {
  busy: boolean
  sessionStarted: boolean
  results: FilePick[]
  slashCommands: SlashCommand[]
  railLeft?: React.ReactNode
  railRightExtra?: React.ReactNode
  onQueryFiles: (reqId: number, query: string) => void
  onSend: (text: string) => void
  /** Typed or picked native dsh command lines ("/compact", "/plan off"). */
  onRunCommand: (line: string) => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [atState, setAtState] = useState<{ start: number; query: string; reqId: number } | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [slash, setSlash] = useState<{ query: string } | undefined>(undefined)
  const [slashSel, setSlashSel] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const atListRef = useRef<HTMLDivElement>(null)
  const slashListRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined)

  const closeAt = useCallback(() => setAtState(undefined), [])
  const closeSlash = useCallback(() => setSlash(undefined), [])

  const detectAt = (text: string, caret: number): void => {
    if (text.startsWith('/')) { closeAt(); return } // slash menu owns the leading token
    const before = text.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!m) { closeAt(); return }
    const query = m[2]
    const start = caret - query.length - 1
    setAtState({ start, query, reqId: -1 })
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const reqId = ++reqSeq.current
      setAtState(st => (st && st.query === query ? { ...st, reqId } : st))
      props.onQueryFiles(reqId, query)
    }, 150)
  }

  /** Slash menu: open while the whole input is a single "/token" (no space yet). */
  const detectSlash = (text: string): void => {
    const m = /^\/(\S*)$/.exec(text)
    setSlash(m ? { query: m[1] } : undefined)
  }

  const slashItems = slash ? filterSlashCommands(props.slashCommands, slash.query) : []

  const pick = (f: FilePick): void => {
    if (!atState) return
    // Remove the `@query` text; the chip carries the reference.
    const next = input.slice(0, atState.start) + input.slice(atState.start + atState.query.length + 1)
    setInput(next)
    post({ type: 'addChip', path: f.path, label: f.label })
    closeAt()
    taRef.current?.focus()
  }

  const runSlash = (cmd: SlashCommand): void => {
    closeSlash()
    if (cmd.run === 'native') {
      // Commands taking input (hint, or plan/goal by policy) fill `/name ` so
      // the user can append arguments; the Enter interception below runs the
      // completed line via command.run. Only argument-free commands run at once.
      if (cmd.hint || NATIVE_COMMAND_FILL.has(cmd.name)) { setInput(`/${cmd.name} `); taRef.current?.focus() }
      else { setInput(''); props.onRunCommand(`/${cmd.name}`) }
      return
    }
    if (cmd.run === 'skill') {
      // Skills never auto-send: fill `/name ` and let the user describe the
      // task; Enter routes the line through the skill prompt template.
      setInput(`/${cmd.name} `)
      taRef.current?.focus()
      return
    }
    switch (cmd.name) {
      case 'file':
        setInput('@')
        detectAt('@', 1)
        taRef.current?.focus()
        return
      case 'image':
        setInput('')
        post({ type: 'pickImages' })
        return
      case 'model':
      case 'effort':
      case 'permission':
        setInput('')
        post({ type: 'commandPicker', kind: cmd.name })
        return
      case 'export':
        setInput('')
        post({ type: 'exportSession' })
        return
      case 'new':
        setInput('')
        post({ type: 'newSession' })
        return
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        post({ type: 'pasteImage', name: f.name || 'pasted-image.png', mimeType: f.type, data: dataUrl.split(',')[1] ?? '' })
      }
      reader.readAsDataURL(f)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Never steal keys mid-IME-composition (pinyin etc.): Enter confirms the
    // candidate there, it must not select menu items or send the prompt.
    if (e.nativeEvent.isComposing) return
    // Shift+Enter is always a newline, even while a completion menu is open:
    // the menu branches below used to claim it (Enter || Tab, no shift check),
    // so pressing Shift+Enter while typing "/" ran a command and while typing
    // "@" inserted a file chip.
    const newlineIntent = e.key === 'Enter' && e.shiftKey
    if (slash && !newlineIntent) {
      if (slashItems.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel(i => Math.min(i + 1, slashItems.length - 1)); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel(i => Math.max(i - 1, 0)); return }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slashItems[Math.min(slashSel, slashItems.length - 1)]); return }
      }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return }
    }
    if (atState && props.results.length > 0 && !newlineIntent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(i + 1, props.results.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(props.results[Math.min(sel, props.results.length - 1)]); return }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = input.trim()
      if (!text || props.busy) return
      // Manually typed "/name [args]" naming a known command is executed, not
      // sent to the model — same as picking it from the menu.
      const resolved = findSlashCommand(props.slashCommands, text)
      setInput('')
      if (resolved?.kind === 'native') props.onRunCommand(resolved.line)
      else if (resolved?.kind === 'local') runSlash(resolved.cmd)
      else if (resolved?.kind === 'skill') props.onSend(`请使用 ${resolved.name} 技能${resolved.rest ? `：${resolved.rest}` : ''}`)
      else props.onSend(text)
    }
  }

  useEffect(() => setSel(0), [props.results])
  useEffect(() => setSlashSel(0), [slash?.query])
  /** Grow the textarea with its rendered content, capped so a pasted essay
   *  doesn't swallow the conversation. */
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [input])
  // Keyboard navigation must keep the highlighted row visible in the
  // scrollable dropdowns.
  useEffect(() => {
    atListRef.current?.querySelector('.at-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  useEffect(() => {
    slashListRef.current?.querySelector('.slash-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [slashSel])

  return (
    <footer className="composer">
      {atState && props.results.length > 0 && (
        <div className="at-dropdown" ref={atListRef}>
          {props.results.map((f, i) => (
            <div key={f.path} className={`at-item${i === sel ? ' sel' : ''}`}
              onMouseDown={e => { e.preventDefault(); pick(f) }}
              onMouseEnter={() => setSel(i)}>
              📄 {f.label}
            </div>
          ))}
        </div>
      )}
      {slash && slashItems.length > 0 && (
        <div className="at-dropdown slash-dropdown" ref={slashListRef}>
          {slashItems.map((c, i) => (
            <React.Fragment key={`${c.section}-${c.name}`}>
              {(i === 0 || slashItems[i - 1].section !== c.section) && <div className="slash-section">{c.section}</div>}
              <div className={`at-item slash-item${i === slashSel ? ' sel' : ''}`}
                onMouseDown={e => { e.preventDefault(); runSlash(c) }}
                onMouseEnter={() => setSlashSel(i)}>
                {c.label && c.label !== c.name ? <span className="slash-label">{c.label}</span> : null}
                <span className="slash-name">{c.name}</span>
                <span className="slash-desc">{c.description}</span>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={input}
        placeholder={props.sessionStarted ? '向 dsh 提问…（@ 引用文件，/ 唤起命令，Enter 发送，Shift+Enter 换行）' : '输入内容以开始对话…'}
        onChange={e => { setInput(e.target.value); detectAt(e.target.value, e.target.selectionStart ?? e.target.value.length); detectSlash(e.target.value) }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => setTimeout(() => { closeAt(); closeSlash() }, 150)}
        // Height follows the RENDERED content (soft wraps included), not the
        // newline count: a long wrapped paragraph used to stay at one row and
        // scroll internally after ~3 lines.
        rows={1}
      />
      <div className="rail">
        {props.railLeft}
        <span className="spacer" />
        {props.railRightExtra}
        {props.busy
          ? <button className="send stop" title="Stop" onClick={() => post({ type: 'cancel' })}>■</button>
          : <button className="send" title="Send" disabled={!input.trim()} onClick={() => { const t = input.trim(); if (t) { setInput(''); props.onSend(t) } }}>➤</button>}
      </div>
    </footer>
  )
}
