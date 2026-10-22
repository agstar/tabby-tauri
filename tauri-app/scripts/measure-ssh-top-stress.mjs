#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const tauriRoot = resolve(__dirname, '..')
const defaultArtifactPath = resolve(repoRoot, '.omx', 'plans', 'ssh-top-stress-tabby-tauri-windows.json')
const defaultAppPath = resolve(tauriRoot, 'src-tauri', 'target', 'release', 'tabby-tauri.exe')

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (!arg.startsWith('--')) {
    continue
  }
  const [key, inlineValue] = arg.slice(2).split('=', 2)
  if (inlineValue !== undefined) {
    args.set(key, inlineValue)
  } else if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    args.set(key, process.argv[index + 1])
    index += 1
  } else {
    args.set(key, 'true')
  }
}

const artifactPath = resolve(args.get('out') ?? process.env.TABBY_TAURI_SSH_TOP_STRESS_ARTIFACT ?? defaultArtifactPath)
const appPath = resolve(args.get('app-path') ?? process.env.TABBY_TAURI_APP_PATH ?? defaultAppPath)
const cdpPort = Number(args.get('port') ?? process.env.TABBY_TAURI_CDP_PORT ?? 9369)
const sessionCount = Number(args.get('sessions') ?? process.env.TABBY_TAURI_SSH_TOP_SESSIONS ?? 10)
const durationMs = Number(args.get('duration-ms') ?? process.env.TABBY_TAURI_SSH_TOP_DURATION_MS ?? 15_000)
const topCommand = args.get('top-command') ?? process.env.TABBY_TAURI_SSH_TOP_COMMAND ?? 'top -c'
const username = args.get('username') ?? process.env.TABBY_TAURI_SSH_USERNAME
const passwordFromEnv = process.env['TABBY_TAURI_SSH_PASSWORD']
const password = args.get('password') ?? passwordFromEnv
const hosts = (args.get('hosts') ?? process.env.TABBY_TAURI_SSH_HOSTS ?? process.env.TABBY_TAURI_SSH_HOST ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const sshPort = Number(args.get('ssh-port') ?? process.env.TABBY_TAURI_SSH_PORT ?? 22)

const sensitiveValues = [
  password,
  process.env.TABBY_TAURI_SSH_KEY_PASSPHRASE,
  process.env.TABBY_TAURI_SSH_PRIVATE_KEY,
]
  .filter(value => typeof value === 'string' && value.length > 0)

function redactSecrets (value) {
  let text = String(value ?? '')
  for (const secret of sensitiveValues) {
    text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(/(password|passphrase|private[_-]?key|token|secret)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/(TABBY_TAURI_SSH_(?:PASSWORD|KEY_PASSPHRASE|KEY_PATH|PRIVATE_KEY))=([^\s]+)/g, '$1=[REDACTED]')
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJson (url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`)
  }
  return await response.json()
}

async function waitForTarget (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`)
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) {
        return target
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}: ${lastError?.message ?? 'no target'}`)
}

function connectCdp (webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  const rejectPending = error => {
    for (const [id, request] of pending.entries()) {
      pending.delete(id)
      request.reject(error)
    }
  }

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) {
      return
    }
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`))
    } else {
      resolve(message.result)
    }
  })

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed')))
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket error')))

  return {
    async send (method, params = {}) {
      await opened
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for CDP response to ${method}`))
        }, params.timeout ?? 30_000)
        pending.set(id, {
          resolve: value => {
            clearTimeout(timeout)
            resolve(value)
          },
          reject: error => {
            clearTimeout(timeout)
            reject(error)
          },
        })
      })
    },
    close () {
      socket.close()
    },
  }
}

async function evaluate (cdp, expression, timeout = 60_000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed')
  }
  return result.result.value
}

function killTree (pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // The process may already have exited.
  }
}

function sampleProcessTree (rootPid) {
  const script = String.raw`
$RootPid = ${Number(rootPid)}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
$queue = New-Object 'System.Collections.Generic.Queue[int]'
[void]$ids.Add([int]$RootPid)
$queue.Enqueue([int]$RootPid)
while ($queue.Count -gt 0) {
  $current = $queue.Dequeue()
  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $current }) {
    if ($ids.Add([int]$child.ProcessId)) {
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
}
$processes = @()
foreach ($id in $ids) {
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process) { $processes += $process }
}
$cpu = ($processes | Measure-Object -Property CPU -Sum).Sum
$working = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
$private = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
if ($null -eq $cpu) { $cpu = 0 }
if ($null -eq $working) { $working = 0 }
if ($null -eq $private) { $private = 0 }
[pscustomobject]@{
  process_count = $processes.Count
  cpu_seconds = [double]$cpu
  working_set_mb = [math]::Round([double]$working / 1MB, 2)
  private_mb = [math]::Round([double]$private / 1MB, 2)
  processes = @($processes | Sort-Object Id | ForEach-Object {
    $processCpu = if ($null -eq $_.CPU) { 0 } else { $_.CPU }
    [pscustomobject]@{
      id = $_.Id
      name = $_.ProcessName
      cpu_seconds = [double]$processCpu
      working_set_mb = [math]::Round($_.WorkingSet64 / 1MB, 2)
      private_mb = [math]::Round($_.PrivateMemorySize64 / 1MB, 2)
    }
  })
} | ConvertTo-Json -Depth 5 -Compress
`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(output)
}

function pageRunnerSource () {
  return String.raw`
async function runSshTopStress ({ hosts, port, username, password, sessionCount, durationMs, topCommand }) {
  const tauri = window.__TAURI__?.core
  if (!tauri?.invoke || !tauri?.Channel) {
    throw new Error('Tauri core invoke/Channel API is unavailable in the loaded WebView page')
  }
  const invoke = tauri.invoke
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const sessions = []

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const trimTail = value => String(value).slice(-120000)
  const startedAt = performance.now()

  async function openTopSession (index) {
    const host = hosts[index % hosts.length]
    const scan = await invoke('ssh_scan_host_key', { request: { host, port } })
    const connected = await invoke('ssh_connect_transport', {
      request: {
        host,
        port,
        username,
        auth: { type: 'password', password },
        host_key_fingerprint: scan.sha256,
        unsupported_features: [],
      },
    })
    const sessionId = connected.session.session_id
    const state = {
      index,
      host,
      session_id: sessionId,
      output: '',
      bytes: 0,
      chunks: 0,
      acks: 0,
      marker: '__TABBY_TOP_INPUT_' + index + '__',
      connected: true,
    }
    const channel = new tauri.Channel()
    channel.onmessage = data => {
      const bytes = Array.isArray(data.bytes) ? data.bytes : []
      state.bytes += bytes.length
      state.chunks += 1
      state.output = trimTail(state.output + decoder.decode(new Uint8Array(bytes), { stream: true }))
      void invoke('ssh_ack', { sessionId: data.session_id, length: bytes.length })
        .then(() => { state.acks += 1 })
        .catch(error => { state.ack_error = String(error?.message ?? error) })
    }

    await invoke('ssh_open_shell_transport', { sessionId, size: { cols: 120, rows: 40 } })
    await invoke('ssh_stream_transport', { sessionId, channel })
    await invoke('ssh_write_transport', {
      sessionId,
      bytes: Array.from(encoder.encode("printf '\\n__TABBY_TOP_STARTED_" + index + "__\\n'; " + topCommand + "\r")),
    })
    return state
  }

  for (let index = 0; index < sessionCount; index += 1) {
    sessions.push(await openTopSession(index))
    await sleep(120)
  }

  await sleep(durationMs)
  const inputStartedAt = performance.now()
  await Promise.all(sessions.map(session => invoke('ssh_write_transport', {
    sessionId: session.session_id,
    bytes: Array.from(encoder.encode('\x03')),
  }).catch(error => { session.ctrl_c_error = String(error?.message ?? error) })))
  await sleep(800)
  await Promise.all(sessions.map(session => invoke('ssh_write_transport', {
    sessionId: session.session_id,
    bytes: Array.from(encoder.encode("printf '\\n" + session.marker + "\\n'\r")),
  }).catch(error => { session.marker_error = String(error?.message ?? error) })))

  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (sessions.every(session => session.output.includes(session.marker))) {
      break
    }
    await sleep(50)
  }
  const inputCompletedAt = performance.now()

  for (const session of sessions) {
    session.marker_seen = session.output.includes(session.marker)
    session.output_tail = session.output.replace(/\r/g, '\n').split(/\n/).filter(Boolean).slice(-30)
    session.snapshot = await invoke('session_state', { sessionId: session.session_id }).catch(error => ({
      error: String(error?.message ?? error),
    }))
  }

  await Promise.all(sessions.map(session => invoke('ssh_close_transport', {
    sessionId: session.session_id,
    reason: 'ssh-top-stress-complete',
  }).catch(error => { session.close_error = String(error?.message ?? error) })))

  return {
    sessions_requested: sessionCount,
    sessions_connected: sessions.filter(session => session.connected).length,
    commands_total: sessionCount,
    commands_passed: sessions.filter(session => session.marker_seen).length,
    elapsed_ms: Math.round(performance.now() - startedAt),
    input_recovery_ms: Math.round(inputCompletedAt - inputStartedAt),
    total_output_bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
    total_output_chunks: sessions.reduce((sum, session) => sum + session.chunks, 0),
    sessions: sessions.map(session => ({
      index: session.index,
      host: session.host,
      session_id: session.session_id,
      marker_seen: session.marker_seen,
      bytes: session.bytes,
      chunks: session.chunks,
      acks: session.acks,
      snapshot: session.snapshot,
      errors: [session.ack_error, session.ctrl_c_error, session.marker_error, session.close_error].filter(Boolean),
      output_tail: session.output_tail,
    })),
  }
}`
}

function validateArgs () {
  if (!existsSync(appPath)) {
    throw new Error(`Built Tauri app not found at ${appPath}; run npm run build or pass --app-path`)
  }
  if (!hosts.length) {
    throw new Error('Missing SSH hosts; pass --hosts host1,host2 or set TABBY_TAURI_SSH_HOSTS')
  }
  if (!username) {
    throw new Error('Missing SSH username; pass --username or set TABBY_TAURI_SSH_USERNAME')
  }
  if (!password) {
    throw new Error('Missing SSH password; pass --password or set TABBY_TAURI_SSH_PASSWORD')
  }
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
    throw new Error('--sessions must be a positive integer')
  }
}

async function main () {
  validateArgs()
  mkdirSync(dirname(artifactPath), { recursive: true })
  const generatedAt = new Date().toISOString()
  const userDataFolder = await mkdtemp(join(tmpdir(), `tabby-tauri-ssh-top-${process.pid}-`))
  const child = spawn(appPath, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: userDataFolder,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        `--remote-debugging-port=${cdpPort}`,
      ].filter(Boolean).join(' '),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  let cdp = null
  let artifact = null
  try {
    const target = await waitForTarget(cdpPort, 25_000)
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await sleep(2_000)
    const page = await evaluate(cdp, `(() => ({ title: document.title, hasTauri: !!window.__TAURI__?.core?.invoke }))()`)
    const before = sampleProcessTree(child.pid)
    const measuredStartedAt = Date.now()
    const runnerArgs = JSON.stringify({ hosts, port: sshPort, username, password, sessionCount, durationMs, topCommand })
    const stressResult = await evaluate(
      cdp,
      `(async () => {
        try {
          return { ok: true, value: await (${pageRunnerSource()})(${runnerArgs}) }
        } catch (error) {
          return { ok: false, error: String(error?.stack ?? error?.message ?? error) }
        }
      })()`,
      durationMs + 120_000,
    )
    if (!stressResult.ok) {
      throw new Error(redactSecrets(stressResult.error))
    }
    const stress = stressResult.value
    const measuredElapsedSeconds = Math.max(1, (Date.now() - measuredStartedAt) / 1000)
    const after = sampleProcessTree(child.pid)
    const cpuSeconds = Math.max(0, Number(after.cpu_seconds ?? 0) - Number(before.cpu_seconds ?? 0))
    const cpuPercent = Number(((cpuSeconds / measuredElapsedSeconds) / Math.max(1, cpus().length) * 100).toFixed(3))
    const resourceUsage = {
      sample_seconds: Number(measuredElapsedSeconds.toFixed(3)),
      logical_processors: cpus().length,
      cpu_seconds_delta: Number(cpuSeconds.toFixed(3)),
      cpu_percent: cpuPercent,
      working_set_mb: after.working_set_mb,
      private_mb: after.private_mb,
      process_count: after.process_count,
    }
    const expected = {
      baseline_10_local_tabs_working_set_mb: 848.86,
      envelope_working_set_mb: 1400,
      envelope_cpu_percent: 35,
      within_expected: after.working_set_mb <= 1400 && cpuPercent <= 35,
      rationale: '10 high-output SSH sessions are expected to exceed the 10-local-tab memory baseline but stay below the 20-local-tab-era 1.4GB stress envelope and below 35% total CPU on this workstation.',
    }
    artifact = {
      scenario: 'ssh-top-stress',
      status: stress.commands_passed === stress.commands_total ? 'passed' : 'failed',
      generated_at: generatedAt,
      app_path: appPath,
      root_pid: child.pid,
      page_context: page,
      requested: {
        hosts,
        ssh_port: sshPort,
        username,
        sessions: sessionCount,
        duration_ms: durationMs,
        top_command: topCommand,
      },
      credential_values_redacted: true,
      stress,
      resource_usage: resourceUsage,
      expected_resource_envelope: expected,
    }
  } catch (error) {
    artifact = {
      scenario: 'ssh-top-stress',
      status: 'failed',
      generated_at: generatedAt,
      app_path: appPath,
      root_pid: child.pid,
      requested: {
        hosts,
        ssh_port: sshPort,
        username,
        sessions: sessionCount,
        duration_ms: durationMs,
        top_command: topCommand,
      },
      credential_values_redacted: true,
      error: redactSecrets(error.stack ?? error.message ?? error),
    }
  } finally {
    cdp?.close()
    killTree(child.pid)
    await rm(userDataFolder, { recursive: true, force: true }).catch(() => null)
  }

  const payload = JSON.stringify(artifact, null, 2)
  writeFileSync(artifactPath, redactSecrets(payload))
  console.log(JSON.stringify({
    status: artifact.status,
    artifact: artifactPath,
    commands_passed: artifact.stress?.commands_passed ?? 0,
    commands_total: artifact.stress?.commands_total ?? sessionCount,
    cpu_percent: artifact.resource_usage?.cpu_percent ?? null,
    working_set_mb: artifact.resource_usage?.working_set_mb ?? null,
    within_expected: artifact.expected_resource_envelope?.within_expected ?? false,
  }, null, 2))
  if (artifact.status !== 'passed') {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(redactSecrets(error.stack ?? error.message ?? error))
  process.exitCode = 1
})
