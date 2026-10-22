#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

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
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) {
      return
    }
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`))
    } else {
      request.resolve(message.result)
    }
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      request.reject(new Error('CDP socket closed'))
    }
    pending.clear()
  })
  return {
    async send (method, params = {}, timeoutMs = 30_000) {
      await opened
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for CDP response to ${method}`))
        }, timeoutMs)
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

async function evaluate (cdp, expression, timeoutMs = 30_000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs)
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    const message = details.exception?.description ?? details.exception?.value ?? details.text ?? 'Runtime.evaluate failed'
    throw new Error(message)
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

async function waitForAutomation (cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(cdp, `(() => ({
      ready: !!document.body,
      openedTabs: Number(document.body?.dataset.tauriOpenedTabs || 0),
      xterms: document.querySelectorAll('.xterm').length,
      hasHarness: !!window.__TABBY_TAURI_AUTOMATION__,
      harnessTabs: window.__TABBY_TAURI_AUTOMATION__?.tabs?.length ?? 0,
      bodyText: document.body?.textContent?.slice(0, 300) ?? ''
    }))()`)
    if (snapshot.openedTabs === 1 && snapshot.hasHarness && snapshot.harnessTabs >= 1) {
      return snapshot
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for automation harness: ${JSON.stringify(snapshot)}`)
}

async function readLocalSshState (cdp) {
  return await evaluate(cdp, `(() => {
    const harness = window.__TABBY_TAURI_AUTOMATION__
    const tab = harness?.tabs?.[0]
    const toolbarTexts = [...document.querySelectorAll('terminal-toolbar')].map(node => node.textContent?.trim() ?? '')
    return {
      title: tab?.title ?? null,
      customTitle: tab?.customTitle ?? null,
      disableDynamicTitle: tab?.disableDynamicTitle ?? null,
      enableToolbar: tab?.enableToolbar ?? null,
      pinToolbar: tab?.pinToolbar ?? null,
      toolbarTexts,
      localSftpHosts: [...document.querySelectorAll('tauri-local-ssh-sftp-toolbar')].map(node => ({
        text: node.textContent?.trim() ?? '',
        html: node.outerHTML.slice(0, 1200),
      })),
      buttonTexts: [...document.querySelectorAll('button')].map(node => ({
        text: node.textContent?.trim() ?? '',
        title: node.getAttribute('title') ?? '',
        ariaLabel: node.getAttribute('aria-label') ?? '',
        classes: node.className ?? '',
      })).filter(item => item.text || item.title),
      hasTopRightSftpButton: !!document.querySelector('.tab-bar .btn-group.background button.btn-tab-bar[title="SFTP"], .tab-bar .btn-group.background button.btn-tab-bar[aria-label="SFTP"]'),
      hasBottomSftpToolbar: [...document.querySelectorAll('terminal-toolbar')]
        .some(node => node.textContent?.includes('SFTP')),
      hasSftpText: document.body.textContent?.includes('SFTP') ?? false,
      diagnostics: window.__TABBY_TAURI_LOCAL_SSH_DIAGNOSTICS__ ?? null,
      tabShape: tab ? {
        constructorName: tab.constructor?.name ?? null,
        profileType: tab.profile?.type ?? null,
        hasInputDollar: !!tab.input$,
        inputDollarType: typeof tab.input$,
        hasInputSubscribe: typeof tab.input$?.subscribe === 'function',
        hasHostView: !!tab.hostView,
        hostRootNodes: tab.hostView?.rootNodes?.length ?? null,
        ownKeys: Object.keys(tab).slice(0, 80),
      } : null,
      outputTail: harness?.readOutput?.(0)?.slice(-800) ?? null,
    }
  })()`)
}

async function sendViaHarness (cdp, command) {
  const input = process.argv[4] === 'paste'
    ? `\x1b[200~${command}\x1b[201~\r`
    : `${command}\r`
  await evaluate(cdp, `(() => {
    const harness = window.__TABBY_TAURI_AUTOMATION__
    if (!harness?.sendInput?.(0, ${JSON.stringify(input)})) {
      throw new Error('No harness tab available')
    }
    return true
  })()`)
}

async function verifyScenario (cdp, label, action) {
  await evaluate(cdp, `(() => {
    const harness = window.__TABBY_TAURI_AUTOMATION__
    harness?.clearOutput?.(0)
    return true
  })()`)
  await action()
  await sleep(1500)
  const state = await readLocalSshState(cdp)
  const passed = state.title === '10.1.3.20' &&
    state.customTitle === '10.1.3.20' &&
    state.disableDynamicTitle === true &&
    state.enableToolbar !== true &&
    state.pinToolbar !== true &&
    state.hasTopRightSftpButton === true &&
    state.hasBottomSftpToolbar === false
  return { label, passed, state }
}

async function main () {
  const appPath = resolve(process.argv[2] ?? 'src-tauri/target/release/tabby-tauri.exe')
  const port = Number(process.argv[3] ?? 9449)
  const userDataFolder = resolve(tmpdir(), `tabby-tauri-local-ssh-ui-${process.pid}-${Date.now()}`)
  await mkdir(userDataFolder, { recursive: true })
  const child = spawn(appPath, ['--test-tabs=1'], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: userDataFolder,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        `--remote-debugging-port=${port}`,
      ].filter(Boolean).join(' '),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  let cdp = null
  try {
    const target = await waitForTarget(port, 30_000)
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    const automation = await waitForAutomation(cdp, 30_000)
    const result = await verifyScenario(cdp, 'harness-sendInput', () => sendViaHarness(cdp, 'ssh devops@10.1.3.20'))
    const artifact = {
      status: result.passed ? 'passed' : 'failed',
      appPath,
      pid: child.pid,
      port,
      automation,
      result,
    }
    console.log(JSON.stringify(artifact, null, 2))
    if (!result.passed) {
      process.exitCode = 2
    }
  } finally {
    cdp?.close()
    killTree(child.pid)
    await sleep(500)
    await rm(userDataFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => null)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
