import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import test from 'node:test'
import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '..', '..')

async function importSshTitleHelper() {
  const sourcePath = resolve(repoRoot, 'tabby-local', 'src', 'sshTitle.ts')
  const outDir = await mkdtemp(join(tmpdir(), 'tabby-local-ssh-title-'))
  const js = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText
  const outPath = join(outDir, 'sshTitle.mjs')
  await writeFile(outPath, js)
  return {
    module: await import(pathToFileURL(outPath).href),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  }
}

test('local terminal ssh commands derive the tab title from the remote host', async () => {
  const { module, cleanup } = await importSshTitleHelper()
  try {
    const { parseLocalSshDestination, parseLocalSshDestinationTitle } = module
    assert.equal(parseLocalSshDestinationTitle('ssh root@10.1.4.126'), '10.1.4.126')
    assert.equal(parseLocalSshDestinationTitle('ssh -p 2222 devops@10.1.4.127'), '10.1.4.127')
    assert.equal(parseLocalSshDestinationTitle('ssh -J jump@10.0.0.1 admin@192.168.1.50'), '192.168.1.50')
    assert.equal(parseLocalSshDestinationTitle('ssh admin@192.168.1.51 uptime'), '192.168.1.51')
    assert.equal(parseLocalSshDestinationTitle('ssh -i "C:/Users/me/.ssh/id key" alice@example.test'), 'example.test')
    assert.equal(parseLocalSshDestinationTitle('echo ssh root@10.1.4.126'), null)
    assert.deepEqual(parseLocalSshDestination('ssh -p 2222 -i "C:/Users/me/.ssh/id key" alice@example.test'), {
      host: 'example.test',
      port: 2222,
      username: 'alice',
      privateKeyPath: 'C:/Users/me/.ssh/id key',
    })
  } finally {
    await cleanup()
  }
})

test('local terminal tab wires ssh command detection before forwarding input to the session', () => {
  const source = readFileSync(
    resolve(repoRoot, 'tabby-local', 'src', 'components', 'terminalTab.component.ts'),
    'utf8',
  )
  const sendInputIndex = source.indexOf('sendInput (data: string|Buffer): void')
  assert.notEqual(sendInputIndex, -1, 'TerminalTabComponent must override sendInput')
  const methodEnd = source.indexOf('\n    async getRecoveryToken', sendInputIndex)
  const sendInput = source.slice(sendInputIndex, methodEnd)
  assert.match(sendInput, /this\.updateTitleFromLocalSshInput\(data\)/)
  assert.match(sendInput, /super\.sendInput\(data\)/)
  assert.ok(
    sendInput.indexOf('this.updateTitleFromLocalSshInput(data)') < sendInput.indexOf('super.sendInput(data)'),
    'title detection should inspect the submitted line before the session consumes it',
  )
  assert.match(source, /parseLocalSshDestination/)
  assert.match(source, /this\.disableDynamicTitle = true/)
  assert.match(source, /this\.setTitle\(target\.host\)/)
  assert.match(source, /this\.customTitle = target\.host/)
  assert.match(source, /__tabbyLocalSshTarget/)
  assert.match(source, /inputEscapeMode/)
  assert.match(source, /char === '\\x1b'/)
})
