#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

function parseArgs (argv) {
  const args = {
    appPath: null,
    tabCounts: [10, 20],
    samples: 50,
    warmupMs: 10_000,
    port: 9229,
    outputPath: '../../.omx/plans/responsiveness-real-tabs-10-20-tabby-tauri-windows.json',
    singleRun: false,
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
      case '--single-run':
        args.singleRun = true
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
  if (!Number.isFinite(args.samples) || args.samples < 5) {
    throw new Error('--samples must be at least 5')
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

async function runSingleScenarioProcess (args, tabCount, scenarioIndex) {
  const scriptPath = fileURLToPath(import.meta.url)
  const port = args.port + scenarioIndex
  const childArgs = [
    scriptPath,
    '--single-run',
    '--app-path', args.appPath,
    '--tab-counts', String(tabCount),
    '--samples', String(args.samples),
    '--warmup-ms', String(args.warmupMs),
    '--port', String(port),
    '--output-path', resolve(tmpdir(), `tabby-tauri-responsiveness-${process.pid}-${tabCount}-${Date.now()}.json`),
  ]

  const child = spawn(process.execPath, childArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  const timeoutMs = Math.max(120_000, args.warmupMs + (args.samples * 2_500) + 60_000)
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`Timed out after ${timeoutMs}ms: ${tabCount}-tab child responsiveness scenario`))
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', code => {
      clearTimeout(timeout)
      resolve(code)
    })
  })

  if (exitCode !== 0) {
    throw new Error(`Child responsiveness scenario for ${tabCount} tabs failed with exit ${exitCode}.\n${stderr || stdout}`)
  }

  const jsonStart = stdout.indexOf('{')
  const jsonEnd = stdout.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`Child responsiveness scenario for ${tabCount} tabs did not emit JSON.\n${stderr || stdout}`)
  }
  const artifact = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1))
  if (!artifact.rows?.[0]) {
    throw new Error(`Child responsiveness scenario for ${tabCount} tabs emitted no rows`)
  }
  return artifact.rows[0]
}

async function waitForAutomation (cdp, expectedTabs, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(cdp, `(() => ({
      perf: window.__TABBY_TAURI_PERF__ ?? null,
      openedTabs: Number(document.body.dataset.tauriOpenedTabs || 0),
      terminalTabs: document.querySelectorAll('.tabby-terminal-tab').length,
      xterms: document.querySelectorAll('.xterm').length,
      bodyText: document.body.textContent?.slice(0, 200) ?? ''
    }))()`)
    if (snapshot.openedTabs === expectedTabs && snapshot.xterms >= expectedTabs) {
      return { verified: true, snapshot }
    }
    await sleep(500)
  }
  return { verified: false, snapshot }
}

async function measureOneScenario (args, tabCount, scenarioIndex, scenarioTimeoutMs = null) {
  const port = args.port + scenarioIndex
  const appPath = resolve(args.appPath)
  const userDataFolder = resolve(tmpdir(), `tabby-tauri-cdp-${process.pid}-${tabCount}-${Date.now()}`)
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
  let scenarioTimeout = null
  try {
    if (scenarioTimeoutMs) {
      scenarioTimeout = setTimeout(() => {
        cdp?.close()
        killTree(child.pid)
      }, scenarioTimeoutMs)
    }
    const target = await waitForTarget(port, Math.max(args.warmupMs, 15_000))
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await sleep(args.warmupMs)
    const automation = await waitForAutomation(cdp, tabCount, 30_000)
    const samples = []
    for (let i = 0; i < args.samples; i++) {
      const value = await evaluate(cdp, `new Promise(resolve => {
        const start = performance.now()
        requestAnimationFrame(() => {
          const probe = document.createElement('span')
          probe.hidden = true
          probe.dataset.tauriResponsivenessProbe = String(start)
          document.body.appendChild(probe)
          requestAnimationFrame(() => {
            const duration = performance.now() - start
            probe.remove()
            resolve(duration)
          })
        })
      })`, 10_000)
      samples.push(Number(value))
      await sleep(50)
    }

    return {
      tab_count: tabCount,
      status: automation.verified ? 'sampled' : 'sampled-with-unverified-automation',
      root_pid: child.pid,
      cdp_port: port,
      sample_count: samples.length,
      average_ms: average(samples),
      p50_ms: percentile(samples, 50),
      p95_ms: percentile(samples, 95),
      max_ms: Number(Math.max(...samples).toFixed(3)),
      automation_verified: automation.verified,
      automation_snapshot: automation.snapshot,
      notes: [
        'Renderer responsiveness proxy: two requestAnimationFrame turns plus a tiny DOM mutation measured inside the WebView renderer.',
        'This is not command-output latency and should be compared only against the same harness and build mode.',
      ],
    }
  } finally {
    clearTimeout(scenarioTimeout)
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
  if (!args.singleRun && args.tabCounts.length > 1) {
    for (const [index, tabCount] of args.tabCounts.entries()) {
      rows.push(await runSingleScenarioProcess(args, tabCount, index))
      if (index < args.tabCounts.length - 1) {
        await sleep(3_000)
      }
    }
  } else {
    for (const [index, tabCount] of args.tabCounts.entries()) {
      const timeoutMs = Math.max(90_000, args.warmupMs + (args.samples * 2_000) + 45_000)
      rows.push(await measureOneScenario(args, tabCount, index, timeoutMs))
      if (index < args.tabCounts.length - 1) {
        await sleep(3_000)
      }
    }
  }

  const byTab = new Map(rows.map(row => [row.tab_count, row]))
  const row10 = byTab.get(10)
  const row20 = byTab.get(20)
  const degradation = row10?.p95_ms && row20?.p95_ms
    ? Number((((row20.p95_ms - row10.p95_ms) / row10.p95_ms) * 100).toFixed(2))
    : null

  const artifact = {
    scenario: 'tauri-renderer-responsiveness',
    status: rows.every(row => row.automation_verified) ? 'sampled' : 'sampled-with-unverified-automation',
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

  if (rows.some(row => !row.automation_verified)) {
    process.exitCode = 2
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
