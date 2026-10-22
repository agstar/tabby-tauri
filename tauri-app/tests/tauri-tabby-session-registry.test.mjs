import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function importCompiledRegistry() {
  const outDir = await mkdtemp(join(tmpdir(), 'tabby-tauri-registry-'))
  await writeFile(join(outDir, 'package.json'), '{"type":"module"}\n')
  const tauriApiStubDir = join(outDir, 'node_modules', '@tauri-apps', 'api')
  await mkdir(tauriApiStubDir, { recursive: true })
  await writeFile(
    join(tauriApiStubDir, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: {
        './core': './core.js',
        './window': './window.js',
      },
    }),
  )
  await writeFile(
    join(tauriApiStubDir, 'core.js'),
    'export class Channel { constructor () { this.onmessage = undefined } }\nexport async function invoke () { throw new Error("Tauri invoke stub called") }\n',
  )
  await writeFile(
    join(tauriApiStubDir, 'window.js'),
    'export function getCurrentWindow () { return { listen: async () => () => {} } }\n',
  )
  await execFileAsync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      '--skipLibCheck',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      'src/tauri-tabby-session-registry.ts',
      'src/tauri-providers.ts',
    ],
    { cwd: process.cwd() },
  )

  return {
    registry: await import(pathToFileURL(join(outDir, 'tauri-tabby-session-registry.js'))),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  }
}

test('selectTauriProviderManifest only returns replacements inside Tauri runtime', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(registry.selectTauriProviderManifest(false), [])
    assert.ok(registry.selectTauriProviderManifest(true).some(provider => provider.token === 'PTYInterface'))
  } finally {
    await cleanup()
  }
})

test('createTauriAngularModuleBlueprint maps upstream Angular provider seams', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    const disabled = registry.createTauriAngularModuleBlueprint(false)
    assert.equal(disabled.moduleName, 'TauriHostModule')
    assert.deepEqual(disabled.providers, [])
    assert.deepEqual(disabled.sessionOverrides, [])

    const enabled = registry.createTauriAngularModuleBlueprint(true)
    assert.equal(enabled.replacesModule, 'tabby-electron/src/index.ts ElectronModule')
    assert.deepEqual(
      enabled.providers.find(provider => provider.provide === 'PTYInterface'),
      {
        provide: 'PTYInterface',
        useClass: 'TauriPTYInterface',
        multi: false,
        action: 'implement-subset',
        upstreamReference: 'tabby-electron/src/index.ts provides PTYInterface -> ElectronPTYInterface',
      },
    )
    assert.deepEqual(
      enabled.providers
        .filter(provider => provider.provide.endsWith('SessionFactory'))
        .map(provider => [provider.provide, provider.useClass])
        .sort(),
      [
        ['SSHSessionFactory', 'TauriSshSessionFactoryProvider'],
        ['SSHShellSessionFactory', 'TauriSshShellSessionFactoryProvider'],
      ],
    )
    assert.deepEqual(
      enabled.providers.find(provider => provider.provide === 'PasswordStorageService'),
      {
        provide: 'PasswordStorageService',
        useClass: 'TauriPasswordStorageService',
        multi: false,
        action: 'implement-subset',
        upstreamReference: 'tabby-tauri/src/tauri-providers.ts tauriMvpProviderManifest',
      },
    )
    assert.deepEqual(
      enabled.providers
        .filter(provider => provider.multi)
        .map(provider => provider.provide)
        .sort(),
      ['ConfigProvider', 'ShellProvider'],
    )
    assert.ok(
      enabled.sessionOverrides.some(override =>
        override.upstreamFile === 'tabby-ssh/src/components/sshTab.component.ts' &&
        override.upstreamConstruction.includes('SSHSessionFactory') &&
        override.upstreamConstruction.includes('SSHShellSessionFactory') &&
        override.tauriReplacement.includes('TauriSSHShellSession'),
      ),
    )
  } finally {
    await cleanup()
  }
})

test('renderTauriAngularHostModuleSource emits a consumable provider-module draft', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    const source = registry.renderTauriAngularHostModuleSource(
      registry.createTauriAngularModuleBlueprint(true),
    )

    assert.match(source, /export default class TauriHostModule/)
    assert.match(source, /\{ provide: PTYInterface, useClass: TauriPTYInterface \}/)
    assert.match(source, /import \{ PasswordStorageService, SSHSessionFactory, SSHShellSessionFactory \} from 'tabby-ssh'/)
    assert.match(source, /\{ provide: SSHSessionFactory, useClass: TauriSshSessionFactoryProvider \}/)
    assert.match(source, /\{ provide: SSHShellSessionFactory, useClass: TauriSshShellSessionFactoryProvider \}/)
    assert.match(source, /\{ provide: PasswordStorageService, useClass: TauriPasswordStorageService \}/)
    assert.match(source, /\{ provide: ShellProvider, useClass: TauriWindowsShellProvider, multi: true \}/)
    assert.match(source, /tabby-ssh SSHSessionFactory/)
    assert.match(source, /SSHShellSessionFactory/)
    assert.doesNotMatch(source, /provide: SSHSession[,}]/)
  } finally {
    await cleanup()
  }
})

test('toPtySpawnRequest maps Tabby local session options to Rust PTY request', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(
      registry.toPtySpawnRequest({
        command: 'cmd.exe',
        args: ['/d'],
        cwd: 'C:/work',
        env: { TERM: 'xterm-256color' },
        width: 132,
        height: 43,
      }),
      {
        command: 'cmd.exe',
        args: ['/d'],
        cwd: 'C:/work',
        env: [['TERM', 'xterm-256color']],
        size: { cols: 132, rows: 43 },
      },
    )
  } finally {
    await cleanup()
  }
})

test('toSshConnectRequest maps supported Tabby SSH password and private-key profiles', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(
      registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          port: 2222,
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
          hostKeyFingerprint: 'SHA256:example',
        },
      }),
      {
        host: 'example.test',
        port: 2222,
        username: 'alice',
        auth: { type: 'password', password: 'secret' },
        host_key_fingerprint: 'SHA256:example',
        unsupported_features: [],
      },
    )

    assert.deepEqual(
      registry.toSshConnectRequest({
        options: {
          host: '10.1.4.123',
          port: 22,
          user: 'devops',
          auth: 'password',
          password: 'secret',
          reuseSession: true,
          hostKeyFingerprint: 'SHA256:remote',
        },
      }),
      {
        host: '10.1.4.123',
        port: 22,
        username: 'devops',
        auth: { type: 'password', password: 'secret' },
        host_key_fingerprint: 'SHA256:remote',
        unsupported_features: [],
      },
      'Tauri should accept Tabby default reuseSession=true and manage each shell with its own Rust transport',
    )

    assert.deepEqual(
      registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'publicKey',
          privateKeys: ['C:/Users/alice/.ssh/id_ed25519'],
          hostKeyFingerprint: 'SHA256:key',
        },
      }),
      {
        host: 'example.test',
        port: 22,
        username: 'alice',
        auth: {
          type: 'private-key',
          private_key_path: 'C:/Users/alice/.ssh/id_ed25519',
        },
        host_key_fingerprint: 'SHA256:key',
        unsupported_features: [],
      },
    )
  } finally {
    await cleanup()
  }
})

test('toSshConnectRequest rejects unsupported upstream SSH profile features explicitly', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(
      registry.getUnsupportedTauriSshProfileFeatures({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'agent',
          jumpHost: 'bastion',
          forwardedPorts: [{ type: 'Dynamic' }, { type: 'Remote' }],
          socksProxyHost: '127.0.0.1',
          privateKeys: ['a', 'b'],
        },
      }),
      ['agent auth', 'jump host', 'SOCKS proxy'],
    )

    assert.deepEqual(
      registry.getUnsupportedTauriSshProfileFeatures({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
          hostKeyFingerprint: 'SHA256:local-forward',
          forwardedPorts: [{
            type: 'Local',
            host: '127.0.0.1',
            port: 8080,
            targetAddress: '127.0.0.1',
            targetPort: 80,
          }, {
            type: 'Dynamic',
            host: '127.0.0.1',
            port: 1080,
          }, {
            type: 'Remote',
            host: '127.0.0.1',
            port: 9000,
            targetAddress: '127.0.0.1',
            targetPort: 9001,
          }],
        },
      }),
      [],
      'Tauri should allow local TCP, dynamic SOCKS, and remote forwarding profiles',
    )

    assert.deepEqual(
      registry.getUnsupportedTauriSshProfileFeatures({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
          forwardedPorts: [{ type: 'UnsupportedForwardType' }],
        },
      }),
      ['port forwarding type UnsupportedForwardType'],
      'Tauri should reject unknown port-forwarding types explicitly instead of ignoring them',
    )

    assert.throws(
      () => registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: null,
          privateKeys: [],
        },
      }),
      error =>
        error.name === 'UnsupportedTauriSshProfileError' &&
        error.unsupportedFeatures.includes('prompted SSH auth'),
    )

    assert.throws(
      () => registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
        },
      }),
      error =>
        error.name === 'UnsupportedTauriSshProfileError' &&
        error.unsupportedFeatures.includes('host key fingerprint required'),
    )
  } finally {
    await cleanup()
  }
})

test('toSshConnectRequest maps keyboard-interactive profiles to a renderer prompt auth request', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(
      registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          port: 22,
          user: 'alice',
          auth: 'keyboardInteractive',
          privateKeys: [],
          hostKeyFingerprint: 'SHA256:keyboard',
        },
      }),
      {
        host: 'example.test',
        port: 22,
        username: 'alice',
        auth: {
          type: 'keyboard-interactive',
          prompt_provider: 'renderer',
        },
        host_key_fingerprint: 'SHA256:keyboard',
        unsupported_features: [],
      },
    )
  } finally {
    await cleanup()
  }
})

test('toSshConnectRequest maps multiple private keys in configured order', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    assert.deepEqual(
      registry.toSshConnectRequest({
        options: {
          host: 'example.test',
          port: 22,
          user: 'alice',
          auth: 'publicKey',
          privateKeys: [
            'C:/Users/alice/.ssh/id_bad',
            'C:/Users/alice/.ssh/id_ed25519',
          ],
          hostKeyFingerprint: 'SHA256:keys',
        },
      }),
      {
        host: 'example.test',
        port: 22,
        username: 'alice',
        auth: {
          type: 'private-keys',
          private_keys: [
            { private_key_path: 'C:/Users/alice/.ssh/id_bad' },
            { private_key_path: 'C:/Users/alice/.ssh/id_ed25519' },
          ],
        },
        host_key_fingerprint: 'SHA256:keys',
        unsupported_features: [],
      },
    )
  } finally {
    await cleanup()
  }
})

test('createTauriSshShellSessionFromProfile instantiates a runnable Tauri SSH shell adapter', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    const calls = []
    const snapshot = (session_id, state = 'running') => ({
      session_id,
      kind: 'ssh',
      state,
      last_activity_at: 1,
      bytes_in: 0,
      bytes_out: 0,
      queue_depth: 0,
      reader_paused: false,
      close_reason: null,
      error_reason: null,
    })
    const ssh = {
      async connectTransport(request) {
        calls.push(['connectTransport', request.host, request.port, request.username, request.auth.type])
        return { session: snapshot('ssh-profile-1', 'starting'), transport_status: 'russh-connected' }
      },
      async openShellTransport(sessionId, size) {
        calls.push(['openShellTransport', sessionId, size.cols, size.rows])
        return snapshot(sessionId)
      },
      async streamTransport(sessionId) {
        calls.push(['streamTransport', sessionId])
        return snapshot(sessionId)
      },
      async ack() {},
    }

    const session = registry.createTauriSshShellSessionFromProfile(
      { ssh },
      {
        options: {
          host: 'example.test',
          port: 2222,
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
          hostKeyFingerprint: 'SHA256:profile',
        },
      },
      { cols: 132, rows: 43 },
    )

    assert.equal((await session.start()).session_id, 'ssh-profile-1')
    assert.equal(session.open, true)
    assert.deepEqual(calls, [
      ['connectTransport', 'example.test', 2222, 'alice', 'password'],
      ['openShellTransport', 'ssh-profile-1', 132, 43],
      ['streamTransport', 'ssh-profile-1'],
    ])
  } finally {
    await cleanup()
  }
})

test('Tauri SSH factory providers expose upstream factory-compatible create methods', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    const calls = []
    const snapshot = (session_id, state = 'running') => ({
      session_id,
      kind: 'ssh',
      state,
      last_activity_at: 1,
      bytes_in: 0,
      bytes_out: 0,
      queue_depth: 0,
      reader_paused: false,
      close_reason: null,
      error_reason: null,
    })
    const ssh = {
      async connectTransport(request) {
        calls.push(['connectTransport', request.username])
        return { session: snapshot('factory-ssh-1', 'starting'), transport_status: 'russh-connected' }
      },
      async openShellTransport(sessionId, size) {
        calls.push(['openShellTransport', sessionId, size.cols, size.rows])
        return snapshot(sessionId)
      },
      async streamTransport(sessionId) {
        calls.push(['streamTransport', sessionId])
        return snapshot(sessionId)
      },
      async ack() {},
    }
    const profile = {
      options: {
        host: 'example.test',
        user: 'alice',
        auth: 'password',
        password: 'secret',
        privateKeys: [],
        hostKeyFingerprint: 'SHA256:factory',
      },
    }

    const sessionFactory = new registry.TauriSshSessionFactoryProvider()
    const shellFactory = new registry.TauriSshShellSessionFactoryProvider({ ssh }, { cols: 100, rows: 40 })
    const sshHandle = sessionFactory.create({}, profile)
    await sshHandle.start()

    const shell = shellFactory.create({}, sshHandle, profile)
    assert.equal((await shell.start()).session_id, 'factory-ssh-1')
    assert.deepEqual(calls, [
      ['connectTransport', 'alice'],
      ['openShellTransport', 'factory-ssh-1', 100, 40],
      ['streamTransport', 'factory-ssh-1'],
    ])

    assert.throws(
      () => sessionFactory.create({}, {
        options: {
          host: 'example.test',
          user: 'alice',
          auth: 'password',
          password: 'secret',
          privateKeys: [],
          jumpHost: 'bastion',
          hostKeyFingerprint: 'SHA256:factory',
        },
      }),
      error =>
        error.name === 'UnsupportedTauriSshProfileError' &&
        error.unsupportedFeatures.includes('jump host'),
    )
  } finally {
    await cleanup()
  }
})

test('createTauriTabbySessionFactories creates local and ssh session adapters from injected providers', async () => {
  const { registry, cleanup } = await importCompiledRegistry()
  try {
    const rawPty = {}
    const ssh = {}
    const factories = registry.createTauriTabbySessionFactories({ rawPty, ssh })

    const local = factories.local({ command: 'powershell.exe' })
    const remote = factories.ssh({
      request: {
        host: '127.0.0.1',
        port: 22,
        username: 'tabby',
        auth: { type: 'password', password: 'secret' },
      },
      size: { cols: 80, rows: 24 },
    })

    assert.equal(local.supportsWorkingDirectory(), true)
    assert.equal(remote.supportsWorkingDirectory(), false)
  } finally {
    await cleanup()
  }
})
