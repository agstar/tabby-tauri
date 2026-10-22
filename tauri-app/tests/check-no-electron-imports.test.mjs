import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scanForElectronImports } from '../scripts/check-no-electron-imports.mjs'
import { buildTauriImportGraph, loadMigrationMatrix, scanTauriNodeElectronGraph } from '../scripts/check-tauri-node-electron-graph.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

test('scanForElectronImports reports Electron and dynamic Node plugin loader patterns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'good.ts'), "export const ok = 'tauri'\n")
    await writeFile(join(dir, 'src', 'bad.ts'), "import { ipcRenderer } from 'electron'\nconst r = global['require']\n")

    const findings = await scanForElectronImports(dir)

    assert.equal(findings.length, 2)
    assert.deepEqual(findings.map(f => f.pattern).sort(), ['dynamic-global-require', 'electron-import'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanForElectronImports reports side-effect Electron imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-gate-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'bad.ts'), "import 'electron'\n")

    const findings = await scanForElectronImports(dir)

    assert.deepEqual(findings, [
      { file: join(dir, 'src', 'bad.ts'), pattern: 'electron-import' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Tauri renderer graph has no reachable Node/Electron migration findings', () => {
  const result = scanTauriNodeElectronGraph({ repoRoot })

  assert.equal(result.untracked.length, 0, result.untracked.map(f => `${f.file}:${f.pattern}`).join('\n'))
  assert.equal(result.tracked.length, 0, result.tracked.map(f => `${f.file}:${f.pattern}`).join('\n'))
  assert.ok(
    result.graph.files.includes('tabby/app/src/entry.tauri.ts'),
    'graph must be rooted in the Tauri entrypoint',
  )
})

test('Tauri graph guard rejects reachable fs/promises imports instead of hiding them behind shims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-graph-'))
  try {
    await writeFile(join(dir, 'entry.ts'), "import { writeFile } from 'fs/promises'\nexport async function save () { await writeFile('x', 'y') }\n")

    const result = scanTauriNodeElectronGraph({ repoRoot: dir, entry: 'entry.ts', matrix: 'matrix.md' })

    assert.deepEqual(result.untracked.map(f => `${f.file}:${f.pattern}:${f.specifier}`), [
      'entry.ts:node-fs:fs/promises',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Tauri graph guard follows webpack-commented dynamic imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-graph-'))
  try {
    await writeFile(join(dir, 'entry.ts'), "export async function load () { return await import(/* webpackChunkName: \"bad\" */ 'fs/promises') }\n")

    const result = scanTauriNodeElectronGraph({ repoRoot: dir, entry: 'entry.ts', matrix: 'matrix.md' })

    assert.deepEqual(result.untracked.map(f => `${f.file}:${f.pattern}:${f.specifier}`), [
      'entry.ts:node-fs:fs/promises',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Tauri SSH graph uses provider contracts instead of Electron russh sessions', () => {
  const graph = buildTauriImportGraph({ repoRoot })

  for (const electronOnlySession of [
    'tabby/tabby-ssh/src/session/ssh.ts',
    'tabby/tabby-ssh/src/session/shell.ts',
    'tabby/tabby-ssh/src/session/sftp.ts',
    'tabby/tabby-ssh/src/session/forwards.ts',
    'tabby/tabby-ssh/src/session/x11.ts',
  ]) {
    assert.ok(!graph.files.includes(electronOnlySession), `${electronOnlySession} must stay out of the Tauri renderer graph`)
  }
  assert.ok(
    graph.files.includes('tabby/tabby-ssh/src/session/types.ts'),
    'Tauri should depend on SSH provider contracts, not Electron transport implementations',
  )
})

test('Tauri terminal stream processor is browser-native', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-terminal', 'src', 'middleware', 'streamProcessing.ts'), 'utf8')

  assert.doesNotMatch(source, /from ['"](?:stream|readline)['"]|require\(['"](?:stream|readline)['"]\)/)
  assert.match(source, /private feedReadlineInput/, 'readline input mode should be implemented directly in the browser middleware')
  assert.match(source, /\\r\\x1b\[2K/, 'readline prompt redraw should clear the active browser terminal line')
})

test('Tauri renderer graph excludes Electron bootstrap and dynamic plugin loader', () => {
  const graph = buildTauriImportGraph({ repoRoot })

  assert.ok(!graph.files.includes('tabby/app/src/entry.ts'), 'Electron entry.ts must not be reachable from entry.tauri.ts')
  assert.ok(!graph.files.includes('tabby/app/src/plugins.ts'), 'Electron dynamic plugin loader must not be reachable from entry.tauri.ts')
})

test('Tauri Node/Electron migration matrix records provider contracts and plugin MVP policy', () => {
  const matrixPath = resolve(repoRoot, '.omx', 'plans', 'tauri-node-electron-migration-matrix.md')
  assert.equal(existsSync(matrixPath), true, 'migration matrix must exist')

  const matrix = readFileSync(matrixPath, 'utf8')
  for (const expected of [
    'built-in/static plugins only',
    '`tauri_plugin_manifest`',
    '`native_path_exists` / `native_stat_path`',
    '`native_vault_crypto`',
    '`tauri_ssh_provider`',
    '`native_tcp_forwarding`',
    'browser-native stream processor',
  ]) {
    assert.match(matrix, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `matrix must document ${expected}`)
  }

  const parsed = loadMigrationMatrix({ repoRoot })
  assert.ok(
    parsed.allowed.has('tabby/tabby-core/src/services/vault.service.ts|node-crypto'),
    'matrix must track the vault crypto migration row',
  )
  assert.ok(
    parsed.allowed.has('tabby/app/src/plugins.ts|node-module-loader'),
    'matrix must track the excluded Electron plugin loader row',
  )
})
