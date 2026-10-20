/** host <-> webview message protocol. Both sides import these types. */
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import type { ChatMessage } from './chat.js'
import type { BridgeCapabilities } from '../bridge/client.js'

export interface ContextChip { path: string; label: string; selection?: { startLine: number; endLine: number } }

export type ToHost =
  | { type: 'ready' }
  | { type: 'prompt'; text: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'selectConfig'; configId: string; value: string }
  | { type: 'commandPicker'; kind: 'model' | 'effort' | 'permission' }
  | { type: 'runCommand'; line: string }
  | { type: 'exportSession' }
  | { type: 'permissionResponse'; requestId: string; optionId: string | null } // null = dismissed
  | { type: 'listSessions' }
  | { type: 'resumeSession'; sessionId: string }
  | { type: 'persistTranscript'; sessionId: string; messages: ChatMessage[] }
  | { type: 'removeChip'; path: string }
  | { type: 'addChip'; path: string; label: string }
  | { type: 'fileSearch'; reqId: number; query: string }
  | { type: 'openDiff'; path: string }
  | { type: 'reconnect' }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'selectPreset'; presetId: string }
  | { type: 'setPermission'; name: string }
  | { type: 'pickImages' }
  | { type: 'pasteImage'; name: string; mimeType: string; data: string }
  | { type: 'removeImage'; index: number }

export type ToWebview =
  | { type: 'bootstrap'; topology: string; workspaceName: string | undefined; logoUri?: string }
  | { type: 'sessionStarted'; sessionId: string; configOptions: SessionConfigOption[]; resumed?: boolean }
  | { type: 'configOptions'; configOptions: SessionConfigOption[] }
  | { type: 'sessionEnded' }
  | { type: 'update'; sessionId: string; update: SessionUpdate }
  | { type: 'busy'; busy: boolean }
  | { type: 'promptSettled'; sessionId: string; stopReason: string }
  | { type: 'permissionRequest'; requestId: string; title: string; description?: string; options: { optionId: string; name: string; kind: string }[] }
  | { type: 'permissionResolved'; requestId: string }
  | { type: 'sessions'; sessions: { sessionId: string; cwd?: string; title?: string; updatedAt?: string }[] }
  /** A session was deleted: drop the row right away (the refreshed `sessions`
   *  list follows). `archivedOnHost` is false for the bridge-less fallback,
   *  where only local state (archive marker, transcript, persisted data) was
   *  cleaned up. */
  | { type: 'sessionDeleted'; sessionId: string; archivedOnHost: boolean }
  | { type: 'chips'; chips: ContextChip[] }
  | { type: 'fileSearchResults'; reqId: number; files: { path: string; label: string }[] }
  | { type: 'changedFiles'; sessionId: string; files: { path: string; label: string; kind: 'created' | 'modified' }[] }
  | { type: 'capabilities'; image: boolean }
  | { type: 'bridge'; on: boolean; capabilities?: BridgeCapabilities }
  | { type: 'presets'; presets: { id: string; name?: string; description?: string; isDefault?: boolean; broken?: string | boolean }[]; current?: string | null }
  | { type: 'permission'; options: { value: string; name: string; description?: string }[]; current?: string }
  | { type: 'todo'; todos: { content: string; status: string }[] }
  | { type: 'planMode'; active: boolean }
  | { type: 'usage'; sessionId: string; text?: string }
  | { type: 'nativeCommands'; commands: { name: string; description?: string; inputHint?: string }[] }
  | { type: 'skills'; skills: { name: string; description?: string; whenToUse?: string }[] }
  | { type: 'commandResult'; sessionId: string; kind: 'success' | 'error'; text?: string }
  | { type: 'commandRunning'; sessionId: string; line?: string; running: boolean }
  | { type: 'imageChips'; images: { name: string; size: number }[] }
  | { type: 'transcript'; sessionId: string; messages: ChatMessage[] }
  | { type: 'error'; message: string }
  | { type: 'connectionState'; state: 'starting' | 'ready' | 'closed'; detail?: string }
