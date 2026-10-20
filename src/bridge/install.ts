/**
 * One-shot bridge installer/repairer: prepares the acp-vscode profile on the
 * TARGET side (wherever dsh runs), then points dsh.profile at it.
 *
 * Steps (all idempotent):
 *   1. probe the host dsh version and pre-fill the matching bridge package
 *      line (bridge 0.3.0 dropped 0.1.5 hosts, and 0.x carets do not cross
 *      minors, so the right default is version-dependent)
 *   2. create profile from the acp template if missing
 *   3. ensure `@deepseek-ai/dsh-acp-app` is in the profile bundles
 *   4. write cordis.patch.yml rows per the host dsh version (the untouched
 *      "[]" template is replaced; real user content gets the rows appended) —
 *      on 0.1.7 hosts existing files are migrated instead: the stale
 *      `dsh-agent-presets` row is stripped (.bak kept) and the declarative
 *      preset rows are appended when missing
 *   5. ensure the bridge package is installed into the profile
 */
import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import { readConfig } from '../config.js'
import { detectHostSide } from '../launcher/detect.js'
import { runTargetShell } from '../launcher/runTargetShell.js'
import { buildPosixInstallScript, buildVersionProbeScript, planWindowsInstall, readWindowsInstallInputs, applyWindowsFsStep, runWindowsDshStep, probeWindowsDshVersion, type WindowsInstallOptions } from './installScript.js'
import { bridgeSpecForHost, parseDshVersion } from './hostVersion.js'
import type { BridgeManager } from './manager.js'

/** Run a command with its script piped over stdin (not passed as an argv
 *  element): the vendored preset rows push the installer past the Windows
 *  CreateProcess command-line limit on the wsl.exe path (spawn ENAMETOOLONG). */
function runWithStdin(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`install timed out after ${timeoutMs / 1000}s`)) }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`exit code ${code}${stderr.trim() ? ` — ${stderr.trim().slice(-300)}` : ''}`))
    })
    child.stdin.on('error', () => undefined) // EPIPE when the child dies before reading
    child.stdin.end(input)
  })
}

export async function installBridgeFlow(out: vscode.OutputChannel, bridge?: BridgeManager): Promise<void> {
  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  const cfg = readConfig()
  const target = cfg.runtime === 'auto' ? host : cfg.runtime

  // Match the bridge package line to the host BEFORE prompting: a connected
  // bridge (>= 0.2.1) reports the host version itself; otherwise probe
  // `dsh --version` on the target side through the configured launch command.
  let detected = bridge?.hostDshVersion
  if (!detected) {
    try {
      detected = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DSH: detecting the host dsh version…' },
        async () => target === 'windows'
          ? (await probeWindowsDshVersion(cfg.command)).trim() || undefined
          : (await runTargetShell(buildVersionProbeScript(cfg.command), 30_000)).stdout.trim() || undefined,
      )
    } catch (e) {
      out.appendLine(`[install] host dsh version probe failed: ${(e as Error).message}`)
    }
  }
  const suggested = bridgeSpecForHost(parseDshVersion(detected))
  out.appendLine(`[install] host dsh ${detected ?? 'unknown'} → suggested bridge spec: ${suggested}`)

  const pkg = await vscode.window.showInputBox({
    title: 'DSH: Install Bridge',
    prompt: `Bridge package spec (npm name@version, tarball path, or directory), pre-filled for host dsh ${detected ?? '(not detected)'}: 0.1.7/0.2.0 hosts take ≥ 0.3.0; 0.1.5 hosts stay on 0.2.x (dropped in 0.3.0).`,
    value: suggested,
  })
  if (!pkg) return

  out.show()
  out.appendLine(`[install] host=${host} target=${target} pkg=${pkg}`)

  try {
    if (target === 'windows') {
      // Supported only when the extension host itself is on Windows: the
      // profile must be created by the Windows dsh CLI. WSL host → Windows
      // target (topology 3) has no bridge channel at all, so wiring a profile
      // there would be dead weight.
      if (host !== 'windows') {
        const msg = 'DSH: 无法从 WSL 内安装 Windows 侧的 bridge（拓扑 3 不支持 bridge）。请把 dsh.runtime 改回 auto，或在 Windows 版 VS Code 中安装。'
        out.appendLine(`[install] ${msg}`)
        void vscode.window.showErrorMessage(msg)
        return
      }
      await installWindows(out, cfg, pkg, detected)
      return
    }
    await installPosix(out, host, cfg, pkg)
  } catch (e) {
    out.appendLine(`[install] FAILED: ${(e as Error).message}`)
    void vscode.window.showErrorMessage(`DSH bridge install failed — see DSH output.\n${(e as Error).message.split('\n')[0]}`)
  }
}

/** Shared tail: point dsh.profile at the profile we just wired, then offer a reload. */
async function finishInstall(out: vscode.OutputChannel, profile: string): Promise<void> {
  const current = readConfig().profile
  if (current !== profile) {
    await vscode.workspace.getConfiguration('dsh').update('profile', profile, vscode.ConfigurationTarget.Global)
    out.appendLine(`[install] dsh.profile: ${current} → ${profile}`)
  } else {
    out.appendLine(`[install] dsh.profile already ${profile}`)
  }
  const pick = await vscode.window.showInformationMessage(`DSH bridge installed; dsh.profile → ${profile}.`, 'Reload Window')
  if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow')
}

/** POSIX/wsl.exe transport: the bash script over stdin (`bash -s`). */
async function installPosix(out: vscode.OutputChannel, host: string, cfg: ReturnType<typeof readConfig>, pkg: string): Promise<void> {
  const script = buildPosixInstallScript(cfg.command, pkg)
  // Run the script on the TARGET side, fed over stdin (bash -s): same-side via
  // bash, WSL-from-Windows via wsl.exe. argv passing would cap the script at
  // 32 KiB on the Windows path — the preset rows alone are larger.
  const spec = host === 'windows'
    ? { cmd: 'wsl.exe', args: [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-s'] }
    : { cmd: '/bin/bash', args: ['-s'] }
  const r = await runWithStdin(spec.cmd, spec.args, script, 180_000)
  out.append(r.stdout)
  if (r.stderr.trim()) out.appendLine(`[stderr] ${r.stderr.slice(-500)}`)
  await finishInstall(out, 'acp-vscode')
}

/**
 * Windows transport: the same six wiring steps, executed natively.
 *
 * A profile that is already wired yields an empty plan and is reported as such
 * — nothing is written, so re-running the command on a working machine is a
 * pure no-op (this is the common case: users run it again whenever the install
 * nudge reappears).
 */
async function installWindows(out: vscode.OutputChannel, cfg: ReturnType<typeof readConfig>, pkg: string, detected: string | undefined): Promise<void> {
  const options: WindowsInstallOptions = {
    command: cfg.command,
    pkg,
    envDshHome: cfg.env['DSH_HOME'],
    profile: 'acp-vscode',
  }
  const looked = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DSH: 检查 acp-vscode profile…' },
    async () => readWindowsInstallInputs(options),
  )
  const plan = planWindowsInstall({ options, ...looked, hostVersion: detected })
  out.appendLine(`[install] windows: profile=${plan.profileDir}`)
  out.appendLine(`[install] windows: patch state=${plan.patchState}, steps=${plan.steps.length}`)
  if (plan.steps.length === 0) {
    out.appendLine('[install] windows: already installed — nothing to do')
    await finishInstall(out, options.profile ?? 'acp-vscode')
    return
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DSH: installing the bridge plugin…' },
    async progress => {
      for (const [i, step] of plan.steps.entries()) {
        progress.report({ message: `${i + 1}/${plan.steps.length} ${step.detail}`, increment: 100 / plan.steps.length })
        out.appendLine(`[install] windows: ${step.detail}…`)
        if (step.kind === 'fs') {
          const r = await applyWindowsFsStep(step, plan, detected)
          out.appendLine(`[install] windows:   ${r.message}`)
        } else {
          const r = await runWindowsDshStep(cfg.command, step)
          if (r.stdout.trim()) out.append(r.stdout)
          if (r.stderr.trim()) out.appendLine(`[stderr] ${r.stderr.slice(-500)}`)
          out.appendLine('[install] windows:   done')
        }
      }
    },
  )
  // Re-read after exec steps (plugin add rewrites package.json) so the final
  // state is verified instead of assumed.
  const after = await readWindowsInstallInputs(options)
  const verify = planWindowsInstall({ options, ...after, hostVersion: detected })
  if (verify.steps.length > 0) {
    out.appendLine(`[install] windows: WARNING — ${verify.steps.length} step(s) still pending: ${verify.steps.map(s => s.id).join(', ')}`)
  } else {
    out.appendLine('[install] windows: verified — profile wired')
  }
  await finishInstall(out, options.profile ?? 'acp-vscode')
}
