#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const VALID_SCENARIOS = new Set(['default', 'effects-on', 'effects-off', 'state-events'])

export function parseArgs (argv) {
  const args = {
    appPath: null,
    scenarios: ['default', 'effects-on', 'effects-off', 'state-events'],
    warmupMs: 8_000,
    port: 9339,
    outputPath: '../../.omx/plans/display-parity-tabby-tauri-windows.json',
    screenshotsDir: '../../.omx/artifacts/display-parity-screenshots',
    testTabs: 0,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--app-path':
      case '-AppPath':
        args.appPath = next()
        break
      case '--scenarios':
      case '-Scenarios':
        args.scenarios = next().split(',').map(value => value.trim()).filter(Boolean)
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
      case '--screenshots-dir':
      case '-ScreenshotsDir':
        args.screenshotsDir = next()
        break
      case '--test-tabs':
      case '-TestTabs':
        args.testTabs = Number.parseInt(next(), 10)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!args.appPath) {
    throw new Error('Missing required --app-path')
  }
  if (!args.scenarios.length) {
    throw new Error('At least one scenario is required')
  }
  const unknownScenario = args.scenarios.find(scenario => !VALID_SCENARIOS.has(scenario))
  if (unknownScenario) {
    throw new Error(`Unknown scenario: ${unknownScenario}`)
  }
  if (!Number.isFinite(args.warmupMs) || args.warmupMs < 0) {
    throw new Error('--warmup-ms must be a non-negative integer')
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error('--port must be a positive integer')
  }
  if (!Number.isFinite(args.testTabs) || args.testTabs < 0) {
    throw new Error('--test-tabs must be a non-negative integer')
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

function killTree (pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // The app may have exited already.
  }
}

function displaySnapshotExpression (scenario) {
  return `(() => {
    const bodyText = document.body?.innerText || document.body?.textContent || ''
    const scripts = Array.from(document.scripts).map(script => script.src || script.getAttribute('src') || '')
    const root = getComputedStyle(document.documentElement)
    const display = window.__TABBY_TAURI_DISPLAY__ ?? null
    const terminalHarness = window.__TABBY_TAURI_AUTOMATION__ ?? null
    const harnessTabs = Array.from(terminalHarness?.tabs ?? [])
    const capabilities = display?.capabilities ?? null
    const appRoot = document.querySelector('app-root')
    const xterm = document.querySelector('.xterm')
    const syntheticShell = bodyText.includes('Tabby Tauri MVP Shell') || scripts.some(src => src.includes('/src/main.ts'))
    return {
      scenario: ${JSON.stringify(scenario)},
      location: String(location.href),
      title: document.title,
      hasAppRoot: Boolean(appRoot),
      syntheticShell,
      bodyTextSample: bodyText.slice(0, 500),
      scripts,
      cssVariables: {
        bodyBg: root.getPropertyValue('--body-bg').trim(),
        appBg: root.getPropertyValue('--app-bg').trim(),
        terminalBg: root.getPropertyValue('--terminal-background').trim(),
        fontFamily: root.getPropertyValue('--font-family').trim(),
        tauriEffects: document.documentElement.dataset.tauriWindowEffects || '',
        tauriEffectsApplied: document.documentElement.dataset.tauriWindowEffectsApplied || '',
        tauriEffectsFallback: document.documentElement.dataset.tauriWindowEffectsFallback || '',
      },
      settingsVisibility: {
        vibrancy: Boolean(capabilities?.windowEffects?.supported),
        opacity: Boolean(capabilities?.opacity?.supported),
        customFrame: Boolean(capabilities?.customFrame?.supported),
      },
      terminal: {
        xtermCount: document.querySelectorAll('.xterm').length,
        hasXterm: Boolean(xterm),
        requestedTabs: Number(document.body.dataset.tauriTestTabs || 0),
        openedTabs: Number(document.body.dataset.tauriOpenedTabs || 0),
        harnessTabs: terminalHarness?.tabs?.length ?? 0,
        frontendReadyTabs: harnessTabs.filter(tab => Boolean(tab?.frontendIsReady)).length,
        frontendClasses: harnessTabs.map(tab => tab?.frontend?.constructor?.name ?? null),
        frontendElementTabs: harnessTabs.filter(tab => Boolean(tab?.frontend?.xterm?.element || tab?.frontend?.element)).length,
        terminalTextSample: (xterm?.textContent || '').slice(0, 500),
      },
      windowState: {
        fullscreenKnown: Boolean(capabilities?.windowStateEvents?.fullscreen),
        maximizedKnown: Boolean(capabilities?.windowStateEvents?.maximized),
        focusedKnown: Boolean(capabilities?.windowStateEvents?.focused),
        closeRequestedKnown: Boolean(capabilities?.windowStateEvents?.closeRequested),
        movedKnown: Boolean(capabilities?.windowStateEvents?.moved),
      },
      effects: display?.lastApplied ?? null,
      displayCapabilities: capabilities,
      displayAutomationPresent: Boolean(display?.applyFromCurrentConfig),
    }
  })()`
}

export function detectRuntimeSurfaceFromSnapshot (snapshot) {
  if (snapshot?.syntheticShell || String(snapshot?.bodyTextSample ?? '').includes('Tabby Tauri MVP Shell')) {
    return 'synthetic-shell'
  }
  if ((snapshot?.scripts ?? []).some(src => String(src).includes('/src/main.ts'))) {
    return 'synthetic-shell'
  }
  if (snapshot?.hasAppRoot) {
    return 'angular-tabby'
  }
  return 'unknown'
}

export function createDisplayArtifact ({ args, startedAt, finishedAt, scenarios }) {
  const sampledScenarios = scenarios.map(scenario => {
    const runtimeSurface = detectRuntimeSurfaceFromSnapshot(scenario.snapshot)
    const assertions = [
      {
        id: 'angular-tabby-runtime',
        passed: runtimeSurface === 'angular-tabby',
        detail: `runtimeSurface=${runtimeSurface}`,
      },
      {
        id: 'no-synthetic-shell',
        passed: runtimeSurface !== 'synthetic-shell' && !scenario.snapshot?.syntheticShell,
        detail: 'Fails if the legacy Tabby Tauri MVP Shell or /src/main.ts probe is loaded.',
      },
      {
        id: 'display-automation-present',
        passed: Boolean(scenario.snapshot?.displayAutomationPresent),
        detail: 'window.__TABBY_TAURI_DISPLAY__ exposes effects state and test hooks.',
      },
      {
        id: 'granular-window-effects-capability',
        passed: Boolean(scenario.snapshot?.displayCapabilities?.windowEffects?.supported),
        detail: 'Window settings should be gated by displayCapabilities instead of supportsWindowControls.',
      },
      {
        id: 'opacity-degraded-explicitly',
        passed: scenario.snapshot?.displayCapabilities?.opacity?.supported === false && Boolean(scenario.snapshot?.displayCapabilities?.opacity?.reason),
        detail: 'The installed Tauri API has setEffects but no setOpacity, so opacity must be an explicit degraded capability.',
      },
      {
        id: 'terminal-rendered',
        passed: !args.testTabs || (
          scenario.snapshot?.terminal?.openedTabs >= args.testTabs &&
          scenario.snapshot?.terminal?.harnessTabs >= args.testTabs &&
          (
            scenario.snapshot?.terminal?.xtermCount >= Math.min(args.testTabs, 1) ||
            scenario.snapshot?.terminal?.frontendReadyTabs >= args.testTabs
          )
        ),
        detail: `requestedTabs=${args.testTabs}; openedTabs=${scenario.snapshot?.terminal?.openedTabs ?? 0}; harnessTabs=${scenario.snapshot?.terminal?.harnessTabs ?? 0}; frontendReadyTabs=${scenario.snapshot?.terminal?.frontendReadyTabs ?? 0}; xtermCount=${scenario.snapshot?.terminal?.xtermCount ?? 0}`,
      },
    ]
    return {
      name: scenario.name,
      screenshot: scenario.screenshot ?? null,
      runtimeSurface,
      snapshot: scenario.snapshot,
      assertions,
    }
  })
  const assertions = sampledScenarios.flatMap(scenario => scenario.assertions.map(assertion => ({ ...assertion, scenario: scenario.name })))
  const passed = assertions.every(assertion => assertion.passed)

  return {
    schemaVersion: 1,
    name: 'tabby-tauri-display-parity',
    status: passed ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    runtimeSurface: sampledScenarios[0]?.runtimeSurface ?? 'unknown',
    appPath: args.appPath,
    scenarios: sampledScenarios,
    assertions,
  }
}

async function applyScenario (cdp, scenario) {
  if (scenario === 'effects-on') {
    return await evaluate(cdp, `window.__TABBY_TAURI_DISPLAY__?.applyTestEffects?.('acrylic') ?? null`)
  }
  if (scenario === 'effects-off') {
    return await evaluate(cdp, `window.__TABBY_TAURI_DISPLAY__?.clear?.('display-parity-effects-off') ?? null`)
  }
  if (scenario === 'state-events') {
    return await evaluate(cdp, `window.__TABBY_TAURI_DISPLAY__?.applyFromCurrentConfig?.('display-parity-state-events') ?? null`)
  }
  return await evaluate(cdp, `window.__TABBY_TAURI_DISPLAY__?.applyFromCurrentConfig?.('display-parity-default') ?? null`)
}

async function waitForScenarioReady (cdp, args, scenario, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(cdp, displaySnapshotExpression(scenario))
    const runtimeReady = snapshot.hasAppRoot && snapshot.displayAutomationPresent && !snapshot.syntheticShell
    const terminalReady = args.testTabs === 0 || (
      snapshot.terminal.openedTabs >= args.testTabs &&
      snapshot.terminal.harnessTabs >= args.testTabs &&
      (
        snapshot.terminal.xtermCount >= Math.min(args.testTabs, 1) ||
        snapshot.terminal.frontendReadyTabs >= args.testTabs
      )
    )
    if (runtimeReady && terminalReady) {
      return snapshot
    }
    await sleep(500)
  }
  return snapshot
}

async function captureScenario ({ args, scenario }) {
  const userDataDir = resolve(tmpdir(), `tabby-tauri-display-parity-${process.pid}-${scenario}-${Date.now()}`)
  const app = spawn(resolve(args.appPath), [`--test-tabs=${args.testTabs}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      TABBY_TAURI_DISPLAY_PARITY_SCENARIO: scenario,
      WEBVIEW2_USER_DATA_FOLDER: userDataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        `--remote-debugging-port=${args.port}`,
      ].filter(Boolean).join(' '),
    },
    windowsHide: true,
  })

  let cdp = null
  try {
    const target = await waitForTarget(args.port, Math.max(args.warmupMs, 15_000))
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await sleep(args.warmupMs)
    await waitForScenarioReady(cdp, args, scenario, Math.max(args.warmupMs, 15_000))
    await applyScenario(cdp, scenario)
    await sleep(500)
    const snapshot = await evaluate(cdp, displaySnapshotExpression(scenario))
    const screenshotResult = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = resolve(args.screenshotsDir, `${scenario}.png`)
    await mkdir(dirname(screenshotPath), { recursive: true })
    await writeFile(screenshotPath, Buffer.from(screenshotResult.data, 'base64'))
    return { name: scenario, snapshot, screenshot: screenshotPath }
  } finally {
    cdp?.close()
    if (app.pid) {
      killTree(app.pid)
    }
    await sleep(500)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => null)
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const scenarios = []
  let artifact

  try {
    for (const scenario of args.scenarios) {
      scenarios.push(await captureScenario({ args, scenario }))
    }
    artifact = createDisplayArtifact({
      args,
      startedAt,
      finishedAt: new Date().toISOString(),
      scenarios,
    })
  } catch (error) {
    artifact = createDisplayArtifact({
      args,
      startedAt,
      finishedAt: new Date().toISOString(),
      scenarios,
    })
    artifact.status = 'failed'
    artifact.error = error.stack ?? error.message
  }

  const outputPath = resolve(args.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)

  if (artifact.status !== 'passed') {
    throw new Error(`Display parity failed; see ${outputPath}`)
  }
  console.log(`Display parity passed; wrote ${outputPath}`)
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
  })
}
