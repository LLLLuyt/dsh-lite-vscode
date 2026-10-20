# DSH Lite — DeepSeek Harness for VS Code

Chat with the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent inside VS Code: sessions, streaming replies, tool-call cards, permission prompts, model/effort/preset pickers, change review, and `@`-mentions — built on the standard [Agent Client Protocol](https://agentclientprotocol.com) (ACP), like the Claude Code and Codex extensions.

## Features

- **Chat view** with markdown rendering, thought folds, tool cards (structured key/value args), and a sessions sidebar
- **Session management** — list / resume / rename / delete, local transcript cache
- **Delete works with or without the bridge plugin** — the button is always available; without the bridge it falls back to a local-only delete and says so in the tooltip
- **Open the conversation as a full editor tab** (`DSH: Open Chat in Editor Area`) or in a separate window, like the Claude Code extension
- **Collapsible session drawer** — overlays the conversation instead of shrinking it; click the backdrop or ✕ to dismiss
- **Model, reasoning-effort, agent-preset, and permission-mode pickers** in the composer rail
- **Change review** — files the agent touches are tracked live; open a native diff against `HEAD` per file
- **`@` file mentions** and editor-context attachment; **image attachments** (paste or picker, when the route supports them)
- **`@dsh` chat participant** in the native Chat view, and **DSH: Explain Selection** for one-shot code explanations
- **Todo cards / plan-mode banner** streamed from the agent (bridge plugin)
- Cross-environment: run dsh on Windows, in WSL, or inside a Remote-WSL window (see [Topologies](#topologies))
- **Windows-native bridge install** — `DSH: Install/Repair Bridge Plugin` works on Windows without WSL (previously a POSIX-only no-op)

### Using third-party models (e.g. WorkBuddy)

This extension talks to whatever model providers your `dsh` profile exposes, so any provider plugin works without changes here. For example, to use the models bundled with the WorkBuddy desktop app, install [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) **into the profile this extension boots** (`acp-vscode`):

```sh
dsh plugin --profile acp-vscode add dsh-workbuddy-connect@<version>
```

Pick the version that matches your `dsh` core — see that project's README for the compatibility table (a mismatched plugin is skipped by the host, which surfaces as `no adapter registered for provider "workbuddy-ai"`). Then add the plugin name to `dsh.profile.bundles` in `~/.dsh/profiles/acp-vscode/package.json`, since `plugin add` only installs the dependency on an existing profile. Restart the extension and the provider's models appear in the model picker.

Note: `dsh` allows one writer per session. If the same session is open in the Desktop app or the Web UI, resuming it here fails with a lock error — close it on the other side first.

## Requirements

- **Node.js ≥ 22.19** on the side where dsh runs (the dsh CLI requires `^22.19.0 || >=24.0.0`; nvm/volta/mise are picked up automatically)
- **DeepSeek Harness** — installed (`npm i -g @deepseek-ai/dsh`), used via `npx`, or from a repository checkout
- **dsh-vscode-bridge** dsh plugin (**required**) — the `DSH: Install/Repair Bridge Plugin` command wires it in (creates the default `acp-vscode` profile, registers the service rows, installs the plugin). It powers session titles, delete, presets, permission modes, workspace grouping, todo/plan push, native slash commands, skill catalog, and session-log export.

### Version matching

| dsh-lite-vscode | DeepSeek Harness | dsh-vscode-bridge |
|---|---|---|
| **0.3.0** | 0.2.0-rc.x | ≥ 0.3.0 |
| **0.3.0** | 0.1.7-rc.2 | ≥ 0.3.0 |
| **0.3.0** | 0.1.7-rc.1 | ≥ 0.2.0 |
| **0.3.0** | 0.1.5-rc.2 | 0.1.3 – 0.2.x (bridge 0.3.0 dropped 0.1.5 — the installer pre-fills `dsh-vscode-bridge@^0.2.0` there) |
| 0.2.2 | 0.1.7-rc.1 | ≥ 0.2.0 |
| 0.2.2 | 0.1.5-rc.2 | 0.1.3 – 0.2.x |
| ≤ 0.2.1 | 0.1.5-rc.2 | 0.1.3 – 0.2.x |
| ≤ 0.2.1 | 0.1.7-rc.1 | ✗ not supported (the profile wiring references the removed `dsh-agent-presets` package) |

Only the host tags above are tested; other 0.1.x releases are unverified. The installer probes the host `dsh --version` and writes the profile rows matching its cohort — the 0.1.7 row set fits 0.2.0 hosts unchanged — and pre-fills `dsh-vscode-bridge@^0.3.0` as the package spec. On 0.1.7+ hosts it also migrates profiles written by older installers (removes the stale `dsh-agent-presets` row, adds the declarative `agent-preset-registry` + preset declarations).

## Quick start

1. Install this extension (`.vsix` or build from source — see [Development](#development)).
2. On first run, the **DSH Lite Setup** page opens: pick where dsh runs and how to launch it. Reopen anytime with `DSH: Setup`.
3. Run **`DSH: Install/Repair Bridge Plugin`** (required): creates the default `acp-vscode` dsh profile, wires the services, and installs the bridge plugin.
4. Open the **DSH** view in the activity bar — the agent boots automatically, and a session is created for you.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dsh.runtime` | `auto` | Where the agent process runs: `auto` (same side as the extension host), `wsl`, or `windows` |
| `dsh.command` | `npx -y @deepseek-ai/dsh` | Launch command on the target side; the extension appends `--profile <dsh.profile>` |
| `dsh.profile` | `acp-vscode` | dsh profile to boot; the default is created by the required bridge install. `acp` runs bridge-less |
| `dsh.wsl.distro` | `""` | WSL distribution name when `dsh.runtime` is `wsl` (empty = default) |
| `dsh.env` | `{}` | Extra environment variables for the dsh process (e.g. `DEEPSEEK_API_KEY`) |
| `dsh.mcpServers` | `[]` | MCP servers mounted on every new session (prefer `DSH: Configure MCP Servers`) |
| `dsh.autoAttachActiveFile` | `false` | Attach the active editor file/selection to every prompt |

## Topologies

| VS Code window | dsh runs | Setting |
|---|---|---|
| Windows | Windows | `auto` |
| Windows | WSL | `wsl` |
| Remote-WSL | WSL | `auto` |
| Remote-WSL | Windows | `windows` (best-effort: WSL-native files appear as slow `\\wsl$` UNC paths; the bridge channel is unavailable in this direction) |

Path translation between the VS Code side and the dsh side is automatic (`wslpath` probing + drvfs prefix mapping).

## Commands

| Command | What it does |
|---|---|
| `DSH: Setup` | Open the setup page (runtime/command/distro/profile) |
| `DSH: New Session` | New session (an untouched empty session is reused instead) |
| `DSH: Install/Repair Bridge Plugin` | Idempotent bridge installer/repairer on the target side |
| `DSH: Doctor` | Probe node/dsh availability **on the dsh side**, and report the bridge connection with its host dsh version |
| `DSH: Show Agent Changes` | QuickPick over agent-changed files → native diff |
| `DSH: Configure MCP Servers` | Add/remove MCP servers (stdio/HTTP) mounted on new sessions |
| `DSH: Explain Selection` | One-shot explanation of the selected code in a preview tab |
| `DSH: Run in Terminal` | Launch the dsh TUI in an integrated terminal (topology-aware) |
| `DSH: Focus Chat` / `DSH: Refresh Sessions` | View utilities |
| `DSH: Open Chat in Editor Area` | Open the conversation as a full editor tab |
| `DSH: Open in New Window` | Continue in a separate VS Code window |

## Troubleshooting

Everything the agent process prints lands in the **DSH** output channel; bridge connection state is logged there too.

- **Chat stuck on “Initializing…”** → run `DSH: Doctor`. Common causes: nvm-managed node not on the non-interactive PATH (the extension sources nvm/volta/mise/asdf quietly; otherwise use an absolute node path in `dsh.command`), wrong distro, or a non-ACP profile (`web`/`tui`/`desktop` are rejected with a warning).
- **First `npx` run times out** → it downloads the package; install once (`npm i -g @deepseek-ai/dsh`) or point `dsh.command` at a checkout.
- **“no API key for provider route”** → configure the key once in the dsh Web UI Models page (shared via `$DSH_HOME`), or set `dsh.env.DEEPSEEK_API_KEY`.
- **“no adapter registered for provider …”** → the model-provider plugin in your profile doesn't match the installed `dsh` core; the host skips it. Install the matching plugin version (see the provider's compatibility table).
- **Bridge features missing** (titles/delete/presets/permissions) → run `DSH: Install/Repair Bridge Plugin`; the bridge is required (see the [version table](#version-matching)).
- **“profile "acp-vscode" does not exist” on startup** → the default profile is created by the bridge installer; run `DSH: Install/Repair Bridge Plugin`.
- **Session “is held by another dsh instance”** → `dsh` allows one writer per session. Close it in the other surface (Desktop app, Web UI, or another window) first, or use a different session.
- **Custom models gone / “no adapter registered for provider …” after a dsh 0.1.7-rc.1 upgrade** → 0.1.7-rc.1 made model providers per-profile (the global `settings.yaml` was folded into the profile that booted first and renamed to `settings.yaml.imported`). Copy the `llm-pi-ai` section into the profile's `cordis.patch.yml` — the installer prints this hint when it detects the migration.

## Credits

A fork of [EPCN-fla/dsh-lite-vscode](https://github.com/EPCN-fla/dsh-lite-vscode), which does the heavy lifting: the ACP client, the bridge plugin, the webview, and the launcher. This fork adds the Windows bridge installer, editor-area chat, session deletion without the bridge, and a set of UX and reliability fixes. MIT, same as upstream.


## Development

```sh
npm install
npm run build       # bundle extension + webview into dist/
npm run watch       # incremental
npm test            # unit tests (node:test, esbuild-bundled)
npm run typecheck   # strict tsc
npm run smoke       # headless ACP contract test against a real dsh (DSH_COMMAND=… to override)
npm run package     # produce a .vsix

# publishing (needs a publisher PAT):
VSCE_PAT=<azure-devops-pat> npm run publish:marketplace   # VS Code Marketplace
OVSX_PAT=<open-vsx-pat>     npm run publish:ovsx          # Open VSX
```

Tag pushes (`v*`) run the full pipeline in `ci.yml`: the ubuntu+windows matrix (typecheck, unit tests, ACP contract smoke against the published dsh) must pass before the `.vsix` is built and released to GitHub; marketplace publishing turns on via the `VSCE_PUBLISH`/`OVSX_PUBLISH` repo variables once the PAT secrets exist.

Press `F5` for an Extension Development Host with this project opened.

```
src/launcher/   topology detection, process launch specs, WSL↔Windows path mapping
src/acp/        typed ACP client + shared service (vscode-free core)
src/bridge/     dsh-vscode-bridge client + centralized discovery (>=0.1.2)
src/chat/       chat view host: sessions, permissions, context, transcripts, changes
src/webview/    React chat UI (RailSelect, sessions sidebar, todo/plan, welcome)
src/setup/      first-run setup webview panel
src/shared/     host↔webview protocol + pure helpers
tests/          node:test suites (launcher matrix, session ordering, bridge protocol, …)
scripts/        smoke test + icon generator
```

## License

[MIT](LICENSE)
