import { Injectable, Injector, NgModule } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    ConfigProvider,
    ConfigService,
    ConsoleLogger,
    DisplayCapabilities,
    DockingService,
    HostAppService,
    HostWindowService,
    LogService,
    MessageBoxOptions,
    MessageBoxResult,
    Platform,
    PlatformService,
    PromptModalComponent,
    UpdaterService,
    WindowEffectName,
} from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { PTYInterface, PTYProxy, Shell, ShellProvider, UACService, SessionOptions, ChildProcess } from 'tabby-local'
import { PasswordStorageService, SSHProfile, SSHSessionFactory, SSHShellSessionFactory, SSHShellLikeSession } from 'tabby-ssh'
import { Observable, Subject } from 'rxjs'

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
        }
        __TAURI_INTERNALS__?: unknown
        __TABBY_TAURI_DISPLAY__?: TauriDisplayAutomationState
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
}

type SshAuthMethod =
    | { type: 'password', password: string }
    | { type: 'private-key', private_key_path: string, passphrase?: string | null }

interface SshConnectRequest {
    host: string
    port: number
    username: string
    auth: SshAuthMethod
    host_key_fingerprint?: string | null
    unsupported_features?: string[]
}

interface SshShellSize {
    cols: number
    rows: number
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

function unsupported (feature: string): never {
    throw new Error(`${feature} is unsupported in the Windows-only Tauri host`)
}

function unsupportedAsync<T> (feature: string): Promise<T> {
    return Promise.reject(new Error(`${feature} is unsupported in the Windows-only Tauri host`))
}

const TAURI_FALLBACK_FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New']

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

function unsupportedSshFeatures (profile: SSHProfile): string[] {
    const options = profile.options
    const unsupportedFeatures: string[] = []
    if (options.auth === 'agent') {
        unsupportedFeatures.push('agent auth')
    }
    if (options.auth === 'keyboardInteractive') {
        unsupportedFeatures.push('keyboard-interactive auth')
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
    if ((options.forwardedPorts ?? []).length > 0) {
        unsupportedFeatures.push('port forwarding')
    }
    if (options.socksProxyHost) {
        unsupportedFeatures.push('SOCKS proxy')
    }
    if (options.httpProxyHost) {
        unsupportedFeatures.push('HTTP proxy')
    }
    if ((options.privateKeys ?? []).length > 1) {
        unsupportedFeatures.push('multiple private keys')
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
        const modal = this.injector.get(NgbModal).open(PromptModalComponent)
        modal.componentInstance.prompt = [
            `SSH host key for ${host}:${port}`,
            `SHA256 fingerprint: ${sha256}`,
            'Accept once / Trust and connect / Cancel',
            'Type once to accept for this connection only, or trust to persist this host key in the Tauri known-host store.',
        ].join('\n')
        modal.componentInstance.value = ''
        const result = await modal.result.catch(() => null)
        const value = result?.value?.trim().toLowerCase()
        if (value === 'once') {
            return 'accept-once'
        }
        if (value === 'trust') {
            return 'trust-and-connect'
        }
        throw new Error(`SSH host key was not trusted for ${host}:${port}`)
    }
}

@Injectable()
export class TauriWindowsPlatformService extends PlatformService {
    override supportsWindowControls = false
    override displayCapabilities = createTauriDisplayCapabilities()

    readClipboard (): string { return '' }
    setClipboard (content: { text: string }): void { void navigator.clipboard?.writeText(content.text) }
    loadConfig (): Promise<string> { return invoke<string>('load_config').catch(() => '{}') }
    saveConfig (content: string): Promise<void> { return invoke<void>('save_config', { content }) }
    startDownload (): Promise<null> { return Promise.resolve(null) }
    startDownloadDirectory (): Promise<null> { return Promise.resolve(null) }
    startUpload (): Promise<[]> { return Promise.resolve([]) }
    startUploadDirectory (): Promise<any> { return Promise.resolve({ getName: () => '', getChildrens: () => [] }) }
    getOSRelease (): string { return navigator.userAgent }
    getAppVersion (): string { return 'tauri-tabby' }
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
    popupContextMenu (): void { unsupported('native context menu') }
    showMessageBox (_options: MessageBoxOptions): Promise<MessageBoxResult> { return Promise.resolve({ response: 0 }) }
    pickDirectory (): Promise<string | null> { return Promise.resolve(null) }
    quit (): void { void invoke<void>('quit') }
    getWinSCPPath (): string | null { return null }
    async exec (_app: string, _argv: string[]): Promise<void> { unsupported('platform exec') }
}

@Injectable()
export class TauriHostWindowService extends HostWindowService {
    private _isFullscreen = false
    private _isMaximized = false
    private _isFocused = true

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

    close (): void { void tauriWindow()?.close?.().catch(() => null) }
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
    get platform (): Platform { return Platform.Windows }
    get configPlatform (): Platform { return Platform.Windows }

    constructor (injector: Injector) { super(injector) }

    newWindow (): void { unsupported('new window') }
    override emitReady (): void { /* Tauri host does not need Electron-style app:ready IPC */ }
    relaunch (): void { void invoke<void>('relaunch') }
    quit (): void { void invoke<void>('quit') }
    getWinSCPPath (): string | null { return null }
    async exec (_app: string, _argv: string[]): Promise<void> { unsupported('platform exec') }
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
        const systemRoot = 'C:\\Windows'
        return [
            { id: 'powershell', name: 'Windows PowerShell', command: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, env: {} },
            { id: 'pwsh', name: 'PowerShell', command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', env: {} },
            { id: 'cmd', name: 'Command Prompt', command: `${systemRoot}\\System32\\cmd.exe`, env: {} },
        ]
    }
}

export class TauriPTYProxy extends PTYProxy {
    private unsubscribers: Array<() => void> = []

    constructor (private response: PtySpawnResponse) { super() }

    getID (): string { return this.response.session.session_id }
    async getPID (): Promise<number> { return this.response.pid ?? 0 }
    resize (columns: number, rows: number): Promise<void> { return invoke<void>('pty_resize', { sessionId: this.getID(), size: { cols: columns, rows } }) }
    write (data: Buffer): Promise<void> { return invoke<SessionSnapshot>('pty_write', { sessionId: this.getID(), bytes: Array.from(data) }).then(() => undefined) }
    kill (signal?: string): Promise<void> { return invoke<SessionSnapshot>('pty_kill', { sessionId: this.getID(), signal }).then(() => undefined) }
    ackData (length: number): void { void invoke<SessionSnapshot>('pty_ack', { sessionId: this.getID(), length }) }
    subscribe (event: string, handler: (..._: any[]) => void): void {
        if (event === 'data') {
            const channel = createChannel<PtyData>(data => handler(Buffer.from(data.bytes)))
            void invoke<void>('pty_stream', { sessionId: this.getID(), channel })
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
    unsubscribeAll (): void { this.unsubscribers.splice(0).forEach(x => x()) }
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

export class TauriSshConnection {
    open = false
    refCount = 0
    private request: SshConnectRequest | null = null

    private serviceMessage = new Subject<string>()
    private keyboardInteractivePrompt = new Subject<never>()
    private willDestroy = new Subject<void>()
    readonly serviceMessage$ = this.serviceMessage.asObservable()
    readonly keyboardInteractivePrompt$ = this.keyboardInteractivePrompt.asObservable()
    readonly willDestroy$ = this.willDestroy.asObservable()

    constructor (private injector: Injector, readonly profile: SSHProfile) { }

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

    ref (): void { this.refCount++ }
    unref (): void { this.refCount--; if (this.refCount <= 0) { void this.destroy() } }
    async destroy (): Promise<void> {
        if (this.open) {
            this.open = false
            this.willDestroy.next()
        }
        this.request = null
        this.serviceMessage.complete()
        this.keyboardInteractivePrompt.complete()
        this.willDestroy.complete()
    }

    private async createConnectRequest (): Promise<SshConnectRequest> {
        const unsupportedFeatures = unsupportedSshFeatures(this.profile)
        if (unsupportedFeatures.length > 0) {
            throw new Error(`Unsupported Tauri SSH profile features: ${unsupportedFeatures.join(', ')}`)
        }

        const options = this.profile.options
        const privateKeyPath = options.privateKeys?.[0]
        if (options.auth === 'publicKey' || privateKeyPath) {
            if (!privateKeyPath) {
                throw new Error('Unsupported Tauri SSH profile features: public key auth without a private key path')
            }
            return {
                host: options.host,
                port: options.port ?? 22,
                username: options.user,
                auth: { type: 'private-key', private_key_path: privateKeyPath },
                host_key_fingerprint: await this.resolveHostKeyFingerprint(options.host, options.port ?? 22),
                unsupported_features: [],
            }
        }

        if (options.auth === 'password' || !options.auth || options.password) {
            const password = options.password ?? await this.loadSavedPassword() ?? await this.promptPassword()
            if (!password) {
                throw new Error('SSH password was not provided')
            }
            return {
                host: options.host,
                port: options.port ?? 22,
                username: options.user,
                auth: { type: 'password', password },
                host_key_fingerprint: await this.resolveHostKeyFingerprint(options.host, options.port ?? 22),
                unsupported_features: [],
            }
        }

        throw new Error('Unsupported Tauri SSH profile features: prompted SSH auth')
    }

    private async loadSavedPassword (): Promise<string | null> {
        try {
            return await this.injector.get(PasswordStorageService).loadPassword(this.profile)
        } catch (error) {
            this.serviceMessage.next(`Could not load saved SSH password: ${error}`)
            return null
        }
    }

    private async promptPassword (): Promise<string | null> {
        const modal = this.injector.get(NgbModal).open(PromptModalComponent)
        modal.componentInstance.prompt = `Password for ${this.profile.options.user}@${this.profile.options.host}`
        modal.componentInstance.password = true
        modal.componentInstance.showRememberCheckbox = true
        const result = await modal.result.catch(() => null)
        if (!result?.value) {
            return null
        }
        if (result.remember) {
            try {
                await this.injector.get(PasswordStorageService).savePassword(this.profile, result.value)
            } catch (error) {
                this.serviceMessage.next(`Could not save SSH password: ${error}`)
            }
        }
        return result.value
    }

    private async resolveHostKeyFingerprint (host: string, port: number): Promise<string> {
        return new TauriSshTrustService(this.injector).resolveHostKeyFingerprint(host, port)
    }
}

export class TauriSshShellSession extends BaseSession implements SSHShellLikeSession {
    get serviceMessage$ (): Observable<string> { return this.serviceMessage.asObservable() }
    private serviceMessage = new Subject<string>()
    private session: SessionSnapshot | null = null
    private releasedConnection = false

    constructor (
        injector: Injector,
        private connection: TauriSshConnection,
        private size: SshShellSize = { cols: 80, rows: 24 },
    ) {
        super(injector.get(LogService).create(`tauri-ssh-${connection.profile.options.host}-${connection.profile.options.port ?? 22}`))
        this.connection.serviceMessage$.subscribe(message => this.serviceMessage.next(message))
        this.setLoginScriptsOptions(this.connection.profile.options)
    }

    async start (): Promise<void> {
        this.connection.ref()
        try {
            if (!this.connection.open) {
                await this.connection.start()
            }
            const connected = await invoke<{ session: SessionSnapshot }>('ssh_connect_transport', { request: await this.connection.getConnectRequest() })
            this.session = await invoke<SessionSnapshot>('ssh_open_shell_transport', { sessionId: connected.session.session_id, size: this.size })
            const channel = createChannel<SshData>(data => {
                const buffer = Buffer.from(data.bytes)
                this.emitOutput(buffer)
                void invoke<SessionSnapshot>('ssh_ack', { sessionId: data.session_id, length: buffer.length })
            })
            this.session = await invoke<SessionSnapshot>('ssh_stream_transport', { sessionId: this.session.session_id, channel })
            this.open = true
            this.loginScriptProcessor?.executeUnconditionalScripts()
        } catch (error) {
            this.releaseConnection()
            throw error
        }
    }

    resize (columns: number, rows: number): void {
        this.size = { cols: columns, rows }
        if (this.session) {
            void invoke<SessionSnapshot>('ssh_resize_transport', { sessionId: this.session.session_id, size: this.size })
        }
    }

    write (data: Buffer): void {
        if (this.session) {
            void invoke<SessionSnapshot>('ssh_write_transport', { sessionId: this.session.session_id, bytes: Array.from(data) })
        }
    }

    kill (_signal?: string): void { void this.gracefullyKillProcess() }

    async gracefullyKillProcess (): Promise<void> {
        try {
            if (this.session) {
                await invoke<SessionSnapshot>('ssh_close_transport', { sessionId: this.session.session_id, reason: 'client-close' })
            }
        } finally {
            this.open = false
            this.session = null
            this.releaseConnection()
        }
    }

    override async destroy (): Promise<void> {
        this.serviceMessage.complete()
        await this.gracefullyKillProcess()
        await super.destroy()
    }

    supportsWorkingDirectory (): boolean { return false }
    getWorkingDirectory (): Promise<string | null> { return Promise.resolve(null) }

    private releaseConnection (): void {
        if (!this.releasedConnection) {
            this.releasedConnection = true
            this.connection.unref()
        }
    }
}


@Injectable()
export class TauriLogService extends LogService {
    create (name: string): ConsoleLogger {
        return new ConsoleLogger(name)
    }
}

@Injectable()
export class TauriSshSessionFactoryProvider {
    create (_injector: Injector, profile: SSHProfile): TauriSshConnection {
        return new TauriSshConnection(_injector, profile)
    }
}

@Injectable()
export class TauriSshShellSessionFactoryProvider {
    create (injector: Injector, ssh: TauriSshConnection, _profile: SSHProfile): TauriSshShellSession {
        return new TauriSshShellSession(injector, ssh)
    }
}

@Injectable()
export class UnsupportedUpdaterService extends UpdaterService {
    check (): Promise<boolean> { return unsupportedAsync<boolean>('auto-update') }
    update (): Promise<void> { return unsupportedAsync<void>('auto-update') }
}

@Injectable()
export class UnsupportedDockingService extends DockingService {
    dock (): void { /* unsupported no-op */ }
    getScreens (): [] { return [] }
}

@Injectable()
export class UnsupportedUACService extends UACService {
    override isAvailable = false
    patchSessionOptionsForUAC (sessionOptions: SessionOptions): SessionOptions { return sessionOptions }
}

@NgModule({
    providers: [
        { provide: PlatformService, useClass: TauriWindowsPlatformService },
        { provide: HostWindowService, useClass: TauriHostWindowService },
        { provide: HostAppService, useClass: TauriHostAppService },
        { provide: LogService, useClass: TauriLogService },
        { provide: ConfigProvider, useClass: TauriConfigProvider, multi: true },
        { provide: PTYInterface, useClass: TauriPTYInterface },
        { provide: SSHSessionFactory, useClass: TauriSshSessionFactoryProvider },
        { provide: SSHShellSessionFactory, useClass: TauriSshShellSessionFactoryProvider },
        { provide: ShellProvider, useClass: TauriWindowsShellProvider, multi: true },
        { provide: UpdaterService, useClass: UnsupportedUpdaterService },
        { provide: DockingService, useClass: UnsupportedDockingService },
        { provide: UACService, useClass: UnsupportedUACService },
        TauriDisplayEffectsService,
    ],
})
export default class TauriHostModule {
    constructor (_displayEffects: TauriDisplayEffectsService) { }
}
