import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function runPowerShell(script) {
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { cwd: process.cwd() })

  return JSON.parse(stdout.replace(/^\uFEFF/, ''))
}

test('process-tree helper excludes children created before the root process', async () => {
  const result = await runPowerShell(`
    . .\\scripts\\process-tree-lib.ps1
    $rootTime = [datetime]'2026-05-16T10:00:00Z'
    $processes = @(
      [pscustomobject]@{ ProcessId = 100; ParentProcessId = 1; Name = 'root'; CreationDate = $rootTime },
      [pscustomobject]@{ ProcessId = 200; ParentProcessId = 100; Name = 'valid-child'; CreationDate = $rootTime.AddSeconds(1) },
      [pscustomobject]@{ ProcessId = 300; ParentProcessId = 100; Name = 'stale-child'; CreationDate = $rootTime.AddSeconds(-1) },
      [pscustomobject]@{ ProcessId = 400; ParentProcessId = 200; Name = 'valid-grandchild'; CreationDate = $rootTime.AddSeconds(2) }
    )
    Get-ProcessTreeProcessIds -RootProcessId 100 -AllProcesses $processes | ConvertTo-Json -Depth 6
  `)

  assert.deepEqual(result.process_ids, [100, 200, 400])
  assert.equal(result.excluded_stale_children.length, 1)
  assert.equal(result.excluded_stale_children[0].pid, 300)
  assert.equal(result.excluded_stale_children[0].reason, 'child-started-before-root')
})

test('cleanup attempts taskkill even if the launched root already exited', async () => {
  const result = await runPowerShell(`
    . .\\scripts\\process-tree-lib.ps1
    $script:taskkillCalls = @()
    function taskkill.exe {
      param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
      $script:taskkillCalls += ,$Rest
    }

    $process = Start-Process -FilePath powershell -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'exit 0'
    ) -PassThru -WindowStyle Hidden
    Wait-Process -Id $process.Id -Timeout 10

    Stop-StartedProcessTree -Process $process

    [pscustomobject]@{
      has_exited = $process.HasExited
      call_count = $script:taskkillCalls.Count
      args = @($script:taskkillCalls[0])
    } | ConvertTo-Json -Depth 4
  `)

  assert.equal(result.has_exited, true)
  assert.equal(result.call_count, 1)
  assert.equal(result.args.length, 4)
  assert.equal(result.args[0], '/PID')
  assert.match(String(result.args[1]), /^\d+$/)
  assert.equal(result.args[2], '/T')
  assert.equal(result.args[3], '/F')
})
