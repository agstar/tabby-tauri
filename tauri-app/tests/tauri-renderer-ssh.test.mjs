import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

test('Tauri renderer SSH accepts Tabby default reuse sessions and resolves password prompts', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const zhCnLocale = readFileSync(resolve(repoRoot, 'tabby', 'locale', 'zh-CN.po'), 'utf8')

  assert.doesNotMatch(
    source,
    /options\.reuseSession[\s\S]{0,120}unsupportedFeatures\.push/,
    'Tabby defaults reuseSession=true; Tauri must not reject otherwise connectable SSH profiles',
  )
  assert.match(source, /await this\.connection\.getConnectRequest\(\)/)
  assert.match(source, /injector\.get\(PasswordStorageService\)\.loadPassword/)
  assert.match(source, /open\(PromptModalComponent\)/)
  assert.match(source, /ssh_scan_host_key/)
  assert.match(source, /ssh_known_host_get/)
  assert.match(source, /ssh_known_host_trust/)
  assert.match(source, /ssh_known_host_forget/)
  assert.match(source, /ssh_known_hosts_list/)
  assert.match(source, /ssh_known_host_mismatch_report/)
  assert.doesNotMatch(source, /tabby-tauri:ssh-known-host/)
  assert.doesNotMatch(source, /localStorage\?\.setItem\([\s\S]*ssh-known-host/)
  assert.doesNotMatch(source, /Type yes to continue/)
  const hostKeyPromptStart = source.indexOf('private async promptTrustDecision')
  assert.notEqual(hostKeyPromptStart, -1, 'Tauri SSH host-key trust prompt must stay explicit and testable')
  const hostKeyPromptEnd = source.indexOf('\n}\n\n@Injectable()\nexport class TauriPasswordStorageService', hostKeyPromptStart)
  assert.notEqual(hostKeyPromptEnd, -1, 'Tauri SSH host-key trust prompt scope marker must stay stable')
  const hostKeyPromptSource = source.slice(hostKeyPromptStart, hostKeyPromptEnd)
  assert.match(hostKeyPromptSource, /TauriSshHostKeyPromptModalComponent/)
  assert.doesNotMatch(
    hostKeyPromptSource,
    /open\(PromptModalComponent\)|componentInstance\.prompt|componentInstance\.value|Type once|type once|trim\(\)\.toLowerCase\(\)/,
    'Host-key trust must not reuse the generic typed prompt; users mistake it for a password dialog',
  )
  assert.match(source, /Accept just this once/)
  assert.match(source, /Accept and remember key/)
  assert.match(source, /Disconnect/)
  const hostKeyComponentStart = source.indexOf("selector: 'tauri-ssh-host-key-prompt'")
  const hostKeyComponentEnd = source.indexOf('class TauriSshTrustService', hostKeyComponentStart)
  assert.notEqual(hostKeyComponentStart, -1, 'Tauri SSH host-key modal component must stay explicit')
  assert.notEqual(hostKeyComponentEnd, -1, 'Tauri SSH host-key modal component scope marker must stay stable')
  const hostKeyComponentSource = source.slice(hostKeyComponentStart, hostKeyComponentEnd)
  assert.match(hostKeyComponentSource, /translate>Host key verification/)
  assert.match(hostKeyComponentSource, /translate>Host/)
  assert.match(hostKeyComponentSource, /translate>Current host key fingerprint/)
  assert.match(hostKeyComponentSource, /translate\s*>Accept and remember key/)
  assert.match(hostKeyComponentSource, /translate\s*>Accept just this once/)
  assert.match(hostKeyComponentSource, /translate\s*>Disconnect/)
  assert.doesNotMatch(
    hostKeyComponentSource,
    /Trust and connect|The SSH host key|Confirm this fingerprint/,
    'Host-key modal must reuse localized Tabby SSH strings instead of adding English-only prose',
  )
  assert.match(source, /import \{ TranslateModule \} from '@ngx-translate\/core'/)
  assert.match(
    source,
    /imports:\s*\[[\s\S]*TranslateModule,[\s\S]*\]/,
    'Tauri host module must keep TranslateModule available for localized SSH prompts',
  )
  assert.match(zhCnLocale, /msgid "Host key verification"\s+msgstr "主机密钥校验"/)
  assert.match(zhCnLocale, /msgid "Accept and remember key"\s+msgstr "接受并记住密钥"/)
  assert.match(zhCnLocale, /msgid "Accept just this once"\s+msgstr "只接受本次"/)
  assert.match(zhCnLocale, /msgid "Disconnect"\s+msgstr "断开连接"/)
  assert.match(source, /const hostKeyFingerprint = await this\.resolveHostKeyFingerprint/)
  assert.match(source, /host_key_fingerprint: hostKeyFingerprint/)
  assert.match(source, /this\.request = null/)
  assert.match(source, /this\.connection\.ref\(\)/)
  assert.match(source, /this\.connection\.unref\(\)/)
})

test('SSH acceptance scripts produce sanitized artifacts without credential persistence', () => {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'package.json'), 'utf8'))
  const smokeScript = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'scripts', 'measure-ssh-acceptance.mjs'), 'utf8')
  const idleScript = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'scripts', 'ssh-idle-soak.ps1'), 'utf8')

  assert.equal(packageJson.scripts['smoke:ssh-e2e'], 'node scripts/measure-ssh-acceptance.mjs')
  assert.equal(packageJson.scripts['soak:ssh-idle'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ssh-idle-soak.ps1')
  assert.match(smokeScript, /ssh-acceptance-smoke-tabby-tauri-windows\.json/)
  assert.match(smokeScript, /credential_values_redacted/)
  assert.match(smokeScript, /raw_credentials_persisted: false/)
  assert.doesNotMatch(
    smokeScript,
    /ssh_transport_smoke_uses_real_server_when_env_is_present[\s\S]{0,180}'--ignored'/,
    'real SSH smoke must not filter out the non-ignored smoke test',
  )
  assert.match(idleScript, /Redact-SshOutput/)
  assert.match(idleScript, /raw_credentials_persisted = \$false/)
})

test('SSH command-matrix harness covers real remote shell input/output without persisting credentials', () => {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'package.json'), 'utf8'))
  const matrixScript = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'scripts', 'measure-ssh-command-matrix.mjs'), 'utf8')
  const smokeTest = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'tests', 'ssh_transport_smoke.rs'), 'utf8')

  assert.equal(packageJson.scripts['smoke:ssh-command-matrix'], 'node scripts/measure-ssh-command-matrix.mjs')
  assert.match(matrixScript, /ssh-command-matrix-tabby-tauri-windows\.json/)
  assert.match(matrixScript, /ssh_transport_command_matrix_uses_real_server_when_env_is_present/)
  assert.match(matrixScript, /credential_values_redacted/)
  assert.match(matrixScript, /raw_credentials_persisted: false/)
  assert.match(matrixScript, /commands_total/)
  assert.match(matrixScript, /ui_automation/)
  assert.doesNotMatch(matrixScript, /TABBY_TAURI_SSH_PASSWORD['"`\]]?\s*[:=]\s*process\.env\.TABBY_TAURI_SSH_PASSWORD/)
  assert.match(smokeTest, /ssh_transport_command_matrix_uses_real_server_when_env_is_present/)
  assert.match(smokeTest, /linux_command_matrix/)
  assert.match(smokeTest, /__TABBY_CMD_12_PASS__/)
})

test('Tauri renderer SSH blocks host-key mismatch before authentication and keeps password handling isolated', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(source, /class TauriSshTrustService/)
  assert.match(source, /stored\.sha256 === scan\.sha256/)
  assert.match(source, /authentication was blocked before password or private-key use/)
  assert.match(source, /const password = options\.password \?\? await this\.loadSavedPassword\(\) \?\? await this\.promptPassword\(\)/)
  assert.match(
    source,
    /const hostKeyFingerprint = await this\.resolveHostKeyFingerprint\([\s\S]*const password = options\.password \?\? await this\.loadSavedPassword\(\) \?\? await this\.promptPassword\(\)/,
    'SSH host-key trust must resolve before password prompt/load so mismatch blocks credential use',
  )
  assert.match(source, /showRememberCheckbox = true/)
  assert.match(source, /PasswordStorageService\)\.savePassword/)
  assert.doesNotMatch(source, /console\.(log|debug|warn|error)\([^)]*password/i)
})

test('Tauri renderer SSH cannot leave a blank terminal while pre-auth, connect, or shell open is stuck', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(source, /function sanitizeSshError/)
  assert.match(source, /function withSshTimeout/)
  assert.match(source, /SSH_PASSWORD_STORAGE_TIMEOUT_MS/)
  assert.match(
    source,
    /withSshTimeout\([\s\S]*PasswordStorageService\)\.loadPassword\(this\.profile\)[\s\S]*'saved password lookup'/,
    'saved password lookup must be bounded so the password modal can appear instead of hanging on a blank SSH tab',
  )
  assert.match(source, /Saved SSH password lookup timed out; prompting for password/)
  assert.match(source, /Waiting for SSH password prompt/)
  assert.match(
    source,
    /withSshTimeout\([\s\S]*PasswordStorageService\)\.savePassword\(this\.profile, result\.value\)[\s\S]*'saved password persistence'/,
    'remember-password persistence must also be bounded so a checked remember box cannot hang SSH startup',
  )
  assert.match(source, /Could not save SSH password; continuing without persistence/)
  assert.match(source, /private emitSshStatus/)
  assert.match(source, /Preparing SSH authentication/)
  assert.match(source, /Opening SSH transport/)
  assert.match(source, /Opening remote shell/)
  assert.match(
    source,
    /withSshTimeout\([\s\S]*ssh_connect_transport[\s\S]*'connect'/,
    'remote SSH connect must have a renderer-side timeout with a visible error',
  )
  assert.match(
    source,
    /withSshTimeout\([\s\S]*ssh_open_shell_transport[\s\S]*'open shell'/,
    'remote shell open must have a renderer-side timeout with a visible error',
  )
  assert.match(
    source,
    /withSshTimeout\([\s\S]*ssh_stream_transport[\s\S]*'stream shell output'/,
    'stream startup must have a renderer-side timeout with a visible error',
  )
  assert.match(
    source,
    /catch \(error\)[\s\S]*const message = sanitizeSshError\(error\)[\s\S]*SSH connection failed: \$\{message\}/,
    'SSH startup failures must be shown in the terminal instead of only rethrowing',
  )
})

test('SSH tab awaits visible initialization failures so failed Tauri auth is rendered before returning', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sshTab.component.ts'), 'utf8')

  assert.match(source, /async initializeSession \(\): Promise<void>/)
  assert.match(
    source,
    /catch \(e\) \{[\s\S]*console\.error\('SSH session initialization failed', e\)[\s\S]*await this\.write\(colors\.black\.bgRed\(' X '\) \+ ' ' \+ colors\.red\(e\.message\) \+ '\\r\\n'\)[\s\S]*return/,
    'terminal startup errors must be awaited so the user sees the failure instead of a blank SSH tab',
  )
})

test('Tauri overrides SSH password storage instead of using Electron keytar in WebView', () => {
  const source = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(source, /export class TauriPasswordStorageService/)
  assert.match(source, /tabby-tauri:ssh-password:/)
  assert.match(source, /tabby-tauri:ssh-private-key-passphrase:/)
  assert.match(source, /credential_get_password/)
  assert.match(source, /credential_set_password/)
  assert.match(source, /credential_delete_password/)
  assert.match(source, /profile\.options\.password \|\| await this\.loadSecret/)
  assert.match(source, /connectionService[\s\S]*`ssh@\$\{profile\.options\.host\}`/)
  assert.match(source, /saveSecret[\s\S]*this\.saveLocalSecret/)
  assert.match(source, /\{ provide: PasswordStorageService, useClass: TauriPasswordStorageService \}/)
  assert.doesNotMatch(
    source,
    /Failed to load stored password for[\s\S]{0,120}keytar/,
    'Tauri host module should not rely on the upstream keytar-backed implementation in WebView',
  )
})

test('Tauri SSH tabs use the native xterm onData input chain without a textarea fallback', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const sshTabSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sshTab.component.ts'), 'utf8')
  const xtermFrontendSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-terminal', 'src', 'frontends', 'xtermFrontend.ts'), 'utf8')
  const terminalTabSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-terminal', 'src', 'api', 'baseTerminalTab.component.ts'), 'utf8')
  const sessionSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-terminal', 'src', 'session.ts'), 'utf8')

  assert.match(xtermFrontendSource, /this\.xterm\.onData\(data => \{[\s\S]*this\.input\.next\(Buffer\.from\(data, 'utf-8'\)\)/)
  assert.match(terminalTabSource, /this\.termContainerSubscriptions\.subscribe\(this\.frontend\.input\$, data => \{[\s\S]*this\.sendInput\(data\)/)
  assert.match(terminalTabSource, /sendInput \(data: string\|Buffer\): void \{[\s\S]*this\.session\?\.feedFromTerminal\(data\)/)
  assert.match(
    terminalTabSource,
    /protected async writeRaw \(data: string\): Promise<void> \{[\s\S]*this\.zone\.runOutsideAngular\(\(\) => this\.frontend!\.write\(data\)\)/,
    'High-frequency terminal writes should run outside Angular change detection',
  )
  assert.match(sessionSource, /this\.middleware\.outputToSession\$\.subscribe\(data => this\.write\(data\)\)/)
  assert.match(tauriSource, /write \(data: Buffer\): void \{[\s\S]*this\.writeTransport\(data\)/)
  assert.match(tauriSource, /invoke<SessionSnapshot>\('ssh_write_transport'/)
  assert.match(tauriSource, /private pendingTerminalInput: Buffer\[\] = \[\]/)
  assert.match(
    tauriSource,
    /private startupOutputBuffer: Buffer\[\] = \[\][\s\S]*private startupOutputReleased = false/,
    'Tauri SSH shell must hold startup output until ConnectableTerminalTab has cleared service messages',
  )
  assert.match(
    tauriSource,
    /createChannel<SshData>\(data => \{[\s\S]*if \(!this\.startupOutputReleased\) \{[\s\S]*this\.startupOutputBuffer\.push\(buffer\)[\s\S]*return[\s\S]*this\.queueOutput\(data\)/,
    'Tauri SSH shell must buffer startup MOTD/banner bytes and batch normal stream output after the post-connect clearServiceMessagesOnConnect pass',
  )
  assert.match(
    tauriSource,
    /window\.setTimeout\(\(\) => this\.releaseStartupOutput\([\s\S]*this\.releaseInitialDataBuffer\(\)[\s\S]*this\.emitSshStatus\(`SSH connected[\s\S]*this\.startupOutputBuffer\.splice\(0\)[\s\S]*this\.emitOutput\(Buffer\.concat\(buffered\)\)[\s\S]*this\.flushPendingTerminalInput\(\)/,
    'Tauri SSH shell must release startup output after initializeSession resolves while batching default MOTD output',
  )
  assert.match(tauriSource, /this\.pendingTerminalInput\.push\(Buffer\.from\(data\)\)/)
  assert.match(tauriSource, /__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__\.writes/)
  assert.doesNotMatch(
    tauriSource,
    /tauriSshInputFallback/,
    'Tauri must not opt into a renderer-side keyboard fallback when the native xterm onData path is available',
  )
  assert.doesNotMatch(
    sshTabSource,
    /attachTauriTextareaInputFallback|fallbackEvents|stopImmediatePropagation|applicationCursorKeysMode/,
    'SSH tabs should rely on xterm keyboard processing, including Vim application cursor mode, instead of duplicating key translation',
  )
})

test('inactive terminal tabs buffer output until they become visible again', () => {
  const terminalTabSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-terminal', 'src', 'api', 'baseTerminalTab.component.ts'), 'utf8')

  assert.match(
    terminalTabSource,
    /const INACTIVE_TERMINAL_OUTPUT_COMPACT_CHUNKS = 128[\s\S]*const INACTIVE_TERMINAL_OUTPUT_COMPACT_CHARACTERS = 512 \* 1024/,
    'Inactive terminal output buffering should compact queued chunks before the array grows without bound',
  )
  assert.match(
    terminalTabSource,
    /private pendingInactiveOutput: string\[\] = \[\][\s\S]*private pendingInactiveOutputCharacters = 0/,
    'Base terminal tabs need a background-output queue separate from xterm writes',
  )
  assert.match(
    terminalTabSource,
    /this\.visibility\$\.subscribe\(visible => \{[\s\S]*if \(visible\) \{[\s\S]*void this\.flushPendingInactiveOutput\(\)/,
    'Becoming visible should flush any deferred terminal output',
  )
  assert.match(
    terminalTabSource,
    /async write \(data: string\): Promise<void> \{[\s\S]*if \(!this\.visibility\.value\) \{[\s\S]*this\.queueInactiveOutput\(data\)[\s\S]*return[\s\S]*this\.withSpinnerPaused\(\(\) => this\.writeRaw\(data\)\)/,
    'Hidden tabs should queue session output instead of writing each chunk into xterm',
  )
  assert.match(
    terminalTabSource,
    /private async flushPendingInactiveOutput[\s\S]*const data = pending\.join\(''\)[\s\S]*this\.withSpinnerPaused\(\(\) => this\.writeRaw\(data\)\)/,
    'Deferred output should be flushed as one ordered xterm write when the tab is visible',
  )
  assert.match(
    terminalTabSource,
    /setSession \(session: BaseSession\|null[\s\S]*this\.clearPendingInactiveOutput\(\)/,
    'Switching sessions should not replay stale background output into the new terminal session',
  )
})

test('Tauri SSH stream transport applies output backpressure before flooding the WebView IPC channel', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const sshSource = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'ssh.rs'), 'utf8')
  const ptySource = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'pty.rs'), 'utf8')

  assert.match(
    tauriSource,
    /private pendingOutputBuffers: Buffer\[\] = \[\][\s\S]*private pendingOutputAckBytes = 0[\s\S]*private pendingOutputFlushTimer: number \| null = null/,
    'Tauri SSH renderer must coalesce high-frequency IPC output before writing into terminal middleware',
  )
  assert.match(
    tauriSource,
    /private queueOutput\(data: SshData\): void[\s\S]*this\.pendingOutputBuffers\.push\(buffer\)[\s\S]*window\.setTimeout\(\(\) => this\.flushPendingOutput\(\), SSH_OUTPUT_FLUSH_DELAY_MS\)/,
    'Tauri SSH renderer should flush output batches on a short timer instead of emitting every IPC chunk',
  )
  assert.match(
    tauriSource,
    /private flushPendingOutput \(\): void[\s\S]*this\.emitOutput\(Buffer\.concat\(buffers, ackBytes\)\)[\s\S]*invoke<SessionSnapshot>\('ssh_ack'/,
    'Tauri SSH renderer must ACK after the merged output has been handed to the terminal middleware',
  )
  assert.match(ptySource, /fn is_reader_paused/)
  assert.match(
    sshSource,
    /async fn wait_until_ssh_reader_resumes/,
    'SSH streaming must have a pause gate matching the PTY reader backpressure path',
  )
  assert.match(
    sshSource,
    /wait_until_ssh_reader_resumes\(&sessions, &session_id\)\.await[\s\S]*russh_channel\.wait\(\)\.await/,
    'SSH streaming must wait for renderer ACKs before reading the next high-output SSH chunk',
  )
  assert.match(
    sshSource,
    /tokio::time::sleep\(Duration::from_millis\(10\)\)\.await/,
    'The SSH pause loop should yield instead of busy-spinning while the WebView catches up',
  )
  assert.match(
    sshSource,
    /const SSH_OUTPUT_BATCH_FLUSH_DELAY: Duration = Duration::from_millis\(8\);[\s\S]*const SSH_OUTPUT_BATCH_MAX_BYTES: usize = 64 \* 1024;/,
    'SSH output should also be batched in Rust before it crosses the Tauri IPC boundary',
  )
  assert.match(
    sshSource,
    /tokio::time::timeout\([\s\S]*SSH_OUTPUT_BATCH_FLUSH_DELAY[\s\S]*russh_channel\.wait\(\)/,
    'The russh stream should coalesce consecutive channel messages for one short frame budget',
  )
  assert.match(
    sshSource,
    /fn extract_osc_metadata[\s\S]*CurrentDir=[\s\S]*BASE64\.decode/,
    'Rust SSH should parse OSC cwd and clipboard metadata while preserving the renderer OSC fallback',
  )
  assert.match(
    tauriSource,
    /interface SshData[\s\S]*currentDir\?: string \| null[\s\S]*clipboardText\?: string \| null/,
    'Renderer SSH data should accept backend OSC metadata without requiring string reparsing later',
  )
  assert.match(
    tauriSource,
    /private applySshMetadata[\s\S]*this\.reportedCWD = data\.currentDir/,
    'Backend parsed cwd metadata should update the session cwd field directly',
  )
  assert.match(
    ptySource,
    /const PTY_OUTPUT_BATCH_FLUSH_DELAY: Duration = Duration::from_millis\(8\);[\s\S]*const PTY_OUTPUT_BATCH_MAX_BYTES: usize = 64 \* 1024;/,
    'Local PTY output should share the same backend frame budget before WebView IPC',
  )
  assert.match(
    ptySource,
    /std::sync::mpsc::channel::<Vec<u8>>\(\)[\s\S]*recv_timeout\(PTY_OUTPUT_BATCH_FLUSH_DELAY\)/,
    'Blocking PTY reads should feed a backend batcher instead of emitting every read chunk',
  )
})

test('Tauri local PTY renderer batches output before the local session ACKs it', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(
    tauriSource,
    /const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 8[\s\S]*const PTY_OUTPUT_FLUSH_DELAY_MS = TERMINAL_OUTPUT_FLUSH_DELAY_MS/,
    'PTY and SSH output batching should share the same short renderer flush budget',
  )
  assert.match(
    tauriSource,
    /class TauriPTYProxy extends PTYProxy[\s\S]*private pendingDataBuffers: Buffer\[\] = \[\][\s\S]*private pendingDataFlushTimer: number \| null = null/,
    'Tauri PTY proxy must keep a renderer-side output batch before notifying tabby-local',
  )
  assert.match(
    tauriSource,
    /createChannel<PtyData>\(data => this\.queueData\(data, handler\)\)/,
    'Tauri PTY stream chunks should enter the batcher instead of calling the local session handler directly',
  )
  assert.match(
    tauriSource,
    /private flushPendingData[\s\S]*handler\(Buffer\.concat\(buffers, byteLength\)\)/,
    'Tauri PTY proxy must deliver one merged buffer so tabby-local ACKs after the merged terminal write path receives it',
  )
  assert.doesNotMatch(
    tauriSource,
    /createChannel<PtyData>\(data => handler\(Buffer\.from\(data\.bytes\)\)\)/,
    'Tauri PTY proxy must not emit every IPC chunk directly to the terminal session',
  )
})

test('Tauri shell provider loads the shell list from Rust with renderer defaults as fallback', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const rustMain = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.match(rustMain, /struct NativeShellEntry/)
  assert.match(rustMain, /fn shell_list\(\) -> Vec<NativeShellEntry>/)
  assert.match(rustMain, /fn detect_windows_shells\(\) -> Vec<NativeShellEntry>/)
  assert.match(rustMain, /shell_list,/, 'Native shell detection must be registered as a Tauri command')
  assert.match(
    tauriSource,
    /class TauriWindowsShellProvider[\s\S]*invoke<NativeShellEntry\[\]>\('shell_list'\)[\s\S]*return shells\.map/,
    'The Angular shell provider should not hard-code shell detection on the hot startup path',
  )
  assert.match(
    tauriSource,
    /private defaultShells \(\): Shell\[\][\s\S]*Windows PowerShell[\s\S]*Command Prompt/,
    'Renderer defaults must remain as a no-regression fallback if the native command is unavailable',
  )
})

test('SSH top stress harness covers 10 high-output remote sessions and resource use', () => {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'package.json'), 'utf8'))
  const stressScript = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'scripts', 'measure-ssh-top-stress.mjs'), 'utf8')

  assert.equal(packageJson.scripts['smoke:ssh-top-stress'], 'node scripts/measure-ssh-top-stress.mjs')
  assert.match(stressScript, /ssh-top-stress-tabby-tauri-windows\.json/)
  assert.match(stressScript, /top -c/)
  assert.match(stressScript, /sessionCount/)
  assert.match(stressScript, /commands_passed/)
  assert.match(stressScript, /cpu_percent/)
  assert.match(stressScript, /working_set_mb/)
  assert.match(stressScript, /credential_values_redacted/)
  assert.doesNotMatch(stressScript, /password:\s*process\.env\.TABBY_TAURI_SSH_PASSWORD/)
  const powershellSnippet = stressScript.slice(
    stressScript.indexOf('function sampleProcessTree'),
    stressScript.indexOf('function pageRunnerSource'),
  )
  assert.doesNotMatch(powershellSnippet, /\?\?\s*0/, 'PowerShell snippets must stay compatible with Windows PowerShell 5')
})

test('SSH stream transport tears down the backend when the renderer output channel closes', () => {
  const sshSource = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'ssh.rs'), 'utf8')

  assert.match(
    sshSource,
    /let transports = self\.transports\.clone\(\)/,
    'The SSH stream task needs transport ownership so a closed renderer channel cannot leave an orphaned remote shell',
  )
  assert.match(
    sshSource,
    /ssh-output-channel-closed/,
    'Closed IPC channels should be recorded as an explicit reconnectable SSH interruption reason',
  )
  assert.match(
    sshSource,
    /mark_ssh_stream_interrupted\(&sessions, &transports, &session_id, reason\)\.await/,
    'The stream loop must remove the russh transport and mark the session reconnectable after a channel failure',
  )
})

test('Tauri SSH idle sessions keep the transport alive and surface stale write failures', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(
    tauriSource,
    /const SSH_KEEPALIVE_INTERVAL_MS = 15_000/,
    'Tauri SSH must proactively keep russh sessions alive before the backend inactivity timeout expires',
  )
  assert.match(
    tauriSource,
    /private keepaliveTimer: number \| null = null/,
    'Tauri SSH shell sessions need an owned keepalive timer that can be cleaned up on close/destroy',
  )
  assert.match(
    tauriSource,
    /private startKeepaliveMonitor \(\): void \{[\s\S]*window\.setInterval\(\(\) => \{[\s\S]*this\.probeTransportLiveness\(\)[\s\S]*SSH_KEEPALIVE_INTERVAL_MS/,
    'Tauri SSH must start a periodic transport liveness probe while the tab is open',
  )
  assert.match(
    tauriSource,
    /invoke<SessionSnapshot>\('ssh_keepalive_transport', \{ sessionId: this\.session\.session_id \}\)/,
    'The liveness probe must call the Rust russh keepalive provider instead of relying on renderer input',
  )
  assert.match(
    tauriSource,
    /private stopKeepaliveMonitor \(\): void \{[\s\S]*window\.clearInterval\(this\.keepaliveTimer\)/,
    'The keepalive timer must be cleared when the SSH session stops',
  )
  assert.match(
    tauriSource,
    /invoke<SessionSnapshot>\('ssh_write_transport'[\s\S]*\.catch\(error => this\.markTransportUnavailable/,
    'Rejected stale writes must update the tab state instead of being swallowed behind a blinking cursor',
  )
})

test('Tauri SSH exposes native SFTP sessions for remote file transfer panels', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const rustMain = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'main.rs'), 'utf8')
  const rustSsh = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'src', 'ssh.rs'), 'utf8')
  const cargoToml = readFileSync(resolve(repoRoot, 'tabby', 'tauri-app', 'src-tauri', 'Cargo.toml'), 'utf8')

  assert.match(tauriSource, /class TauriSftpSession/, 'SFTP panel must get a Tauri-native SFTP session object')
  assert.match(tauriSource, /openSFTP\s*\(\):\s*Promise<TauriSftpSession>/, 'Tauri SSH connections must implement openSFTP')
  assert.match(tauriSource, /ssh_sftp_connect_transport/, 'SFTP must use the Rust transport provider instead of a renderer shim')
  for (const method of ['readdir', 'readlink', 'realpath', 'stat', 'open', 'mkdir', 'rename', 'unlink', 'chmod', 'rmdir']) {
    assert.match(tauriSource, new RegExp(`class TauriSftpSession[\\s\\S]*async ${method}\\s*\\(`), `TauriSftpSession must expose ${method}`)
  }
  assert.match(
    tauriSource,
    /class TauriSftpSession[\s\S]*async directoryPlan\s*\([\s\S]*ssh_sftp_directory_plan/,
    'Tauri SFTP sessions should expose a backend directory plan to avoid renderer recursive stat walks',
  )
  for (const command of [
    'ssh_sftp_connect_transport',
    'ssh_sftp_readdir',
    'ssh_sftp_directory_plan',
    'ssh_sftp_readlink',
    'ssh_sftp_realpath',
    'ssh_sftp_stat',
    'ssh_sftp_open',
    'ssh_sftp_read_file_chunk',
    'ssh_sftp_write_file_chunk',
    'ssh_sftp_close_file',
    'ssh_sftp_mkdir',
    'ssh_sftp_rename',
    'ssh_sftp_unlink',
    'ssh_sftp_rmdir',
    'ssh_sftp_chmod',
    'ssh_sftp_close',
  ]) {
    assert.match(rustMain, new RegExp(`fn ${command}`), `Rust must implement ${command}`)
    assert.match(rustMain, new RegExp(`${command},`), `Tauri invoke handler must register ${command}`)
  }
  assert.match(rustSsh, /russh_sftp::client::SftpSession/, 'Rust SSH provider must use russh-sftp, not shelling out to sftp.exe')
  assert.match(rustSsh, /pub struct SftpDirectoryPlan/, 'Rust SFTP must be able to plan directory downloads in one backend walk')
  assert.match(rustSsh, /total_size: u64/, 'Rust SFTP directory plans must include total size for progress without a renderer stat pass')
  assert.match(rustSsh, /fn sort_sftp_entries/, 'Rust SFTP listings should be sorted before crossing IPC')
  assert.match(rustSsh, /pub file_type: String/, 'Rust SFTP listings should carry file type metadata for renderer-light icons')
  assert.match(rustSsh, /\.canonicalize\(path\)/, 'Rust SSH provider must use SFTP realpath/canonicalize for the login-directory fallback')
  assert.match(cargoToml, /russh-sftp\s*=/, 'Cargo must declare the Rust SFTP provider dependency')
})

test('Tauri local terminal ssh commands expose an ad-hoc SFTP toolbar entry', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')

  assert.match(
    tauriSource,
    /parseLocalSshProcessCommand\s*\(command: string\): LocalSshProcessTarget \| null/,
    'Tauri host must parse foreground local ssh child process commands into SFTP connection targets',
  )
  assert.match(
    tauriSource,
    /class TauriLocalSshSftpConnection implements SSHConnectionLike/,
    'Local terminal ssh commands need an SSHConnectionLike adapter so the existing SFTP panel can upload and download files',
  )
  assert.match(
    tauriSource,
    /class TauriLocalSshSftpToolbarService/,
    'Tauri host should actively attach the SFTP entry to local terminal tabs without depending on decorator timing',
  )
  assert.match(
    tauriSource,
    /getChildProcesses\?\.\(\)[\s\S]*parseLocalSshProcessCommand\(child\.command\)/,
    'The toolbar entry should become available from the local terminal child ssh command after the connection is running',
  )
  assert.match(
    tauriSource,
    /ssh_sftp_connect_transport/,
    'The ad-hoc local SSH SFTP connection must reuse the native Rust SFTP transport provider',
  )
  assert.match(
    tauriSource,
    /TauriLocalSshSftpToolbarService,[\s\S]*constructor \(_displayEffects: TauriDisplayEffectsService, _localSshSftpToolbar: TauriLocalSshSftpToolbarService\)/,
    'The Tauri module must eagerly instantiate the local SSH SFTP toolbar service',
  )
})

test('Tauri local ssh SFTP toolbar follows submitted terminal input when process lookup misses', () => {
  const tauriSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const appRootSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'components', 'appRoot.component.ts'), 'utf8')
  const appRootTemplate = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'components', 'appRoot.component.pug'), 'utf8')

  assert.match(
    tauriSource,
    /class LocalSshCommandTracker/,
    'typed local ssh commands must be tracked from the terminal input stream',
  )
  assert.match(
    tauriSource,
    /parseLocalSshSubmittedCommand\s*\(line: string\): LocalSshProcessTarget \| null/,
    'submitted command parsing must reject non-leading ssh text such as echo ssh host',
  )
  assert.match(
    tauriSource,
    /terminal\.input\$\.[\s\S]*subscribe\(data => \{[\s\S]*tracker\.feed\(data\)[\s\S]*componentRef\.instance\.setInputTarget\(target\)[\s\S]*terminal\.setTitle\(target\.host\)/,
    'the toolbar service must update SFTP and title from actual xterm input, not only TerminalTabComponent.sendInput',
  )
  assert.match(
    tauriSource,
    /this\.target = this\.processTarget \?\? this\.inputTarget/,
    'process refresh must not clear a target learned from terminal input when process enumeration is unavailable',
  )
  assert.match(
    tauriSource,
    /const profileType = \(terminal as any\)\.profile\?\.type[\s\S]*profileType && profileType !== 'local'/,
    'the toolbar service should skip explicit non-local profiles while still handling local terminals without profile metadata',
  )
  assert.doesNotMatch(
    tauriSource,
    /terminal instanceof TerminalTabComponent/,
    'the local terminal check must not rely on instanceof after webpack bundles tabby-local separately',
  )
  assert.doesNotMatch(
    tauriSource,
    /<terminal-toolbar \*ngIf="target"/,
    'local ssh SFTP should not render in the bottom terminal toolbar',
  )
  assert.doesNotMatch(
    tauriSource,
    /terminal\.pinToolbar = true|terminal\.enableToolbar = true/,
    'local ssh SFTP should not force the bottom terminal toolbar visible',
  )
  assert.match(
    tauriSource,
    /class TauriLocalSshSftpToolbarButtonProvider extends ToolbarButtonProvider/,
    'local ssh SFTP should be exposed as a top app toolbar button',
  )
  assert.match(
    tauriSource,
    /\{ provide: ToolbarButtonProvider, useClass: TauriLocalSshSftpToolbarButtonProvider, multi: true \}/,
    'the local ssh SFTP top toolbar provider must be registered',
  )
  assert.match(
    tauriSource,
    /hasActiveSftpTarget[\s\S]*openActiveSFTP/,
    'the toolbar provider should only show and open SFTP for the active local ssh tab',
  )
  assert.match(
    appRootSource,
    /activeTabChange\$[\s\S]*refreshToolbarButtons[\s\S]*tabsChanged\$[\s\S]*refreshToolbarButtons/,
    'the app toolbar must refresh when the active tab or tab state changes',
  )
  assert.match(
    appRootTemplate,
    /\[attr\.title\]='button\.label'[\s\S]*\[attr\.aria-label\]='button\.label'/,
    'toolbar buttons need stable labels so the SFTP button is inspectable and accessible',
  )
  assert.match(
    tauriSource,
    /app\.tabOpened\$[\s\S]*app\.tabsChanged\$[\s\S]*app\.activeTabChange\$/,
    'the toolbar service should rescan after tabs are opened, changed, or selected',
  )
  assert.match(
    tauriSource,
    /__tabbyLocalSshTarget[\s\S]*applyTarget/,
    'the toolbar service should also read the SSH target recorded by local terminal sendInput paths',
  )
  assert.match(
    tauriSource,
    /inputEscapeMode[\s\S]*char === '\\x1b'/,
    'the toolbar input tracker should ignore terminal paste escape wrappers such as bracketed paste',
  )
})

test('SFTP folder downloads use a backend plan when Tauri provides one', () => {
  const panelSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sftpPanel.component.ts'), 'utf8')
  const typesSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'session', 'types.ts'), 'utf8')

  assert.match(typesSource, /directoryPlan\?\s*\(p: string\): Promise<SFTPDirectoryPlan>/)
  assert.match(
    panelSource,
    /if \(this\.sftp\.directoryPlan\) \{[\s\S]*await this\.downloadFolderWithPlan\(folder, transfer\)[\s\S]*\} else \{/,
    'The SFTP panel should prefer the Tauri backend directory plan without removing the generic SFTP fallback',
  )
  assert.match(
    panelSource,
    /private async downloadFolderWithPlan[\s\S]*const plan = await this\.sftp\.directoryPlan!\(folder\.fullPath\)[\s\S]*transfer\.setTotalSize\(plan\.totalSize\)[\s\S]*for \(const item of plan\.entries\)/,
    'Directory-download progress should use the backend total size and a single planned entry stream',
  )
  assert.match(
    panelSource,
    /await this\.sftp\.download\(item\.path, fileDownload\)/,
    'Planned folder downloads should still use the existing file transfer path for each file',
  )
  assert.match(
    panelSource,
    /calculateFolderSizeAndUpdate[\s\S]*downloadFolderRecursive/,
    'The original recursive fallback must remain for non-Tauri SFTP sessions',
  )
})

test('SFTP panel falls back from missing shell cwd to the remote login directory', () => {
  const panelSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sftpPanel.component.ts'), 'utf8')

  assert.match(
    panelSource,
    /private async getInitialPath[\s\S]*!this\.cwdDetectionAvailable[\s\S]*this\.path === '\/'[\s\S]*this\.sftp\.realpath\('\.'\)/,
    'SFTP panel must resolve the SFTP login directory when shell cwd detection has not reported a directory',
  )
  assert.match(
    panelSource,
    /await this\.navigate\(await this\.getInitialPath\(\)\)/,
    'SFTP panel initial navigation must use the login-directory fallback instead of always opening /',
  )
})

test('SFTP working-directory tip close button dismisses without opening docs', () => {
  const panelSource = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sftpPanel.component.ts'), 'utf8')
  const panelTemplate = readFileSync(resolve(repoRoot, 'tabby', 'tabby-ssh', 'src', 'components', 'sftpPanel.component.pug'), 'utf8')

  assert.match(
    panelTemplate,
    /a\.alert\.alert-info\.d-flex\.align-items-center\([\s\S]*\(click\)='platform\.openExternal\("https:\/\/tabby\.sh\/go\/cwd-detection"\)'/,
    'The SFTP cwd tip body should still open the cwd detection documentation',
  )
  assert.match(
    panelTemplate,
    /button\.close\(type='button', \(click\)='dismissCWDTip\(\$event\)'\)/,
    'The SFTP cwd tip close button must pass its click event to the dismiss handler',
  )
  assert.match(
    panelSource,
    /dismissCWDTip \(event\?: MouseEvent\): void \{[\s\S]*event\?\.preventDefault\(\)[\s\S]*event\?\.stopPropagation\(\)[\s\S]*window\.localStorage\.sshCWDTipDismissed = 'true'/,
    'Dismissing the SFTP cwd tip must stop the click from bubbling into the surrounding documentation link',
  )
})
