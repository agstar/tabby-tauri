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
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`)
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) {
        return target
      }
    } catch {
      // keep waiting
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`)
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
    // Process may already be gone.
  }
}

async function waitForTerminal (cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await evaluate(cdp, `(() => ({
      xterms: document.querySelectorAll('.xterm').length,
      textareas: document.querySelectorAll('.xterm textarea').length,
      bodyText: document.body?.textContent?.slice(0, 500) ?? '',
      diagnostics: window.__TABBY_TAURI_LOCAL_SSH_DIAGNOSTICS__ ?? null
    }))()`)
    if (snapshot.xterms >= 1 && snapshot.textareas >= 1) {
      return snapshot
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for normal terminal: ${JSON.stringify(snapshot)}`)
}

async function openNewTerminal (cdp) {
  await evaluate(cdp, `(() => {
    const clickable = [...document.querySelectorAll('button, a, .btn, [role="button"]')]
      .find(node => /新终端|New terminal|Terminal/.test(node.textContent ?? ''))
    if (!clickable) {
      throw new Error([...document.querySelectorAll('button, a, .btn, [role="button"]')]
        .map(node => node.textContent?.trim()).filter(Boolean).slice(0, 50).join(' | '))
    }
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return clickable.textContent?.trim() ?? ''
  })()`)
}

async function focusTerminal (cdp) {
  await evaluate(cdp, `(() => {
    const textarea = document.querySelector('.xterm textarea')
    if (!textarea) throw new Error('xterm textarea not found')
    textarea.focus()
    return true
  })()`)
}

async function typeText (cdp, text) {
  for (const char of text) {
    if (char === '\r') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    } else {
      await cdp.send('Input.insertText', { text: char })
    }
    await sleep(20)
  }
}

async function readState (cdp) {
  return await evaluate(cdp, `(() => {
    const headers = [...document.querySelectorAll('tab-header, .tab-header, .tabs-tab, .tab')].map(node => node.textContent?.trim()).filter(Boolean)
    const toolbarTexts = [...document.querySelectorAll('terminal-toolbar')].map(node => node.textContent?.trim() ?? '')
    const sftpHosts = [...document.querySelectorAll('tauri-local-ssh-sftp-toolbar')].map(node => node.textContent?.trim() ?? '')
    const buttons = [...document.querySelectorAll('button')].map(node => ({
      text: node.textContent?.trim() ?? '',
      title: node.getAttribute('title') ?? '',
      ariaLabel: node.getAttribute('aria-label') ?? '',
      classes: node.className ?? '',
    })).filter(item => item.text || item.title)
    return {
      headers,
      toolbarTexts,
      sftpHosts,
      buttons,
      hasTopRightSftpButton: !!document.querySelector('.tab-bar .btn-group.background button.btn-tab-bar[title="SFTP"], .tab-bar .btn-group.background button.btn-tab-bar[aria-label="SFTP"]'),
      hasBottomSftpToolbar: [...document.querySelectorAll('terminal-toolbar')]
        .some(node => node.textContent?.includes('SFTP')),
      hasSftpText: document.body.textContent?.includes('SFTP') ?? false,
      diagnostics: window.__TABBY_TAURI_LOCAL_SSH_DIAGNOSTICS__ ?? null,
      bodyText: document.body?.textContent?.slice(0, 1500) ?? '',
    }
  })()`)
}

async function main () {
  const appPath = resolve(process.argv[2] ?? 'src-tauri/target/release/tabby-tauri.exe')
  const port = Number(process.argv[3] ?? 9462)
  const userDataFolder = resolve(tmpdir(), `tabby-tauri-normal-local-ssh-ui-${process.pid}-${Date.now()}`)
  await mkdir(userDataFolder, { recursive: true })
  const child = spawn(appPath, [], {
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
    let terminal = null
    try {
      terminal = await waitForTerminal(cdp, 3000)
    } catch {
      await openNewTerminal(cdp)
      terminal = await waitForTerminal(cdp, 30_000)
    }
    await focusTerminal(cdp)
    await typeText(cdp, 'ssh devops@10.1.3.20\r')
    await sleep(2000)
    const state = await readState(cdp)
    const passed = state.hasTopRightSftpButton === true &&
      state.hasBottomSftpToolbar === false &&
      state.diagnostics?.attachedTabs >= 1 &&
      state.diagnostics?.lastTarget === '10.1.3.20'
    console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', appPath, pid: child.pid, port, terminal, state }, null, 2))
    if (!passed) {
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
