import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface BootstrapData {
  platform: 'windows'
  bootstrap_component: string
  purpose: string
}

export interface SessionSnapshot {
  session_id: string
  kind: 'local' | 'ssh'
  state: 'starting' | 'running' | 'idle' | 'closed' | 'errored' | 'reconnectable'
  last_activity_at: number
  bytes_in: number
  bytes_out: number
  queue_depth: number
  reader_paused: boolean
  close_reason: string | null
  error_reason: string | null
}

export interface PtySpawnRequest {
  command: string
  args?: string[]
  cwd?: string | null
  env?: Array<[string, string]>
  size: {
    cols: number
    rows: number
  }
}

export interface PtySpawnResponse {
  session: SessionSnapshot
  pid: number | null
  cwd: string | null
}

export interface PtyChildProcess {
  pid: number
  ppid: number
  command: string
}

export interface PtyData {
  session_id: string
  seq: number
  bytes: number[]
}

export interface ProviderDescriptor {
  token: string
  action: 'implement' | 'implement-subset' | 'stub' | 'drop'
  replacement: string
}

export type SshAuthMethod =
  | { type: 'password'; password: string }
  | { type: 'private-key'; private_key_path: string; passphrase?: string | null }
  | { type: 'private-keys'; private_keys: SshPrivateKeyCandidate[] }
  | { type: 'keyboard-interactive'; prompt_provider: 'renderer' }

export interface SshPrivateKeyCandidate {
  private_key_path: string
  passphrase?: string | null
}

export interface SshConnectRequest {
  host: string
  port: number
  username: string
  auth: SshAuthMethod
  host_key_fingerprint?: string | null
  unsupported_features?: string[]
}

export interface SshConnectResponse {
  session: SessionSnapshot
  transport_status: 'pending-russh-transport' | 'russh-connected'
}

export interface SshData {
  session_id: string
  seq: number
  bytes: number[]
}

export interface SshKeyboardInteractivePrompt {
  prompt: string
  echo?: boolean
}

export interface SshKeyboardInteractivePromptEvent {
  request_id: string
  name: string
  instruction: string
  prompts: SshKeyboardInteractivePrompt[]
}

export interface SshKeyboardInteractiveResponseRequest {
  request_id: string
  responses?: string[]
  cancelled?: boolean
}

export interface SshLocalPortForwardRequest {
  session_id: string
  bind_host: string
  bind_port: number
  target_host: string
  target_port: number
}

export interface SshLocalPortForwardResponse {
  forward_id: string
  session_id: string
  bind_host: string
  bind_port: number
  target_host: string
  target_port: number
  status: 'listening'
}

export interface SshDynamicPortForwardRequest {
  session_id: string
  bind_host: string
  bind_port: number
}

export interface SshDynamicPortForwardResponse {
  forward_id: string
  session_id: string
  bind_host: string
  bind_port: number
  status: 'listening'
}

export interface SshRemotePortForwardRequest {
  session_id: string
  bind_host: string
  bind_port: number
  target_host: string
  target_port: number
}

export interface SshRemotePortForwardResponse {
  forward_id: string
  session_id: string
  bind_host: string
  bind_port: number
  target_host: string
  target_port: number
  status: 'listening'
}

export interface SshShellSize {
  cols: number
  rows: number
}

export interface SshKeepaliveProbeRequest {
  probes: number
  interval_ms: number
}

export interface SshKeepaliveReport {
  session: SessionSnapshot
  probes_attempted: number
  probes_succeeded: number
  status: 'healthy' | 'reconnectable' | 'errored' | 'closed'
}

export interface TauriSshSessionOptions {
  request: SshConnectRequest
  size: SshShellSize
  transport?: 'contract' | 'russh'
  keepalive?: SshKeepaliveProbeRequest
  keyboardInteractivePromptHandler?: (
    event: SshKeyboardInteractivePromptEvent,
    adapter: TauriSSHSessionAdapter,
  ) => void | Promise<void>
}

export interface TauriLocalSessionOptions {
  request: PtySpawnRequest
}

export interface TabbyPtySpawnOptions {
  cols?: number
  rows?: number
  cwd?: string | null
  env?: Record<string, string> | Array<[string, string]>
}

export interface SshHostKeyPrompt {
  host: string
  port: number
  username: string
  fingerprint: string
  keyType?: string
}

export interface SshHostKeyDecision {
  action: 'accept' | 'reject'
  remember: boolean
  host_key_fingerprint?: string
}

interface HostKeyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class UnsupportedFeatureError extends Error {
  readonly code = 'UNSUPPORTED_TAURI_MVP_FEATURE'

  constructor(readonly feature: string) {
    super(`${feature} is unsupported in the Windows-only Tauri MVP`)
    this.name = 'UnsupportedFeatureError'
  }
}

export const tauriMvpProviderManifest: ProviderDescriptor[] = [
  { token: 'PlatformService', action: 'implement', replacement: 'TauriWindowsPlatformService' },
  { token: 'HostWindowService', action: 'implement-subset', replacement: 'TauriHostWindowService' },
  { token: 'HostAppService', action: 'implement-subset', replacement: 'TauriHostAppService' },
  { token: 'ConfigProvider', action: 'implement-subset', replacement: 'TauriConfigProvider' },
  { token: 'PTYInterface', action: 'implement-subset', replacement: 'TauriPTYInterface' },
  { token: 'SSHSessionFactory', action: 'implement-subset', replacement: 'TauriSshSessionFactoryProvider' },
  { token: 'SSHShellSessionFactory', action: 'implement-subset', replacement: 'TauriSshShellSessionFactoryProvider' },
  { token: 'PasswordStorageService', action: 'implement-subset', replacement: 'TauriPasswordStorageService' },
  { token: 'OneKeySecretStorageProvider', action: 'implement-subset', replacement: 'TauriOneKeySecretStorageProvider' },
  { token: 'ShellProvider', action: 'implement-subset', replacement: 'TauriWindowsShellProvider' },
  { token: 'UpdaterService', action: 'stub', replacement: 'UnsupportedUpdaterService' },
  { token: 'UACService', action: 'stub', replacement: 'UnsupportedUACService' },
]

export class TauriWindowsPlatformService {
  readonly platform = 'windows'
  readonly webview = 'webview2'
  readonly isWindows = true
  readonly isMacOS = false
  readonly isLinux = false
}

class SimpleSubject<T> {
  private observers: Array<(value: T) => void> = []

  subscribe(observer: ((value: T) => void) | { next: (value: T) => void }): { unsubscribe: () => void } {
    const nextFn = typeof observer === 'function' ? observer : observer?.next?.bind(observer)
    if (nextFn) {
      this.observers.push(nextFn)
    }
    return {
      unsubscribe: () => {
        this.observers = this.observers.filter(obs => obs !== nextFn)
      }
    }
  }

  next(value: T): void {
    for (const observer of this.observers) {
      observer(value)
    }
  }

  toPromise(): Promise<T> {
    return new Promise<T>(resolve => {
      const sub = this.subscribe(val => {
        sub.unsubscribe()
        resolve(val)
      })
    })
  }

  asObservable(): this {
    return this
  }
}

export class TauriHostWindowService {
  private readonly window = getCurrentWindow()
  private isClosing = false
  private maximized = false
  private fullscreen = false

  /** Signals app.service.ts to skip closeAllTabs() and call close() directly */
  readonly supportsDirectQuit = true

  readonly windowShown$ = new SimpleSubject<void>()
  readonly windowCloseRequest$ = new SimpleSubject<void>()
  readonly windowMoved$ = new SimpleSubject<void>()
  readonly windowFocused$ = new SimpleSubject<void>()

  constructor() {
    this.window.isMaximized().then(m => this.maximized = m)
    this.window.isFullscreen().then(f => this.fullscreen = f)

    this.window.onCloseRequested(async (event) => {
      if (this.isClosing) {
        return
      }
      event.preventDefault()
      this.windowCloseRequest$.next()
    })

    this.window.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        this.windowFocused$.next()
      }
    })

    this.window.onResized(() => {
      this.window.isMaximized().then(m => this.maximized = m)
      this.window.isFullscreen().then(f => this.fullscreen = f)
      this.windowMoved$.next()
    })

    this.window.onMoved(() => {
      this.windowMoved$.next()
    })

    setTimeout(() => {
      this.windowShown$.next()
    }, 100)
  }

  get isFullscreen(): boolean {
    return this.fullscreen
  }

  reload(): void {
    globalThis.location.reload()
  }

  setTitle(title: string): Promise<void> {
    return this.window.setTitle(title)
  }

  async toggleFullscreen(): Promise<void> {
    const next = !this.fullscreen
    await this.window.setFullscreen(next)
    this.fullscreen = next
  }

  minimize(): Promise<void> {
    return this.window.minimize()
  }

  isMaximized(): boolean {
    return this.maximized
  }

  async toggleMaximize(): Promise<void> {
    await this.window.toggleMaximize()
    this.maximized = await this.window.isMaximized()
  }

  async close(): Promise<void> {
    this.isClosing = true
    // Try the Rust-side quit command first (calls app.exit(0) synchronously).
    // If the invoke itself throws (e.g. IPC torn down mid-flight because the
    // process is already exiting), fall back to the Tauri window close API.
    // Because isClosing is already true, the onCloseRequested handler will
    // skip event.preventDefault() and allow the OS to close the window.
    invoke('quit').catch(() => {
      void this.window.close()
    })
  }

  focus(): Promise<void> {
    return this.window.setFocus()
  }

  async setFullscreen(enabled: boolean): Promise<void> {
    await this.window.setFullscreen(enabled)
    this.fullscreen = enabled
  }

  openDevTools(): void {}

  bringToFront(): void {
    void this.window.setFocus()
  }
}

export class TauriHostAppService {
  loadBootstrapData(): Promise<BootstrapData> {
    return invoke<BootstrapData>('bootstrap_data')
  }

  async markReady(): Promise<void> {
    await getCurrentWindow().emit('tauri-mvp-ready', { ready: true })
  }
}

export class TauriConfigProvider {
  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = this.storage?.getItem(key)
    if (!raw) {
      return fallback
    }
    return JSON.parse(raw) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.storage?.setItem(key, JSON.stringify(value))
  }
}

interface TauriPasswordProfile {
  options: {
    host: string
    port?: number | null
    user: string
    password?: string | null
  }
}

export class TauriPasswordStorageService {
  private readonly passwordPrefix = 'tabby-tauri:ssh-password:'
  private readonly passphrasePrefix = 'tabby-tauri:ssh-private-key-passphrase:'

  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  async savePassword(profile: TauriPasswordProfile, password: string, username?: string): Promise<void> {
    const account = username ?? profile.options.user
    if (!account) {
      return
    }
    await this.saveSecret(this.connectionService(profile), account, password, this.connectionLocalKey(profile, account))
  }

  async deletePassword(profile: TauriPasswordProfile, username?: string): Promise<void> {
    const account = username ?? profile.options.user
    if (!account) {
      return
    }
    await this.deleteSecret(this.connectionService(profile), account, this.connectionLocalKey(profile, account))
  }

  async loadPassword(profile: TauriPasswordProfile, username?: string): Promise<string | null> {
    const account = username ?? profile.options.user
    if (!account) {
      return null
    }
    return profile.options.password || await this.loadSecret(this.connectionService(profile), account, this.connectionLocalKey(profile, account))
  }

  async savePrivateKeyPassword(id: string, password: string): Promise<void> {
    await this.saveSecret(this.privateKeyService(id), 'user', password, this.privateKeyLocalKey(id))
  }

  async deletePrivateKeyPassword(id: string): Promise<void> {
    await this.deleteSecret(this.privateKeyService(id), 'user', this.privateKeyLocalKey(id))
  }

  async loadPrivateKeyPassword(id: string): Promise<string | null> {
    return this.loadSecret(this.privateKeyService(id), 'user', this.privateKeyLocalKey(id))
  }

  private connectionService(profile: TauriPasswordProfile): string {
    let service = `ssh@${profile.options.host}`
    if (profile.options.port) {
      service = `${service}:${profile.options.port}`
    }
    return service
  }

  private connectionLocalKey(profile: TauriPasswordProfile, username: string): string {
    return `${this.passwordPrefix}${encodeURIComponent(username)}@${encodeURIComponent(profile.options.host)}:${profile.options.port ?? 22}`
  }

  private privateKeyService(id: string): string {
    return `ssh-private-key:${id}`
  }

  private privateKeyLocalKey(id: string): string {
    return `${this.passphrasePrefix}${encodeURIComponent(id)}`
  }

  private async loadSecret(service: string, account: string, fallbackKey: string): Promise<string | null> {
    try {
      return await invoke<string | null>('credential_get_password', { service, account }) ?? this.loadLocalSecret(fallbackKey)
    } catch {
      return this.loadLocalSecret(fallbackKey)
    }
  }

  private async saveSecret(service: string, account: string, password: string, fallbackKey: string): Promise<void> {
    try {
      await invoke('credential_set_password', { service, account, password })
      this.deleteLocalSecret(fallbackKey)
    } catch {
      this.saveLocalSecret(fallbackKey, password)
    }
  }

  private async deleteSecret(service: string, account: string, fallbackKey: string): Promise<void> {
    try {
      await invoke('credential_delete_password', { service, account })
    } catch {
      // Local fallback is still cleared below.
    }
    this.deleteLocalSecret(fallbackKey)
  }

  private loadLocalSecret(key: string): string | null {
    return this.storage?.getItem(key) ?? null
  }

  private saveLocalSecret(key: string, value: string): void {
    this.storage?.setItem(key, value)
  }

  private deleteLocalSecret(key: string): void {
    this.storage?.removeItem(key)
  }
}

export class TauriOneKeySecretStorageProvider {
  private readonly service = 'tabby-onekey'

  async probe(): Promise<boolean> {
    try {
      await invoke<string | null>('credential_get_password', { service: this.service, account: 'onekey:__probe__' })
      return true
    } catch {
      return false
    }
  }

  async getSecret(target: string): Promise<string | null> {
    return invoke<string | null>('credential_get_password', { service: this.service, account: target })
  }

  async setSecret(target: string, value: string): Promise<void> {
    await invoke('credential_set_password', { service: this.service, account: target, password: value })
  }

  async deleteSecret(target: string): Promise<void> {
    await invoke('credential_delete_password', { service: this.service, account: target })
  }
}

export class TauriWindowsShellProvider {
  listShells(): Array<{ id: string; name: string; command: string }> {
    return [
      { id: 'powershell', name: 'Windows PowerShell', command: 'powershell.exe' },
      { id: 'pwsh', name: 'PowerShell', command: 'pwsh.exe' },
      { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe' },
    ]
  }
}

export class TauriRawPTYBridge {
  spawn(request: PtySpawnRequest): Promise<PtySpawnResponse> {
    return invoke<PtySpawnResponse>('pty_spawn', { request })
  }

  restore(sessionId: string): Promise<PtySpawnResponse | null> {
    return invoke<PtySpawnResponse | null>('pty_restore', { sessionId })
  }

  write(sessionId: string, bytes: Uint8Array): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('pty_write', { sessionId, bytes: Array.from(bytes) })
  }

  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return invoke('pty_resize', { sessionId, size: { cols, rows } })
  }

  kill(sessionId: string): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('pty_kill', { sessionId })
  }

  exists(sessionId: string): Promise<boolean> {
    return invoke<boolean>('pty_exists', { sessionId })
  }

  getPid(sessionId: string): Promise<number | null> {
    return invoke<number | null>('pty_get_pid', { sessionId })
  }

  ackData(sessionId: string, length: number): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('pty_ack', { sessionId, length })
  }

  getWorkingDirectory(sessionId: string): Promise<string | null> {
    return invoke<string | null>('pty_cwd', { sessionId })
  }

  state(sessionId: string): Promise<SessionSnapshot | null> {
    return invoke<SessionSnapshot | null>('session_state', { sessionId })
  }

  getTruePid(sessionId: string): Promise<number | null> {
    return invoke<number | null>('pty_true_pid', { sessionId })
  }

  getChildProcesses(sessionId: string): Promise<PtyChildProcess[]> {
    return invoke<PtyChildProcess[]>('pty_children', { sessionId })
  }

  stream(sessionId: string, onData: (data: PtyData) => void): Promise<void> {
    const channel = new Channel<PtyData>()
    channel.onmessage = onData
    return invoke('pty_stream', { sessionId, channel })
  }
}

export function normalizePtySpawnRequest(
  requestOrCommand: PtySpawnRequest | string,
  args: string[] = [],
  options: TabbyPtySpawnOptions = {},
): PtySpawnRequest {
  if (typeof requestOrCommand !== 'string') {
    return requestOrCommand
  }

  return {
    command: requestOrCommand,
    args,
    cwd: options.cwd ?? null,
    env: Array.isArray(options.env) ? options.env : Object.entries(options.env ?? {}),
    size: {
      cols: options.cols ?? 80,
      rows: options.rows ?? 30,
    },
  }
}

export class TauriPTYProxy {
  private unsubscribers: Array<() => void> = []

  constructor(
    private readonly bridge: TauriRawPTYBridge,
    private readonly spawnResponse: PtySpawnResponse,
  ) {}

  getID(): string {
    return this.spawnResponse.session.session_id
  }

  getPID(): Promise<number> {
    return this.bridge.getPid(this.getID()).then(pid => pid ?? 0)
  }

  resize(columns: number, rows: number): Promise<void> {
    return this.bridge.resize(this.getID(), columns, rows)
  }

  async write(data: Uint8Array): Promise<void> {
    await this.bridge.write(this.getID(), data)
  }

  async kill(_signal?: string): Promise<void> {
    await this.bridge.kill(this.getID())
  }

  ackData(length: number): void {
    void this.bridge.ackData(this.getID(), length)
  }

  subscribe(event: string, handler: (...args: unknown[]) => void): void {
    if (event === 'data') {
      void this.bridge.stream(this.getID(), data => handler(new Uint8Array(data.bytes)))
      this.unsubscribers.push(() => {
        // Channel lifecycle cancellation is not exposed yet; this placeholder keeps the proxy API shape explicit.
      })
      return
    }

    if (event === 'close' || event === 'exit') {
      let disposed = false
      const interval = globalThis.setInterval(async () => {
        if (disposed) {
          return
        }
        const snapshot = await this.bridge.state(this.getID())
        if (
          snapshot?.state === 'closed' ||
          snapshot?.state === 'errored' ||
          snapshot?.state === 'reconnectable'
        ) {
          disposed = true
          globalThis.clearInterval(interval)
          handler(snapshot)
        }
      }, 500)
      this.unsubscribers.push(() => {
        disposed = true
        globalThis.clearInterval(interval)
      })
    }
  }

  unsubscribeAll(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe()
    }
    this.unsubscribers = []
  }

  getChildProcesses(): Promise<PtyChildProcess[]> {
    return this.bridge.getChildProcesses(this.getID())
  }

  getTruePID(): Promise<number> {
    return this.bridge.getTruePid(this.getID()).then(pid => pid ?? 0)
  }

  getWorkingDirectory(): Promise<string | null> {
    return this.bridge.getWorkingDirectory(this.getID())
  }
}

export class TauriPTYInterface {
  constructor(private readonly bridge = new TauriRawPTYBridge()) {}

  async spawn(
    requestOrCommand: PtySpawnRequest | string,
    args: string[] = [],
    options: TabbyPtySpawnOptions = {},
  ): Promise<TauriPTYProxy> {
    return new TauriPTYProxy(
      this.bridge,
      await this.bridge.spawn(normalizePtySpawnRequest(requestOrCommand, args, options)),
    )
  }

  async restore(sessionId: string): Promise<TauriPTYProxy | null> {
    const restored = await this.bridge.restore(sessionId)
    return restored ? new TauriPTYProxy(this.bridge, restored) : null
  }
}

export class TauriLocalTerminalSession {
  private spawnResponse: PtySpawnResponse | null = null
  private readonly dataHandlers = new Set<(bytes: Uint8Array) => void>()
  private readonly stateHandlers = new Set<(snapshot: SessionSnapshot) => void>()
  open = false

  constructor(
    private readonly bridge: TauriRawPTYBridge,
    private readonly options: TauriLocalSessionOptions,
  ) {}

  get id(): string | null {
    return this.spawnResponse?.session.session_id ?? null
  }

  get snapshot(): SessionSnapshot | null {
    return this.spawnResponse?.session ?? null
  }

  onData(handler: (bytes: Uint8Array) => void): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onState(handler: (snapshot: SessionSnapshot) => void): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  async start(): Promise<SessionSnapshot> {
    this.spawnResponse = await this.bridge.spawn(this.options.request)
    this.open = true
    this.emitState(this.spawnResponse.session)
    await this.bridge.stream(this.spawnResponse.session.session_id, data => {
      const bytes = new Uint8Array(data.bytes)
      for (const handler of this.dataHandlers) {
        handler(bytes)
      }
      void this.bridge.ackData(data.session_id, bytes.byteLength).then(snapshot => this.emitState(snapshot))
    })
    return this.spawnResponse.session
  }

  async write(bytes: Uint8Array): Promise<SessionSnapshot> {
    const snapshot = await this.bridge.write(this.sessionIdOrThrow(), bytes)
    this.emitState(snapshot)
    return snapshot
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.bridge.resize(this.sessionIdOrThrow(), cols, rows)
  }

  async close(): Promise<SessionSnapshot> {
    const snapshot = await this.bridge.kill(this.sessionIdOrThrow())
    this.open = false
    this.emitState(snapshot)
    return snapshot
  }

  kill(_signal?: string): void {
    void this.close()
  }

  destroy(): Promise<void> {
    return this.close().then(() => undefined)
  }

  gracefullyKillProcess(): Promise<void> {
    return this.destroy()
  }

  supportsWorkingDirectory(): boolean {
    return true
  }

  getWorkingDirectory(): Promise<string | null> {
    return this.bridge.getWorkingDirectory(this.sessionIdOrThrow())
  }

  getChildProcesses(): Promise<PtyChildProcess[]> {
    return this.bridge.getChildProcesses(this.sessionIdOrThrow())
  }

  private emitState(snapshot: SessionSnapshot): void {
    if (this.spawnResponse) {
      this.spawnResponse = { ...this.spawnResponse, session: snapshot }
    }
    for (const handler of this.stateHandlers) {
      handler(snapshot)
    }
  }

  private sessionIdOrThrow(): string {
    if (!this.spawnResponse) {
      throw new Error('Local terminal session has not been started')
    }
    return this.spawnResponse.session.session_id
  }
}

export class TauriHostKeyTrustStore {
  private readonly prefix = 'tabby-tauri:ssh-host-key:'

  constructor(private readonly storage: HostKeyStorage | null = defaultHostKeyStorage()) {}

  getTrustedFingerprint(prompt: Pick<SshHostKeyPrompt, 'host' | 'port' | 'username'>): string | null {
    return this.storage?.getItem(this.storageKey(prompt)) ?? null
  }

  isTrusted(prompt: SshHostKeyPrompt): boolean {
    return this.getTrustedFingerprint(prompt) === prompt.fingerprint
  }

  remember(prompt: SshHostKeyPrompt): void {
    this.storage?.setItem(this.storageKey(prompt), prompt.fingerprint)
  }

  forget(prompt: Pick<SshHostKeyPrompt, 'host' | 'port' | 'username'>): void {
    this.storage?.removeItem(this.storageKey(prompt))
  }

  private storageKey(prompt: Pick<SshHostKeyPrompt, 'host' | 'port' | 'username'>): string {
    return `${this.prefix}${prompt.username}@${prompt.host}:${prompt.port}`
  }
}

export class TauriHostKeyConfirmationView {
  constructor(
    private readonly root: HTMLElement,
    private readonly trustStore = new TauriHostKeyTrustStore(),
  ) {}

  confirm(prompt: SshHostKeyPrompt): Promise<SshHostKeyDecision> {
    if (this.trustStore.isTrusted(prompt)) {
      return Promise.resolve({
        action: 'accept',
        remember: true,
        host_key_fingerprint: prompt.fingerprint,
      })
    }

    return new Promise(resolve => {
      this.root.replaceChildren(this.buildPrompt(prompt, resolve))
    })
  }

  private buildPrompt(
    prompt: SshHostKeyPrompt,
    resolve: (decision: SshHostKeyDecision) => void,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'host-key-confirmation'

    const title = document.createElement('h2')
    title.textContent = 'Confirm SSH host key'

    const description = document.createElement('p')
    description.textContent =
      'Verify this fingerprint before connecting. Reject the connection if it changed unexpectedly.'

    const details = document.createElement('dl')
    for (const [label, value] of [
      ['Host', `${prompt.username}@${prompt.host}:${prompt.port}`],
      ['Key type', prompt.keyType ?? 'unknown'],
      ['Fingerprint', prompt.fingerprint],
    ] as const) {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = value
      details.append(term, detail)
    }

    const rememberLabel = document.createElement('label')
    const remember = document.createElement('input')
    remember.type = 'checkbox'
    remember.checked = true
    rememberLabel.append(remember, ' Remember this host key')

    const actions = document.createElement('div')
    actions.className = 'host-key-actions'
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.textContent = 'Reject'
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.textContent = 'Accept and connect'

    reject.addEventListener('click', () => {
      resolve({ action: 'reject', remember: false })
    })
    accept.addEventListener('click', () => {
      if (remember.checked) {
        this.trustStore.remember(prompt)
      }
      resolve({
        action: 'accept',
        remember: remember.checked,
        host_key_fingerprint: prompt.fingerprint,
      })
    })

    actions.append(reject, accept)
    section.append(title, description, details, rememberLabel, actions)
    return section
  }
}

export class TauriSSHSessionAdapter {
  constructor(private readonly trustStore = new TauriHostKeyTrustStore()) {}

  async confirmHostKey(prompt: SshHostKeyPrompt, viewRoot: HTMLElement): Promise<SshHostKeyDecision> {
    return new TauriHostKeyConfirmationView(viewRoot, this.trustStore).confirm(prompt)
  }

  connect(request: SshConnectRequest): Promise<SshConnectResponse> {
    return invoke<SshConnectResponse>('ssh_connect', { request })
  }

  connectTransport(request: SshConnectRequest): Promise<SshConnectResponse> {
    return invoke<SshConnectResponse>('ssh_connect_transport', { request })
  }

  connectTransportInteractive(
    request: SshConnectRequest,
    onPrompt: (event: SshKeyboardInteractivePromptEvent) => void,
  ): Promise<SshConnectResponse> {
    const channel = new Channel<SshKeyboardInteractivePromptEvent>()
    channel.onmessage = onPrompt
    return invoke<SshConnectResponse>('ssh_connect_transport_interactive', { request, channel })
  }

  respondKeyboardInteractive(request: SshKeyboardInteractiveResponseRequest): Promise<void> {
    return invoke('ssh_keyboard_interactive_respond', { request })
  }

  startLocalPortForward(request: SshLocalPortForwardRequest): Promise<SshLocalPortForwardResponse> {
    return invoke<SshLocalPortForwardResponse>('ssh_start_local_port_forward', { request })
  }

  startDynamicPortForward(request: SshDynamicPortForwardRequest): Promise<SshDynamicPortForwardResponse> {
    return invoke<SshDynamicPortForwardResponse>('ssh_start_dynamic_port_forward', { request })
  }

  startRemotePortForward(request: SshRemotePortForwardRequest): Promise<SshRemotePortForwardResponse> {
    return invoke<SshRemotePortForwardResponse>('ssh_start_remote_port_forward', { request })
  }

  stopPortForward(forwardId: string): Promise<void> {
    return invoke('ssh_stop_port_forward', { forwardId })
  }

  prepareConnect(request: SshConnectRequest): Promise<SshConnectResponse> {
    return invoke<SshConnectResponse>('ssh_prepare_connect', { request })
  }

  openShell(sessionId: string, size: SshShellSize): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_open_shell', { sessionId, size })
  }

  openShellTransport(sessionId: string, size: SshShellSize): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_open_shell_transport', { sessionId, size })
  }

  write(sessionId: string, bytes: Uint8Array): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_write', { sessionId, bytes: Array.from(bytes) })
  }

  writeTransport(sessionId: string, bytes: Uint8Array): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_write_transport', { sessionId, bytes: Array.from(bytes) })
  }

  resize(sessionId: string, size: SshShellSize): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_resize', { sessionId, size })
  }

  resizeTransport(sessionId: string, size: SshShellSize): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_resize_transport', { sessionId, size })
  }

  ack(sessionId: string, length: number): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_ack', { sessionId, length })
  }

  keepalive(sessionId: string): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_keepalive', { sessionId })
  }

  keepaliveTransport(sessionId: string): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_keepalive_transport', { sessionId })
  }

  keepaliveEvaluator(
    sessionId: string,
    request: SshKeepaliveProbeRequest,
  ): Promise<SshKeepaliveReport> {
    return invoke<SshKeepaliveReport>('ssh_keepalive_evaluator', { sessionId, request })
  }

  keepaliveEvaluatorTransport(
    sessionId: string,
    request: SshKeepaliveProbeRequest,
  ): Promise<SshKeepaliveReport> {
    return invoke<SshKeepaliveReport>('ssh_keepalive_evaluator_transport', { sessionId, request })
  }

  close(sessionId: string, reason = 'client-close'): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_close', { sessionId, reason })
  }

  closeTransport(sessionId: string, reason = 'client-close'): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_close_transport', { sessionId, reason })
  }

  state(sessionId: string): Promise<SessionSnapshot | null> {
    return invoke<SessionSnapshot | null>('ssh_state', { sessionId })
  }

  stream(sessionId: string, onData: (data: SshData) => void): Promise<SessionSnapshot> {
    const channel = new Channel<SshData>()
    channel.onmessage = onData
    return invoke<SessionSnapshot>('ssh_stream', { sessionId, channel })
  }

  streamTransport(sessionId: string, onData: (data: SshData) => void): Promise<SessionSnapshot> {
    const channel = new Channel<SshData>()
    channel.onmessage = onData
    return invoke<SessionSnapshot>('ssh_stream_transport', { sessionId, channel })
  }

  forcedDisconnectTest(sessionId: string, reason: string): Promise<SessionSnapshot> {
    return invoke<SessionSnapshot>('ssh_forced_disconnect_test', { sessionId, reason })
  }
}

export class TauriSSHShellSession {
  private session: SessionSnapshot | null = null
  private readonly dataHandlers = new Set<(bytes: Uint8Array) => void>()
  private readonly stateHandlers = new Set<(snapshot: SessionSnapshot) => void>()
  private readonly transport: 'contract' | 'russh'
  private readonly textDecoder = new TextDecoder()
  private remoteWorkingDirectory: string | null = null
  private oscBuffer = ''
  open = false

  constructor(
    private readonly adapter: TauriSSHSessionAdapter,
    private readonly options: TauriSshSessionOptions,
  ) {
    this.transport = options.transport ?? 'russh'
  }

  get id(): string | null {
    return this.session?.session_id ?? null
  }

  get snapshot(): SessionSnapshot | null {
    return this.session
  }

  onData(handler: (bytes: Uint8Array) => void): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onState(handler: (snapshot: SessionSnapshot) => void): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  async start(): Promise<SessionSnapshot> {
    const connected = await this.connect()
    this.open = true
    this.setSession(connected.session)

    const opened =
      this.transport === 'russh'
        ? await this.adapter.openShellTransport(connected.session.session_id, this.options.size)
        : await this.adapter.openShell(connected.session.session_id, this.options.size)
    this.setSession(opened)

    const stream =
      this.transport === 'russh' ? this.adapter.streamTransport.bind(this.adapter) : this.adapter.stream.bind(this.adapter)
    this.setSession(
      await stream(opened.session_id, data => {
        const bytes = new Uint8Array(data.bytes)
        this.captureWorkingDirectoryReport(bytes)
        for (const handler of this.dataHandlers) {
          handler(bytes)
        }
        void this.adapter.ack(data.session_id, bytes.byteLength)
      }),
    )

    if (this.options.keepalive) {
      await this.keepalive(this.options.keepalive)
    }

    return this.sessionOrThrow()
  }

  private connect(): Promise<SshConnectResponse> {
    if (this.transport !== 'russh') {
      return this.adapter.connect(this.options.request)
    }
    if (this.options.request.auth.type !== 'keyboard-interactive') {
      return this.adapter.connectTransport(this.options.request)
    }
    return this.adapter.connectTransportInteractive(this.options.request, event => {
      const handler = this.options.keyboardInteractivePromptHandler
      if (handler) {
        void handler(event, this.adapter)
        return
      }
      void this.adapter.respondKeyboardInteractive({
        request_id: event.request_id,
        cancelled: true,
      })
    })
  }

  async write(bytes: Uint8Array): Promise<SessionSnapshot> {
    const sessionId = this.sessionOrThrow().session_id
    const snapshot =
      this.transport === 'russh'
        ? await this.adapter.writeTransport(sessionId, bytes)
        : await this.adapter.write(sessionId, bytes)
    this.setSession(snapshot)
    return snapshot
  }

  async resize(sizeOrCols: SshShellSize | number, rows?: number): Promise<SessionSnapshot> {
    const size =
      typeof sizeOrCols === 'number'
        ? { cols: sizeOrCols, rows: rows ?? this.options.size.rows }
        : sizeOrCols
    const sessionId = this.sessionOrThrow().session_id
    const snapshot =
      this.transport === 'russh'
        ? await this.adapter.resizeTransport(sessionId, size)
        : await this.adapter.resize(sessionId, size)
    this.setSession(snapshot)
    return snapshot
  }

  async keepalive(request: SshKeepaliveProbeRequest = { probes: 1, interval_ms: 0 }): Promise<SshKeepaliveReport> {
    const sessionId = this.sessionOrThrow().session_id
    const report =
      this.transport === 'russh'
        ? await this.adapter.keepaliveEvaluatorTransport(sessionId, request)
        : await this.adapter.keepaliveEvaluator(sessionId, request)
    this.setSession(report.session)
    return report
  }

  async close(reason = 'client-close'): Promise<SessionSnapshot> {
    const sessionId = this.sessionOrThrow().session_id
    const snapshot =
      this.transport === 'russh'
        ? await this.adapter.closeTransport(sessionId, reason)
        : await this.adapter.close(sessionId, reason)
    this.open = false
    this.setSession(snapshot)
    return snapshot
  }

  kill(_signal?: string): void {
    void this.close('killed')
  }

  destroy(): Promise<void> {
    return this.close('destroyed').then(() => undefined)
  }

  gracefullyKillProcess(): Promise<void> {
    return this.destroy()
  }

  supportsWorkingDirectory(): boolean {
    return this.remoteWorkingDirectory !== null
  }

  getWorkingDirectory(): Promise<string | null> {
    return Promise.resolve(this.remoteWorkingDirectory)
  }

  private captureWorkingDirectoryReport(bytes: Uint8Array): void {
    this.oscBuffer += this.textDecoder.decode(bytes, { stream: true })

    const currentDirPattern = /\x1b\]1337;CurrentDir=([^\x07\x1b]*)(?:\x07|\x1b\\)/g
    let consumedUpTo = 0
    for (let match = currentDirPattern.exec(this.oscBuffer); match; match = currentDirPattern.exec(this.oscBuffer)) {
      this.remoteWorkingDirectory = match[1] || null
      consumedUpTo = currentDirPattern.lastIndex
    }
    if (consumedUpTo > 0) {
      this.oscBuffer = this.oscBuffer.slice(consumedUpTo)
    }

    const lastOscStart = this.oscBuffer.lastIndexOf('\x1b]')
    if (lastOscStart === -1) {
      this.oscBuffer = ''
      return
    }

    this.oscBuffer = this.oscBuffer.slice(lastOscStart, lastOscStart + 4096)
  }

  private setSession(snapshot: SessionSnapshot): void {
    this.session = snapshot
    for (const handler of this.stateHandlers) {
      handler(snapshot)
    }
  }

  private sessionOrThrow(): SessionSnapshot {
    if (!this.session) {
      throw new Error('SSH session has not been started')
    }
    return this.session
  }
}

function defaultHostKeyStorage(): HostKeyStorage | null {
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
}

export class UnsupportedUpdaterService {
  readonly isAvailable = false

  checkForUpdates(): false {
    return false
  }

  update(): never {
    throw new UnsupportedFeatureError('auto-update')
  }
}

export class UnsupportedUACService {
  readonly isAvailable = false

  elevate(): never {
    throw new UnsupportedFeatureError('UAC elevation')
  }
}

export function createTauriMvpProviders() {
  return {
    platform: new TauriWindowsPlatformService(),
    hostWindow: new TauriHostWindowService(),
    hostApp: new TauriHostAppService(),
    config: new TauriConfigProvider(),
    passwordStorage: new TauriPasswordStorageService(),
    oneKeySecrets: new TauriOneKeySecretStorageProvider(),
    shells: new TauriWindowsShellProvider(),
    rawPty: new TauriRawPTYBridge(),
    pty: new TauriPTYInterface(),
    localTerminalSession: TauriLocalTerminalSession,
    ssh: new TauriSSHSessionAdapter(),
    sshShellSession: TauriSSHShellSession,
    updater: new UnsupportedUpdaterService(),
    uac: new UnsupportedUACService(),
  }
}

export type TauriMvpProviderSet = ReturnType<typeof createTauriMvpProviders>
