import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import test from 'node:test'
import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '..', '..')

async function importSizeSync () {
  const sourcePath = resolve(repoRoot, 'tabby-tauri', 'src', 'sshTerminalSizeSync.ts')
  const outDir = await mkdtemp(join(tmpdir(), 'tabby-tauri-ssh-size-'))
  const js = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText
  const outPath = join(outDir, 'sshTerminalSizeSync.mjs')
  await writeFile(outPath, js)
  return {
    module: await import(pathToFileURL(outPath).href),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  }
}

test('SSH terminal opens with the latest frontend size instead of the 80-column fallback', async () => {
  const { module, cleanup } = await importSizeSync()
  try {
    const sent = []
    const sync = new module.SshTerminalSizeSync(
      { cols: 80, rows: 24 },
      async size => sent.push(size),
    )

    await sync.update(168, 42)
    assert.deepEqual(sync.current, { cols: 168, rows: 42 })
    assert.deepEqual(sent, [], 'resizes before shell open should update the initial PTY request without sending window-change')

    await sync.markOpened(sync.current)
    assert.deepEqual(sent, [], 'opening at the desired size should not send a redundant resize')
  } finally {
    await cleanup()
  }
})

test('SSH terminal serializes resize requests and applies the newest size after an in-flight resize', async () => {
  const { module, cleanup } = await importSizeSync()
  try {
    const started = []
    const releases = []
    const sync = new module.SshTerminalSizeSync(
      { cols: 80, rows: 24 },
      size => new Promise(resolve => {
        started.push(size)
        releases.push(resolve)
      }),
    )

    await sync.markOpened({ cols: 80, rows: 24 })
    const first = sync.update(120, 30)
    const second = sync.update(168, 42)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, [{ cols: 120, rows: 30 }])

    releases.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, [
      { cols: 120, rows: 30 },
      { cols: 168, rows: 42 },
    ])

    releases.shift()()
    await Promise.all([first, second])
  } finally {
    await cleanup()
  }
})

test('SSH terminal can force the current size to be resent after a missed remote resize', async () => {
  const { module, cleanup } = await importSizeSync()
  try {
    const sent = []
    const sync = new module.SshTerminalSizeSync(
      { cols: 168, rows: 42 },
      async size => sent.push(size),
    )

    await sync.markOpened(sync.current)
    await sync.resync()

    assert.deepEqual(sent, [{ cols: 168, rows: 42 }])
  } finally {
    await cleanup()
  }
})

test('SSH tab primes the shell session with the current frontend size before opening it', () => {
  const source = readFileSync(
    resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshTab.component.ts'),
    'utf8',
  )
  const createIndex = source.indexOf('const session = await this.sshShellSessionFactory.create')
  const setSessionIndex = source.indexOf('this.setSession(session)', createIndex)
  const preAttachSource = source.slice(createIndex, setSessionIndex)

  assert.notEqual(createIndex, -1)
  assert.notEqual(setSessionIndex, -1)
  assert.match(
    preAttachSource,
    /session\.resize\(this\.size\.columns, this\.size\.rows\)/,
    'the renderer size must be stored before Tauri opens the remote PTY',
  )
})

test('SSH tab resynchronizes the remote PTY size after the terminal regains focus', () => {
  const source = readFileSync(
    resolve(repoRoot, 'tabby-ssh', 'src', 'components', 'sshTab.component.ts'),
    'utf8',
  )

  assert.match(source, /this\.subscribeUntilDestroyed\(this\.focused\$,[^]*scheduleTerminalSizeResync/)
  assert.match(source, /this\.subscribeUntilDestroyed\(this\.visibility\$,[^]*scheduleTerminalSizeResync/)
  assert.match(source, /session\.resyncSize\?\.\(\)/)
})
