# Changelog

All notable changes to DSH Lite are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [0.3.1] — 2026-10-20

Fork of EPCN-fla/dsh-lite-vscode. See [Credits](README.md#credits).

### Added
- **Windows-native bridge install**: `DSH: Install/Repair Bridge Plugin` now wires the `acp-vscode` profile on Windows instead of refusing to run (the POSIX bash installer was the only path, so Windows users could never install the required bridge)
- **Editor-area chat** (`DSH: Open Chat in Editor Area`) and **open in new window**
- **Session delete without the bridge**: always-visible delete button with a local-only fallback; the button no longer vanishes when bridge capabilities are missing
- **Claude Code-style conversation layout** (row-aligned messages, left-rail tool rows)
- **Collapsible session drawer** that overlays the conversation instead of shrinking it

### Fixed
- **Bridge never connected on Windows** (discoveryDir() treated `host === 'windows'` as an unsupported topology, so every Windows user saw the install prompt forever, uuid titles, and a 3s reconnect loop)
- **Bridge requests had no timeout**: one wedged connection pinned the reconnect promise and every later poll merged into it
- **Cold start reported `closed` instead of `starting`**, painting "not connected" for the whole boot window
- **Reconnect race**: a retired socket's async close tore down the newly established connection
- **Session titles showed the literal `session-` prefix** (and a failed title lookup was cached permanently)
- **Forced scroll-to-bottom on every token** made reading earlier messages impossible
- **Shift+Enter was stolen** by the slash/mention menus
- **No busy feedback on the first prompt**; a competing prompt left the composer stuck
- **Windows delete never removed data** (`deleteSessionData` was a bash script)
- Posting into a disposed editor panel (detachPanel was never called)
- `installScript.ts` was written with CRLF, which would have injected `\r` into the generated POSIX script and silently broken WSL installs
## [0.3.0] — 2026-10-08

### Added

- **DeepSeek Harness 0.2.0-rc.x and 0.1.7-rc.2 support** (see the README [version matrix](README.md#version-matching)): the bridge pairing moves to `dsh-vscode-bridge@^0.3.0` (corridor `0.1.7-rc.x || >=0.2.0-rc.1 <0.2.0`), and the profile row set the installer writes on 0.1.7 hosts fits 0.2.0 hosts unchanged. DSH 0.1.5 hosts stay on bridge 0.2.x (bridge 0.3.0 moved 0.1.5 out of its support corridor)
- **Host-aware bridge install**: `DSH: Install/Repair Bridge Plugin` detects the host dsh version before prompting — a connected bridge reports it on the handshake (bridge ≥ 0.2.1), otherwise `dsh --version` is probed on the target side — and pre-fills the matching package line (`^0.3.0` for 0.1.7/0.2.0 hosts, `^0.2.0` for 0.1.5 and older)
- **The doctor reports the bridge state**: connection, plugin version, and the bridge-reported host dsh version; the bridge connect log also flags hosts outside the tested corridor

### Changed

- **Node.js floor raised to 22** (20 dropped): matches the dsh CLI's `^22.19.0 || >=24.0.0` engines on the target side; the extension bundle targets node22 and requires VS Code ≥ 1.101 (the first release whose extension host runs Node 22)
- **The startup session is created only after the chat panel has rendered** — a restored view at window startup resolves long before its bundle paints, and agent-ready used to win that race

### Fixed

- **Bridge client corrupted multibyte characters split across TCP chunks** (CJK session titles, permission prompts): inbound frames now decode through an incremental `StringDecoder`, mirroring the bridge 0.3.0 server-side fix
- The ACP handshake reports the real extension version instead of the hardcoded `0.0.1`
- MCP HTTP header rows with a missing/non-string `value` are dropped instead of crossing the wire
- The in-code `dsh.profile` fallback matches the manifest default (`acp-vscode`)
- Setup panel: re-opening focuses the existing panel instead of stacking, the first-run auto-open timer is cancelled on extension shutdown, and the page carries a Content-Security-Policy

## [0.2.2] — 2026-09-30

### Added

- **DeepSeek Harness 0.1.7-rc.1 support** (see the README [version matrix](README.md#version-matching)):
  - The bridge installer probes the host `dsh --version` and writes the profile rows matching its cohort: 0.1.5 hosts keep the monolithic `dsh-agent-presets` row, while 0.1.7 hosts get the declarative split — an `agent-preset-registry` row plus one `dsh-agent-preset` declaration per shipped preset (standard/ptc/minimal/cordis) — so the preset picker survives the upstream removal (DSH-0.1.7-J1-03)
  - The preset declarations are vendored from the host cohort (re-vendor on host bumps with `node scripts/sync-presets.mjs`); drift degrades per-preset into a marked-broken roster entry, never into a composition failure
  - **Existing profiles are migrated in place** on 0.1.7 hosts: the stale `dsh-agent-presets` row is stripped (backup at `cordis.patch.yml.bak`) and the preset rows appended when missing — older installers (and the pre-0.2.0 bridge README) left profiles that no longer compose those rows
  - When the 0.1.7 per-profile settings migration is detected (`settings.yaml.imported` present, no `llm-pi-ai` row in the profile), the installer prints where to copy custom model providers from

### Changed

- **dsh-vscode-bridge is now required**: `dsh.profile` defaults to `acp-vscode` (created by the install flow), and the install nudge fires when the bridge never connects after boot or the dsh process dies before first becoming ready (which is how a missing default profile surfaces). The dismissal key was versioned (`dsh.bridgePrompt.dismissed.v2`) so users who dismissed the old optional nudge still see the required one
- Installer default bridge package: `dsh-vscode-bridge@^0.2.0`
- The installer writes the permission-preset descriptions in English

### Fixed

- **`spawn ENAMETOOLONG` on the Windows → WSL install path**: the generated script (≈60 KB with the preset rows) exceeded the Windows CreateProcess command-line limit when passed as an argument to `wsl.exe`; it is now piped to `bash -s` over stdin on both transport shapes
- **Reasoning effort ignored the model's `defaultEffort` on 0.1.7 hosts** — every model switch pinned `max`: the defaults map read the global `settings.yaml`, which 0.1.7 folds into the booting profile and renames to `settings.yaml.imported`. The active profile's `cordis.patch.yml` is now layered over the legacy file
- **Preset mount refusals on 0.1.7 hosts mark the preset broken again**: the registry rejects with `RemoteError('agent-preset/invalid')` (forwarded as `data.code`), which the `/failed to mount/` message match never saw; both forms are recognized. The `preset.list` `broken` field is also typed as the string it always was on the wire
- **Deleting a session with a running turn on a 0.1.7 host** no longer strands local state half-torn-down: the host archive runs first, and a `session/active` refusal just asks you to stop the session — local state stays intact
- A pending install-nudge timer could fire while the extension host was tearing down for a window reload

## [0.2.1] — 2026-09-29

### Fixed

- **Blank-session model/effort reset on the first send**: the startup session was stamped with the client generation read *before* the agent finished starting, so the first prompt took the restart re-attach path, hit "already active", and silently recreated the session at the deployment default (DeepSeek-V4-Flash). The generation is now stamped after the await, an "already active" answer is adopted instead of recreated, and `ensureSession` is serialized so prompts can no longer race a re-attach
- **Switching to a session owned by another dsh instance (e.g. still open in the Web UI) no longer breaks the chat**: the switch now resumes the target *before* closing the current session, lock contention surfaces a clear "session busy in another instance" explanation instead of a raw internal error, and a failed request no longer paints the connection indicator red — it reflects the service's actual state
- **No way back from a dropped connection**: the red status dot is now a reconnect button, and the empty state offers a reconnect action (the `.reconnect` style existed but nothing rendered it)
- **A session the server forgot without a connection drop** (e.g. a plugin hot-reload disposed it) is now marked stale and transparently re-attached from persistence on the next prompt, instead of failing with "unknown session" forever
- **Restart re-attach restores the pre-restart model/effort**: a resumed session only knows its last *logged* route, so a blank session (or a model switch after the last prompt) used to come back at the default; the picks are now replayed when they diverge
- **Sessions created outside the client (e.g. in the Web UI) rendered as empty chats**: ACP resume does not replay history and the local transcript cache only knows home-grown sessions. On switch, the transcript is now rebuilt once from the durable dsh log via the bridge's `session.exportZip` (user prompts, assistant text/reasoning, tool calls and results) and cached locally
- **`preset.current` echo after `preset.select`** no longer errors when the session was switched or closed mid-select

### Added

- **Remembered model + reasoning effort for new sessions**: the last selection (`dsh.lastModelSelection`) is replayed onto every freshly created session — no more DeepSeek-V4-Flash by default. Values that disappeared from the catalog fall back to the provider default gracefully
- `scripts/verify-fixes.ts` (`npm run verify:fixes`): end-to-end harness that drives the real `ChatViewProvider` against a live dsh through the blank-session switch/send flow, the lock-contention switch, and a kill+reconnect recovery
- Headless regression tests for the three fixes (vscode API mocked, ACP service faked)

## [0.2.0] — 2026-09-21

### Added

- **Slash-command menu** in the composer (Web-UI style): typing `/` opens grouped 指令/技能 sections with substring filtering, arrow-key navigation that scrolls the selection into view, and IME-safe key handling
  - Extension commands: `/file`, `/image`, `/model`, `/effort`, `/permission`, `/new`, `/export`
  - With **dsh-vscode-bridge ≥ 0.1.3**: native dsh commands via `command.list`/`command.run` (compact, plan, goal, …), the skill catalog via `skill.list`, and session-log ZIP export via `session.exportZip` (path mapped back to the host, reveal/copy actions)
  - Typed `/name args` lines are intercepted and executed instead of reaching the model; commands taking input and all skills only fill the composer so a prompt can be appended (`请使用 <name> 技能：<args>`)
  - Long-running commands show a `Running /compact…` indicator; results land as ✓/✖ system messages routed to the originating session; pre-0.1.3 bridges get an in-transcript upgrade hint
  - The native command list refetches when the agent preset changes (the registry is agent-scoped); known commands carry the Web UI's Chinese labels
- **Tool-call cards**: Web-UI-style subtitles distilled from raw input (per-call description first), plus labeled input/result/output sections in the expanded fold
- **Copy buttons**: icon-only, hover-revealed — below user bubbles and at the bottom of assistant output
- **Pinned, collapsible task card** with a done/total counter and a background tint
- **Token usage in the VS Code status bar**: orca icon 🐳, model name, and per-session context usage persisted across window reloads
- **Bridge v0.1.2 support**: new sessions are filed into their workspace via `workspace.attach` right after ACP `newSession`

### Fixed

- **Startup session stacking**: the previous session (empty ones included) is resumed first and a new one created only when nothing resumes; the persisted id now survives window reloads, and first prompts are serialized behind the restore
- **`dsh.installBridge`**: writes a valid `cordis.patch.yml` per the bridge README (untouched-template replacement, single insert list, permission metadata)
- **Empty tool folds** always show at least the call's raw input
- **Select menus** size to their content; the composer rail wraps instead of overflowing
- **"session-" rows**: untitled sessions strip the id prefix before slicing
- Resuming a session without local history shows the welcome screen instead of a synthetic "Session resumed" notice
- Tool detail text renders in a CJK-friendly font stack (no more 宋体 fallback)
- Composer keys during IME composition no longer trigger menu picks or sends

### Changed

- Recommended bridge minimum: **dsh-vscode-bridge ≥ 0.1.3** (installer default and README updated)

## [0.1.0] — 2026-09-19

Initial public release.

### Features

- **Chat view** with markdown rendering, thought folds, structured tool-call cards, and a sessions sidebar (stable ordering, click to resume)
- **Four runtime topologies** — Windows, Windows→WSL, Remote-WSL, and Remote-WSL→Windows (best-effort) — with automatic path translation and a shell environment bootstrap (nvm/volta/mise/asdf)
- **Composer rail**: agent preset, model, and reasoning-effort pickers plus permission modes; `@` file mentions; image attachments (paste or picker, capability-gated)
- **Change review**: files touched by the agent are tracked live (file watcher + git fallback) with native diff against `HEAD`
- **`@dsh` chat participant** in the native Chat view; **DSH: Explain Selection** one-shot explanations
- **Bridge plugin integration** ([dsh-vscode-bridge](https://www.npmjs.com/package/dsh-vscode-bridge) ≥ 0.1.1): native session titles, rename/delete, agent presets, permission modes, todo cards, plan-mode banner, and workspace grouping in the DSH Web UI — discovered via the centralized `$DSH_HOME/vscode-bridge/<pid>.json` registry
- **First-run setup page**, environment doctor, one-shot bridge installer/repairer
- Chinese and English UI strings; dark/light theme-aware throughout
