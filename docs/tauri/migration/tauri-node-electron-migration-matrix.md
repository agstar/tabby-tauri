# Tauri Node/Electron API Migration Matrix

This matrix is the execution ledger for migrating the Tauri build away from
Node.js/Electron runtime assumptions. It is intentionally separate from the
general unsupported matrix: a row here means a Node/Electron API is either:

1. reachable from the current Tauri renderer graph and must be migrated, or
2. present in Electron-only code that must remain excluded from the Tauri graph.

The first two columns are parsed by
`tauri-app/scripts/check-tauri-node-electron-graph.mjs`.

## Policy

- Tauri MVP plugin mode is **built-in/static plugins only** through
  `app/src/entry.tauri.ts`.
- Third-party Electron/Node plugins are unavailable until a separate Tauri-safe
  manifest/sandbox compatibility milestone is approved.
- The legacy `app/src/tauri-shims/*` namespace is removed. Tauri paths must
  be explicit: Rust/Tauri-backed modules live under `tauri-providers`, intentional
  rejections under `tauri-guards`, and small browser-only helpers under
  `tauri-polyfills`.
- Provider contracts must agree across runtime registration, public typings,
  generated helpers, Tauri capabilities, and tests before a feature is
  considered supported.

## Provider contract targets

| Contract | Replaces | Target owner | Frontend boundary | Verification owner |
|---|---|---|---|---|
| `tauri_bootstrap_data` / `native_env_snapshot` | fake `process.env`, Electron bootstrap IPC | `tauri-app/src-tauri/src/main.rs` | `app/src/entry.tauri.ts`, Tauri host services | graph guard + local shell PATH smoke |
| `tauri_plugin_manifest` | `@electron/remote`, `require('module')`, `global.require` plugin loader | `app/src/entry.tauri.ts` + future Rust app paths provider | built-in static plugin list for MVP | graph exclusion test |
| `native_path_exists` / `native_stat_path` | sync `fs.existsSync` / `mz/fs` path probes | `tauri-app/src-tauri/src/native_files.rs` | `PlatformService` / file-provider boundary | static import guard + cwd tests |
| `native_vault_crypto` | Node `crypto` PBKDF/random/cipher APIs | future `tauri-app/src-tauri/src/vault.rs` | `VaultService` Tauri branch | fixture compatibility tests |
| `tauri_ssh_provider` | Electron `russh` direct APIs | `tauri-app/src-tauri/src/ssh.rs` | `TauriSshConnection` / SSH factories | SSH command matrix + SFTP smoke |
| `native_tcp_forwarding` | Node `net.createServer` / `socksv5` | Rust SSH local TCP provider, dynamic SOCKS5 listener, and remote tcpip-forward bridge | SSH forwarding service boundary | listener lifecycle, SOCKS, and remote forwarding roundtrip tests |
| browser-native stream processor | Node `stream` / `readline` terminal middleware | `tabby-terminal` pure TS implementation | terminal middleware abstraction | processor fixture tests |

## Reachable migration rows

| Pattern | File | Current API/import | Target provider/action | Priority | Removal acceptance |
|---|---|---|---|---|---|
| `node-crypto` | `tabby-core/src/services/vault.service.ts` | Node `crypto` PBKDF/random/cipher | `native_vault_crypto` Rust provider | P1 | **Completed 2026-05-21:** `VaultCryptoProvider` is overridden by `TauriVaultCryptoProvider`; Rust fixture tests cover Node-compatible decrypt/encrypt |
| `node-fs` | `tabby-local/src/cli.ts` | `mz/fs` path probes | `native_path_exists` / `native_stat_path` | P1 | **Completed 2026-05-21:** CLI path handling uses `PlatformService.statPath`, with Tauri backed by Rust `native_stat_path` |
| `node-fs` | `tabby-local/src/services/terminal.service.ts` | sync `fs.existsSync` CWD check | `native_path_exists` via platform boundary | P1 | **Completed 2026-05-21:** local profile CWD validation uses `PlatformService.pathExists` and no longer imports sync `fs` |
| `node-fs` | `tabby-local/src/session.ts` | `mz/fs` + sync `fs` CWD checks | native path provider or Tauri-specific split | P1 | **Completed 2026-05-21:** local session CWD/access/realpath checks use `PlatformService` native path providers |
| `direct-russh` | `tabby-ssh/src/algorithms.ts` | Electron `russh` algorithm helpers | Rust/typed provider or static capability data | P1/P2 | **Completed 2026-05-21:** algorithm capabilities are static TypeScript data and no longer import direct `russh` |
| `direct-russh` | `tabby-ssh/src/components/sshTab.component.ts` | Electron `russh` types/runtime | Tauri SSH abstractions only | P1/P2 | **Completed 2026-05-21:** SSH tab depends on `SSHConnectionLike`/factory contracts and has no direct `russh` import |
| `node-crypto` | `tabby-ssh/src/services/ssh.service.ts` | Node `crypto` key/hash helpers | Rust SSH/key provider | P1/P2 | **Completed 2026-05-21:** WinSCP key hash uses WebCrypto and no longer imports Node `crypto` in the Tauri graph |
| `node-net` | `tabby-ssh/src/session/forwards.ts` | Node `net.createServer` local listener | Rust SSH local TCP listener + dynamic SOCKS5 listener + remote `tcpip-forward` bridge + russh `direct-tcpip` provider | P2 | **Completed 2026-05-22 for local, dynamic, and remote forwarding:** Electron forwarding implementation is excluded from Tauri; Tauri local TCP forwarding uses `ssh_start_local_port_forward`, dynamic SOCKS uses `ssh_start_dynamic_port_forward`, and remote forwarding uses `ssh_start_remote_port_forward` |
| `socksv5` | `tabby-ssh/src/session/forwards.ts` | `@luminati-io/socksv5` dynamic listener | Rust SOCKS listener provider | P2 | **Completed 2026-05-22 for SSH profile dynamic forwarding; namespace cleanup 2026-05-24:** Electron SOCKS implementation is excluded from Tauri; SSH profile dynamic forwarding uses a Rust SOCKS5 listener; generic `socksv5` package calls route to `app/src/tauri-guards/socksv5.ts` and reject explicitly |
| `direct-russh` | `tabby-ssh/src/session/sftp.ts` | Electron `russh` SFTP types/runtime | `TauriSftpSession` + Rust `russh-sftp` | P1/P2 | **Completed 2026-05-21:** shared UI imports SFTP contracts from `session/types`; Electron SFTP implementation is excluded from Tauri graph |
| `direct-russh` | `tabby-ssh/src/session/shell.ts` | Electron `russh` shell channel | `TauriSshShellSession` + Rust channel | P1/P2 | **Completed 2026-05-21:** Tauri shell uses `TauriSshShellSession`; Electron shell implementation is excluded from Tauri graph |
| `direct-russh` | `tabby-ssh/src/session/ssh.ts` | Electron `russh` client/auth/transport | Rust SSH provider | P1/P2 | **Completed 2026-05-21 for graph migration:** Tauri uses `TauriSshConnection`; Electron SSH transport is excluded while unsupported advanced features stay explicit |
| `direct-russh-keyboard-interactive` | `tabby-ssh/src/session/ssh.ts` | Electron keyboard-interactive prompt loop | Rust SSH prompt provider + shared renderer prompt panel | P1 | **Completed 2026-05-22:** Tauri request typing, command registration, and Rust auth state machine use `ssh_connect_transport_interactive` / `ssh_keyboard_interactive_respond`; `Subject<never>` removed |
| `direct-russh-private-key-list` | `tabby-ssh/src/session/ssh.ts` | Electron ordered private-key auth attempts | Rust SSH ordered `PrivateKeyCandidate` provider | P1 | **Completed 2026-05-22:** Tauri request typing maps multiple keys to `private-keys`; Rust tries candidates in order and redacts passphrases/errors |
| `node-crypto` | `tabby-ssh/src/session/ssh.ts` | Node `crypto` SSH helper behavior | Rust SSH/key provider | P1/P2 | **Completed 2026-05-21:** Electron SSH implementation is excluded from Tauri graph |
| `node-fs` | `tabby-ssh/src/session/ssh.ts` | `mz/fs` key/config file access | native file/key provider | P1/P2 | **Completed 2026-05-21:** Electron key-loading implementation is excluded; Tauri SSH key path handling is owned by Rust request construction |
| `node-net` | `tabby-ssh/src/session/ssh.ts` | Node sockets for proxy/agent paths | Rust TCP/agent provider | P2/P3 | **Completed 2026-05-22 for forwarding:** Electron proxy/agent sockets are excluded; local, dynamic, and remote SSH forwarding are Rust-backed; proxy/agent features remain explicitly unsupported until provider-backed |
| `node-net` | `tabby-ssh/src/session/x11.ts` | Node socket X11 forwarding | future Rust provider or keep unsupported | P4 | **Completed 2026-05-21 for graph migration:** settings use pure display-spec parsing; Electron X11 socket implementation is excluded from Tauri graph |
| `node-readline` | `tabby-terminal/src/middleware/streamProcessing.ts` | Node `readline` | browser-native line editor/transform | P2 | **Completed 2026-05-21:** terminal middleware uses browser-native line buffering and no longer imports Node `readline` |
| `node-stream` | `tabby-terminal/src/middleware/streamProcessing.ts` | Node `stream` | pure TS stream processor | P2 | **Completed 2026-05-21:** terminal middleware emits directly through middleware subjects and no longer imports Node `stream` |

## Electron-only exclusion rows

These rows are not allowed to become reachable from `entry.tauri.ts`. The graph
guard must fail if they enter the Tauri runtime graph.

| Pattern | File | Current API/import | Target provider/action | Priority | Removal acceptance |
|---|---|---|---|---|---|
| `electron-import` | `app/src/entry.ts` | Electron `ipcRenderer` bootstrap | excluded Electron-only entry; Tauri uses `entry.tauri.ts` | P1 | graph guard proves `entry.ts` unreachable |
| `electron-remote` | `app/src/plugins.ts` | `@electron/remote` app paths | Tauri static plugin manifest / app paths provider | P1 | graph guard proves `plugins.ts` unreachable |
| `node-module-loader` | `app/src/plugins.ts` | `require('module')` dynamic plugin loader | Tauri built-in static plugins for MVP | P1 | no module-loader path in Tauri graph |
| `dynamic-global-require` | `app/src/plugins.ts` | `global['require']` plugin loading | Tauri manifest/sandbox future API | P1 | no global require in Tauri graph |
| `module-prototype-require` | `app/src/plugins.ts` | `Module.prototype.require` monkey patch | forbidden in Tauri runtime | P1 | no module monkey patch in Tauri graph |
| `node-fs` | `app/src/plugins.ts` | `mz/fs` plugin discovery | Tauri static plugin manifest / app paths provider | P1 | Electron plugin loader remains excluded |




