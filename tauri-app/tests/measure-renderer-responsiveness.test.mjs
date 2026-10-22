import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('single-run responsiveness scenario keeps cleanup ownership inside measureOneScenario', async () => {
  const source = await readFile(new URL('../scripts/measure-renderer-responsiveness.mjs', import.meta.url), 'utf8')

  assert.equal(
    source.includes('withTimeout(measureOneScenario'),
    false,
    'wrapping measureOneScenario in an outer timeout can abandon its finally cleanup on timeout',
  )
})
