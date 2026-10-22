import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function importCompiledProviders() {
  const outDir = await mkdtemp(join(process.cwd(), '.tmp-providers-'))
  await writeFile(join(outDir, 'package.json'), '{"type":"module"}\n')
  await execFileAsync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      '--skipLibCheck',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      'src/tauri-providers.ts',
    ],
    { cwd: process.cwd() },
  )

  return {
    providers: await import(pathToFileURL(join(outDir, 'tauri-providers.js'))),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  }
}

function snapshot(session_id, kind, state = 'running') {
  return {
    session_id,
    kind,
    state,
    last_activity_at: 1,
    bytes_in: 0,
    bytes_out: 0,
    queue_depth: 0,
    reader_paused: false,
    close_reason: state === 'closed' ? 'client-close' : null,
    error_reason: null,
  }
}

test('TauriLocalTerminalSession maps PTY stream, ack, write, resize, and close', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  try {
    const calls = []
    const bridge = {
      async spawn(request) {
        calls.push(['spawn', request.command])
        return { session: snapshot('local-1', 'local'), pid: 42, cwd: 'C:/Users/test' }
      },
      async stream(sessionId, onData) {
        calls.push(['stream', sessionId])
        onData({ session_id: sessionId, seq: 1, bytes: [65, 66] })
      },
      async ackData(sessionId, length) {
        calls.push(['ack', sessionId, length])
        return { ...snapshot(sessionId, 'local'), bytes_out: length }
      },
      async write(sessionId, bytes) {
        calls.push(['write', sessionId, Array.from(bytes)])
        return { ...snapshot(sessionId, 'local'), bytes_in: bytes.byteLength }
      },
      async resize(sessionId, cols, rows) {
        calls.push(['resize', sessionId, cols, rows])
      },
      async kill(sessionId) {
        calls.push(['kill', sessionId])
        return snapshot(sessionId, 'local', 'closed')
      },
      async getWorkingDirectory(sessionId) {
        calls.push(['cwd', sessionId])
        return 'C:/Users/test'
      },
      async getChildProcesses(sessionId) {
        calls.push(['children', sessionId])
        return [{ pid: 8, ppid: 7, command: 'cmd.exe' }]
      },
    }

    const session = new providers.TauriLocalTerminalSession(bridge, {
      request: { command: 'powershell.exe', size: { cols: 80, rows: 24 } },
    })
    const data = []
    const states = []
    session.onData(bytes => data.push(Array.from(bytes)))
    session.onState(state => states.push(state.state))

    assert.equal((await session.start()).session_id, 'local-1')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(data, [[65, 66]])
    assert.equal(session.id, 'local-1')
    assert.equal(session.open, true)
    assert.equal(session.snapshot.bytes_out, 2)
    assert.equal(session.supportsWorkingDirectory(), true)

    await session.write(new Uint8Array([67]))
    await session.resize(100, 30)
    assert.equal(await session.getWorkingDirectory(), 'C:/Users/test')
    assert.deepEqual(await session.getChildProcesses(), [{ pid: 8, ppid: 7, command: 'cmd.exe' }])
    assert.equal((await session.close()).state, 'closed')
    assert.equal(session.open, false)

    assert.deepEqual(calls, [
      ['spawn', 'powershell.exe'],
      ['stream', 'local-1'],
      ['ack', 'local-1', 2],
      ['write', 'local-1', [67]],
      ['resize', 'local-1', 100, 30],
      ['cwd', 'local-1'],
      ['children', 'local-1'],
      ['kill', 'local-1'],
    ])
    assert.ok(states.includes('running'))
    assert.equal(states.at(-1), 'closed')
  } finally {
    await cleanup()
  }
})

test('TauriPTYProxy maps close and exit subscriptions to session-state polling', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  try {
    const calls = []
    globalThis.setInterval = handler => {
      Promise.resolve().then(handler)
      return 1
    }
    globalThis.clearInterval = id => calls.push(['clearInterval', id])

    const bridge = {
      async state(sessionId) {
        calls.push(['state', sessionId])
        return snapshot(sessionId, 'local', 'closed')
      },
    }
    const proxy = new providers.TauriPTYProxy(bridge, {
      session: snapshot('local-1', 'local'),
      pid: 42,
      cwd: null,
    })

    const closeSnapshot = await new Promise(resolve => {
      proxy.subscribe('close', resolve)
    })

    assert.equal(closeSnapshot.state, 'closed')
    assert.deepEqual(calls, [
      ['state', 'local-1'],
      ['clearInterval', 1],
    ])
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    await cleanup()
  }
})

test('TauriPTYInterface accepts upstream tabby-local spawn command/args/options shape', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  try {
    const requests = []
    const bridge = {
      async spawn(request) {
        requests.push(request)
        return { session: snapshot('local-1', 'local'), pid: 7, cwd: request.cwd }
      },
    }

    const pty = new providers.TauriPTYInterface(bridge)
    const proxy = await pty.spawn('powershell.exe', ['-NoLogo'], {
      cols: 120,
      rows: 40,
      cwd: 'C:/work',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      encoding: null,
      useConpty: 1,
    })

    assert.equal(proxy.getID(), 'local-1')
    assert.deepEqual(requests, [
      {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        cwd: 'C:/work',
        env: [
          ['TERM', 'xterm-256color'],
          ['COLORTERM', 'truecolor'],
        ],
        size: { cols: 120, rows: 40 },
      },
    ])
  } finally {
    await cleanup()
  }
})

test('TauriSSHShellSession uses russh transport, stream ack, keepalive, and close paths', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  try {
    const calls = []
    const adapter = {
      async connectTransport(request) {
        calls.push(['connectTransport', request.host])
        return { session: snapshot('ssh-1', 'ssh', 'starting'), transport_status: 'russh-connected' }
      },
      async openShellTransport(sessionId, size) {
        calls.push(['openShellTransport', sessionId, size.cols, size.rows])
        return snapshot(sessionId, 'ssh')
      },
      async streamTransport(sessionId, onData) {
        calls.push(['streamTransport', sessionId])
        onData({ session_id: sessionId, seq: 1, bytes: [111, 107] })
        return snapshot(sessionId, 'ssh')
      },
      async ack(sessionId, length) {
        calls.push(['ack', sessionId, length])
        return { ...snapshot(sessionId, 'ssh'), bytes_out: length }
      },
      async keepaliveEvaluatorTransport(sessionId, request) {
        calls.push(['keepaliveEvaluatorTransport', sessionId, request.probes, request.interval_ms])
        return {
          session: snapshot(sessionId, 'ssh', 'idle'),
          probes_attempted: request.probes,
          probes_succeeded: request.probes,
          status: 'healthy',
        }
      },
      async writeTransport(sessionId, bytes) {
        calls.push(['writeTransport', sessionId, Array.from(bytes)])
        return { ...snapshot(sessionId, 'ssh'), bytes_in: bytes.byteLength }
      },
      async resizeTransport(sessionId, size) {
        calls.push(['resizeTransport', sessionId, size.cols, size.rows])
        return snapshot(sessionId, 'ssh')
      },
      async closeTransport(sessionId, reason) {
        calls.push(['closeTransport', sessionId, reason])
        return { ...snapshot(sessionId, 'ssh', 'closed'), close_reason: reason }
      },
    }

    const session = new providers.TauriSSHShellSession(adapter, {
      request: {
        host: '127.0.0.1',
        port: 22,
        username: 'tabby',
        auth: { type: 'password', password: 'secret' },
      },
      size: { cols: 80, rows: 24 },
      keepalive: { probes: 2, interval_ms: 1 },
    })
    const data = []
    const states = []
    session.onData(bytes => data.push(Array.from(bytes)))
    session.onState(state => states.push(state.state))

    assert.equal((await session.start()).state, 'idle')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(data, [[111, 107]])
    assert.equal(session.id, 'ssh-1')
    await session.write(new Uint8Array([13]))
    assert.equal(session.open, true)
    assert.equal(session.supportsWorkingDirectory(), false)
    assert.equal(await session.getWorkingDirectory(), null)
    await session.resize(100, 30)
    assert.equal((await session.close('done')).close_reason, 'done')
    assert.equal(session.open, false)

    assert.deepEqual(calls, [
      ['connectTransport', '127.0.0.1'],
      ['openShellTransport', 'ssh-1', 80, 24],
      ['streamTransport', 'ssh-1'],
      ['ack', 'ssh-1', 2],
      ['keepaliveEvaluatorTransport', 'ssh-1', 2, 1],
      ['writeTransport', 'ssh-1', [13]],
      ['resizeTransport', 'ssh-1', 100, 30],
      ['closeTransport', 'ssh-1', 'done'],
    ])
    assert.deepEqual(states, ['starting', 'running', 'running', 'idle', 'running', 'running', 'closed'])
  } finally {
    await cleanup()
  }
})

test('TauriSSHShellSession reports remote working directory from OSC 1337 CurrentDir', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  try {
    const oscCurrentDir = Buffer.from('\x1b]1337;CurrentDir=/srv/app\x07')
    const adapter = {
      async connectTransport() {
        return { session: snapshot('ssh-cwd', 'ssh', 'starting'), transport_status: 'russh-connected' }
      },
      async openShellTransport(sessionId) {
        return snapshot(sessionId, 'ssh')
      },
      async streamTransport(sessionId, onData) {
        onData({ session_id: sessionId, seq: 1, bytes: Array.from(oscCurrentDir) })
        return snapshot(sessionId, 'ssh')
      },
      async ack(sessionId, length) {
        return { ...snapshot(sessionId, 'ssh'), bytes_out: length }
      },
    }

    const session = new providers.TauriSSHShellSession(adapter, {
      request: {
        host: '127.0.0.1',
        port: 22,
        username: 'tabby',
        auth: { type: 'password', password: 'secret' },
      },
      size: { cols: 80, rows: 24 },
    })

    await session.start()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(session.supportsWorkingDirectory(), true)
    assert.equal(await session.getWorkingDirectory(), '/srv/app')
  } finally {
    await cleanup()
  }
})

test('TauriHostKeyTrustStore remembers and forgets pinned host keys', async () => {
  const { providers, cleanup } = await importCompiledProviders()
  try {
    const map = new Map()
    const store = new providers.TauriHostKeyTrustStore({
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value),
      removeItem: key => map.delete(key),
    })
    const prompt = {
      host: 'example.test',
      port: 22,
      username: 'tabby',
      fingerprint: 'SHA256:abc',
    }

    assert.equal(store.isTrusted(prompt), false)
    store.remember(prompt)
    assert.equal(store.getTrustedFingerprint(prompt), 'SHA256:abc')
    assert.equal(store.isTrusted(prompt), true)
    store.forget(prompt)
    assert.equal(store.isTrusted(prompt), false)
  } finally {
    await cleanup()
  }
})
