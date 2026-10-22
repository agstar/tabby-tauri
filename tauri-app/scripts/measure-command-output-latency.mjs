#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function parseArgs (argv) {
  const args = {
    appPath: null,
    tabCounts: [10, 20],
    samples: 10,
    warmupMs: 10_000,
    port: 9329,
    outputPath: '../../.omx/plans/command-output-latency-real-tabs-10-20-tabby-tauri-windows.json',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--app-path':
      case '-AppPath':
        args.appPath = next()
        break
      case '--tab-counts':
      case '-TabCounts':
        args.tabCounts = next().split(',').map(value => Number.parseInt(value.trim(), 10)).filter(Number.isFinite)
        break
      case '--samples':
      case '-Samples':
        args.samples = Number.parseInt(next(), 10)
        break
      case '--warmup-ms':
      case '-WarmupMs':
        args.warmupMs = Number.parseInt(next(), 10)
        break
      case '--port':
      case '-Port':
        args.port = Number.parseInt(next(), 10)
        break
      case '--output-path':
      case '-OutputPath':
        args.outputPath = next()
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!args.appPath) {
    throw new Error('Missing required --app-path')
  }
  if (!args.tabCounts.length) {
    throw new Error('At least one tab count is required')
  }
  if (!Number.isFinite(args.samples) || args.samples < 1) {
    throw new Error('--samples must be at least 1')
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error('--port must be a positive integer')
  }

  return args
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

async function evaluate (cdp, expression, timeout = 30_000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed')
  }
  return result.result.value
}

function percentile (values, p) {
  if (!values.length) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(3))
}

function average (values) {
  if (!values.length) {
    return null
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
}

function killTree (pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // The process may already have exited.
  }
}

async function waitForAutomation (cdp, expectedTabs, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(cdp, `(() => ({
      perf: window.__TABBY_TAURI_PERF__ ?? null,
      openedTabs: Number(document.body.dataset.tauriOpenedTabs || 0),
      xterms: document.querySelectorAll('.xterm').length,
      hasCommandHarness: !!window.__TABBY_TAURI_AUTOMATION__,
      harnessTabs: window.__TABBY_TAURI_AUTOMATION__?.tabs?.length ?? 0
    }))()`)
    if (
      snapshot.openedTabs === expectedTabs &&
      snapshot.xterms >= expectedTabs &&
      snapshot.hasCommandHarness &&
      snapshot.harnessTabs >= expectedTabs
    ) {
      return { verified: true, snapshot }
    }
    await sleep(500)
  }
  return { verified: false, snapshot }
}

function commandForMarker (marker) {
  const encoded = Buffer.from(marker, 'utf8').toString('base64')
  return `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "[Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))"\r`
}

async function measureCommandOutputSample (cdp, marker, tabIndex, timeoutMs) {
  return await evaluate(cdp, `new Promise((resolve, reject) => {
    const harness = window.__TABBY_TAURI_AUTOMATION__
    if (!harness) {
      reject(new Error('Tauri command-output automation harness is unavailable'))
      return
    }
    const tabIndex = ${tabIndex}
    harness.clearOutput(tabIndex)
    const command = ${JSON.stringify(commandForMarker(marker))}
    const startedAt = performance.now()
    if (!harness.sendInput(tabIndex, command)) {
      reject(new Error('No automation tab at index ' + tabIndex))
      return
    }
    const timer = setInterval(() => {
      const output = harness.readOutput(tabIndex)
      if (output.includes(${JSON.stringify(marker)})) {
        clearInterval(timer)
        resolve(performance.now() - startedAt)
        return
      }
      if (performance.now() - startedAt > ${timeoutMs}) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for command marker; output tail: ' + output.slice(-500)))
      }
    }, 10)
  })`, timeoutMs + 5_000)
}

async function waitForShellPrompt (cdp, tabIndex, timeoutMs) {
  return await evaluate(cdp, `new Promise((resolve, reject) => {
    const harness = window.__TABBY_TAURI_AUTOMATION__
    if (!harness) {
      reject(new Error('Tauri command-output automation harness is unavailable'))
      return
    }
    harness.clearOutput(${tabIndex})
    harness.sendInput(${tabIndex}, ${JSON.stringify('\r')})
    const startedAt = performance.now()
    const stripAnsi = value => String(value).replace(/\\x1b\\[[0-9;?]*[ -/]*[@-~]/g, '')
    const timer = setInterval(() => {
      const output = stripAnsi(harness.readOutput(${tabIndex}))
      const tail = output.slice(-300)
      if (/[A-Za-z]:\\\\[^\\r\\n]*>\\s*$/.test(tail)) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (performance.now() - startedAt > ${timeoutMs}) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for shell prompt; output tail: ' + tail))
      }
    }, 50)
  })`, timeoutMs + 5_000)
}

async function measureOneScenario (args, tabCount, scenarioIndex) {
  const port = args.port + scenarioIndex
  const appPath = resolve(args.appPath)
  const userDataFolder = resolve(tmpdir(), `tabby-tauri-command-output-${process.pid}-${tabCount}-${Date.now()}`)
  await mkdir(userDataFolder, { recursive: true })
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: userDataFolder,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      `--remote-debugging-port=${port}`,
    ].filter(Boolean).join(' '),
  }
  const child = spawn(appPath, [`--test-tabs=${tabCount}`], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  let cdp = null
  try {
    const target = await waitForTarget(port, Math.max(args.warmupMs, 15_000))
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await sleep(args.warmupMs)
    const automation = await waitForAutomation(cdp, tabCount, 30_000)
    const samples = []
    const failures = []
    const prompt_warnings = []
    const retry_warnings = []
    const measured_tab_index = Math.max(0, tabCount - 1)
    const maxAttempts = args.samples + 3
    let attempts = 0
    while (samples.length < args.samples && attempts < maxAttempts) {
      const marker = `TABBY_CMD_OUTPUT_${tabCount}_${attempts}_${Date.now()}`
      attempts++
      try {
        await waitForShellPrompt(cdp, measured_tab_index, 20_000).catch(error => {
          prompt_warnings.push(error.message)
        })
        samples.push(Number(await measureCommandOutputSample(cdp, marker, measured_tab_index, 20_000)))
      } catch (error) {
        retry_warnings.push(error.message)
      }
      await sleep(1_000)
    }
    if (samples.length < args.samples) {
      failures.push(`Only captured ${samples.length}/${args.samples} command-output samples after ${attempts} attempts`)
    }

    return {
      tab_count: tabCount,
      status: automation.verified && failures.length === 0 ? 'sampled' : 'sampled-with-failures',
      root_pid: child.pid,
      cdp_port: port,
      measured_tab_index,
      sample_count: samples.length,
      requested_samples: args.samples,
      attempts,
      average_ms: average(samples),
      p50_ms: percentile(samples, 50),
      p95_ms: percentile(samples, 95),
      max_ms: samples.length ? Number(Math.max(...samples).toFixed(3)) : null,
      automation_verified: automation.verified,
      automation_snapshot: automation.snapshot,
      failures,
      prompt_warnings,
      retry_warnings,
      notes: [
        'Command-output latency proxy: CDP calls a Tauri-only automation harness, sends a PowerShell command to the active/latest opened local terminal tab, and measures until the decoded marker is observed in BaseTerminalTab.write output.',
        'The command line contains a base64 marker, not the marker text, so the measurement waits for shell command output rather than local input echo. The command is launched through the absolute Windows PowerShell path so it works from the default cmd.exe local profile even when PATH is minimal.',
      ],
    }
  } finally {
    cdp?.close()
    killTree(child.pid)
    await sleep(1_000)
    await rm(userDataFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(error => {
      console.warn(`Warning: could not remove temporary WebView2 data folder ${userDataFolder}: ${error.message}`)
    })
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const rows = []
  for (const [index, tabCount] of args.tabCounts.entries()) {
    rows.push(await measureOneScenario(args, tabCount, index))
    if (index < args.tabCounts.length - 1) {
      await sleep(3_000)
    }
  }

  const byTab = new Map(rows.map(row => [row.tab_count, row]))
  const row10 = byTab.get(10)
  const row20 = byTab.get(20)
  const degradation = row10?.p95_ms && row20?.p95_ms
    ? Number((((row20.p95_ms - row10.p95_ms) / row10.p95_ms) * 100).toFixed(2))
    : null

  const artifact = {
    scenario: 'tauri-command-output-latency',
    status: rows.every(row => row.status === 'sampled') ? 'sampled' : 'sampled-with-failures',
    generated_at: new Date().toISOString(),
    app_path: args.appPath,
    tab_counts: args.tabCounts,
    samples_per_scenario: args.samples,
    warmup_ms: args.warmupMs,
    p95_degradation_10_to_20_percent: degradation,
    rows,
  }

  const outputPath = resolve(args.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(artifact, null, 2))

  if (rows.some(row => row.status !== 'sampled')) {
    process.exitCode = 2
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
