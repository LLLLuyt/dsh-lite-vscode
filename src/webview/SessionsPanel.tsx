/** In-webview sessions sidebar: click to resume; rename/delete appear when the
 *  dsh-vscode-bridge plugin reports the corresponding capabilities.
 *
 *  The delete button is ALWAYS rendered: when the bridge is unavailable the
 *  host can still delete the session locally, so the button only loses its
 *  bridge-specific behaviour and explains itself through the tooltip. Hiding
 *  it made the feature look non-existent. */
import React, { useState } from 'react'
import { post } from './vscode.js'
import { shortSessionId } from './sessionOrder.js'

export interface SessionRow { sessionId: string; cwd?: string; title?: string; updatedAt?: string }

export function SessionsPanel(props: {
  rows: (SessionRow & { active: boolean })[]
  canRename?: boolean
  /** Bridge archive capability. Undefined/false = local-only delete (still allowed). */
  canDelete?: boolean
  /** Tooltip for the local-only delete; the host explains the exact reason
   *  (bridge missing vs. bridge without sessionArchive). */
  deleteHint?: string
  onClose?: () => void
}): React.JSX.Element {
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  const commitRename = (id: string): void => {
    post({ type: 'renameSession', sessionId: id, title: draft })
    setRenaming(undefined)
  }
  const onDelete = (id: string): void => {
    if (confirming === id) { post({ type: 'deleteSession', sessionId: id }); setConfirming(undefined) }
    else { setConfirming(id); setTimeout(() => setConfirming(c => (c === id ? undefined : c)), 3000) }
  }
  const deleteHint = (): string => props.canDelete
    ? '删除该会话（需再点一次确认）'
    : props.deleteHint ?? '删除该会话（bridge 未连接：只清理本地记录，dsh 侧记录保留）'
  const { rows } = props
  return (
    <aside className="sessions">
      <div className="sessions-head">
        <span>会话</span>
        <span className="spacer" />
        <button className="icon-btn" title="刷新会话列表" onClick={() => post({ type: 'listSessions' })}>⟳</button>
        {props.onClose && <button className="icon-btn" title="关闭" onClick={props.onClose}>✕</button>}
      </div>
      <div className="sessions-list">
        {rows.length === 0 && <div className="hint">还没有会话</div>}
        {rows.map(r => (
          <div key={r.sessionId} className={`session-row${r.active ? ' active' : ''}`}
            title={`${r.sessionId}${r.updatedAt ? `\n${r.updatedAt}` : ''}`}
            onClick={() => !r.active && post({ type: 'resumeSession', sessionId: r.sessionId })}>
            {renaming === r.sessionId ? (
              <input
                className="session-rename" autoFocus value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => commitRename(r.sessionId)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(r.sessionId); if (e.key === 'Escape') setRenaming(undefined) }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="session-title"
                onDoubleClick={e => { if (props.canRename) { e.stopPropagation(); setRenaming(r.sessionId); setDraft(r.title ?? '') } }}>
                {r.active ? '● ' : ''}{r.title ?? shortSessionId(r.sessionId)}
              </span>
            )}
            <span className="session-actions" onClick={e => e.stopPropagation()}>
              {props.canRename && <button className="icon-btn" title="重命名" onClick={() => { setRenaming(r.sessionId); setDraft(r.title ?? '') }}>✎</button>}
              <button className={`icon-btn${confirming === r.sessionId ? ' danger' : ''}`}
                style={props.canDelete ? undefined : { opacity: 0.6 }}
                title={confirming === r.sessionId ? '再点一次确认删除' : deleteHint()}
                onClick={() => onDelete(r.sessionId)}>
                {confirming === r.sessionId ? '确认?' : '🗑'}
              </button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  )
}
