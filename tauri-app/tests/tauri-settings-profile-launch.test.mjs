import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

function readRepoFile(...segments) {
  return readFileSync(resolve(repoRoot, ...segments), 'utf8')
}

test('bundled Tauri SSH shell sessions keep Tabby terminal input and output middleware active', () => {
  const source = readRepoFile('tabby', 'tabby-tauri', 'src', 'index.ts')
  const sessionStart = source.indexOf('export class TauriSshShellSession')
  const sessionEndMatch = /@Injectable\(\)\r?\nexport class TauriLogService/.exec(source)

  assert.notEqual(sessionStart, -1, 'TauriSshShellSession must exist in the bundled Tabby host module')
  assert.notEqual(sessionEndMatch, null, 'TauriSshShellSession boundary must be discoverable')

  const sessionSource = source.slice(sessionStart, sessionEndMatch.index)
  assert.match(
    source,
    /import\s+\{[^}]*BaseSession[^}]*UTF8SplitterMiddleware[^}]*InputProcessor[^}]*\}\s+from 'tabby-terminal'/s,
    'the bundled Tauri host must import Tabby terminal middleware used by upstream SSH shell sessions',
  )
  assert.match(
    sessionSource,
    /this\.middleware\.push\(new UTF8SplitterMiddleware\(\)\)/,
    'SSH output must pass through UTF8SplitterMiddleware before being rendered',
  )
  assert.match(
    sessionSource,
    /this\.middleware\.push\(new InputProcessor\(profile\.options\.input\)\)/,
    'SSH keyboard input must pass through Tabby input processing so terminal input reaches the remote shell correctly',
  )
  assert.match(
    sessionSource,
    /supportsWorkingDirectory \(\): boolean \{ return !!this\.reportedCWD \}/,
    'SSH working directory support must reflect OSC 1337 CurrentDir reports parsed by BaseSession',
  )
  assert.match(
    sessionSource,
    /getWorkingDirectory \(\): Promise<string \| null> \{ return Promise\.resolve\(this\.reportedCWD \?\? null\) \}/,
    'SFTP opening must use the remote working directory reported by the shell instead of always falling back to /',
  )

  const openShellIndex = sessionSource.indexOf('ssh_open_shell_transport')
  const openTrueIndex = sessionSource.indexOf('this.open = true')
  const streamIndex = sessionSource.indexOf('ssh_stream_transport')

  assert.ok(openShellIndex >= 0, 'remote shell open must be present')
  assert.ok(streamIndex >= 0, 'remote stream startup must be present')
  assert.ok(
    openTrueIndex > openShellIndex && openTrueIndex < streamIndex,
    'session.open should become true after the remote shell opens and before stream startup, matching Tabby SSH lifecycle',
  )
})

test('release backend uses Windows APIs instead of console subprocesses for fonts and process trees', () => {
  const cargoToml = readRepoFile('tabby', 'tauri-app', 'src-tauri', 'Cargo.toml')
  const libSource = readRepoFile('tabby', 'tauri-app', 'src-tauri', 'src', 'lib.rs')
  const mainSource = readRepoFile('tabby', 'tauri-app', 'src-tauri', 'src', 'main.rs')
  const ptySource = readRepoFile('tabby', 'tauri-app', 'src-tauri', 'src', 'pty.rs')
  const credentialSource = readRepoFile('tabby', 'tauri-app', 'src-tauri', 'src', 'credential.rs')

  assert.match(cargoToml, /windows-sys\s*=\s*\{[^}]*Win32_System_Registry/s)
  assert.match(cargoToml, /windows-sys\s*=\s*\{[^}]*Win32_System_Diagnostics_ToolHelp/s)
  assert.match(cargoToml, /windows-sys\s*=\s*\{[^}]*Win32_Security_Credentials/s)

  assert.doesNotMatch(libSource, /pub mod subprocess;/, 'subprocess helper should be gone when no console subprocess is required')
  assert.doesNotMatch(mainSource, /reg\.exe|hidden_subprocess_command|Command::new/)
  assert.match(mainSource, /RegOpenKeyExW/)
  assert.match(mainSource, /RegEnumValueW/)
  assert.match(mainSource, /credential_get_password/)
  assert.match(mainSource, /credential_set_password/)
  assert.match(mainSource, /credential_delete_password/)

  assert.doesNotMatch(ptySource, /powershell|hidden_subprocess_command|Command::new/)
  assert.match(ptySource, /CreateToolhelp32Snapshot/)
  assert.match(ptySource, /Process32FirstW/)
  assert.match(ptySource, /Process32NextW/)
  assert.match(credentialSource, /CredReadW/)
  assert.match(credentialSource, /CredWriteW/)
  assert.match(credentialSource, /CredDeleteW/)
  assert.match(credentialSource, /legacy_keytar_target\(service, account\)/)
})
