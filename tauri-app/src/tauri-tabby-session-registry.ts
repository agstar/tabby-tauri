import {
  createTauriMvpProviders,
  TauriLocalTerminalSession,
  TauriSSHShellSession,
  tauriMvpProviderManifest,
} from './tauri-providers.js'
import type {
  ProviderDescriptor,
  PtySpawnRequest,
  SshConnectRequest,
  SshShellSize,
  TauriMvpProviderSet,
} from './tauri-providers.js'

export interface TauriRuntimeProbe {
  isTauriRuntime(): boolean
}

export interface TauriTabbyLocalSessionOptions {
  command: string
  args?: string[]
  cwd?: string | null
  env?: Record<string, string>
  width?: number | null
  height?: number | null
}

export interface TauriTabbySshSessionOptions {
  request: SshConnectRequest
  size: SshShellSize
}

type TauriForwardedPortType = 'Local' | 'Remote' | 'Dynamic'

interface TauriForwardedPort {
  type?: TauriForwardedPortType
}

export interface TauriTabbySshProfile {
  options: {
    host: string
    port?: number | null
    user: string
    auth?: null | 'password' | 'publicKey' | 'agent' | 'keyboardInteractive'
    password?: string | null
    privateKeys?: string[]
    x11?: boolean
    jumpHost?: string | null
    agentForward?: boolean
    proxyCommand?: string | null
    forwardedPorts?: TauriForwardedPort[]
    socksProxyHost?: string | null
    httpProxyHost?: string | null
    reuseSession?: boolean
    hostKeyFingerprint?: string | null
  }
}

export interface TauriTabbySessionFactories {
  local(options: TauriTabbyLocalSessionOptions): TauriLocalTerminalSession
  ssh(options: TauriTabbySshSessionOptions): TauriSSHShellSession
}

export interface TauriAngularProviderBlueprint {
  provide: string
  useClass: string
  multi: boolean
  action: ProviderDescriptor['action']
  upstreamReference: string
}

export interface TauriSessionOverrideBlueprint {
  upstreamFile: string
  upstreamConstruction: string
  tauriReplacement: string
  rationale: string
}

export interface TauriAngularModuleBlueprint {
  moduleName: 'TauriHostModule'
  replacesModule: 'tabby-electron/src/index.ts ElectronModule'
  providers: TauriAngularProviderBlueprint[]
  sessionOverrides: TauriSessionOverrideBlueprint[]
}

const multiProviderTokens = new Set(['ConfigProvider', 'ShellProvider'])
const providerClassImports = [
  'TauriWindowsPlatformService',
  'TauriHostWindowService',
  'TauriHostAppService',
  'TauriConfigProvider',
  'TauriPasswordStorageService',
  'TauriOneKeySecretStorageProvider',
  'TauriPTYInterface',
  'TauriWindowsShellProvider',
  'UnsupportedUpdaterService',
  'UnsupportedUACService',
]
const registryProviderClassImports = [
  'TauriSshSessionFactoryProvider',
  'TauriSshShellSessionFactoryProvider',
]

const emptyObservable = {
  subscribe: () => ({
    unsubscribe: () => undefined,
  }),
}

export class UnsupportedTauriSshProfileError extends Error {
  constructor(readonly unsupportedFeatures: string[]) {
    super(`Unsupported Tauri SSH profile features: ${unsupportedFeatures.join(', ')}`)
    this.name = 'UnsupportedTauriSshProfileError'
  }
}

export function isTauriRuntime(globalObject: Pick<typeof globalThis, 'window'> | typeof globalThis = globalThis): boolean {
  const candidate = globalObject as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown
    window?: Window & { __TAURI_INTERNALS__?: unknown }
  }
  return Boolean(candidate.__TAURI_INTERNALS__ ?? candidate.window?.__TAURI_INTERNALS__)
}

export function selectTauriProviderManifest(enabled = isTauriRuntime()): ProviderDescriptor[] {
  return enabled ? tauriMvpProviderManifest : []
}

export function createTauriAngularModuleBlueprint(enabled = isTauriRuntime()): TauriAngularModuleBlueprint {
  const manifest = selectTauriProviderManifest(enabled)
  return {
    moduleName: 'TauriHostModule',
    replacesModule: 'tabby-electron/src/index.ts ElectronModule',
    providers: manifest.map(provider => ({
      provide: provider.token,
      useClass: provider.replacement,
      multi: multiProviderTokens.has(provider.token),
      action: provider.action,
      upstreamReference: provider.token === 'PTYInterface'
        ? 'tabby-electron/src/index.ts provides PTYInterface -> ElectronPTYInterface'
        : 'tabby-tauri/src/tauri-providers.ts tauriMvpProviderManifest',
    })),
    sessionOverrides: enabled
      ? [
          {
            upstreamFile: 'tabby-local/src/session.ts',
            upstreamConstruction: 'injector.get(PTYInterface).spawn(command, args, options)',
            tauriReplacement: 'TauriPTYInterface.spawn(command, args, options)',
            rationale: 'Local sessions already resolve PTYInterface through Angular DI, so the Tauri module can replace the Electron PTY provider at the provider-token seam.',
          },
          {
            upstreamFile: 'tabby-ssh/src/components/sshTab.component.ts',
            upstreamConstruction: 'injector.get(SSHSessionFactory).create(injector, profile) + injector.get(SSHShellSessionFactory).create(injector, sshSession, profile)',
            tauriReplacement: 'Tauri-provided SSHSessionFactory can route supported profiles through toSshConnectRequest(...) and the Rust SSH command surface; Tauri-provided SSHShellSessionFactory can return a TauriSSHShellSession-compatible BaseSession for terminal wiring.',
            rationale: 'Upstream SSH connection and shell-session construction now have injectable factory seams, so the Tauri host can replace the transport and shell adapter without patching SSHTabComponent for each backend.',
          },
        ]
      : [],
  }
}

export function renderTauriAngularHostModuleSource(
  blueprint: TauriAngularModuleBlueprint = createTauriAngularModuleBlueprint(true),
): string {
  const providerRows = blueprint.providers
    .filter(provider => provider.provide !== 'SSHSession')
    .map(provider => {
      const multi = provider.multi ? ', multi: true' : ''
      return `        { provide: ${provider.provide}, useClass: ${provider.useClass}${multi} },`
    })

  return [
    "import { NgModule } from '@angular/core'",
    "import { ConfigProvider, HostAppService, HostWindowService, OneKeySecretStorageProvider, PlatformService, UpdaterService } from 'tabby-core'",
    "import { PTYInterface, ShellProvider, UACService } from 'tabby-local'",
    "import { PasswordStorageService, SSHSessionFactory, SSHShellSessionFactory } from 'tabby-ssh'",
    "import {",
    ...providerClassImports.map(name => `  ${name},`),
    "} from './tauri-providers'",
    "import {",
    ...registryProviderClassImports.map(name => `  ${name},`),
    "} from './tauri-tabby-session-registry'",
    '',
    '/**',
    ` * Host module draft for replacing ${blueprint.replacesModule}.`,
    ' * Local terminal integration is provider-token based through PTYInterface.',
    ' * SSH transport integration is routed through tabby-ssh SSHSessionFactory',
    ' * and SSHShellSessionFactory. The upstream tabby-tauri host package now',
    ' * carries the concrete provider-module implementation; this draft remains',
    ' * a generated review/handoff artifact.',
    ' */',
    '@NgModule({',
    '    providers: [',
    ...providerRows,
    '    ],',
    '})',
    'export default class TauriHostModule { }',
    '',
  ].join('\n')
}

export function createTauriTabbySessionFactories(
  providers: Pick<TauriMvpProviderSet, 'rawPty' | 'ssh'> = createTauriMvpProviders(),
): TauriTabbySessionFactories {
  return {
    local: options =>
      new TauriLocalTerminalSession(providers.rawPty, {
        request: toPtySpawnRequest(options),
      }),
    ssh: options =>
      new TauriSSHShellSession(providers.ssh, {
        request: options.request,
        size: options.size,
        transport: 'russh',
      }),
  }
}

export function createTauriSshShellSessionFromProfile(
  providers: Pick<TauriMvpProviderSet, 'ssh'>,
  profile: TauriTabbySshProfile,
  size: SshShellSize = { cols: 80, rows: 24 },
): TauriSSHShellSession {
  return new TauriSSHShellSession(providers.ssh, {
    request: toSshConnectRequest(profile),
    size,
    transport: 'russh',
  })
}

export class TauriSshSessionFactoryHandle {
  readonly serviceMessage$ = emptyObservable
  readonly keyboardInteractivePrompt$ = emptyObservable
  readonly willDestroy$ = emptyObservable
  open = false

  constructor(
    readonly profile: TauriTabbySshProfile,
    readonly request: SshConnectRequest,
  ) {}

  async start(): Promise<void> {
    this.open = true
  }

  ref(): void {
    // Tauri MVP does not support SSH multiplexing yet; keep the upstream call shape.
  }

  unref(): void {
    // Tauri MVP does not support SSH multiplexing yet; keep the upstream call shape.
  }

  async destroy(): Promise<void> {
    this.open = false
  }
}

export class TauriSshSessionFactoryProvider {
  create(_injector: unknown, profile: TauriTabbySshProfile): TauriSshSessionFactoryHandle {
    return new TauriSshSessionFactoryHandle(profile, toSshConnectRequest(profile))
  }
}

export class TauriSshShellSessionFactoryProvider {
  constructor(
    private readonly providers: Pick<TauriMvpProviderSet, 'ssh'> = createTauriMvpProviders(),
    private readonly defaultSize: SshShellSize = { cols: 80, rows: 24 },
  ) {}

  create(
    _injector: unknown,
    ssh: TauriSshSessionFactoryHandle,
    profile: TauriTabbySshProfile,
  ): TauriSSHShellSession {
    return new TauriSSHShellSession(this.providers.ssh, {
      request: ssh.profile === profile ? ssh.request : toSshConnectRequest(profile),
      size: this.defaultSize,
      transport: 'russh',
    })
  }
}

export function getUnsupportedTauriSshProfileFeatures(profile: TauriTabbySshProfile): string[] {
  const options = profile.options
  const unsupported: string[] = []

  if (options.auth === 'agent') {
    unsupported.push('agent auth')
  }
  if (options.jumpHost) {
    unsupported.push('jump host')
  }
  if (options.agentForward) {
    unsupported.push('agent forwarding')
  }
  if (options.x11) {
    unsupported.push('X11 forwarding')
  }
  if (options.proxyCommand) {
    unsupported.push('proxy command')
  }
  for (const fw of options.forwardedPorts ?? []) {
    if (fw.type !== 'Local' && fw.type !== 'Dynamic' && fw.type !== 'Remote') {
      unsupported.push(`port forwarding type ${fw.type}`)
    }
  }
  if (options.socksProxyHost) {
    unsupported.push('SOCKS proxy')
  }
  if (options.httpProxyHost) {
    unsupported.push('HTTP proxy')
  }

  return unsupported
}

export function toSshConnectRequest(profile: TauriTabbySshProfile): SshConnectRequest {
  const unsupportedFeatures = getUnsupportedTauriSshProfileFeatures(profile)
  if (unsupportedFeatures.length > 0) {
    throw new UnsupportedTauriSshProfileError(unsupportedFeatures)
  }

  const options = profile.options
  const privateKeys = options.privateKeys ?? []
  const privateKeyPath = privateKeys[0]
  const password = options.password ?? ''
  const hostKeyFingerprint = options.hostKeyFingerprint ?? null

  if (options.auth === 'keyboardInteractive') {
    if (!hostKeyFingerprint) {
      throw new UnsupportedTauriSshProfileError(['host key fingerprint required'])
    }
    return {
      host: options.host,
      port: options.port ?? 22,
      username: options.user,
      auth: {
        type: 'keyboard-interactive',
        prompt_provider: 'renderer',
      },
      host_key_fingerprint: hostKeyFingerprint,
      unsupported_features: [],
    }
  }

  if (options.auth === 'publicKey' || privateKeyPath) {
    if (!privateKeyPath) {
      throw new UnsupportedTauriSshProfileError(['public key auth without a private key path'])
    }
    if (!hostKeyFingerprint) {
      throw new UnsupportedTauriSshProfileError(['host key fingerprint required'])
    }
    return {
      host: options.host,
      port: options.port ?? 22,
      username: options.user,
      auth: privateKeys.length > 1
        ? {
            type: 'private-keys',
            private_keys: privateKeys.map(private_key_path => ({ private_key_path })),
          }
        : {
            type: 'private-key',
            private_key_path: privateKeyPath,
          },
      host_key_fingerprint: hostKeyFingerprint,
      unsupported_features: [],
    }
  }

  if (options.auth === 'password' || password) {
    if (!password) {
      throw new UnsupportedTauriSshProfileError(['password auth without a saved password'])
    }
    if (!hostKeyFingerprint) {
      throw new UnsupportedTauriSshProfileError(['host key fingerprint required'])
    }
    return {
      host: options.host,
      port: options.port ?? 22,
      username: options.user,
      auth: {
        type: 'password',
        password,
      },
      host_key_fingerprint: hostKeyFingerprint,
      unsupported_features: [],
    }
  }

  throw new UnsupportedTauriSshProfileError(['prompted SSH auth'])
}

export function toPtySpawnRequest(options: TauriTabbyLocalSessionOptions): PtySpawnRequest {
  return {
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd ?? null,
    env: Object.entries(options.env ?? {}),
    size: {
      cols: options.width ?? 80,
      rows: options.height ?? 30,
    },
  }
}
