import { ApplicationRef, Component, ComponentFactoryResolver, ComponentRef, Inject, Injectable, Injector, Input, NgModule, NgZone, OnDestroy } from '@angular/core'
import { CommonModule } from '@angular/common'
import { NgbActiveModal, NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { TranslateModule } from '@ngx-translate/core'
import {
    ConfigProvider,
    ConfigService,
    ConsoleLogger,
    BOOTSTRAP_DATA,
    BootstrapData,
    ClipboardContent,
    DisplayCapabilities,
    DirectoryDownload,
    DirectoryUpload,
    FileDownload,
    FileUpload,
    FileUploadOptions,
    HostAppService,
    HostWindowService,
    LogService,
    MenuItemOptions,
    MessageBoxOptions,
    MessageBoxResult,
    MessageBoxModalComponent,
    Platform,
    PlatformPathMetadata,
    PlatformService,
    PlatformTemporaryFile,
    PlatformTemporaryFileOptions,
    PromptModalComponent,
    OneKeyEntry,
    OneKeySecretStorageProvider,
    OneKeyService,
    AppService,
    BaseTabComponent,
    ToolbarButton,
    ToolbarButtonProvider,
    UpdaterService,
    Vault,
    VaultCryptoProvider,
    WindowEffectName,
    StoredVault,
} from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'
import { BaseSession, UTF8SplitterMiddleware, InputProcessor, BaseTerminalTabComponent } from 'tabby-terminal'
import { PTYInterface, PTYProxy, Shell, ShellProvider, UACService, SessionOptions, ChildProcess } from 'tabby-local'
import TabbySSHModule from 'tabby-ssh'
import { KeyboardInteractivePrompt, PasswordStorageService, PortForwardType, SSHSessionFactory, SSHShellSessionFactory } from 'tabby-ssh'
import type { ForwardedPortConfig, SFTPDirectoryPlan, SFTPFile, SSHConnectionLike, SSHProfile, SSHShellLikeSession } from 'tabby-ssh'
import { Observable, Subject, Subscription } from 'rxjs'
import { showTabbyContextMenu } from './contextMenu'
import { SshTerminalSizeSync } from './sshTerminalSizeSync'

interface TauriCoreApi {
    invoke<T = unknown> (command: string, args?: Record<string, unknown>): Promise<T>
    Channel?: new<T>(onmessage?: (payload: T) => void) => { onmessage?: (payload: T) => void }
}

interface TauriWindowApi {
    getCurrentWindow?: () => {
        setTitle?: (title: string) => Promise<void>
        minimize?: () => Promise<void>
        close?: () => Promise<void>
        setFocus?: () => Promise<void>
        isFullscreen?: () => Promise<boolean>
        setFullscreen?: (enabled: boolean) => Promise<void>
        isMaximized?: () => Promise<boolean>
        toggleMaximize?: () => Promise<void>
        isFocused?: () => Promise<boolean>
        setEffects?: (effects: { effects: string[], color?: { r: number, g: number, b: number, a: number } }) => Promise<void>
        clearEffects?: () => Promise<void>
        setTheme?: (theme: 'light' | 'dark' | null) => Promise<void>
        setDecorations?: (decorations: boolean) => Promise<void>
        startDragging?: () => Promise<void>
        onCloseRequested?: (handler: () => void) => Promise<() => void>
        onFocusChanged?: (handler: (event: { payload: boolean }) => void) => Promise<() => void>
        onMoved?: (handler: () => void) => Promise<() => void>
        onResized?: (handler: () => void) => Promise<() => void>
        emit?: (event: string, payload?: unknown) => Promise<void>
    }
}

interface TauriWebviewWindowApi {
    WebviewWindow?: new(label: string, options?: {
        url?: string
        title?: string
        width?: number
        height?: number
        resizable?: boolean
        transparent?: boolean
        decorations?: boolean
        shadow?: boolean
    }) => {
        once?: (event: string, handler: (event: { payload?: unknown }) => void) => Promise<() => void>
    }
}

interface TauriDisplayEffectsSnapshot {
    requested: string | null
    effects: string[]
    applied: boolean
    fallback: string | null
    warnings: string[]
    errors: string[]
    opacity: number
    colorSchemeMode: string | null
    source: string
    updatedAt: string
}

interface TauriDisplayAutomationState {
    capabilities: DisplayCapabilities
    lastApplied: TauriDisplayEffectsSnapshot
    applyFromCurrentConfig: (source?: string) => Promise<TauriDisplayEffectsSnapshot>
    applyTestEffects: (effect?: WindowEffectName) => Promise<TauriDisplayEffectsSnapshot>
    clear: (source?: string) => Promise<TauriDisplayEffectsSnapshot>
    startDragging: () => Promise<void>
}

declare global {
    interface Window {
        __TAURI__?: {
            core?: TauriCoreApi
            window?: TauriWindowApi
            webviewWindow?: TauriWebviewWindowApi
        }
        __TAURI_INTERNALS__?: unknown
        __TABBY_TAURI_DISPLAY__?: TauriDisplayAutomationState
        __TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__?: {
            writes?: number
            lastWriteSessionId?: string
            lastWriteBytes?: number
        }
        __TABBY_TAURI_LOCAL_SSH_DIAGNOSTICS__?: {
            attachedTabs: number
            inputMatches: number
            lastTarget: string | null
        }
    }
}

interface SessionSnapshot {
    session_id: string
    kind: 'local'|'ssh'
    state: 'starting'|'running'|'idle'|'closed'|'errored'|'reconnectable'
    last_activity_at: number
    bytes_in: number
    bytes_out: number
    queue_depth: number
    reader_paused: boolean
    close_reason: string | null
    error_reason: string | null
}

interface NativeFileMetadata {
    path: string
    name: string
    size: number
    mode: number
    isDirectory: boolean
}

interface NativeUploadEntry {
    name: string
    path: string | null
    size: number
    mode: number
    isDirectory: boolean
    children: NativeUploadEntry[]
}

interface NativeShellEntry {
    id: string
    name: string
    command: string
    env?: Record<string, string>
}

interface PtySpawnRequest {
    command: string
    args?: string[]
    cwd?: string | null
    env?: Array<[string, string]>
    size: {
        cols: number
        rows: number
    }
}

interface PtySpawnResponse {
    session: SessionSnapshot
    pid: number | null
    cwd: string | null
}

interface PtyData {
    session_id: string
    seq: number
    bytes: number[]
}

interface SshData {
    session_id: string
    seq: number
    bytes: number[]
    currentDir?: string | null
    clipboardText?: string | null
}

type SshAuthMethod =
    | { type: 'password', password: string }
    | { type: 'private-key', private_key_path: string, passphrase?: string | null }
    | { type: 'private-keys', private_keys: SshPrivateKeyCandidate[] }
    | { type: 'keyboard-interactive', prompt_provider: 'renderer' }

interface SshPrivateKeyCandidate {
    private_key_path: string
    passphrase?: string | null
}

interface SshConnectRequest {
    host: string
    port: number
    username: string
    auth: SshAuthMethod
    host_key_fingerprint?: string | null
    term?: string
    unsupported_features?: string[]
}

interface SshKeyboardInteractivePromptEvent {
    request_id: string
    name: string
    instruction: string
    prompts: Array<{ prompt: string, echo?: boolean }>
}

interface SshKeyboardInteractiveResponseRequest {
    request_id: string
    responses?: string[]
    cancelled?: boolean
}

interface SshLocalPortForwardRequest {
    session_id: string
    bind_host: string
    bind_port: number
    target_host: string
    target_port: number
}

interface SshLocalPortForwardResponse {
    forward_id: string
    session_id: string
    bind_host: string
    bind_port: number
    target_host: string
    target_port: number
    status: 'listening'
}

interface SshDynamicPortForwardRequest {
    session_id: string
    bind_host: string
    bind_port: number
}

interface SshDynamicPortForwardResponse {
    forward_id: string
    session_id: string
    bind_host: string
    bind_port: number
    status: 'listening'
}

interface SshRemotePortForwardRequest {
    session_id: string
    bind_host: string
    bind_port: number
    target_host: string
    target_port: number
}

interface SshRemotePortForwardResponse {
    forward_id: string
    session_id: string
    bind_host: string
    bind_port: number
    target_host: string
    target_port: number
    status: 'listening'
}

interface SshShellSize {
    cols: number
    rows: number
}

interface SftpConnectResponse {
    session: SessionSnapshot
    transport_status: string
}

interface NativeSftpFileEntry {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: number
    fileType?: string
}

interface NativeSftpDirectoryPlanEntry {
    path: string
    relativePath: string
    isDirectory: boolean
    mode: number
    size: number
}

interface NativeSftpDirectoryPlan {
    rootPath: string
    entries: NativeSftpDirectoryPlanEntry[]
    totalSize: number
}

interface NativeSftpOpenFileResponse {
    handleId: string
}

interface SshHostKeyScanResponse {
    host: string
    port: number
    sha256: string
    sha512: string
}

interface SshKnownHostEntry {
    host: string
    port: number
    sha256: string
    first_seen: number
    last_seen: number
    alias?: string | null
    comment?: string | null
}

type SshTrustDecision = 'accept-once' | 'trust-and-connect'

interface LocalSshProcessTarget {
    host: string
    port: number
    username: string | null
    privateKeyPath: string | null
}

function splitLocalSshCommandLine (command: string): string[] {
    const tokens: string[] = []
    let current = ''
    let quote: '"' | "'" | null = null
    let escaped = false

    for (const char of command.trim()) {
        if (escaped) {
            current += char
            escaped = false
            continue
        }
        if (char === '\\' && quote !== "'") {
            escaped = true
            continue
        }
        if ((char === '"' || char === "'") && (!quote || quote === char)) {
            quote = quote ? null : char
            continue
        }
        if (!quote && /\s/.test(char)) {
            if (current) {
                tokens.push(current)
                current = ''
            }
            continue
        }
        current += char
    }
    if (current) {
        tokens.push(current)
    }
    return tokens
}

function isSshExecutableToken (token: string): boolean {
    const normalized = token.replace(/^["']|["']$/g, '').replace(/\\/g, '/').toLowerCase()
    const basename = normalized.split('/').pop() ?? normalized
    return basename === 'ssh' || basename === 'ssh.exe'
}

function parseLocalSshProcessCommand (command: string): LocalSshProcessTarget | null {
    const tokens = splitLocalSshCommandLine(command)
    const sshIndex = tokens.findIndex(isSshExecutableToken)
    if (sshIndex === -1) {
        return null
    }

    let port = 22
    let username: string | null = null
    let privateKeyPath: string | null = null
    let destination: string | null = null
    const args = tokens.slice(sshIndex + 1)

    for (let i = 0; i < args.length; i++) {
        const token = args[i]
        if (token === '--') {
            destination = args[i + 1] ?? null
            break
        }
        if (token === '-p' && args[i + 1]) {
            port = parseInt(args[++i], 10) || port
            continue
        }
        if (token.startsWith('-p') && token.length > 2) {
            port = parseInt(token.slice(2), 10) || port
            continue
        }
        if (token === '-l' && args[i + 1]) {
            username = args[++i]
            continue
        }
        if (token.startsWith('-l') && token.length > 2) {
            username = token.slice(2)
            continue
        }
        if (token === '-i' && args[i + 1]) {
            privateKeyPath = args[++i]
            continue
        }
        if (token.startsWith('-i') && token.length > 2) {
            privateKeyPath = token.slice(2)
            continue
        }
        if (['-J', '-b', '-c', '-D', '-E', '-F', '-I', '-L', '-m', '-O', '-o', '-Q', '-R', '-S', '-W', '-w'].includes(token)) {
            i++
            continue
        }
        if (token.startsWith('-')) {
            continue
        }
        destination = token
        break
    }

    if (!destination) {
        return null
    }

    destination = destination.replace(/^ssh:\/\//i, '')
    const at = destination.lastIndexOf('@')
    if (at !== -1) {
        username = destination.slice(0, at) || username
        destination = destination.slice(at + 1)
    }
    destination = destination.replace(/^\[/, '').replace(/\]$/, '')
    const colonPort = /^([^:]+):(\d+)$/.exec(destination)
    if (colonPort) {
        destination = colonPort[1]
        port = parseInt(colonPort[2], 10) || port
    }

    if (!destination || destination.includes('=')) {
        return null
    }

    return {
        host: destination,
        port,
        username,
        privateKeyPath,
    }
}

function parseLocalSshSubmittedCommand (line: string): LocalSshProcessTarget | null {
    const tokens = splitLocalSshCommandLine(line)
    if (!tokens.length || !isSshExecutableToken(tokens[0])) {
        return null
    }
    return parseLocalSshProcessCommand(line)
}

class LocalSshCommandTracker {
    private pendingInputLine = ''
    private inputEscapeMode: 'none'|'esc'|'csi' = 'none'

    feed (data: Buffer): LocalSshProcessTarget | null {
        const text = data.toString('utf-8')
        let target: LocalSshProcessTarget | null = null
        for (const char of text) {
            if (this.inputEscapeMode !== 'none') {
                if (this.inputEscapeMode === 'esc' && char === '[') {
                    this.inputEscapeMode = 'csi'
                    continue
                }
                if (this.inputEscapeMode === 'esc' || (char >= '@' && char <= '~')) {
                    this.inputEscapeMode = 'none'
                }
                continue
            }
            if (char === '\x1b') {
                this.inputEscapeMode = 'esc'
                continue
            }
            if (char === '\x03') {
                this.pendingInputLine = ''
                this.inputEscapeMode = 'none'
                continue
            }
            if (char === '\x08' || char === '\x7f') {
                this.pendingInputLine = this.pendingInputLine.slice(0, -1)
                continue
            }
            if (char === '\r' || char === '\n') {
                target = parseLocalSshSubmittedCommand(this.pendingInputLine) ?? target
                this.pendingInputLine = ''
                continue
            }
            if (char >= ' ' && char !== '\x7f') {
                this.pendingInputLine += char
            }
        }
        return target
    }
}

@Component({
    selector: 'tauri-ssh-host-key-prompt',
    template: `
        <div class="modal-header">
            <h3 class="m-0" translate>Host key verification</h3>
        </div>

        <div class="modal-body pt-0">
            <div class="mb-3">
                <div class="d-flex align-items-center">
                    <label translate>Host</label>
                    <span class="badge text-bg-success ms-auto">SSH</span>
                </div>
                <code class="d-block text-break">{{ host }}:{{ port }}</code>
            </div>

            <div class="mb-3">
                <div class="d-flex align-items-center">
                    <label translate>Current host key fingerprint</label>
                    <span class="badge text-bg-success ms-auto">SHA256</span>
                </div>
                <code class="d-block text-break">{{ sha256 }}</code>
            </div>
        </div>

        <div class="modal-footer">
            <div class="w-100">
                <button
                    type="button"
                    class="d-block w-100 mb-3 btn btn-primary"
                    (click)="trustAndConnect()"
                    translate
                >Accept and remember key
                </button>
                <button
                    type="button"
                    class="d-block w-100 mb-3 btn btn-secondary"
                    (click)="acceptOnce()"
                    translate
                >Accept just this once
                </button>
                <button
                    type="button"
                    class="d-block w-100 btn btn-secondary"
                    (click)="disconnect()"
                    translate
                >Disconnect
                </button>
            </div>
        </div>
    `,
})
class TauriSshHostKeyPromptModalComponent {
    host = ''
    port = 22
    sha256 = ''

    constructor (private modalInstance: NgbActiveModal) {}

    acceptOnce (): void {
        this.closeWithDecision('accept-once')
    }

    trustAndConnect (): void {
        this.closeWithDecision('trust-and-connect')
    }

    disconnect (): void {
        this.modalInstance.dismiss('disconnect')
    }

    private closeWithDecision (decision: SshTrustDecision): void {
        this.modalInstance.close(decision)
    }
}

function tauriCore (): TauriCoreApi {
    const core = window.__TAURI__?.core
    if (!core) {
        throw new Error('Tauri global API is unavailable; enable app.withGlobalTauri for the Tauri host module')
    }
    return core
}

function tauriWindow () {
    return window.__TAURI__?.window?.getCurrentWindow?.()
}

function tauriWebviewWindow (): TauriWebviewWindowApi {
    const webviewWindow = window.__TAURI__?.webviewWindow
    if (!webviewWindow?.WebviewWindow) {
        throw new Error('Tauri WebviewWindow API is unavailable; enable app.withGlobalTauri for the Tauri host module')
    }
    return webviewWindow
}

function invoke<T> (command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriCore().invoke<T>(command, args)
}

function createChannel<T> (onmessage: (payload: T) => void) {
    const Channel = tauriCore().Channel
    if (!Channel) {
        throw new Error('Tauri Channel API is unavailable on the global Tauri core API')
    }
    return new Channel<T>(onmessage)
}

function unsupportedAsync<T> (feature: string): Promise<T> {
    return Promise.reject(new Error(`${feature} is unsupported in the Windows-only Tauri host`))
}

const TAURI_FALLBACK_FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New']
const SSH_CONNECT_TIMEOUT_MS = 30_000
const SSH_SHELL_OPEN_TIMEOUT_MS = 20_000
const SSH_STREAM_START_TIMEOUT_MS = 10_000
const SSH_KEEPALIVE_INTERVAL_MS = 15_000
const SSH_PASSWORD_STORAGE_TIMEOUT_MS = 3_000
const TERMINAL_OUTPUT_FLUSH_DELAY_MS = 8
const SSH_OUTPUT_FLUSH_DELAY_MS = TERMINAL_OUTPUT_FLUSH_DELAY_MS
const PTY_OUTPUT_FLUSH_DELAY_MS = TERMINAL_OUTPUT_FLUSH_DELAY_MS
const SFTP_TRANSFER_CHUNK_SIZE = 256 * 1024
const TAURI_SSH_PASSWORD_PREFIX = 'tabby-tauri:ssh-password:'
const TAURI_SSH_PRIVATE_KEY_PASSPHRASE_PREFIX = 'tabby-tauri:ssh-private-key-passphrase:'

type TauriHostBootstrapData = BootstrapData & {
    environment?: Record<string, string>
    os_release?: string
    app_version?: string
    winscp_path?: string | null
}

function sanitizeSshError (error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message
        .replace(/(password|passphrase|private[_\s-]?key|token|secret)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
        .replace(/(auth:\s*\{\s*type:\s*['"]password['"]\s*,\s*password:\s*)['"][^'"]+['"]/gi, '$1[REDACTED]')
}

function withSshTimeout<T> (operation: Promise<T>, label: string, timeoutMs = SSH_CONNECT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            reject(new Error(`SSH ${label} timed out after ${Math.ceil(timeoutMs / 1000)}s`))
        }, timeoutMs)

        operation.then(resolve, reject).finally(() => window.clearTimeout(timeout))
    })
}

function createTauriDisplayCapabilities (): DisplayCapabilities {
    return {
        windowEffects: {
            supported: true,
            requiresTransparent: true,
            availableEffects: ['tabbed', 'tabbedDark', 'tabbedLight', 'mica', 'blur', 'acrylic'],
            defaultFallbackOrder: ['tabbed', 'mica', 'acrylic', 'blur'],
            performanceWarnings: [
                'Window effects require a transparent Tauri window and can degrade while the window is dragged or resized.',
                'Acrylic and blur are kept behind Mica/tabbed fallback order because they are visually closer but more expensive on some WebView2 systems.',
            ],
        },
        opacity: {
            supported: false,
            reason: 'The local Tauri window API does not expose setOpacity; Tabby keeps CSS opacity only for legacy hosts.',
        },
        customFrame: {
            supported: true,
            strategy: 'decorations-false-tauri-drag-region',
        },
        nativeControls: {
            minimize: true,
            maximize: true,
            close: true,
        },
        draggableRegions: {
            supported: true,
            directElementOnly: true,
        },
        windowStateEvents: {
            fullscreen: true,
            maximized: true,
            focused: true,
            closeRequested: true,
            moved: true,
        },
        monitors: {
            supported: false,
        },
        fonts: {
            listFonts: true,
            defaultFont: 'Cascadia Mono',
            fallbackFonts: [...TAURI_FALLBACK_FONTS],
        },
        docking: {
            supported: false,
            reason: 'Docking needs monitor placement/always-on-top behavior that is not implemented in the Tauri host yet.',
        },
    }
}

function normalizePtySpawnRequest (
    requestOrCommand: PtySpawnRequest|string,
    args: string[] = [],
    options: Partial<SessionOptions> = {},
): PtySpawnRequest {
    if (typeof requestOrCommand !== 'string') {
        return requestOrCommand
    }
    return {
        command: requestOrCommand,
        args,
        cwd: options.cwd ?? null,
        env: Object.entries(options.env ?? {}),
        size: {
            cols: options.width ?? 80,
            rows: options.height ?? 30,
        },
    }
}

function resolveSshTerm (term: string | null | undefined): string {
    const value = typeof term === 'string' ? term.trim() : ''
    return value || 'xterm-256color'
}

function unsupportedSshFeatures (profile: SSHProfile): string[] {
    const options = profile.options
    const unsupportedFeatures: string[] = []
    if (options.auth === 'agent') {
        unsupportedFeatures.push('agent auth')
    }
    if (options.jumpHost) {
        unsupportedFeatures.push('jump host')
    }
    if (options.agentForward) {
        unsupportedFeatures.push('agent forwarding')
    }
    if (options.x11) {
        unsupportedFeatures.push('X11 forwarding')
    }
    if (options.proxyCommand) {
        unsupportedFeatures.push('proxy command')
    }
    for (const fw of options.forwardedPorts ?? []) {
        if (fw.type !== PortForwardType.Local && fw.type !== PortForwardType.Dynamic && fw.type !== PortForwardType.Remote) {
            unsupportedFeatures.push(`port forwarding type ${fw.type}`)
        }
    }
    if (options.socksProxyHost) {
        unsupportedFeatures.push('SOCKS proxy')
    }
    if (options.httpProxyHost) {
        unsupportedFeatures.push('HTTP proxy')
    }
    return unsupportedFeatures
}

class TauriSshTrustService {
    constructor (private injector: Injector) {}

    async resolveHostKeyFingerprint (host: string, port: number): Promise<string> {
        const stored = await invoke<SshKnownHostEntry | null>('ssh_known_host_get', { request: { host, port } })
        const scan = await invoke<SshHostKeyScanResponse>('ssh_scan_host_key', { request: { host, port } })
        if (stored) {
            if (stored.sha256 === scan.sha256) {
                return stored.sha256
            }
            await invoke('ssh_known_host_mismatch_report', { stored, scannedSha256: scan.sha256 }).catch(() => null)
            throw new Error(`SSH host key mismatch for ${host}:${port}; authentication was blocked before password or private-key use`)
        }

        const decision = await this.promptTrustDecision(host, port, scan.sha256)
        if (decision === 'trust-and-connect') {
            await invoke<SshKnownHostEntry>('ssh_known_host_trust', {
                request: {
                    host,
                    port,
                    sha256: scan.sha256,
                    comment: 'Trusted from Tauri SSH host-key prompt',
                },
            })
        }
        return scan.sha256
    }

    async forget (host: string, port: number): Promise<boolean> {
        return invoke<boolean>('ssh_known_host_forget', { request: { host, port } })
    }

    async list (): Promise<SshKnownHostEntry[]> {
        return invoke<SshKnownHostEntry[]>('ssh_known_hosts_list')
    }

    private async promptTrustDecision (host: string, port: number, sha256: string): Promise<SshTrustDecision> {
        const modal = this.injector.get(NgbModal).open(TauriSshHostKeyPromptModalComponent, { backdrop: 'static' })
        const component = modal.componentInstance as TauriSshHostKeyPromptModalComponent
        component.host = host
        component.port = port
        component.sha256 = sha256
        const result = await modal.result.catch(() => null)
        if (result === 'accept-once' || result === 'trust-and-connect') {
            return result
        }
        throw new Error(`SSH host key was not trusted for ${host}:${port}`)
    }
}

@Injectable()
export class TauriPasswordStorageService {
    async savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (!account) {
            return
        }
        await this.saveSecret(this.connectionService(profile), account, password, this.connectionLocalKey(profile, account))
    }

    async deletePassword (profile: SSHProfile, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (!account) {
            return
        }
        await this.deleteSecret(this.connectionService(profile), account, this.connectionLocalKey(profile, account))
    }

    async loadPassword (profile: SSHProfile, username?: string): Promise<string|null> {
        const account = username ?? profile.options.user
        if (!account) {
            return null
        }
        return profile.options.password || await this.loadSecret(this.connectionService(profile), account, this.connectionLocalKey(profile, account))
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        await this.saveSecret(this.privateKeyService(id), 'user', password, this.privateKeyLocalKey(id))
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        await this.deleteSecret(this.privateKeyService(id), 'user', this.privateKeyLocalKey(id))
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        return this.loadSecret(this.privateKeyService(id), 'user', this.privateKeyLocalKey(id))
    }

    private connectionService (profile: SSHProfile): string {
        let service = `ssh@${profile.options.host}`
        if (profile.options.port) {
            service = `${service}:${profile.options.port}`
        }
        return service
    }

    private connectionLocalKey (profile: SSHProfile, username: string): string {
        const port = profile.options.port ?? 22
        return `${TAURI_SSH_PASSWORD_PREFIX}${encodeURIComponent(username)}@${encodeURIComponent(profile.options.host)}:${port}`
    }

    private privateKeyService (id: string): string {
        return `ssh-private-key:${id}`
    }

    private privateKeyLocalKey (id: string): string {
        return `${TAURI_SSH_PRIVATE_KEY_PASSPHRASE_PREFIX}${encodeURIComponent(id)}`
    }

    private async loadSecret (service: string, account: string, fallbackKey: string): Promise<string|null> {
        try {
            return await invoke<string|null>('credential_get_password', { service, account }) ?? this.loadLocalSecret(fallbackKey)
        } catch {
            return this.loadLocalSecret(fallbackKey)
        }
    }

    private async saveSecret (service: string, account: string, password: string, fallbackKey: string): Promise<void> {
        try {
            await invoke<void>('credential_set_password', { service, account, password })
            this.deleteLocalSecret(fallbackKey)
        } catch {
            this.saveLocalSecret(fallbackKey, password)
        }
    }

    private async deleteSecret (service: string, account: string, fallbackKey: string): Promise<void> {
        try {
            await invoke<boolean>('credential_delete_password', { service, account })
        } catch {
            // The local fallback is still cleared below.
        }
        this.deleteLocalSecret(fallbackKey)
    }

    private loadLocalSecret (key: string): string|null {
        return window.localStorage.getItem(key)
    }

    private saveLocalSecret (key: string, value: string): void {
        window.localStorage.setItem(key, value)
    }

    private deleteLocalSecret (key: string): void {
        window.localStorage.removeItem(key)
    }
}

@Injectable()
export class TauriOneKeySecretStorageProvider extends OneKeySecretStorageProvider {
    private readonly service = 'tabby-onekey'

    override async probe (): Promise<boolean> {
        try {
            await invoke<string|null>('credential_get_password', { service: this.service, account: 'onekey:__probe__' })
            return true
        } catch {
            return false
        }
    }

    override async getSecret (target: string): Promise<string|null> {
        return invoke<string|null>('credential_get_password', { service: this.service, account: target })
    }

    override async setSecret (target: string, value: string): Promise<void> {
        await invoke<void>('credential_set_password', { service: this.service, account: target, password: value })
    }

    override async deleteSecret (target: string): Promise<void> {
        await invoke<boolean>('credential_delete_password', { service: this.service, account: target })
    }
}

@Injectable()
export class TauriVaultCryptoProvider extends VaultCryptoProvider {
    override async encrypt (content: Vault, passphrase: string): Promise<StoredVault> {
        return invoke<StoredVault>('vault_encrypt', {
            contentJson: JSON.stringify(content),
            passphrase,
        })
    }

    override async decrypt (vault: StoredVault, passphrase: string): Promise<Vault> {
        const plaintext = await invoke<string>('vault_decrypt', { vault, passphrase })
        const content = JSON.parse(plaintext)
        return {
            config: content.config,
            secrets: content.secrets ?? [],
        }
    }

    override async randomBytes (length: number): Promise<Buffer> {
        return Buffer.from(await invoke<number[]>('vault_random_bytes', { length }))
    }
}

const NATIVE_TRANSFER_CHUNK_SIZE = 256 * 1024

function nativeBaseName (path: string): string {
    const normalized = path.replace(/\\/g, '/')
    return normalized.split('/').filter(Boolean).pop() ?? path
}

function sanitizeTempFilePart (value: string): string {
    const sanitized = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    return sanitized || 'tabby'
}

function windowsJoinPath (directory: string, name: string): string {
    const trimmed = directory.replace(/[\\/]+$/, '')
    return `${trimmed}\\${name}`
}

class TauriNativeFileUpload extends FileUpload {
    private offset = 0

    constructor (private metadata: NativeFileMetadata, private zone: NgZone) {
        super()
        this.setTotalSize(metadata.size)
    }

    getName (): string { return this.metadata.name || nativeBaseName(this.metadata.path) }
    getMode (): number { return this.metadata.mode }
    getSize (): number { return this.metadata.size }

    async read (): Promise<Uint8Array> {
        const bytes = await invoke<number[]>('native_read_file_chunk', {
            path: this.metadata.path,
            offset: this.offset,
            length: NATIVE_TRANSFER_CHUNK_SIZE,
        })
        const chunk = new Uint8Array(bytes)
        this.zone.run(() => {
            this.offset += chunk.length
            this.increaseProgress(chunk.length)
        })
        return chunk
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close (): void { }
}

class TauriNativeFileDownload extends FileDownload {
    private offset = 0

    constructor (private metadata: NativeFileMetadata, private size: number, private zone: NgZone) {
        super()
        this.setTotalSize(size)
    }

    getName (): string { return this.metadata.name || nativeBaseName(this.metadata.path) }
    getSize (): number { return this.size }

    async write (buffer: Uint8Array): Promise<void> {
        if (!buffer.length) {
            return
        }
        const writtenOffset = await invoke<number>('native_write_file_chunk', {
            path: this.metadata.path,
            offset: this.offset,
            bytes: Array.from(buffer),
        })
        this.zone.run(() => {
            const writtenBytes = writtenOffset - this.offset
            this.offset = writtenOffset
            this.increaseProgress(Math.max(0, writtenBytes))
            if (this.getCompletedBytes() >= this.getSize()) {
                this.setCompleted(true)
            }
        })
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close (): void { }
}

class TauriNativeDirectoryDownload extends DirectoryDownload {
    constructor (private metadata: NativeFileMetadata, private zone: NgZone, estimatedSize = 0) {
        super()
        this.setTotalSize(estimatedSize)
    }

    getName (): string { return this.metadata.name || nativeBaseName(this.metadata.path) }
    getSize (): number { return this.getTotalSize() }

    async createDirectory (relativePath: string): Promise<void> {
        await invoke<void>('native_create_directory_in_directory', {
            basePath: this.metadata.path,
            relativePath,
        })
    }

    async createFile (relativePath: string, mode: number, size: number): Promise<FileDownload> {
        const metadata = await invoke<NativeFileMetadata>('native_prepare_download_file_in_directory', {
            basePath: this.metadata.path,
            relativePath,
            mode,
            size,
        })
        return new TauriNativeFileDownload(metadata, size, this.zone)
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close (): void { }
}

@Injectable()
export class TauriWindowsPlatformService extends PlatformService {
    override supportsWindowControls = true
    override displayCapabilities = createTauriDisplayCapabilities()

    constructor (
        @Inject(BOOTSTRAP_DATA) private bootstrapData: TauriHostBootstrapData,
        private zone: NgZone,
        private ngbModal: NgbModal,
    ) {
        super()
    }

    readClipboard (): Promise<string> { return invoke<string>('read_clipboard_text') }
    setClipboard (content: ClipboardContent): void { void invoke<void>('write_clipboard_text', { text: content.text }) }
    loadConfig (): Promise<string> { return invoke<string>('load_config').catch(() => '{}') }
    saveConfig (content: string): Promise<void> { return invoke<void>('save_config', { content }) }
    async startDownload (name: string, mode: number, size: number): Promise<FileDownload | null> {
        const path = await invoke<string | null>('native_pick_save_file', { defaultName: name })
        if (!path) {
            return null
        }
        const metadata = await invoke<NativeFileMetadata>('native_prepare_download_file', { path, mode, size })
        const transfer = new TauriNativeFileDownload(metadata, size, this.zone)
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startDownloadDirectory (name: string, estimatedSize = 0): Promise<DirectoryDownload | null> {
        const parent = await invoke<string | null>('native_pick_directory', {
            title: `选择 ${name} 的下载目录`,
        })
        if (!parent) {
            return null
        }
        const metadata = await invoke<NativeFileMetadata>('native_prepare_download_directory', { parent, name })
        const transfer = new TauriNativeDirectoryDownload(metadata, this.zone, estimatedSize)
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startUpload (options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]> {
        options ??= { multiple: false }
        if (!paths) {
            paths = await invoke<string[] | null>('native_pick_files', { multiple: !!options.multiple }) ?? []
        }
        const transfers: FileUpload[] = []
        for (const path of paths) {
            const metadata = await invoke<NativeFileMetadata>('native_stat_path', { path })
            if (metadata.isDirectory) {
                continue
            }
            const transfer = new TauriNativeFileUpload(metadata, this.zone)
            this.fileTransferStarted.next(transfer)
            transfers.push(transfer)
        }
        return transfers
    }

    async startUploadDirectory (paths?: string[]): Promise<DirectoryUpload> {
        if (!paths) {
            const path = await invoke<string | null>('native_pick_directory', {
                title: '选择要上传的目录',
            })
            paths = path ? [path] : []
        }
        const root = new DirectoryUpload()
        for (const path of paths.slice(0, 1)) {
            const tree = await invoke<NativeUploadEntry>('native_upload_directory_tree', { path })
            root.pushChildren(this.createDirectoryUploadFromNativeTree(tree))
        }
        return root
    }

    override async statPath (path: string): Promise<PlatformPathMetadata | null> {
        try {
            return await invoke<NativeFileMetadata>('native_stat_path', { path })
        } catch {
            return null
        }
    }

    override async pathExists (path: string): Promise<boolean> {
        return await invoke<boolean>('native_path_exists', { path }).catch(() => false)
    }

    override async realpath (path: string): Promise<string | null> {
        return await invoke<string>('native_fs_realpath', { path }).catch(() => null)
    }

    override async createTemporaryTextFile (content: string, options: PlatformTemporaryFileOptions = {}): Promise<PlatformTemporaryFile> {
        const tempDirectory = this.bootstrapData.environment?.TMP ?? this.bootstrapData.environment?.TEMP ?? 'C:\\Windows\\Temp'
        const prefix = sanitizeTempFilePart(options.prefix ?? 'tabby-tauri-')
        const suffix = sanitizeTempFilePart(options.suffix ?? '.tmp')
        const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
        const path = windowsJoinPath(tempDirectory, `${prefix}${token}${suffix}`)
        await invoke<void>('native_fs_write_text', { path, content })
        return {
            path,
            cleanup: async () => { await invoke<void>('native_fs_unlink', { path }).catch(() => null) },
        }
    }

    getOSRelease (): string { return this.bootstrapData.os_release ?? navigator.userAgent }
    getAppVersion (): string { return this.bootstrapData.app_version ?? 'tauri-tabby' }
    openExternal (url: string): Promise<void> { return invoke<void>('open_external', { url }) }
    async listFonts (): Promise<string[]> {
        try {
            const fonts = await invoke<string[]>('list_fonts')
            return fonts.length ? fonts : [...TAURI_FALLBACK_FONTS]
        } catch {
            return [...TAURI_FALLBACK_FONTS]
        }
    }
    setErrorHandler (handler: (_: any) => void): void { window.addEventListener('error', handler) }
    popupContextMenu (menu: MenuItemOptions[], event?: MouseEvent): void {
        showTabbyContextMenu(menu, event)
    }

    async showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult> {
        const previouslyFocusedElement = document.activeElement
        const modal = this.ngbModal.open(MessageBoxModalComponent, {
            backdrop: 'static',
            keyboard: true,
        })
        const instance: MessageBoxModalComponent = modal.componentInstance
        instance.options = options
        modal.hidden.subscribe(() => {
            if (previouslyFocusedElement instanceof HTMLElement && previouslyFocusedElement.isConnected) {
                previouslyFocusedElement.focus()
            }
        })
        try {
            return { response: await modal.result }
        } catch {
            return { response: options.cancelId ?? 1 }
        }
    }

    pickDirectory (): Promise<string | null> { return invoke<string | null>('native_pick_directory', { title: null }) }
    quit (): void { void invoke<void>('quit') }
    openPath (path: string): void { void invoke<void>('open_path_allowlisted', { path }) }
    getWinSCPPath (): string | null { return this.bootstrapData.winscp_path ?? null }
    async exec (app: string, argv: string[]): Promise<void> { return invoke<void>('exec_allowlisted', { app, argv }) }

    private createDirectoryUploadFromNativeTree (entry: NativeUploadEntry): DirectoryUpload | FileUpload {
        if (!entry.isDirectory) {
            const transfer = new TauriNativeFileUpload({
                path: entry.path ?? '',
                name: entry.name,
                size: entry.size,
                mode: entry.mode,
                isDirectory: false,
            }, this.zone)
            this.fileTransferStarted.next(transfer)
            return transfer
        }
        const directory = new DirectoryUpload(entry.name)
        for (const child of entry.children) {
            directory.pushChildren(this.createDirectoryUploadFromNativeTree(child))
        }
        return directory
    }
}

@Injectable()
export class TauriHostWindowService extends HostWindowService {
    private _isFullscreen = false
    private _isMaximized = false
    private _isFocused = true

    override get supportsDirectQuit (): boolean { return true }

    constructor () {
        super()
        this.installListeners()
        void this.refreshState()
    }

    get isFullscreen (): boolean { return this._isFullscreen }
    get isFocused (): boolean { return this._isFocused }

    reload (): void { window.location.reload() }
    setTitle (title = 'Tabby Tauri'): void { void tauriWindow()?.setTitle?.(title).catch(() => null) }

    toggleFullscreen (): void {
        const win = tauriWindow()
        void win?.isFullscreen?.()
            .then(fullscreen => win.setFullscreen?.(!fullscreen).then(() => {
                this._isFullscreen = !fullscreen
            }))
            .then(() => this.refreshState())
            .catch(() => null)
    }

    minimize (): void { void tauriWindow()?.minimize?.().catch(() => null) }
    isMaximized (): boolean { return this._isMaximized }

    toggleMaximize (): void {
        const win = tauriWindow()
        void win?.toggleMaximize?.()
            .then(() => this.refreshState())
            .catch(() => null)
    }

    close (): void {
        void invoke<void>('quit').catch(() => tauriWindow()?.close?.().catch(() => null))
    }

    bringToFront (): void { void tauriWindow()?.setFocus?.().catch(() => null) }

    private installListeners (): void {
        const win = tauriWindow()
        if (!win) {
            return
        }

        const ignoreListenerFailure = (listener?: Promise<() => void>) => {
            void listener?.catch(() => null)
        }

        ignoreListenerFailure(win.onCloseRequested?.(() => this.windowCloseRequest.next()))
        ignoreListenerFailure(win.onFocusChanged?.(event => {
            this._isFocused = event.payload
            if (event.payload) {
                this.windowFocused.next()
            }
        }))
        ignoreListenerFailure(win.onMoved?.(() => {
            this.windowMoved.next()
            void this.refreshState()
        }))
        ignoreListenerFailure(win.onResized?.(() => {
            this.windowMoved.next()
            void this.refreshState()
        }))
    }

    private async refreshState (): Promise<void> {
        const win = tauriWindow()
        if (!win) {
            return
        }

        const [fullscreen, maximized, focused] = await Promise.all([
            win.isFullscreen?.().catch(() => this._isFullscreen),
            win.isMaximized?.().catch(() => this._isMaximized),
            win.isFocused?.().catch(() => this._isFocused),
        ])
        if (typeof fullscreen === 'boolean') {
            this._isFullscreen = fullscreen
        }
        if (typeof maximized === 'boolean') {
            this._isMaximized = maximized
        }
        if (typeof focused === 'boolean') {
            this._isFocused = focused
        }
    }
}

@Injectable()
export class TauriDisplayEffectsService {
    private automation: TauriDisplayAutomationState

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
    ) {
        this.automation = {
            capabilities: platform.displayCapabilities,
            lastApplied: this.createSnapshot({
                requested: null,
                effects: [],
                applied: false,
                fallback: 'initial',
                warnings: platform.displayCapabilities.windowEffects.performanceWarnings,
                errors: [],
                opacity: 1,
                colorSchemeMode: null,
                source: 'init',
            }),
            applyFromCurrentConfig: (source = 'manual') => this.applyFromCurrentConfig(source),
            applyTestEffects: (effect = 'acrylic') => this.applyEffects({
                source: 'test',
                forcedEffects: [effect],
                forceVibrancy: true,
            }),
            clear: (source = 'manual-clear') => this.clearEffects(source),
            startDragging: async () => {
                await tauriWindow()?.startDragging?.()
            },
        }
        window.__TABBY_TAURI_DISPLAY__ = this.automation

        this.config.ready$.subscribe(() => {
            void this.applyFromCurrentConfig('config-ready')
            this.config.changed$.subscribe(() => void this.applyFromCurrentConfig('config-changed'))
        })
    }

    private async applyFromCurrentConfig (source: string): Promise<TauriDisplayEffectsSnapshot> {
        return this.applyEffects({ source })
    }

    private async clearEffects (source: string): Promise<TauriDisplayEffectsSnapshot> {
        const win = tauriWindow()
        const errors: string[] = []
        try {
            await win?.clearEffects?.()
        } catch (error) {
            errors.push(String(error))
        }
        const snapshot = this.createSnapshot({
            requested: null,
            effects: [],
            applied: false,
            fallback: errors.length ? 'clear-effects-failed' : 'css-background',
            warnings: this.warningMessages(1),
            errors,
            opacity: 1,
            colorSchemeMode: this.colorSchemeMode,
            source,
        })
        this.updateSnapshot(snapshot)
        return snapshot
    }

    private async applyEffects (options: { source: string, forcedEffects?: WindowEffectName[], forceVibrancy?: boolean }): Promise<TauriDisplayEffectsSnapshot> {
        const appearance = this.config.store?.appearance ?? {}
        const opacity = Number(appearance.opacity ?? 1)
        const colorSchemeMode = String(appearance.colorSchemeMode ?? 'dark')
        const warnings = this.warningMessages(opacity)
        const errors: string[] = []
        const vibrancyEnabled = options.forceVibrancy ?? Boolean(appearance.vibrancy)

        if (!vibrancyEnabled || !this.platform.displayCapabilities.windowEffects.supported) {
            return this.clearEffects(options.source)
        }

        const effects = options.forcedEffects ?? this.effectsForConfig(String(appearance.vibrancyType ?? 'blur'), colorSchemeMode)
        const theme = this.themeForColorScheme(colorSchemeMode)
        const win = tauriWindow()

        try {
            await win?.setTheme?.(theme)
        } catch (error) {
            warnings.push(`Unable to apply Tauri theme: ${String(error)}`)
        }

        try {
            if (appearance.frame) {
                await win?.setDecorations?.(appearance.frame === 'native')
            }
        } catch (error) {
            warnings.push(`Unable to sync Tauri decorations: ${String(error)}`)
        }

        try {
            if (!win?.setEffects) {
                throw new Error('Tauri setEffects is unavailable')
            }
            await win.setEffects({ effects })
        } catch (error) {
            errors.push(String(error))
        }

        const snapshot = this.createSnapshot({
            requested: effects[0] ?? null,
            effects,
            applied: errors.length === 0,
            fallback: errors.length ? 'css-background' : null,
            warnings,
            errors,
            opacity,
            colorSchemeMode,
            source: options.source,
        })
        this.updateSnapshot(snapshot)
        return snapshot
    }

    private effectsForConfig (vibrancyType: string, colorSchemeMode: string): WindowEffectName[] {
        if (vibrancyType === 'fluent') {
            if (colorSchemeMode === 'light') {
                return ['tabbedLight', 'mica', 'acrylic', 'blur']
            }
            if (colorSchemeMode === 'dark') {
                return ['tabbedDark', 'mica', 'acrylic', 'blur']
            }
            return ['tabbed', 'mica', 'acrylic', 'blur']
        }
        return ['blur', 'acrylic', 'mica']
    }

    private themeForColorScheme (colorSchemeMode: string): 'light' | 'dark' | null {
        if (colorSchemeMode === 'light' || colorSchemeMode === 'dark') {
            return colorSchemeMode
        }
        return null
    }

    private warningMessages (opacity: number): string[] {
        const warnings = [...this.platform.displayCapabilities.windowEffects.performanceWarnings]
        if (opacity !== 1 && !this.platform.displayCapabilities.opacity.supported) {
            warnings.push(this.platform.displayCapabilities.opacity.reason ?? 'Window opacity is not supported by this host')
        }
        return warnings
    }

    private get colorSchemeMode (): string | null {
        return this.config.store?.appearance?.colorSchemeMode ?? null
    }

    private createSnapshot (options: Omit<TauriDisplayEffectsSnapshot, 'updatedAt'>): TauriDisplayEffectsSnapshot {
        return {
            ...options,
            updatedAt: new Date().toISOString(),
        }
    }

    private updateSnapshot (snapshot: TauriDisplayEffectsSnapshot): void {
        this.automation.lastApplied = snapshot
        document.documentElement.dataset.tauriWindowEffects = snapshot.effects.join(',')
        document.documentElement.dataset.tauriWindowEffectsApplied = String(snapshot.applied)
        document.documentElement.dataset.tauriWindowEffectsFallback = snapshot.fallback ?? ''
    }
}

@Injectable()
export class TauriHostAppService extends HostAppService {
    private bootstrapData: TauriHostBootstrapData

    get platform (): Platform { return Platform.Windows }
    get configPlatform (): Platform { return Platform.Windows }

    constructor (injector: Injector) {
        super(injector)
        this.bootstrapData = injector.get(BOOTSTRAP_DATA) as TauriHostBootstrapData
    }

    newWindow (): void { void this.createNewWindow() }
    override emitReady (): void { /* Tauri host does not need Electron-style app:ready IPC */ }
    relaunch (): void { void invoke<void>('relaunch') }
    quit (): void { void invoke<void>('quit') }
    getWinSCPPath (): string | null { return this.bootstrapData.winscp_path ?? null }
    async exec (app: string, argv: string[]): Promise<void> { return invoke<void>('exec_allowlisted', { app, argv }) }

    private async createNewWindow (): Promise<void> {
        const WebviewWindow = tauriWebviewWindow().WebviewWindow!
        const label = `tabby-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        const win = new WebviewWindow(label, {
            url: location.href,
            title: 'Tabby Tauri',
            width: 1024,
            height: 720,
            resizable: true,
            transparent: true,
            decorations: false,
            shadow: true,
        })
        void win.once?.('tauri://error', event => {
            const message = `Failed to create Tauri window: ${String(event.payload ?? 'unknown error')}`
            window.dispatchEvent(new ErrorEvent('error', { message, error: new Error(message) }))
        })
    }
}

@Injectable()
export class TauriConfigProvider extends ConfigProvider {
    defaults = {
        recoverTabs: false,
        enableAnalytics: false,
        enableWelcomeTab: false,
        enableAutomaticUpdates: false,
    }
}

@Injectable()
export class TauriWindowsShellProvider extends ShellProvider {
    async provide (): Promise<Shell[]> {
        try {
            const shells = await invoke<NativeShellEntry[]>('shell_list')
            if (shells.length) {
                return shells.map(shell => ({ ...shell, env: shell.env ?? {} }))
            }
        } catch (error) {
            console.warn('Could not load native shell list; falling back to renderer defaults', error)
        }
        return this.defaultShells()
    }

    private defaultShells (): Shell[] {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
        const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files'
        return [
            { id: 'powershell', name: 'Windows PowerShell', command: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, env: {} },
            { id: 'pwsh', name: 'PowerShell', command: `${programFiles}\\PowerShell\\7\\pwsh.exe`, env: {} },
            { id: 'cmd', name: 'Command Prompt', command: `${systemRoot}\\System32\\cmd.exe`, env: {} },
        ]
    }
}

export class TauriPTYProxy extends PTYProxy {
    private unsubscribers: Array<() => void> = []
    private pendingDataBuffers: Buffer[] = []
    private pendingDataFlushTimer: number | null = null

    constructor (private response: PtySpawnResponse) { super() }

    getID (): string { return this.response.session.session_id }
    async getPID (): Promise<number> { return this.response.pid ?? 0 }
    resize (columns: number, rows: number): Promise<void> { return invoke<void>('pty_resize', { sessionId: this.getID(), size: { cols: columns, rows } }) }
    write (data: Buffer): Promise<void> { return invoke<SessionSnapshot>('pty_write', { sessionId: this.getID(), bytes: Array.from(data) }).then(() => undefined) }
    kill (signal?: string): Promise<void> { return invoke<SessionSnapshot>('pty_kill', { sessionId: this.getID(), signal }).then(() => undefined) }
    ackData (length: number): void { void invoke<SessionSnapshot>('pty_ack', { sessionId: this.getID(), length }) }
    subscribe (event: string, handler: (..._: any[]) => void): void {
        if (event === 'data') {
            const channel = createChannel<PtyData>(data => this.queueData(data, handler))
            void invoke<void>('pty_stream', { sessionId: this.getID(), channel })
            this.unsubscribers.push(() => this.clearPendingData())
            return
        }
        if (event === 'close' || event === 'exit') {
            const timer = window.setInterval(async () => {
                const snapshot = await invoke<SessionSnapshot | null>('session_state', { sessionId: this.getID() })
                if (snapshot && ['closed', 'errored', 'reconnectable'].includes(snapshot.state)) {
                    window.clearInterval(timer)
                    handler(snapshot)
                }
            }, 500)
            this.unsubscribers.push(() => window.clearInterval(timer))
        }
    }

    private queueData (data: PtyData, handler: (..._: any[]) => void): void {
        this.pendingDataBuffers.push(Buffer.from(data.bytes))
        if (this.pendingDataFlushTimer === null) {
            this.pendingDataFlushTimer = window.setTimeout(() => this.flushPendingData(handler), PTY_OUTPUT_FLUSH_DELAY_MS)
        }
    }

    private flushPendingData (handler: (..._: any[]) => void): void {
        if (this.pendingDataFlushTimer !== null) {
            window.clearTimeout(this.pendingDataFlushTimer)
            this.pendingDataFlushTimer = null
        }
        const buffers = this.pendingDataBuffers.splice(0)
        if (buffers.length === 0) {
            return
        }
        const byteLength = buffers.reduce((total, buffer) => total + buffer.length, 0)
        handler(Buffer.concat(buffers, byteLength))
    }

    private clearPendingData (): void {
        if (this.pendingDataFlushTimer !== null) {
            window.clearTimeout(this.pendingDataFlushTimer)
            this.pendingDataFlushTimer = null
        }
        this.pendingDataBuffers = []
    }

    unsubscribeAll (): void {
        this.clearPendingData()
        this.unsubscribers.splice(0).forEach(x => x())
    }
    getChildProcesses (): Promise<ChildProcess[]> { return invoke<ChildProcess[]>('pty_children', { sessionId: this.getID() }) }
    getTruePID (): Promise<number> { return invoke<number | null>('pty_true_pid', { sessionId: this.getID() }).then(pid => pid ?? 0) }
    getWorkingDirectory (): Promise<string | null> { return invoke<string | null>('pty_cwd', { sessionId: this.getID() }) }
}

@Injectable()
export class TauriPTYInterface extends PTYInterface {
    async spawn (...options: any[]): Promise<PTYProxy> {
        const request = normalizePtySpawnRequest(options[0], options[1], options[2])
        return new TauriPTYProxy(await invoke<PtySpawnResponse>('pty_spawn', { request }))
    }
    async restore (id: string): Promise<PTYProxy | null> {
        const response = await invoke<PtySpawnResponse | null>('pty_restore', { sessionId: id })
        return response ? new TauriPTYProxy(response) : null
    }
}

const SFTP_OPEN_READ = 0x00000001
const SFTP_OPEN_WRITE = 0x00000002
const SFTP_OPEN_CREATE = 0x00000008

function sftpBaseName (path: string): string {
    return path.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? path
}

function nativeSftpFile (entry: NativeSftpFileEntry): SFTPFile {
    return {
        name: entry.name || sftpBaseName(entry.fullPath),
        fullPath: entry.fullPath,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        mode: entry.mode ?? 0,
        size: entry.size ?? 0,
        modified: new Date((entry.modified ?? 0) * 1000),
        fileType: entry.fileType,
    }
}

function normalizeSftpChmodMode (mode: string | number): number {
    if (typeof mode === 'number') {
        return mode
    }
    const trimmed = mode.trim()
    return parseInt(trimmed, trimmed.startsWith('0o') ? 8 : 8)
}

class TauriSftpFileHandle {
    position = 0

    constructor (private handleId: string | null) { }

    async read (): Promise<Uint8Array> {
        if (!this.handleId) {
            return new Uint8Array(0)
        }
        const bytes = await invoke<number[]>('ssh_sftp_read_file_chunk', {
            handleId: this.handleId,
            length: SFTP_TRANSFER_CHUNK_SIZE,
        })
        const chunk = new Uint8Array(bytes)
        this.position += chunk.length
        return chunk
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.handleId) {
            throw new Error('File handle is closed')
        }
        await invoke<void>('ssh_sftp_write_file_chunk', {
            handleId: this.handleId,
            bytes: Array.from(chunk),
        })
        this.position += chunk.length
    }

    async close (): Promise<void> {
        if (!this.handleId) {
            return
        }
        const handleId = this.handleId
        this.handleId = null
        await invoke<void>('ssh_sftp_close_file', { handleId })
    }
}

class TauriSftpSession {
    get closed$ (): Observable<void> { return this.closed.asObservable() }
    private closed = new Subject<void>()
    private isClosed = false

    constructor (private sessionId: string, private zone: NgZone) { }

    async readdir (p: string): Promise<SFTPFile[]> {
        const entries = await invoke<NativeSftpFileEntry[]>('ssh_sftp_readdir', { sessionId: this.sessionId, path: p })
        return entries.map(nativeSftpFile)
    }

    async directoryPlan (p: string): Promise<SFTPDirectoryPlan> {
        return invoke<NativeSftpDirectoryPlan>('ssh_sftp_directory_plan', { sessionId: this.sessionId, path: p })
    }

    async readlink (p: string): Promise<string> {
        return invoke<string>('ssh_sftp_readlink', { sessionId: this.sessionId, path: p })
    }

    async realpath (p: string): Promise<string> {
        return invoke<string>('ssh_sftp_realpath', { sessionId: this.sessionId, path: p })
    }

    async stat (p: string): Promise<SFTPFile> {
        return nativeSftpFile(await invoke<NativeSftpFileEntry>('ssh_sftp_stat', { sessionId: this.sessionId, path: p }))
    }

    async open (p: string, mode: number): Promise<TauriSftpFileHandle> {
        const response = await invoke<NativeSftpOpenFileResponse>('ssh_sftp_open', {
            sessionId: this.sessionId,
            path: p,
            mode,
        })
        return new TauriSftpFileHandle(response.handleId)
    }

    async mkdir (p: string): Promise<void> {
        await invoke<void>('ssh_sftp_mkdir', { sessionId: this.sessionId, path: p })
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        await invoke<void>('ssh_sftp_rename', { sessionId: this.sessionId, oldPath, newPath })
    }

    async unlink (p: string): Promise<void> {
        await invoke<void>('ssh_sftp_unlink', { sessionId: this.sessionId, path: p })
    }

    async chmod (p: string, mode: string | number): Promise<void> {
        await invoke<void>('ssh_sftp_chmod', {
            sessionId: this.sessionId,
            path: p,
            mode: normalizeSftpChmodMode(mode),
        })
    }

    async rmdir (p: string): Promise<void> {
        await invoke<void>('ssh_sftp_rmdir', { sessionId: this.sessionId, path: p })
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        const tempPath = `${path}.tabby-upload`
        let handle: TauriSftpFileHandle | null = null
        try {
            handle = await this.open(tempPath, SFTP_OPEN_WRITE | SFTP_OPEN_CREATE)
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            await handle.close()
            handle = null
            await this.unlink(path).catch(() => null)
            await this.rename(tempPath, path)
            this.zone.run(() => transfer.setCompleted(true))
            transfer.close()
        } catch (error) {
            this.zone.run(() => {
                transfer.setStatus(error instanceof Error ? error.message : String(error))
                transfer.cancel()
            })
            await handle?.close().catch(() => null)
            await this.unlink(tempPath).catch(() => null)
            throw error
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        let handle: TauriSftpFileHandle | null = null
        try {
            handle = await this.open(path, SFTP_OPEN_READ)
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            transfer.close()
        } catch (error) {
            transfer.cancel()
            throw error
        } finally {
            await handle?.close().catch(() => null)
        }
    }

    async close (): Promise<void> {
        if (this.isClosed) {
            return
        }
        this.isClosed = true
        try {
            await invoke<SessionSnapshot>('ssh_sftp_close', {
                sessionId: this.sessionId,
                reason: 'client-close',
            })
        } finally {
            this.closed.next()
            this.closed.complete()
        }
    }
}

export class TauriSshConnection implements SSHConnectionLike {
    open = false
    refCount = 0
    forwardedPorts: ForwardedPortConfig[] = []
    activePrivateKey: null = null
    authUsername: string | null = null
    private request: SshConnectRequest | null = null
    private sftpSessions = new Set<TauriSftpSession>()
    private activeTransportSessionId: string | null = null
    private portForwardIds = new Map<string, string>()

    private serviceMessage = new Subject<string>()
    private keyboardInteractivePrompt = new Subject<KeyboardInteractivePrompt>()
    private willDestroy = new Subject<void>()
    readonly serviceMessage$ = this.serviceMessage.asObservable()
    readonly keyboardInteractivePrompt$ = this.keyboardInteractivePrompt.asObservable()
    readonly willDestroy$ = this.willDestroy.asObservable()

    constructor (private injector: Injector, readonly profile: SSHProfile) {
        this.authUsername = profile.options.user ?? null
    }

    async start (): Promise<void> {
        this.open = true
        this.serviceMessage.next(`Using Tauri SSH backend for ${this.profile.options.user}@${this.profile.options.host}`)
    }

    async getConnectRequest (): Promise<SshConnectRequest> {
        if (!this.request) {
            this.request = await this.createConnectRequest()
        }
        return this.request
    }

    async openSFTP (): Promise<TauriSftpSession> {
        const request = await this.getConnectRequest()
        const response = await withSshTimeout(
            invoke<SftpConnectResponse>('ssh_sftp_connect_transport', { request }),
            'open sftp',
            SSH_CONNECT_TIMEOUT_MS,
        )
        const session = new TauriSftpSession(response.session.session_id, this.injector.get(NgZone))
        this.sftpSessions.add(session)
        session.closed$.subscribe(() => this.sftpSessions.delete(session))
        return session
    }

    emitServiceMessage (message: string): void {
        this.serviceMessage.next(message)
    }

    async handleKeyboardInteractivePrompt (event: SshKeyboardInteractivePromptEvent): Promise<void> {
        const prompt = new KeyboardInteractivePrompt(event.name, event.instruction, event.prompts)
        const savedPassword = await this.loadSavedPassword().catch(() => null)
        if (savedPassword) {
            prompt.prompts.forEach((_, index) => {
                if (prompt.isAPasswordPrompt(index)) {
                    prompt.responses[index] = savedPassword
                }
            })
        }
        this.keyboardInteractivePrompt.next(prompt)
        try {
            const responses = await prompt.promise
            await invoke<void>('ssh_keyboard_interactive_respond', {
                request: {
                    request_id: event.request_id,
                    responses,
                } satisfies SshKeyboardInteractiveResponseRequest,
            })
        } catch {
            await invoke<void>('ssh_keyboard_interactive_respond', {
                request: {
                    request_id: event.request_id,
                    cancelled: true,
                } satisfies SshKeyboardInteractiveResponseRequest,
            })
        }
    }

    setActiveTransportSessionId (sessionId: string): void {
        this.activeTransportSessionId = sessionId
    }

    startConfiguredPortForwards (): void {
        for (const fw of this.profile.options.forwardedPorts ?? []) {
            void this.addPortForward(fw).catch(error => {
                this.serviceMessage.next(`Could not start SSH port forward ${fw.host}:${fw.port}: ${sanitizeSshError(error)}`)
            })
        }
    }

    async addPortForward (fw: ForwardedPortConfig): Promise<void> {
        if (!this.activeTransportSessionId) {
            throw new Error('Cannot start Tauri SSH port forwarding before SSH transport is connected')
        }
        const key = this.portForwardKey(fw)
        if (this.portForwardIds.has(key)) {
            return
        }
        const forwardType = fw.type
        let forwardId: string
        if (forwardType === PortForwardType.Dynamic) {
            const response = await invoke<SshDynamicPortForwardResponse>('ssh_start_dynamic_port_forward', {
                request: {
                    session_id: this.activeTransportSessionId,
                    bind_host: fw.host,
                    bind_port: fw.port,
                } satisfies SshDynamicPortForwardRequest,
            })
            forwardId = response.forward_id
            this.serviceMessage.next(`Started SOCKS proxy on ${response.bind_host}:${response.bind_port}`)
        } else if (forwardType === PortForwardType.Local) {
            const response = await invoke<SshLocalPortForwardResponse>('ssh_start_local_port_forward', {
                request: {
                    session_id: this.activeTransportSessionId,
                    bind_host: fw.host,
                    bind_port: fw.port,
                    target_host: fw.targetAddress,
                    target_port: fw.targetPort,
                } satisfies SshLocalPortForwardRequest,
            })
            forwardId = response.forward_id
            this.serviceMessage.next(`Forwarded local port ${response.bind_host}:${response.bind_port} to ${response.target_host}:${response.target_port}`)
        } else if (forwardType === PortForwardType.Remote) {
            const response = await invoke<SshRemotePortForwardResponse>('ssh_start_remote_port_forward', {
                request: {
                    session_id: this.activeTransportSessionId,
                    bind_host: fw.host,
                    bind_port: fw.port,
                    target_host: fw.targetAddress,
                    target_port: fw.targetPort,
                } satisfies SshRemotePortForwardRequest,
            })
            forwardId = response.forward_id
            this.serviceMessage.next(`Forwarded remote port ${response.bind_host}:${response.bind_port} to ${response.target_host}:${response.target_port}`)
        } else {
            throw new Error(`Unsupported Tauri SSH profile features: port forwarding type ${forwardType}`)
        }
        this.portForwardIds.set(key, forwardId)
        if (!this.forwardedPorts.some(existing => this.portForwardKey(existing) === key)) {
            this.forwardedPorts.push(fw)
        }
    }

    async removePortForward (fw: ForwardedPortConfig): Promise<void> {
        const key = this.portForwardKey(fw)
        const forwardId = this.portForwardIds.get(key)
        if (forwardId) {
            await invoke<void>('ssh_stop_port_forward', { forwardId })
        }
        this.portForwardIds.delete(key)
        this.forwardedPorts = this.forwardedPorts.filter(existing => this.portForwardKey(existing) !== key)
    }

    async openTCPForwardChannelTo (_host: string, _port: number): Promise<unknown> {
        throw new Error('Unsupported Tauri SSH profile features: jump host')
    }

    setJumpChannel (_channel: unknown): void {
        throw new Error('Unsupported Tauri SSH profile features: jump host')
    }

    ref (): void { this.refCount++ }
    unref (): void { this.refCount--; if (this.refCount <= 0) { void this.destroy() } }
    async destroy (): Promise<void> {
        if (this.open) {
            this.open = false
            this.willDestroy.next()
        }
        await Promise.all([...this.portForwardIds.values()].map(forwardId => invoke<void>('ssh_stop_port_forward', { forwardId }).catch(() => null)))
        this.portForwardIds.clear()
        this.forwardedPorts = []
        this.activeTransportSessionId = null
        await Promise.all([...this.sftpSessions].map(session => session.close().catch(() => null)))
        this.sftpSessions.clear()
        this.request = null
        this.serviceMessage.complete()
        this.keyboardInteractivePrompt.complete()
        this.willDestroy.complete()
    }

    private portForwardKey (fw: ForwardedPortConfig): string {
        return [fw.type, fw.host, fw.port, fw.targetAddress, fw.targetPort].join('|')
    }

    private async createConnectRequest (): Promise<SshConnectRequest> {
        const unsupportedFeatures = unsupportedSshFeatures(this.profile)
        if (unsupportedFeatures.length > 0) {
            throw new Error(`Unsupported Tauri SSH profile features: ${unsupportedFeatures.join(', ')}`)
        }

        const options = this.profile.options
        const port = options.port ?? 22
        const term = resolveSshTerm(options.term)
        const hostKeyFingerprint = await this.resolveHostKeyFingerprint(options.host, port)
        const oneKeyEntry = this.isOneKeyMode() ? this.resolveOneKeyEntry() : null
        const username = oneKeyEntry?.username || options.user
        if (!username) {
            throw new Error('SSH username was not provided')
        }
        this.authUsername = username
        const privateKeys: SshPrivateKeyCandidate[] = oneKeyEntry
            ? await this.resolveOneKeyPrivateKeyCandidates(oneKeyEntry)
            : (options.privateKeys ?? []).map(private_key_path => ({ private_key_path }))
        const privateKeyPath = privateKeys[0]?.private_key_path
        if (options.auth === 'keyboardInteractive') {
            return {
                host: options.host,
                port,
                username,
                auth: { type: 'keyboard-interactive', prompt_provider: 'renderer' },
                host_key_fingerprint: hostKeyFingerprint,
                term,
                unsupported_features: [],
            }
        }
        if (options.auth === 'publicKey' || (options.auth !== 'password' && privateKeyPath)) {
            if (!privateKeyPath) {
                throw new Error('Unsupported Tauri SSH profile features: public key auth without a private key path')
            }
            return {
                host: options.host,
                port,
                username,
                auth: privateKeys.length > 1
                    ? {
                        type: 'private-keys',
                        private_keys: privateKeys,
                    }
                    : { type: 'private-key', private_key_path: privateKeyPath, passphrase: privateKeys[0]?.passphrase },
                host_key_fingerprint: hostKeyFingerprint,
                term,
                unsupported_features: [],
            }
        }

        if (options.auth === 'password' || !options.auth || options.password) {
            if (oneKeyEntry) {
                const password = await this.resolveOneKeyPassword(oneKeyEntry)
                if (password == null) {
                    throw new Error('SSH password was not provided')
                }
                return {
                    host: options.host,
                    port,
                    username,
                    auth: { type: 'password', password },
                    host_key_fingerprint: hostKeyFingerprint,
                    term,
                    unsupported_features: [],
                }
            }
            const password = options.password ?? await this.loadSavedPassword() ?? await this.promptPassword()
            if (password == null) {
                throw new Error('SSH password was not provided')
            }
            return {
                host: options.host,
                port,
                username,
                auth: { type: 'password', password },
                host_key_fingerprint: hostKeyFingerprint,
                term,
                unsupported_features: [],
            }
        }

        throw new Error('Unsupported Tauri SSH profile features: prompted SSH auth')
    }

    private async loadSavedPassword (): Promise<string | null> {
        try {
            if (this.isOneKeyMode()) {
                const entry = this.resolveOneKeyEntry()
                return await this.resolveOneKeyPassword(entry)
            }
            return await withSshTimeout(
                this.injector.get(PasswordStorageService).loadPassword(this.profile),
                'saved password lookup',
                SSH_PASSWORD_STORAGE_TIMEOUT_MS,
            )
        } catch (error) {
            const message = sanitizeSshError(error)
            if (message.includes('saved password lookup timed out')) {
                this.serviceMessage.next('Saved SSH password lookup timed out; prompting for password')
            } else {
                this.serviceMessage.next(`Could not load saved SSH password; prompting for password: ${message}`)
            }
            return null
        }
    }

    private async promptPassword (): Promise<string | null> {
        this.serviceMessage.next(`Waiting for SSH password prompt for ${this.profile.options.user}@${this.profile.options.host}`)
        const modal = this.injector.get(NgbModal).open(PromptModalComponent)
        modal.componentInstance.prompt = `Password for ${this.profile.options.user}@${this.profile.options.host}`
        modal.componentInstance.password = true
        modal.componentInstance.showRememberCheckbox = true
        const result = await modal.result.catch(() => null)
        if (typeof result?.value !== 'string') {
            return null
        }
        if (result.remember) {
            try {
                await withSshTimeout(
                    this.injector.get(PasswordStorageService).savePassword(this.profile, result.value),
                    'saved password persistence',
                    SSH_PASSWORD_STORAGE_TIMEOUT_MS,
                )
            } catch (error) {
                this.serviceMessage.next(`Could not save SSH password; continuing without persistence: ${sanitizeSshError(error)}`)
            }
        }
        return result.value
    }

    private isOneKeyMode (): boolean {
        return this.profile.options.credentialMode === 'oneKey' || !!this.profile.options.oneKeyId
    }

    private resolveOneKeyEntry (): OneKeyEntry {
        const id = this.profile.options.oneKeyId
        if (!id) {
            throw new Error('SSH profile is configured for OneKey but no OneKey credential is selected')
        }
        const entry = this.injector.get(OneKeyService).getEntry(id)
        if (!entry) {
            throw new Error(`OneKey credential not found: ${id}`)
        }
        return entry
    }

    private async resolveOneKeyPassword (entry: OneKeyEntry): Promise<string|null> {
        if (!entry.hasPassword) {
            return null
        }
        return withSshTimeout(
            this.injector.get(OneKeyService).loadPassword(entry.id),
            'OneKey password lookup',
            SSH_PASSWORD_STORAGE_TIMEOUT_MS,
        )
    }

    private async resolveOneKeyPrivateKeyCandidates (entry: OneKeyEntry): Promise<SshPrivateKeyCandidate[]> {
        const oneKey = this.injector.get(OneKeyService)
        const candidates: SshPrivateKeyCandidate[] = []
        for (const key of entry.privateKeys) {
            const passphrase = key.hasPassphrase
                ? await withSshTimeout(
                    oneKey.loadPrivateKeyPassphrase(entry.id, key.id),
                    'OneKey private key passphrase lookup',
                    SSH_PASSWORD_STORAGE_TIMEOUT_MS,
                )
                : null
            if (key.hasPassphrase && !passphrase) {
                throw new Error(`OneKey private key passphrase was not found for ${key.path}`)
            }
            candidates.push({
                private_key_path: key.path,
                passphrase,
            })
        }
        return candidates
    }

    private async resolveHostKeyFingerprint (host: string, port: number): Promise<string> {
        return new TauriSshTrustService(this.injector).resolveHostKeyFingerprint(host, port)
    }
}

class TauriLocalSshSftpConnection implements SSHConnectionLike {
    readonly profile: SSHProfile
    open = true
    refCount = 0
    forwardedPorts: ForwardedPortConfig[] = []
    activePrivateKey: null = null
    authUsername: string | null
    readonly serviceMessage$ = new Subject<string>().asObservable()
    readonly keyboardInteractivePrompt$ = new Subject<KeyboardInteractivePrompt>().asObservable()
    readonly willDestroy$ = new Subject<void>().asObservable()

    private sftpSessions = new Set<TauriSftpSession>()

    constructor (
        private injector: Injector,
        private target: LocalSshProcessTarget,
    ) {
        this.authUsername = this.target.username
        this.profile = {
            type: 'ssh',
            name: `${this.target.username ? `${this.target.username}@` : ''}${this.target.host}`,
            options: {
                host: this.target.host,
                port: this.target.port,
                user: this.target.username ?? '',
                auth: this.target.privateKeyPath ? 'publicKey' : 'password',
                privateKeys: this.target.privateKeyPath ? [this.target.privateKeyPath] : [],
            },
        } as SSHProfile
    }

    async start (): Promise<void> { this.open = true }
    ref (): void { this.refCount++ }
    unref (): void { this.refCount = Math.max(0, this.refCount - 1) }
    setJumpChannel (): void { throw new Error('Jump channels are unsupported for local ssh SFTP sessions') }
    openTCPForwardChannelTo (): Promise<unknown> { return Promise.reject(new Error('Local ssh SFTP sessions do not support TCP forwarding')) }
    addPortForward (): Promise<void> { return Promise.reject(new Error('Local ssh SFTP sessions do not support port forwarding')) }
    removePortForward (): Promise<void> { return Promise.reject(new Error('Local ssh SFTP sessions do not support port forwarding')) }
    emitServiceMessage (): void { }

    async destroy (): Promise<void> {
        this.open = false
        await Promise.all([...this.sftpSessions].map(session => session.close().catch(() => null)))
        this.sftpSessions.clear()
    }

    async openSFTP (): Promise<TauriSftpSession> {
        const request = await this.createConnectRequest()
        const response = await withSshTimeout(
            invoke<SftpConnectResponse>('ssh_sftp_connect_transport', { request }),
            'open local ssh sftp',
            SSH_CONNECT_TIMEOUT_MS,
        )
        const session = new TauriSftpSession(response.session.session_id, this.injector.get(NgZone))
        this.sftpSessions.add(session)
        session.closed$.subscribe(() => this.sftpSessions.delete(session))
        return session
    }

    private async createConnectRequest (): Promise<SshConnectRequest> {
        const username = this.target.username ?? this.defaultUsername()
        if (!username) {
            throw new Error(`Could not infer SSH username for ${this.target.host}; use user@host or -l user`)
        }
        this.authUsername = username
        const hostKeyFingerprint = await new TauriSshTrustService(this.injector).resolveHostKeyFingerprint(this.target.host, this.target.port)
        if (this.target.privateKeyPath) {
            return {
                host: this.target.host,
                port: this.target.port,
                username,
                auth: { type: 'private-key', private_key_path: this.target.privateKeyPath },
                host_key_fingerprint: hostKeyFingerprint,
                unsupported_features: [],
            }
        }
        return {
            host: this.target.host,
            port: this.target.port,
            username,
            auth: { type: 'password', password: await this.promptPassword(username) },
            host_key_fingerprint: hostKeyFingerprint,
            unsupported_features: [],
        }
    }

    private defaultUsername (): string | null {
        const data = this.injector.get(BOOTSTRAP_DATA) as TauriHostBootstrapData
        return data.environment?.USERNAME ?? data.environment?.USER ?? null
    }

    private async promptPassword (username: string): Promise<string> {
        const modal = this.injector.get(NgbModal).open(PromptModalComponent)
        modal.componentInstance.prompt = `Password for ${username}@${this.target.host}`
        modal.componentInstance.password = true
        modal.componentInstance.showRememberCheckbox = false
        const result = await modal.result.catch(() => null)
        if (typeof result?.value !== 'string') {
            throw new Error('SSH password was not provided')
        }
        return result.value
    }
}

@Component({
    selector: 'tauri-local-ssh-sftp-toolbar',
    template: `
        <sftp-panel
            class="bg-dark"
            [(path)]="sftpPath"
            *ngIf="sftpPanelVisible && sftpConnection"
            (click)="$event.stopPropagation()"
            [session]="sftpConnection"
            [cwdDetectionAvailable]="false"
            (closed)="sftpPanelVisible = false"
        ></sftp-panel>
    `,
})
class TauriLocalSshSftpToolbarComponent implements OnDestroy {
    private refreshTimer: number | null = null
    private _terminal: BaseTerminalTabComponent<any> | null = null
    private inputTarget: LocalSshProcessTarget | null = null
    private processTarget: LocalSshProcessTarget | null = null
    target: LocalSshProcessTarget | null = null
    sftpConnection: TauriLocalSshSftpConnection | null = null
    sftpPanelVisible = false
    sftpPath = '/'

    constructor (private injector: Injector) {}

    @Input()
    set terminal (terminal: BaseTerminalTabComponent<any>) {
        this._terminal = terminal
        this.refreshTarget()
        this.refreshTimer = window.setInterval(() => this.refreshTarget(), 2000)
    }

    get terminal (): BaseTerminalTabComponent<any> {
        return this._terminal!
    }

    ngOnDestroy (): void {
        if (this.refreshTimer !== null) {
            window.clearInterval(this.refreshTimer)
        }
        void this.sftpConnection?.destroy()
    }

    setInputTarget (target: LocalSshProcessTarget): void {
        this.inputTarget = target
        this.target = this.processTarget ?? this.inputTarget
    }

    async openSFTP (event?: MouseEvent): Promise<void> {
        event?.preventDefault()
        event?.stopPropagation()
        await this.refreshTarget()
        if (!this.target) {
            return
        }
        this.sftpConnection = new TauriLocalSshSftpConnection(this.injector, this.target)
        this.sftpPath = '/'
        this.sftpPanelVisible = true
    }

    private async refreshTarget (): Promise<void> {
        const session = this.terminal.session as (BaseSession & { getChildProcesses?: () => Promise<ChildProcess[]> }) | null
        const children = await session?.getChildProcesses?.() ?? []
        this.processTarget = children
            .map(child => parseLocalSshProcessCommand(child.command))
            .find((target): target is LocalSshProcessTarget => Boolean(target)) ?? null
        this.target = this.processTarget ?? this.inputTarget
    }
}

const TAURI_LOCAL_SSH_SFTP_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512">
  <path fill="currentColor" d="M64 96c0-17.7 14.3-32 32-32h160c10.1 0 19.6 4.7 25.6 12.8L320 128h160c17.7 0 32 14.3 32 32v32H64V96zm0 144h448c35.3 0 64 28.7 64 64v80c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64v-80c0-35.3 28.7-64 64-64z"/>
</svg>`

@Injectable()
class TauriLocalSshSftpToolbarService {
    private componentRefs = new Map<BaseTerminalTabComponent<any>, ComponentRef<TauriLocalSshSftpToolbarComponent>>()
    private inputSubscriptions = new Map<BaseTerminalTabComponent<any>, Subscription>()
    private retryTimers = new Map<BaseTerminalTabComponent<any>, number>()
    private targetKeys = new Map<BaseTerminalTabComponent<any>, string>()
    private diagnostics = {
        attachedTabs: 0,
        inputMatches: 0,
        lastTarget: null as string | null,
    }

    constructor (
        private app: AppService,
        private appRef: ApplicationRef,
        private componentFactoryResolver: ComponentFactoryResolver,
        private injector: Injector,
    ) {
        window.__TABBY_TAURI_LOCAL_SSH_DIAGNOSTICS__ = this.diagnostics
        this.app.ready$.subscribe(() => this.scheduleScan())
        this.app.tabOpened$.subscribe(() => this.scheduleScan())
        this.app.tabsChanged$.subscribe(() => this.scheduleScan())
        this.app.activeTabChange$.subscribe(() => this.scheduleScan())
        this.scheduleScan()
        this.scheduleScan(250)
        this.scheduleScan(1000)
        this.scheduleScan(3000)
        window.setInterval(() => this.scanTabs(), 1000)
    }

    private scheduleScan (delay = 0): void {
        window.setTimeout(() => this.scanTabs(), delay)
    }

    private scanTabs (): void {
        const tabs = new Set<BaseTabComponent>()
        for (const tab of this.app.tabs) {
            tabs.add(tab)
        }
        if (this.app.activeTab) {
            tabs.add(this.app.activeTab)
        }
        for (const tab of tabs) {
            for (const child of this.flattenTabs(tab)) {
                this.attachIfLocalTerminal(child)
            }
        }
        this.diagnostics.attachedTabs = this.componentRefs.size
    }

    private flattenTabs (tab: BaseTabComponent): BaseTabComponent[] {
        const children = (tab as any).getAllTabs?.()
        return Array.isArray(children) ? children : [tab]
    }

    private attachIfLocalTerminal (tab: BaseTabComponent): void {
        const terminal = tab as BaseTerminalTabComponent<any>
        const profileType = (terminal as any).profile?.type
        if ((profileType && profileType !== 'local') || typeof (terminal as any).input$?.subscribe !== 'function') {
            return
        }
        this.attach(terminal)
        this.syncAnnotatedTarget(terminal)
    }

    private attach (terminal: BaseTerminalTabComponent<any>): void {
        if (this.componentRefs.has(terminal)) {
            return
        }
        const host = (terminal.hostView as any).rootNodes?.find((node: unknown) => node instanceof HTMLElement) as HTMLElement | undefined
        if (!host) {
            if (!this.retryTimers.has(terminal)) {
                const timer = window.setTimeout(() => {
                    this.retryTimers.delete(terminal)
                    this.attach(terminal)
                }, 250)
                this.retryTimers.set(terminal, timer)
            }
            return
        }
        const componentRef = this.componentFactoryResolver
            .resolveComponentFactory(TauriLocalSshSftpToolbarComponent)
            .create(this.injector)
        componentRef.instance.terminal = terminal
        this.appRef.attachView(componentRef.hostView)
        host.appendChild((componentRef.hostView as any).rootNodes[0])
        this.componentRefs.set(terminal, componentRef)
        this.diagnostics.attachedTabs = this.componentRefs.size
        const tracker = new LocalSshCommandTracker()
        this.inputSubscriptions.set(terminal, terminal.input$.subscribe(data => {
            const target = tracker.feed(data)
            if (!target) {
                return
            }
            this.diagnostics.inputMatches += 1
            this.applyTarget(terminal, componentRef, target)
        }))
        terminal.destroyed$.subscribe(() => this.detach(terminal))
    }

    private syncAnnotatedTarget (terminal: BaseTerminalTabComponent<any>): void {
        const target = (terminal as any).__tabbyLocalSshTarget as Partial<LocalSshProcessTarget> | undefined
        const componentRef = this.componentRefs.get(terminal)
        if (!componentRef || !target?.host) {
            return
        }
        this.applyTarget(terminal, componentRef, {
            host: target.host,
            port: target.port ?? 22,
            username: target.username ?? null,
            privateKeyPath: target.privateKeyPath ?? null,
        })
    }

    private applyTarget (
        terminal: BaseTerminalTabComponent<any>,
        componentRef: ComponentRef<TauriLocalSshSftpToolbarComponent>,
        target: LocalSshProcessTarget,
    ): void {
        const targetKey = `${target.username ?? ''}@${target.host}:${target.port}:${target.privateKeyPath ?? ''}`
        const changed = this.targetKeys.get(terminal) !== targetKey
        this.targetKeys.set(terminal, targetKey)
        this.diagnostics.lastTarget = target.host
        componentRef.instance.setInputTarget(target)
        ;(terminal as any).disableDynamicTitle = true
        terminal.setTitle(target.host)
        ;(terminal as any).customTitle = target.host
        componentRef.changeDetectorRef.detectChanges()
        if (changed) {
            this.app.emitTabsChanged()
        }
    }

    hasActiveSftpTarget (): boolean {
        return Boolean(this.getActiveSftpComponent()?.instance.target)
    }

    async openActiveSFTP (): Promise<void> {
        await this.getActiveSftpComponent()?.instance.openSFTP()
    }

    private getActiveSftpComponent (): ComponentRef<TauriLocalSshSftpToolbarComponent> | null {
        const activeTab = this.app.activeTab
        if (!activeTab) {
            return null
        }
        for (const tab of this.flattenTabs(activeTab)) {
            const componentRef = this.componentRefs.get(tab as BaseTerminalTabComponent<any>)
            if (componentRef?.instance.target) {
                return componentRef
            }
        }
        return null
    }

    private detach (terminal: BaseTerminalTabComponent<any>): void {
        const componentRef = this.componentRefs.get(terminal)
        if (!componentRef) {
            return
        }
        this.inputSubscriptions.get(terminal)?.unsubscribe()
        this.inputSubscriptions.delete(terminal)
        const timer = this.retryTimers.get(terminal)
        if (timer) {
            window.clearTimeout(timer)
            this.retryTimers.delete(terminal)
        }
        this.appRef.detachView(componentRef.hostView)
        componentRef.destroy()
        this.componentRefs.delete(terminal)
        this.targetKeys.delete(terminal)
        this.diagnostics.attachedTabs = this.componentRefs.size
    }
}

@Injectable()
class TauriLocalSshSftpToolbarButtonProvider extends ToolbarButtonProvider {
    constructor (private localSshSftpToolbar: TauriLocalSshSftpToolbarService) {
        super()
    }

    provide (): ToolbarButton[] {
        if (!this.localSshSftpToolbar.hasActiveSftpTarget()) {
            return []
        }
        return [{
            icon: TAURI_LOCAL_SSH_SFTP_ICON,
            title: 'SFTP',
            weight: 20,
            click: (): void => {
                void this.localSshSftpToolbar.openActiveSFTP()
            },
        }]
    }
}

export class TauriSshShellSession extends BaseSession implements SSHShellLikeSession {
    get serviceMessage$ (): Observable<string> { return this.serviceMessage.asObservable() }
    private serviceMessage = new Subject<string>()
    private session: SessionSnapshot | null = null
    private releasedConnection = false
    private pendingTerminalInput: Buffer[] = []
    private startupOutputBuffer: Buffer[] = []
    private startupOutputReleased = false
    private pendingOutputBuffers: Buffer[] = []
    private pendingOutputAckBytes = 0
    private pendingOutputFlushTimer: number | null = null
    private pendingOutputSessionId: string | null = null
    private keepaliveTimer: number | null = null
    private keepaliveInFlight = false
    private transportUnavailableReason: string | null = null
    private sizeSync: SshTerminalSizeSync

    constructor (
        injector: Injector,
        private connection: TauriSshConnection,
        initialSize: SshShellSize = { cols: 80, rows: 24 },
    ) {
        super(injector.get(LogService).create(`tauri-ssh-${connection.profile.options.host}-${connection.profile.options.port ?? 22}`))
        this.sizeSync = new SshTerminalSizeSync(
            initialSize,
            async size => {
                if (!this.session) {
                    throw new Error('SSH shell session is unavailable during resize')
                }
                const sessionId = this.session.session_id
                const snapshot = await invoke<SessionSnapshot>('ssh_resize_transport', { sessionId, size })
                if (this.open && this.session?.session_id === sessionId) {
                    this.session = snapshot
                }
            },
            error => this.logger.warn(`SSH resize failed: ${sanitizeSshError(error)}`),
        )
        const profile = this.connection.profile
        this.connection.serviceMessage$.subscribe(message => this.serviceMessage.next(message))
        this.setLoginScriptsOptions(profile.options)
        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (): Promise<void> {
        this.connection.ref()
        this.transportUnavailableReason = null
        this.startupOutputBuffer = []
        this.startupOutputReleased = false
        try {
            if (!this.connection.open) {
                await this.connection.start()
            }
            const options = this.connection.profile.options
            const endpoint = `${options.user}@${options.host}:${options.port ?? 22}`
            this.emitSshStatus(`Preparing SSH authentication for ${endpoint}`)
            const request = await this.connection.getConnectRequest()
            this.emitSshStatus(`Opening SSH transport to ${endpoint}`)
            const connectCommand = request.auth.type === 'keyboard-interactive'
                ? 'ssh_connect_transport_interactive'
                : 'ssh_connect_transport'
            const connectArgs: Record<string, unknown> = { request }
            if (request.auth.type === 'keyboard-interactive') {
                connectArgs.channel = createChannel<SshKeyboardInteractivePromptEvent>(
                    event => void this.connection.handleKeyboardInteractivePrompt(event),
                )
            }
            const connected = await withSshTimeout(
                invoke<{ session: SessionSnapshot }>(connectCommand, connectArgs),
                'connect',
                SSH_CONNECT_TIMEOUT_MS,
            )
            this.connection.setActiveTransportSessionId(connected.session.session_id)
            this.emitSshStatus(`Opening remote shell on ${endpoint}`)
            const openSize = this.sizeSync.current
            this.session = await withSshTimeout(
                invoke<SessionSnapshot>('ssh_open_shell_transport', { sessionId: connected.session.session_id, size: openSize }),
                'open shell',
                SSH_SHELL_OPEN_TIMEOUT_MS,
            )
            await this.sizeSync.markOpened(openSize)
            this.open = true
            const channel = createChannel<SshData>(data => {
                this.applySshMetadata(data)
                const buffer = Buffer.from(data.bytes)
                if (!this.startupOutputReleased) {
                    this.startupOutputBuffer.push(buffer)
                    void invoke<SessionSnapshot>('ssh_ack', { sessionId: data.session_id, length: buffer.length })
                    return
                }
                this.queueOutput(data)
            })
            this.session = await withSshTimeout(
                invoke<SessionSnapshot>('ssh_stream_transport', { sessionId: this.session.session_id, channel }),
                'stream shell output',
                SSH_STREAM_START_TIMEOUT_MS,
            )
            this.startKeepaliveMonitor()
            this.connection.startConfiguredPortForwards()
            window.setTimeout(() => this.releaseStartupOutput(endpoint))
        } catch (error) {
            const message = sanitizeSshError(error)
            this.open = false
            this.session = null
            this.stopKeepaliveMonitor()
            this.startupOutputBuffer = []
            this.startupOutputReleased = true
            this.emitSshStatus(`SSH connection failed: ${message}`)
            this.releaseConnection()
            throw new Error(message)
        }
    }

    resize (columns: number, rows: number): void {
        void this.sizeSync.update(columns, rows)
    }

    resyncSize (): void {
        void this.sizeSync.resync()
    }

    write (data: Buffer): void {
        if (this.transportUnavailableReason) {
            this.emitSshStatus(`SSH connection is not active: ${this.transportUnavailableReason}`)
            return
        }
        if (!this.session) {
            this.pendingTerminalInput.push(Buffer.from(data))
            if (this.pendingTerminalInput.length > 256) {
                this.pendingTerminalInput.shift()
            }
            return
        }
        this.writeTransport(data)
    }

    private flushPendingTerminalInput (): void {
        if (!this.session) {
            return
        }
        const pending = this.pendingTerminalInput.splice(0)
        for (const data of pending) {
            this.writeTransport(data)
        }
    }

    private releaseStartupOutput (endpoint: string): void {
        if (this.startupOutputReleased || !this.session || !this.open) {
            return
        }
        this.startupOutputReleased = true
        this.releaseInitialDataBuffer()
        this.emitSshStatus(`SSH connected to ${endpoint}`)
        const buffered = this.startupOutputBuffer.splice(0)
        if (buffered.length > 0) {
            this.emitOutput(Buffer.concat(buffered))
        }
        this.flushPendingTerminalInput()
        this.loginScriptProcessor?.executeUnconditionalScripts()
        const cwd = this.connection.profile.options.cwd
        if (cwd) {
            this.changeInitialDirectory(cwd)
        }
    }

    private changeInitialDirectory (dir: string): void {
        this.write(Buffer.from(` cd -- '${dir.replace(/'/g, `'\\''`)}'\n`))
    }

    private applySshMetadata (data: SshData): void {
        if (data.currentDir) {
            this.reportedCWD = data.currentDir
        }
    }

    private queueOutput(data: SshData): void {
        const buffer = Buffer.from(data.bytes)
        if (this.pendingOutputSessionId && this.pendingOutputSessionId !== data.session_id) {
            this.flushPendingOutput()
        }
        this.pendingOutputSessionId = data.session_id
        this.pendingOutputBuffers.push(buffer)
        this.pendingOutputAckBytes += buffer.length
        if (this.pendingOutputFlushTimer === null) {
            this.pendingOutputFlushTimer = window.setTimeout(() => this.flushPendingOutput(), SSH_OUTPUT_FLUSH_DELAY_MS)
        }
    }

    private flushPendingOutput (): void {
        if (this.pendingOutputFlushTimer !== null) {
            window.clearTimeout(this.pendingOutputFlushTimer)
            this.pendingOutputFlushTimer = null
        }
        const buffers = this.pendingOutputBuffers.splice(0)
        const ackBytes = this.pendingOutputAckBytes
        const sessionId = this.pendingOutputSessionId
        this.pendingOutputAckBytes = 0
        this.pendingOutputSessionId = null
        if (!sessionId || ackBytes === 0) {
            return
        }
        if (buffers.length > 0 && this.open && this.session?.session_id === sessionId) {
            this.emitOutput(Buffer.concat(buffers, ackBytes))
        }
        void invoke<SessionSnapshot>('ssh_ack', { sessionId, length: ackBytes })
            .then(snapshot => {
                if (this.open && this.session?.session_id === sessionId) {
                    this.session = snapshot
                    if (snapshot.state === 'closed') {
                        this.markTransportUnavailable(snapshot.close_reason ?? 'SSH remote shell exited')
                    }
                }
            })
            .catch(error => this.markTransportUnavailable(`SSH output acknowledgement failed: ${sanitizeSshError(error)}`))
    }

    private writeTransport (data: Buffer): void {
        if (this.session) {
            const sessionId = this.session.session_id
            window.__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__ ??= {}
            window.__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__.writes = (window.__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__.writes ?? 0) + 1
            window.__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__.lastWriteSessionId = sessionId
            window.__TABBY_TAURI_SSH_INPUT_DIAGNOSTICS__.lastWriteBytes = data.length
            void invoke<SessionSnapshot>('ssh_write_transport', { sessionId, bytes: Array.from(data) })
                .then(snapshot => {
                    if (this.open && this.session?.session_id === sessionId) {
                        this.session = snapshot
                    }
                })
                .catch(error => this.markTransportUnavailable(`SSH write failed: ${sanitizeSshError(error)}`))
        }
    }

    private startKeepaliveMonitor (): void {
        if (this.keepaliveTimer !== null) {
            return
        }
        this.keepaliveTimer = window.setInterval(() => {
            void this.probeTransportLiveness()
        }, SSH_KEEPALIVE_INTERVAL_MS)
    }

    private stopKeepaliveMonitor (): void {
        if (this.keepaliveTimer !== null) {
            window.clearInterval(this.keepaliveTimer)
            this.keepaliveTimer = null
        }
        this.keepaliveInFlight = false
    }

    private async probeTransportLiveness (): Promise<void> {
        if (!this.open || !this.session || this.keepaliveInFlight) {
            return
        }
        const sessionId = this.session.session_id
        this.keepaliveInFlight = true
        try {
            const snapshot = await invoke<SessionSnapshot>('ssh_keepalive_transport', { sessionId: this.session.session_id })
            if (!this.open || this.session?.session_id !== sessionId) {
                return
            }
            this.session = snapshot
            if (['closed', 'errored', 'reconnectable'].includes(snapshot.state)) {
                this.markTransportUnavailable(snapshot.error_reason ?? snapshot.close_reason ?? `SSH session state changed to ${snapshot.state}`)
            }
        } catch (error) {
            this.markTransportUnavailable(`SSH keepalive failed: ${sanitizeSshError(error)}`)
        } finally {
            this.keepaliveInFlight = false
        }
    }

    private markTransportUnavailable (reason: string): void {
        if (this.transportUnavailableReason) {
            return
        }
        this.transportUnavailableReason = reason
        this.emitSshStatus(`SSH connection interrupted: ${reason}`)
        this.open = false
        this.session = null
        this.pendingTerminalInput = []
        this.startupOutputBuffer = []
        this.startupOutputReleased = true
        this.clearPendingOutput()
        this.stopKeepaliveMonitor()
        this.releaseConnection()
        this.closed.next()
        this.destroyed.next()
    }

    kill (_signal?: string): void { void this.gracefullyKillProcess() }

    async gracefullyKillProcess (): Promise<void> {
        try {
            this.stopKeepaliveMonitor()
            if (this.session) {
                await invoke<SessionSnapshot>('ssh_close_transport', { sessionId: this.session.session_id, reason: 'client-close' })
            }
        } finally {
            this.open = false
            this.session = null
            this.transportUnavailableReason = null
            this.pendingTerminalInput = []
            this.startupOutputBuffer = []
            this.startupOutputReleased = true
            this.clearPendingOutput()
            this.releaseConnection()
        }
    }

    private clearPendingOutput (): void {
        if (this.pendingOutputFlushTimer !== null) {
            window.clearTimeout(this.pendingOutputFlushTimer)
            this.pendingOutputFlushTimer = null
        }
        this.pendingOutputBuffers = []
        this.pendingOutputAckBytes = 0
        this.pendingOutputSessionId = null
    }

    override async destroy (): Promise<void> {
        this.serviceMessage.complete()
        await this.gracefullyKillProcess()
        await super.destroy()
    }

    supportsWorkingDirectory (): boolean { return !!this.reportedCWD }
    getWorkingDirectory (): Promise<string | null> { return Promise.resolve(this.reportedCWD ?? null) }

    private releaseConnection (): void {
        if (!this.releasedConnection) {
            this.releasedConnection = true
            this.connection.unref()
        }
    }

    private emitSshStatus (message: string): void {
        this.serviceMessage.next(message)
        this.logger.info(message)
    }
}


@Injectable()
export class TauriLogService extends LogService {
    create (name: string): ConsoleLogger {
        return new ConsoleLogger(name)
    }
}

@Injectable()
export class TauriSshSessionFactoryProvider extends SSHSessionFactory {
    create (_injector: Injector, profile: SSHProfile): TauriSshConnection {
        return new TauriSshConnection(_injector, profile)
    }
}

@Injectable()
export class TauriSshShellSessionFactoryProvider extends SSHShellSessionFactory {
    create (injector: Injector, ssh: SSHConnectionLike, _profile: SSHProfile): TauriSshShellSession {
        if (!(ssh instanceof TauriSshConnection)) {
            throw new Error('Tauri SSH shell factory requires a Tauri SSH connection')
        }
        return new TauriSshShellSession(injector, ssh)
    }
}

@Injectable()
export class UnsupportedUpdaterService extends UpdaterService {
    override isAvailable = false
    check (): Promise<boolean> { return Promise.resolve(false) }
    update (): Promise<void> { return unsupportedAsync<void>('auto-update') }
}

@Injectable()
export class UnsupportedUACService extends UACService {
    override isAvailable = false
    patchSessionOptionsForUAC (sessionOptions: SessionOptions): SessionOptions { return sessionOptions }
}

@NgModule({
    imports: [
        CommonModule,
        TranslateModule,
        TabbyTerminalModule,
        TabbySSHModule,
    ],
    declarations: [
        TauriSshHostKeyPromptModalComponent,
        TauriLocalSshSftpToolbarComponent,
    ],
    providers: [
        { provide: PlatformService, useClass: TauriWindowsPlatformService },
        { provide: HostWindowService, useClass: TauriHostWindowService },
        { provide: HostAppService, useClass: TauriHostAppService },
        { provide: LogService, useClass: TauriLogService },
        { provide: ConfigProvider, useClass: TauriConfigProvider, multi: true },
        { provide: PTYInterface, useClass: TauriPTYInterface },
        { provide: SSHSessionFactory, useClass: TauriSshSessionFactoryProvider },
        { provide: SSHShellSessionFactory, useClass: TauriSshShellSessionFactoryProvider },
        { provide: PasswordStorageService, useClass: TauriPasswordStorageService },
        { provide: OneKeySecretStorageProvider, useClass: TauriOneKeySecretStorageProvider },
        { provide: VaultCryptoProvider, useClass: TauriVaultCryptoProvider },
        { provide: ShellProvider, useClass: TauriWindowsShellProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: TauriLocalSshSftpToolbarButtonProvider, multi: true },
        { provide: UpdaterService, useClass: UnsupportedUpdaterService },
        { provide: UACService, useClass: UnsupportedUACService },
        TauriDisplayEffectsService,
        TauriLocalSshSftpToolbarService,
    ],
})
export default class TauriHostModule {
    constructor (_displayEffects: TauriDisplayEffectsService, _localSshSftpToolbar: TauriLocalSshSftpToolbarService) { }
}
