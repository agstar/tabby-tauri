#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const tauriRoot = resolve(__dirname, '..')
const defaultArtifactPath = resolve(repoRoot, '.omx', 'plans', 'ssh-command-matrix-tabby-tauri-windows.json')
const defaultAppPath = resolve(tauriRoot, 'src-tauri', 'target', 'debug', 'tabby-tauri.exe')
const packageJson = JSON.parse(readFileSync(resolve(tauriRoot, 'package.json'), 'utf8'))

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

const artifactPath = resolve(args.get('out') ?? process.env.TABBY_TAURI_SSH_COMMAND_MATRIX_ARTIFACT ?? defaultArtifactPath)
const scenario = args.get('scenario') ?? 'ssh-command-matrix'
const generatedAt = new Date().toISOString()
const appPath = resolve(args.get('app-path') ?? process.env.TABBY_TAURI_APP_PATH ?? defaultAppPath)
const cdpPort = Number(args.get('port') ?? process.env.TABBY_TAURI_CDP_PORT ?? 9359)

const sensitiveNames = [
  'TABBY_TAURI_SSH_PASSWORD',
  'TABBY_TAURI_SSH_KEY_PASSPHRASE',
  'TABBY_TAURI_SSH_KEY_PATH',
  'TABBY_TAURI_SSH_PRIVATE_KEY',
]
const sensitiveValues = sensitiveNames
  .map(name => process.env[name])
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

function redactOutput (output, limit = 180) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map(redactSecrets)
    .filter(Boolean)
    .slice(-limit)
}

function dependencyDeclared (name) {
  return Boolean(packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name])
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

function commandMatrix () {
  return [
    { index: 1, name: 'whoami', input: 'whoami', expected: 'current SSH username' },
    { index: 2, name: 'uname', input: 'uname -s', expected: 'Linux' },
    { index: 3, name: 'pwd', input: 'pwd', expected: 'non-empty output' },
    { index: 4, name: 'id_un', input: 'id -un', expected: 'current SSH username' },
    { index: 5, name: 'id_u', input: 'id -u', expected: 'non-empty output' },
    { index: 6, name: 'hostname', input: 'hostname', expected: 'non-empty output' },
    { index: 7, name: 'shell_path', input: 'command -v sh', expected: 'sh' },
    { index: 8, name: 'arithmetic', input: "sh -c 'echo $((6*7))'", expected: '42' },
    { index: 9, name: 'tmp_listing', input: 'ls -ld /tmp', expected: '/tmp' },
    { index: 10, name: 'tmp_file_roundtrip', input: 'printf tabby-tauri-file-ok > /tmp/tabby-tauri-e2e-$$.txt; cat /tmp/tabby-tauri-e2e-$$.txt; rm -f /tmp/tabby-tauri-e2e-$$.txt', expected: 'tabby-tauri-file-ok' },
    { index: 11, name: 'disk_usage', input: 'df -P /', expected: 'non-empty output' },
    { index: 12, name: 'utc_date', input: 'date -u +%Y-%m-%d', expected: 'non-empty output' },
  ]
}

function pageRunnerSource () {
  return String.raw`
async function runSshCommandMatrix ({ host, port, username, password }) {
  const tauri = window.__TAURI__?.core
  if (!tauri?.invoke || !tauri?.Channel) {
    throw new Error('Tauri core invoke/Channel API is unavailable in the loaded WebView page')
  }
  const invoke = tauri.invoke
  const commands = ${JSON.stringify(commandMatrix())}
  const expectedUser = username
  const script = [
    "sh <<'__TABBY_E2E_SCRIPT__'",
    "expected_user='" + String(expectedUser).replace(/'/g, "'\"'\"'") + "'",
    "",
    "run_contains() {",
    "  idx=\"$1\"",
    "  name=\"$2\"",
    "  expected=\"$3\"",
    "  shift 3",
    "  marker=$(printf '%02d' \"$idx\")",
    "  printf '\\n__TABBY_CMD_%s_BEGIN__\\n' \"$marker\"",
    "  printf '__TABBY_CMD_%s_INPUT__ %s\\n' \"$marker\" \"$*\"",
    "  output=\"$(\"$@\" 2>&1)\"",
    "  rc=$?",
    "  printf '%s\\n' \"$output\"",
    "  if [ \"$rc\" -eq 0 ] && printf '%s' \"$output\" | grep -F \"$expected\" >/dev/null 2>&1; then",
    "    printf '__TABBY_CMD_%s_PASS__\\n' \"$marker\"",
    "  else",
    "    printf '__TABBY_CMD_%s_FAIL__ rc=%s expected=%s name=%s\\n' \"$marker\" \"$rc\" \"$expected\" \"$name\"",
    "  fi",
    "  printf '__TABBY_CMD_%s_END__\\n' \"$marker\"",
    "}",
    "",
    "run_nonempty() {",
    "  idx=\"$1\"",
    "  name=\"$2\"",
    "  shift 2",
    "  marker=$(printf '%02d' \"$idx\")",
    "  printf '\\n__TABBY_CMD_%s_BEGIN__\\n' \"$marker\"",
    "  printf '__TABBY_CMD_%s_INPUT__ %s\\n' \"$marker\" \"$*\"",
    "  output=\"$(\"$@\" 2>&1)\"",
    "  rc=$?",
    "  printf '%s\\n' \"$output\"",
    "  if [ \"$rc\" -eq 0 ] && [ -n \"$output\" ]; then",
    "    printf '__TABBY_CMD_%s_PASS__\\n' \"$marker\"",
    "  else",
    "    printf '__TABBY_CMD_%s_FAIL__ rc=%s name=%s\\n' \"$marker\" \"$rc\" \"$name\"",
    "  fi",
    "  printf '__TABBY_CMD_%s_END__\\n' \"$marker\"",
    "}",
    "",
    "tmp_file=\"/tmp/tabby-tauri-e2e-$$.txt\"",
    "run_contains 1 whoami \"$expected_user\" whoami",
    "run_contains 2 uname Linux uname -s",
    "run_nonempty 3 pwd pwd",
    "run_contains 4 id_un \"$expected_user\" id -un",
    "run_nonempty 5 id_u id -u",
    "run_nonempty 6 hostname hostname",
    "run_contains 7 shell_path sh command -v sh",
    "run_contains 8 arithmetic 42 sh -c 'echo $((6*7))'",
    "run_contains 9 tmp_listing /tmp ls -ld /tmp",
    "printf 'tabby-tauri-file-ok\\n' > \"$tmp_file\"",
    "run_contains 10 tmp_file_roundtrip tabby-tauri-file-ok cat \"$tmp_file\"",
    "rm -f \"$tmp_file\"",
    "run_nonempty 11 disk_usage df -P /",
    "run_nonempty 12 utc_date date -u +%Y-%m-%d",
    "printf '\\n%s%s\\n' \"__TABBY_E2E_\" \"DONE__\"",
    "__TABBY_E2E_SCRIPT__",
    "",
  ].join("\n")

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
  let output = ''
  const decoder = new TextDecoder()
  const channel = new tauri.Channel()
  channel.onmessage = data => {
    const bytes = Array.isArray(data.bytes) ? data.bytes : []
    output += decoder.decode(new Uint8Array(bytes), { stream: true })
    void invoke('ssh_ack', { sessionId: data.session_id, length: bytes.length }).catch(() => null)
  }

  try {
    await invoke('ssh_open_shell_transport', { sessionId, size: { cols: 120, rows: 40 } })
    await invoke('ssh_stream_transport', { sessionId, channel })
    await invoke('ssh_write_transport', { sessionId, bytes: Array.from(new TextEncoder().encode(script)) })
    const deadline = Date.now() + 45_000
    while (!output.includes('__TABBY_E2E_DONE__') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!output.includes('__TABBY_E2E_DONE__')) {
      throw new Error('Timed out waiting for remote command matrix completion; output tail: ' + output.slice(-1000))
    }
  } finally {
    await invoke('ssh_close_transport', { sessionId, reason: 'page-command-matrix-complete' }).catch(() => null)
  }

  const extract = index => {
    const marker = String(index).padStart(2, '0')
    const begin = "__TABBY_CMD_" + marker + "_BEGIN__"
    const end = "__TABBY_CMD_" + marker + "_END__"
    const start = output.indexOf(begin)
    if (start === -1) return ''
    const after = output.slice(start + begin.length)
    const endIndex = after.indexOf(end)
    return endIndex === -1 ? after : after.slice(0, endIndex)
  }
  const excerpt = value => {
    const lines = String(value).replace(/\r/g, "\n").split(/\n/).map(line => line.trim()).filter(Boolean)
    return lines.slice(-40).map(line => line.length > 180 ? line.slice(0, 180) + "…" : line)
  }
  const results = commands.map(command => {
    const marker = String(command.index).padStart(2, '0')
    return {
      ...command,
      passed: output.includes("__TABBY_CMD_" + marker + "_PASS__"),
      output_excerpt: excerpt(extract(command.index)),
    }
  })
  return {
    commands_total: results.length,
    commands_passed: results.filter(command => command.passed).length,
    commands: results,
    page_output_tail: excerpt(output).slice(-80),
  }
}`
}

async function runPageCommandMatrix ({ host, port, username, password }) {
  if (!existsSync(appPath)) {
    throw new Error(`Built Tauri app not found at ${appPath}; run a debug build or pass --app-path`)
  }

  const userDataFolder = await mkdtemp(join(tmpdir(), `tabby-tauri-ssh-page-${process.pid}-`))
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
  try {
    const target = await waitForTarget(cdpPort, 20_000)
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await sleep(2_000)
    const page = await evaluate(cdp, `(() => ({ title: document.title, body: document.body.innerText.slice(0, 160), hasTauri: !!window.__TAURI__?.core?.invoke }))()`)
    const matrix = await evaluate(
      cdp,
      `(${pageRunnerSource()})(${JSON.stringify({ host, port, username, password })})`,
      75_000,
    )
    return {
      ...matrix,
      page_context: {
        title: page.title ?? '',
        body_excerpt: redactSecrets(page.body ?? ''),
        app_path: appPath,
        cdp_port: cdpPort,
      },
    }
  } finally {
    cdp?.close()
    killTree(child.pid)
    await sleep(1_000)
    await rm(userDataFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => null)
  }
}

function runCargoCommandMatrix () {
  const command = [
    'cargo',
    'test',
    '--test',
    'ssh_transport_smoke',
    'ssh_transport_command_matrix_uses_real_server_when_env_is_present',
    '--',
    '--nocapture',
  ]
  const result = spawnSync(command[0], command.slice(1), {
    cwd: resolve(tauriRoot, 'src-tauri'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TABBY_TAURI_SSH_COMMAND_MATRIX_ARTIFACT: artifactPath,
    },
  })
  const exitCode = result.status ?? 1
  let matrix = null
  if (existsSync(artifactPath)) {
    try {
      matrix = JSON.parse(readFileSync(artifactPath, 'utf8'))
    } catch {
      matrix = null
    }
  }
  return {
    command,
    exitCode,
    output: redactOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
    matrix,
  }
}

async function main () {
  const required = ['TABBY_TAURI_SSH_HOST', 'TABBY_TAURI_SSH_USERNAME']
  const missing = required.filter(name => !process.env[name])
  if (!process.env.TABBY_TAURI_SSH_PASSWORD && !process.env.TABBY_TAURI_SSH_KEY_PATH) {
    missing.push('TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH')
  }

  let command = null
  let exitCode = 0
  let status = 'skipped-missing-env'
  let output = []
  let matrix = null
  let cargoFallback = null
  const uiAutomation = {
    requested_real_page: true,
    attempted: false,
    status: existsSync(appPath) ? 'not-run' : 'blocked-no-built-app',
    blocked_reason: existsSync(appPath)
      ? null
      : `Built Tauri app not found at ${appPath}; page automation needs a debug/release executable.`,
    evidence: {
      app_path: appPath,
      app_exists: existsSync(appPath),
      cdp_port: cdpPort,
      tauri_driver_dependency: dependencyDeclared('tauri-driver'),
      playwright_dependency: dependencyDeclared('playwright') || dependencyDeclared('@playwright/test'),
      selenium_dependency: dependencyDeclared('selenium-webdriver'),
      cdp_automation: true,
    },
    fallback_path: 'tabby-tauri/src-tauri/tests/ssh_transport_smoke.rs::ssh_transport_command_matrix_uses_real_server_when_env_is_present',
  }

  if (missing.length === 0) {
    if (process.env.TABBY_TAURI_SSH_KEY_PATH && !process.env.TABBY_TAURI_SSH_PASSWORD) {
      uiAutomation.status = 'skipped-key-auth-only'
      uiAutomation.blocked_reason = 'Page CDP command-matrix currently automates password auth only; falling back to the Rust transport matrix for key auth.'
    } else {
      uiAutomation.attempted = true
      try {
        matrix = await runPageCommandMatrix({
          host: process.env.TABBY_TAURI_SSH_HOST,
          port: process.env.TABBY_TAURI_SSH_PORT ? Number(process.env.TABBY_TAURI_SSH_PORT) : 22,
          username: process.env.TABBY_TAURI_SSH_USERNAME,
          password: process.env.TABBY_TAURI_SSH_PASSWORD,
        })
        uiAutomation.status = matrix.commands_passed === matrix.commands_total ? 'passed' : 'failed'
        uiAutomation.blocked_reason = null
        status = uiAutomation.status
        exitCode = status === 'passed' ? 0 : 1
        output = matrix.page_output_tail ?? []
        command = [`${appPath} -- CDP Runtime.evaluate ssh command matrix on port ${cdpPort}`]
      } catch (error) {
        uiAutomation.status = 'failed'
        uiAutomation.blocked_reason = redactSecrets(error.stack ?? error.message ?? error)
        output = redactOutput(error.stack ?? error.message ?? error)
      }
    }

    if (status !== 'passed') {
      cargoFallback = runCargoCommandMatrix()
      command = cargoFallback.command
      exitCode = cargoFallback.exitCode
      status = exitCode === 0 ? 'passed' : 'failed'
      output = [...output, ...cargoFallback.output].slice(-180)
      matrix = cargoFallback.matrix
    }
  } else {
    output = [
      'Set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and either TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH to run the real SSH command-matrix acceptance test.',
      'This harness writes an explicit skipped artifact instead of claiming remote SSH command coverage.',
    ]
  }

  const commands = Array.isArray(matrix?.commands) ? matrix.commands : []
  const artifact = {
    scenario,
    status,
    generated_at: generatedAt,
    target: {
      host: process.env.TABBY_TAURI_SSH_HOST ?? null,
      host_present: Boolean(process.env.TABBY_TAURI_SSH_HOST),
      port: process.env.TABBY_TAURI_SSH_PORT ? Number(process.env.TABBY_TAURI_SSH_PORT) : 22,
      username_present: Boolean(process.env.TABBY_TAURI_SSH_USERNAME),
    },
    credential_values_redacted: true,
    raw_credentials_persisted: false,
    credential_inputs: {
      password_present: Boolean(process.env.TABBY_TAURI_SSH_PASSWORD),
      key_path_present: Boolean(process.env.TABBY_TAURI_SSH_KEY_PATH),
      key_passphrase_present: Boolean(process.env.TABBY_TAURI_SSH_KEY_PASSPHRASE),
    },
    coverage: [
      uiAutomation.status === 'passed' ? 'real-webview-page-cdp-runtime-evaluate' : 'real-ssh-transport-fallback',
      'real-ssh-host-key-scan',
      'real-ssh-authentication',
      'remote-shell-open',
      'interactive-shell-write',
      'interactive-shell-output-read',
      'linux-command-matrix-12-commands',
      'sanitized-output-artifact',
    ],
    ui_automation: uiAutomation,
    page_context: matrix?.page_context ?? null,
    transport_fallback: cargoFallback
      ? {
          attempted: true,
          status: cargoFallback.exitCode === 0 ? 'passed' : 'failed',
          exit_code: cargoFallback.exitCode,
        }
      : {
          attempted: false,
          status: null,
          exit_code: null,
        },
    missing,
    command: command ? command.join(' ') : null,
    exit_code: exitCode,
    commands_total: matrix?.commands_total ?? commands.length,
    commands_passed: matrix?.commands_passed ?? commands.filter(command => command.passed).length,
    commands,
    output,
  }

  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    artifact: artifactPath,
    status,
    commands_total: artifact.commands_total,
    commands_passed: artifact.commands_passed,
    raw_credentials_persisted: false,
    ui_automation_status: uiAutomation.status,
    transport_fallback_status: artifact.transport_fallback.status,
  }, null, 2))

  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

main().catch(error => {
  console.error(redactSecrets(error.stack ?? error.message ?? error))
  process.exit(1)
})
