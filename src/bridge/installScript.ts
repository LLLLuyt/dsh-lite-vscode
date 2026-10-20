/**
 * Target-side install logic (unit-testable, no vscode imports).
 *
 * Two targets, one wiring contract:
 *  - POSIX (WSL/Linux): a bash script fed to `bash -s` over stdin.
 *  - Windows: the same six steps executed natively (native Node APIs + `dsh`
 *    through cmd.exe), because a pure Windows host has no bash and its profile
 *    can only be created by the Windows dsh CLI. See the "Windows installer"
 *    section at the bottom.
 */
import { spawn } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PRESET_PATCH_YML } from './presetPatches.js'
import { posixBootstrap } from '../launcher/shellenv.js'
import type { DshVersion } from './hostVersion.js'

/**
 * Target-side host-version probe for the install flow: prints the first
 * semver `dsh --version` mentions (empty output when undetectable, e.g. dsh
 * not installed yet). The bootstrap makes version-manager node/npx visible
 * to the non-login shell, exactly like the installer's own probe.
 */
export function buildVersionProbeScript(command: string): string {
  return `${posixBootstrap()}; ${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n1`
}

/**
 * The `agent-presets` service row — valid only on DSH ≤ 0.1.6 hosts.
 * `@deepseek-ai/dsh-agent-presets` was removed in DSH 0.1.7, split into
 * `@deepseek-ai/dsh-agent-preset` + `@deepseek-ai/dsh-agent-preset-registry`
 * (DSH-0.1.7-J1-03); on a 0.1.7 host the row fails to import (entry-level),
 * leaving the composition up but the `agentPresets` service missing.
 */
const AGENT_PRESETS_ROW = `    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
`

/**
 * Canonical cordis.patch.yml content for the acp-vscode profile, following the
 * dsh-vscode-bridge README ("wiring profile"): one insert list carrying the
 * service rows the acp composition lacks, plus the permission-preset display
 * metadata the base layer does not ship.
 */
function buildPatchYml(agentPresetsRow: string): string {
  return `# Service rows the acp composition does not carry.
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
${agentPresetsRow}    # The subagent model routing reads this host row (the web bundle
    # ships it; the acp composition does not).
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: dsh-vscode-bridge
      name: 'dsh-vscode-bridge'
      # config: { portStart: 7310, portEnd: 7319 }   # optional override

# Display metadata for the three permission presets (base only ships
# sandbox/approval, no name/description).
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: read-only
        description: Read-only; writes and wider retries require approval.
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: workspace-write
        description: Writes inside the workspace allowed; wider retries require approval.
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: danger-full-access
        description: Full file access; no approval prompts.
`
}

/**
 * DSH ≥ 0.1.7 variant: the removed `agent-presets` service row is replaced by
 * the declarative split — an `agent-preset-registry` row plus one
 * `dsh-agent-preset` declaration per shipped preset, vendored from the host
 * cohort by scripts/sync-presets.mjs (drift fails per-preset into a broken
 * roster entry, never into a composition failure). This restores the same
 * roster the 0.1.5 monolith shipped, so the preset picker keeps working.
 */
export const PATCH_YML_DSH_0_1_7 = buildPatchYml('') + '\n' + AGENT_PRESET_PATCH_YML

/** DSH ≤ 0.1.6 variant: adds the monolithic `agent-presets` service row. */
export const PATCH_YML_DSH_0_1_5 = buildPatchYml(AGENT_PRESETS_ROW)

/** Posix target-side installer script (WSL / Linux). `command`/`pkg` are interpolated into the script text. */
export function buildPosixInstallScript(command: string, pkg: string): string {
  return `set -e
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
PROF="$DSH_HOME/profiles/acp-vscode"
if [ ! -d "$PROF" ]; then
  echo "[install] creating profile from acp template…"
  ${command} --profile acp-vscode --from-default-profile acp --dump-config >/dev/null
fi
echo "[install] ensuring dsh-acp-app bundle…"
node -e '
const fs = require("fs")
const p = process.argv[1] + "/package.json"
const d = JSON.parse(fs.readFileSync(p, "utf8"))
const b = d.dsh.profile.bundles
if (!b.includes("@deepseek-ai/dsh-acp-app")) { b.push("@deepseek-ai/dsh-acp-app"); fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\\n"); console.log("[install]   added") }
else console.log("[install]   already present")
' "$PROF"
PYML="$PROF/cordis.patch.yml"
# dsh-agent-presets was removed in DSH 0.1.7 (split into dsh-agent-preset +
# dsh-agent-preset-registry, DSH-0.1.7-J1-03): the old row cannot import on a
# 0.1.7 host (entry-level failure, agentPresets service missing), so the patch
# content is picked by host version. An unparseable or newer version takes the
# 0.1.7 variant — on a genuinely old host that only loses the preset picker,
# while the legacy row on a 0.1.7 host loses it for sure.
DSH_VER="$(${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"
case "$DSH_VER" in
  0.0.* | 0.1.[0-6]) PATCH_VARIANT=legacy ;;
  *) PATCH_VARIANT=current ;;
esac
echo "[install] host dsh \${DSH_VER:-unknown} → cordis.patch.yml variant: $PATCH_VARIANT"

# Repair an existing file on a 0.1.7 host: the stale agent-presets row can
# never import again — drop it (block-deleted by id, only when the block
# actually references the removed package; backup kept at cordis.patch.yml.bak).
if [ "$PATCH_VARIANT" = "current" ] && [ -f "$PYML" ] && grep -q "@deepseek-ai/dsh-agent-presets" "$PYML"; then
  echo "[install] removing the stale agent-presets row from cordis.patch.yml…"
  cp "$PYML" "$PYML.bak"
  node -e '
const fs = require("fs")
const p = process.argv[1]
const lines = fs.readFileSync(p, "utf8").split("\\n")
const out = []
let removed = 0
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\\s*)- id: agent-presets\\s*$/)
  if (m) {
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== "" && lines[j].match(/^(\\s*)/)[1].length > m[1].length) j++
    if (lines.slice(i, j).join("\\n").includes("@deepseek-ai/dsh-agent-presets")) { removed++; i = j - 1; continue }
  }
  out.push(lines[i])
}
if (removed) { fs.writeFileSync(p, out.join("\\n")); console.log("[install]   removed (backup: cordis.patch.yml.bak)") }
else console.log("[install]   WARNING: row shape not recognized; left in place — edit " + p + " manually")
' "$PYML"
fi

# 0.1.7 moved the user settings document per-profile (settings.yaml was
# renamed to .imported and folded into the booting profile): custom model
# providers (llm-pi-ai) that every profile used to share are gone from this
# one. The installer must not guess provider config — point at the fix.
if [ "$PATCH_VARIANT" = "current" ] && [ -f "$DSH_HOME/settings.yaml.imported" ] && ! grep -q "llm-pi-ai" "$PYML" 2>/dev/null; then
  echo "[install] NOTE: DSH 0.1.7 made model providers per-profile; settings.yaml.imported holds your old llm-pi-ai section — copy it into $PYML if you use custom providers."
fi

if [ -f "$PYML" ] && grep -q dsh-vscode-bridge "$PYML"; then
  if [ "$PATCH_VARIANT" = "current" ] && ! grep -q agent-preset-registry "$PYML"; then
    # Pre-0.2.2 file whose rows are otherwise fine: add the 0.1.7 preset wiring.
    echo "[install] adding the agent-preset rows (registry + shipped presets)…"
    printf '\\n' >> "$PYML"
    cat >> "$PYML" << 'YML'
${AGENT_PRESET_PATCH_YML}YML
  else
    echo "[install] bridge rows already present in cordis.patch.yml"
  fi
else
  PATCH_TMP="$(mktemp)"
  if [ "$PATCH_VARIANT" = "legacy" ]; then
    cat > "$PATCH_TMP" << 'YML'
${PATCH_YML_DSH_0_1_5}YML
  else
    cat > "$PATCH_TMP" << 'YML'
${PATCH_YML_DSH_0_1_7}YML
  fi
  # A fresh profile ships a placeholder patch file whose only content is a bare
  # flow sequence ("[]"); appending block entries after it is invalid YAML, so
  # the placeholder is replaced. A file with real user content gets an append.
  stripped="$(grep -vE '^[[:space:]]*(#|$)' "$PYML" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$stripped" ] || [ "$stripped" = "[]" ]; then
    echo "[install] writing cordis.patch.yml (workspace + subagent route + bridge + permission metadata)…"
    cat "$PATCH_TMP" > "$PYML"
  else
    echo "[install] appending bridge rows to existing cordis.patch.yml…"
    printf '\\n' >> "$PYML"
    cat "$PATCH_TMP" >> "$PYML"
  fi
  rm -f "$PATCH_TMP"
fi
if ! grep -q dsh-vscode-bridge "$PROF/package.json" 2>/dev/null; then
  echo "[install] installing bridge package ${pkg}…"
  ${command} plugin --profile acp-vscode add "${pkg}"
else
  echo "[install] bridge package already installed"
fi
echo "[install] DONE"`
}

// ===========================================================================
// Windows installer
//
// `dsh` on Windows is a .cmd shim (npx/dsh are batch files), so every host
// invocation goes through one `spawn(..., { shell: true })` call with an
// explicitly quoted command line: libuv's default argv quoting double-quotes a
// .cmd path and cmd.exe then fails to resolve it. With shell:true, a path
// containing spaces must be wrapped in quotes by US — and it must NOT be a
// separate argv element (that yields `'…\Temp\dsh' is not recognized`).
//
// Every step is a pure planner (`planWindowsInstall`) plus a thin executor, so
// the idempotency rules are unit-testable without a real Windows host.
// ===========================================================================

/** Where the Windows-side profile lives: `%DSH_HOME%` wins when dsh.env set it. */
export function windowsDshHome(envDshHome?: string): string {
  const custom = envDshHome?.trim()
  return custom ? custom : join(homedir(), '.dsh')
}

/** `cmd.exe`-safe quoting for one argument (`^`/`&` are cmd metacharacters;
 *  they are literal inside double quotes, which is why every arg is quoted). */
export function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * Build the single command line handed to `cmd.exe` for a dsh invocation.
 * `command` comes from settings and may be a bare shim name (`dsh`), an
 * absolute .cmd path — possibly containing spaces (`C:\Program Files\…`), or a
 * multi-word line (`npx -y @deepseek-ai/dsh`). Absolute paths are split from
 * their trailing arguments before quoting so a path with spaces is not
 * swallowed whole; bare/multi-word commands are left as the user wrote them.
 */
export function windowsDshCommandLine(command: string, args: string[]): string {
  const parts = splitCommandLine(command)
  return [...parts, ...args.map(cmdQuote)].join(' ')
}

/** Split a configured command line into an executable part + literal args.
 *  Only absolute paths are re-quoted (a bare `npx -y pkg` is passed through
 *  verbatim: cmd.exe resolves `npx` itself and the rest are plain tokens). */
export function splitCommandLine(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return []
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(trimmed)) {
    // Absolute path: the exe ends at the first `.exe`/`.cmd`/`.bat`/`.js`
    // token boundary or the first space after the last path separator.
    const m = /^(.+?\.(?:exe|cmd|bat|js|com))\b(.*)$/i.exec(trimmed)
    if (m) {
      const rest = m[2].trim()
      return [cmdQuote(m[1]), ...(rest ? rest.split(/\s+/) : [])]
    }
    // No known extension: quote the leading (possibly spaced) path segment.
    const quoted = /^("[^"]+")(.*)$/.exec(trimmed)
    if (quoted) return [quoted[1], ...(quoted[2].trim() ? quoted[2].trim().split(/\s+/) : [])]
    return [cmdQuote(trimmed)]
  }
  return trimmed.split(/\s+/)
}

export interface WindowsInstallOptions {
  /** dsh launch command from settings (may be multi-word). */
  command: string
  /** Bridge package spec (`dsh-vscode-bridge@^0.3.0`). */
  pkg: string
  /** Overrides the resolved `$DSH_HOME` (tests only; production leaves it undefined). */
  dshHomeOverride?: string
  /** `DSH_HOME` from dsh.env (dsh resolves the profile dir from it). */
  envDshHome?: string
  profile?: string
}

/** One planned step: `fs` steps run in-process, `exec` steps spawn dsh. */
export type WindowsInstallStep =
  | { kind: 'fs'; id: string; action: 'ensureBundle' | 'writePatch' | 'migratePatch' | 'backup'; detail: string }
  | { kind: 'exec'; id: 'createProfile' | 'installBridge'; args: string[]; detail: string }

export interface WindowsInstallPlan {
  steps: WindowsInstallStep[]
  profileDir: string
  patchPath: string
  /** Host version the patch variant was chosen from. */
  version?: string
  /** Set when the profile already needed no patch rewrite (idempotent skip). */
  patchState: 'missing' | 'placeholder' | 'wired' | 'needs-wiring'
}

export interface WindowsInstallInputs {
  options: WindowsInstallOptions
  /** Whether `$DSH_HOME/profiles/<profile>` exists (executor stats it). */
  profileExists: boolean
  /** Current cordis.patch.yml content, undefined when the file is absent. */
  patchContent?: string
  /** Current profile package.json content, undefined when absent. */
  packageJson?: string
  hostVersion?: string
}

/** Versions whose host needs the legacy (monolithic agent-presets) rows. */
function patchVariantFor(hostVersion: string | undefined): 'legacy' | 'current' {
  const v = parseVersionLoose(hostVersion)
  if (v && v.major === 0 && (v.minor === 0 || (v.minor === 1 && v.patch <= 6))) return 'legacy'
  return 'current'
}

/** Local semver probe: avoids importing hostVersion's helpers into the script
 *  builder's call graph (the install flow already probes the CLI separately). */
function parseVersionLoose(text: string | undefined): DshVersion | undefined {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return undefined
  return { major: +m[1], minor: +m[2], patch: +m[3], ...(m[4] === undefined ? {} : { prerelease: m[4] }) }
}

/** A profile patch file whose only content is comments and the bare `[]`
 *  placeholder — appending block entries after it produces invalid YAML. */
export function isPlaceholderPatch(content: string): boolean {
  const stripped = content
    .split(/\r?\n/)
    .filter(line => !/^\s*(#|$)/.test(line))
    .join('')
    .replace(/\s+/g, '')
  return stripped === '' || stripped === '[]'
}

/** The profile's package.json already lists the ACP bundle. */
export function hasAcpAppBundle(packageJson: string | undefined): boolean {
  if (!packageJson) return false
  try {
    const parsed = JSON.parse(packageJson) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = parsed.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes('@deepseek-ai/dsh-acp-app')
  } catch {
    return false
  }
}

/** The profile's package.json already depends on dsh-vscode-bridge. */
export function hasBridgeDependency(packageJson: string | undefined): boolean {
  if (!packageJson) return false
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, unknown> }
    return !!parsed.dependencies && 'dsh-vscode-bridge' in parsed.dependencies
  } catch {
    return false
  }
}

/**
 * Strip the removed `dsh-agent-presets` insert row (DSH 0.1.7 dropped the
 * package). Only the block that actually references the removed package is
 * removed; anything else is left byte-for-byte intact.
 */
export function stripLegacyAgentPresets(content: string): { content: string; removed: boolean } {
  const lines = content.split('\n')
  const out: string[] = []
  let removed = false
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- id: agent-presets\s*$/.exec(lines[i])
    if (!m) { out.push(lines[i]); continue }
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '' && (/^(\s*)/.exec(lines[j])?.[1].length ?? 0) > m[1].length) j++
    if (lines.slice(i, j).join('\n').includes('@deepseek-ai/dsh-agent-presets')) { removed = true; i = j - 1; continue }
    out.push(lines[i])
  }
  return { content: out.join('\n'), removed }
}

/**
 * Compose the patch rewrite for an existing profile: migrate a 0.1.5-era file
 * on a 0.1.7 host, append missing rows, or report that nothing needs doing.
 * Returns undefined when the file is already fully wired.
 */
export function planPatchContent(content: string, hostVersion: string | undefined): { next: string; changed: boolean; migrated: boolean; appended: boolean } {
  const variant = patchVariantFor(hostVersion)
  let next = content
  let migrated = false
  if (variant === 'current') {
    const stripped = stripLegacyAgentPresets(next)
    if (stripped.removed) { next = stripped.content; migrated = true }
  }
  const hasBridge = /dsh-vscode-bridge/.test(next)
  const hasRegistry = /agent-preset-registry/.test(next)
  if (hasBridge) {
    if (variant === 'current' && !hasRegistry) {
      return { next: `${next.replace(/\n*$/, '')}\n\n${AGENT_PRESET_PATCH_YML}`, changed: true, migrated, appended: true }
    }
    if (!migrated) return { next, changed: false, migrated: false, appended: false }
    return { next, changed: true, migrated, appended: false }
  }
  const fresh = variant === 'legacy' ? PATCH_YML_DSH_0_1_5 : PATCH_YML_DSH_0_1_7
  if (isPlaceholderPatch(next)) return { next: fresh, changed: true, migrated, appended: false }
  return { next: `${next.replace(/\n*$/, '')}\n\n${fresh}`, changed: true, migrated, appended: true }
}

/**
 * Plan the whole Windows install. Idempotency contract: a profile that already
 * has the ACP bundle, the bridge dependency and a wired patch file yields ZERO
 * steps — the caller reports "already installed" and writes nothing.
 */
export function planWindowsInstall(inputs: WindowsInstallInputs): WindowsInstallPlan {
  const { options } = inputs
  const profile = options.profile ?? 'acp-vscode'
  const dshHome = options.dshHomeOverride ?? windowsDshHome(options.envDshHome)
  const profileDir = join(dshHome, 'profiles', profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const steps: WindowsInstallStep[] = []
  let patchState: WindowsInstallPlan['patchState'] = 'missing'

  if (!inputs.profileExists) {
    steps.push({ kind: 'exec', id: 'createProfile', args: ['--profile', profile, '--from-default-profile', 'acp', '--dump-config'], detail: `create ${profile} from the acp template` })
  }
  if (!hasAcpAppBundle(inputs.packageJson)) {
    steps.push({ kind: 'fs', id: 'ensureBundle', action: 'ensureBundle', detail: 'add @deepseek-ai/dsh-acp-app to dsh.profile.bundles' })
  }
  const patch = inputs.patchContent
  if (patch === undefined) {
    patchState = 'missing'
    steps.push({ kind: 'fs', id: 'writePatch', action: 'writePatch', detail: 'write the cordis.patch.yml wiring' })
  } else {
    const planned = planPatchContent(patch, inputs.hostVersion)
    if (planned.migrated && planned.changed) {
      patchState = 'needs-wiring'
      steps.push({ kind: 'fs', id: 'backup', action: 'backup', detail: 'back up cordis.patch.yml → .bak' })
      steps.push({ kind: 'fs', id: 'migratePatch', action: 'migratePatch', detail: 'drop the removed agent-presets row' })
    } else if (planned.changed) {
      patchState = isPlaceholderPatch(patch) ? 'placeholder' : 'needs-wiring'
      steps.push({ kind: 'fs', id: 'writePatch', action: 'writePatch', detail: 'write the cordis.patch.yml wiring' })
    } else {
      patchState = 'wired'
    }
  }
  if (!hasBridgeDependency(inputs.packageJson)) {
    steps.push({ kind: 'exec', id: 'installBridge', args: ['plugin', '--profile', profile, 'add', options.pkg], detail: `install ${options.pkg}` })
  }
  return { steps, profileDir, patchPath, version: inputs.hostVersion, patchState }
}

/** Result of one applied step, for the output channel. */
export interface WindowsStepResult { id: string; message: string }

/**
 * Apply one planned fs step. Every write is read-modify-write against the file
 * on disk at execution time (never a snapshot taken during planning), so a
 * dsh-side edit that lands between plan and apply is preserved.
 */
export async function applyWindowsFsStep(
  step: Extract<WindowsInstallStep, { kind: 'fs' }>,
  plan: WindowsInstallPlan,
  hostVersion: string | undefined,
): Promise<WindowsStepResult> {
  switch (step.action) {
    case 'ensureBundle': {
      const pkgPath = join(plan.profileDir, 'package.json')
      const raw = await readFile(pkgPath, 'utf8')
      const parsed = JSON.parse(raw) as { dsh?: { profile?: { bundles?: string[] } } }
      parsed.dsh ??= {}
      parsed.dsh.profile ??= {}
      const bundles = parsed.dsh.profile.bundles ?? []
      if (bundles.includes('@deepseek-ai/dsh-acp-app')) return { id: step.id, message: 'already present' }
      bundles.push('@deepseek-ai/dsh-acp-app')
      parsed.dsh.profile.bundles = bundles
      await writeFile(pkgPath, `${JSON.stringify(parsed, null, 2)}\n`)
      return { id: step.id, message: 'added' }
    }
    case 'backup': {
      await copyFile(plan.patchPath, `${plan.patchPath}.bak`)
      return { id: step.id, message: `backup: ${plan.patchPath}.bak` }
    }
    case 'writePatch':
    case 'migratePatch': {
      const current = await readFile(plan.patchPath, 'utf8').catch(() => undefined)
      if (current !== undefined) {
        const planned = planPatchContent(current, hostVersion)
        if (!planned.changed) return { id: step.id, message: 'already wired' }
        await writeFile(plan.patchPath, planned.next)
        return {
          id: step.id,
          message: planned.migrated
            ? `migrated (backup kept)${planned.appended ? ', preset rows appended' : ''}`
            : planned.appended ? 'bridge rows appended' : 'wiring written',
        }
      }
      await writeFile(plan.patchPath, patchVariantFor(hostVersion) === 'legacy' ? PATCH_YML_DSH_0_1_5 : PATCH_YML_DSH_0_1_7)
      return { id: step.id, message: 'wiring written (new file)' }
    }
  }
}

/** Run one planned exec step (dsh through cmd.exe with an explicit command line). */
export function runWindowsDshStep(
  command: string,
  step: Extract<WindowsInstallStep, { kind: 'exec' }>,
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const line = windowsDshCommandLine(command, step.args)
    const child = spawn(line, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += String(d) })
    child.stderr?.on('data', d => { stderr += String(d) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${step.detail} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${step.detail} failed (exit ${code})${stderr.trim() ? ` — ${stderr.trim().slice(-300)}` : ''}`))
    })
  })
}

/** `dsh --version` probe on a Windows host (empty when undetectable). */
export function probeWindowsDshVersion(command: string, timeoutMs = 30_000): Promise<string> {
  return new Promise(resolve => {
    const line = windowsDshCommandLine(command, ['--version'])
    const child = spawn(line, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += String(d) })
    child.stderr?.on('data', d => { stderr += String(d) })
    const timer = setTimeout(() => { child.kill(); resolve('') }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => {
      clearTimeout(timer)
      const m = `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
      resolve(m?.[0] ?? '')
    })
  })
}

/** Read the three inputs the planner needs (undefined = absent). */
export async function readWindowsInstallInputs(
  options: WindowsInstallOptions,
): Promise<{ profileExists: boolean; packageJson?: string; patchContent?: string }> {
  const profile = options.profile ?? 'acp-vscode'
  const profileDir = join(options.dshHomeOverride ?? windowsDshHome(options.envDshHome), 'profiles', profile)
  const read = (p: string): Promise<string | undefined> => readFile(p, 'utf8').catch(() => undefined)
  const packageJson = await read(join(profileDir, 'package.json'))
  return {
    profileExists: packageJson !== undefined,
    packageJson,
    patchContent: await read(join(profileDir, 'cordis.patch.yml')),
  }
}
