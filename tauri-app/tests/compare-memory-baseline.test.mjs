import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function matrixResult(name, rows) {
  return {
    scenario: 'memory-scenario-matrix',
    status: 'sampled',
    generated_at: '2026-05-16T00:00:00.000Z',
    app_path: name,
    requested_tab_counts: rows.map(row => row.tab_count),
    results: rows.map(row => ({
      status: 'sampled',
      scenario: `${name}-${row.tab_count}-tabs`,
      tab_count: row.tab_count,
      total_working_set_mb: row.working_set,
      total_private_memory_mb: row.private_memory,
      process_count: row.process_count,
      automation_verified: true,
    })),
  }
}

function singleResult(name, row) {
  return {
    scenario: 'memory-scenario-matrix',
    status: 'sampled',
    sampled_at_end: '2026-05-16T00:00:00.000Z',
    app_path: name,
    total_working_set_mb: row.working_set,
    total_private_memory_mb: row.private_memory,
    process_count: row.process_count,
  }
}

async function runComparison(dir, tauri, electron) {
  const tauriPath = join(dir, 'tauri.json')
  const electronPath = join(dir, 'electron.json')
  const outputPath = join(dir, 'comparison.json')
  await writeFile(tauriPath, JSON.stringify(tauri))
  await writeFile(electronPath, JSON.stringify(electron))

  await execFileAsync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/compare-memory-baseline.ps1',
    '-TauriResultPath',
    tauriPath,
    '-ElectronResultPath',
    electronPath,
    '-OutputPath',
    outputPath,
  ], { cwd: process.cwd() })

  return JSON.parse((await readFile(outputPath, 'utf8')).replace(/^\uFEFF/, ''))
}

test('compare-memory-baseline emits per-tab deltas when both inputs are matrices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, matrixResult('tauri', [
      { tab_count: 1, working_set: 120, private_memory: 80, process_count: 3 },
      { tab_count: 6, working_set: 240, private_memory: 160, process_count: 8 },
    ]), matrixResult('electron', [
      { tab_count: 1, working_set: 200, private_memory: 120, process_count: 4 },
      { tab_count: 6, working_set: 360, private_memory: 210, process_count: 10 },
    ]))

    assert.equal(comparison.status, 'compared')
    assert.deepEqual(comparison.deltas.rows.map(row => row.tab_count), [1, 6])
    assert.deepEqual(comparison.deltas.rows[0].working_set, {
      absolute_mb: -80,
      percent: -40,
    })
    assert.deepEqual(comparison.deltas.rows[1].private_memory, {
      absolute_mb: -50,
      percent: -23.81,
    })
    assert.deepEqual(comparison.deltas.rows[1].process_count, {
      absolute: -2,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compare-memory-baseline warns when Electron is a matrix but Tauri is a single sample', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, singleResult('tauri', {
      working_set: 120,
      private_memory: 80,
      process_count: 3,
    }), matrixResult('electron', [
      { tab_count: 1, working_set: 200, private_memory: 120, process_count: 4 },
      { tab_count: 6, working_set: 360, private_memory: 210, process_count: 10 },
    ]))

    assert.equal(comparison.status, 'compared-with-warnings')
    assert.equal(comparison.deltas, null)
    assert.ok(
      comparison.warnings.includes('Electron result is a scenario matrix but Tauri result is a single scenario; per-tab deltas are intentionally omitted.'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compare-memory-baseline warns when matrix inputs contain duplicate tab counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, matrixResult('tauri', [
      { tab_count: 1, working_set: 120, private_memory: 80, process_count: 3 },
      { tab_count: 1, working_set: 125, private_memory: 82, process_count: 3 },
      { tab_count: 6, working_set: 240, private_memory: 160, process_count: 8 },
    ]), matrixResult('electron', [
      { tab_count: 1, working_set: 200, private_memory: 120, process_count: 4 },
      { tab_count: 6, working_set: 360, private_memory: 210, process_count: 10 },
      { tab_count: 6, working_set: 365, private_memory: 215, process_count: 10 },
    ]))

    assert.equal(comparison.status, 'compared-with-warnings')
    assert.equal(comparison.deltas, null)
    assert.ok(
      comparison.warnings.includes('Tauri matrix contains duplicate tab_count rows: 1.'),
    )
    assert.ok(
      comparison.warnings.includes('Electron matrix contains duplicate tab_count rows: 6.'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compare-memory-baseline short-circuits deltas before converting duplicate matrix rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, matrixResult('tauri', [
      { tab_count: 1, working_set: 120, private_memory: 80, process_count: 3 },
      { tab_count: 1, working_set: 'not-a-number', private_memory: 82, process_count: 3 },
    ]), matrixResult('electron', [
      { tab_count: 1, working_set: 200, private_memory: 120, process_count: 4 },
    ]))

    assert.equal(comparison.status, 'compared-with-warnings')
    assert.equal(comparison.deltas, null)
    assert.ok(
      comparison.warnings.includes('Tauri matrix contains duplicate tab_count rows: 1.'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compare-memory-baseline warns instead of converting non-numeric matrix tab counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, matrixResult('tauri', [
      { tab_count: 'not-a-tab-count', working_set: 120, private_memory: 80, process_count: 3 },
    ]), matrixResult('electron', [
      { tab_count: 1, working_set: 200, private_memory: 120, process_count: 4 },
    ]))

    assert.equal(comparison.status, 'compared-with-warnings')
    assert.equal(comparison.deltas, null)
    assert.ok(
      comparison.warnings.includes('Tauri matrix contains non-numeric tab_count rows: not-a-tab-count.'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compare-memory-baseline sorts numeric string tab counts numerically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-tauri-memory-compare-'))
  try {
    const comparison = await runComparison(dir, matrixResult('tauri', [
      { tab_count: '10', working_set: 500, private_memory: 300, process_count: 12 },
      { tab_count: '2', working_set: 200, private_memory: 120, process_count: 5 },
    ]), matrixResult('electron', [
      { tab_count: '10', working_set: 800, private_memory: 480, process_count: 16 },
      { tab_count: '2', working_set: 260, private_memory: 160, process_count: 6 },
    ]))

    assert.equal(comparison.status, 'compared')
    assert.deepEqual(comparison.deltas.rows.map(row => row.tab_count), [2, 10])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
