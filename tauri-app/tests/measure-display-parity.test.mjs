import test from 'node:test'
import assert from 'node:assert/strict'
import { createDisplayArtifact, detectRuntimeSurfaceFromSnapshot, parseArgs } from '../scripts/measure-display-parity.mjs'

test('parseArgs requires app-path', () => {
  assert.throws(() => parseArgs([]), /Missing required --app-path/)
})

test('parseArgs rejects unknown scenarios', () => {
  assert.throws(
    () => parseArgs(['--app-path', 'C:/fake/tabby.exe', '--scenarios', 'default,unknown']),
    /Unknown scenario: unknown/,
  )
})

test('detectRuntimeSurfaceFromSnapshot catches the legacy synthetic shell', () => {
  assert.equal(
    detectRuntimeSurfaceFromSnapshot({
      hasAppRoot: false,
      syntheticShell: true,
      bodyTextSample: 'Tabby Tauri MVP Shell',
      scripts: ['http://127.0.0.1:1420/src/main.ts'],
    }),
    'synthetic-shell',
  )
})

test('createDisplayArtifact records required display parity fields', () => {
  const artifact = createDisplayArtifact({
    args: { appPath: 'C:/fake/tabby.exe', testTabs: 1 },
    startedAt: '2026-05-16T00:00:00.000Z',
    finishedAt: '2026-05-16T00:00:01.000Z',
    scenarios: [
      {
        name: 'default',
        screenshot: 'default.png',
        snapshot: {
          hasAppRoot: true,
          syntheticShell: false,
          bodyTextSample: 'Tabby',
          scripts: ['app/bundle.tauri.js'],
          displayAutomationPresent: true,
          displayCapabilities: {
            windowEffects: { supported: true },
            opacity: { supported: false, reason: 'no setOpacity' },
          },
          cssVariables: { bodyBg: '#000' },
          settingsVisibility: { vibrancy: true, opacity: false, customFrame: true },
          terminal: { requestedTabs: 1, openedTabs: 1, harnessTabs: 1, frontendReadyTabs: 1, xtermCount: 1 },
          windowState: { fullscreenKnown: true },
          effects: { applied: false, effects: [] },
        },
      },
    ],
  })

  assert.equal(artifact.status, 'passed')
  assert.equal(artifact.runtimeSurface, 'angular-tabby')
  assert.equal(artifact.scenarios[0].snapshot.settingsVisibility.vibrancy, true)
  assert.equal(artifact.assertions.every(assertion => assertion.passed), true)
})
