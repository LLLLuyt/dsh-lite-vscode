/**
 * Editor-area chat panel: the same agent conversation as the sidebar view, but
 * opened as a full editor tab (like Claude Code's "Open in New Tab").
 *
 * Design: `ChatViewProvider` owns the session/agent logic and is bound to a
 * `WebviewView` (sidebar). Rather than duplicating that logic, this panel asks
 * the provider for its HTML and forwards messages into the same provider
 * instance. To keep both surfaces coherent, `ChatViewProvider` exposes
 * `attachPanel`/`detachPanel`, which retarget outbound posts and inbound
 * messages at whichever surface was interactive most recently.
 *
 * The provider already tolerates a single active webview (its `post()` no-ops
 * when absent and `resolveWebviewView` is called once per view), so the panel
 * mirrors that contract: whichever surface is visible receives the stream.
 */
import * as vscode from 'vscode'
import type { ChatViewProvider } from './ChatViewProvider.js'

export class ChatPanel {
  private static current: ChatPanel | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []

  private constructor(panel: vscode.WebviewPanel, private readonly chat: ChatViewProvider, private readonly ctx: vscode.ExtensionContext) {
    this.panel = panel
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(ctx.extensionUri, 'dist'),
        vscode.Uri.joinPath(ctx.extensionUri, 'media'),
      ],
    }
    panel.webview.html = chat.panelHtml(panel.webview)
    chat.attachPanel(panel.webview)
    this.disposables.push(
      panel.webview.onDidReceiveMessage(m => void chat.panelOnMessage(m)),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  static open(ctx: vscode.ExtensionContext, chat: ChatViewProvider, column: vscode.ViewColumn = vscode.ViewColumn.Active): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column)
      return ChatPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      'dsh.chatPanel',
      'DSH Lite',
      column,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    )
    ChatPanel.current = new ChatPanel(panel, chat, ctx)
    return ChatPanel.current
  }

  static get isOpen(): boolean { return ChatPanel.current !== undefined }

  dispose(): void {
    ChatPanel.current = undefined
    // Stop posting into a disposed webview: post() targets the panel too, and
    // messaging a dead webview rejects the underlying promise.
    this.chat.detachPanel()
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.panel.dispose()
  }
}
