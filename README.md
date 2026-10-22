# Tabby Tauri

**English** | [简体中文](README.zh-CN.md)

Tabby Tauri is an unofficial **Tauri v2 + Rust** desktop port of [Tabby](https://tabby.sh). It keeps Tabby's Angular/xterm interface, tabs, themes, profiles and SSH/SFTP workflows, while moving system access from Electron and Node.js to explicit Tauri commands and Rust providers.

This is an experimental Windows MVP. It is not an official Tabby release and is not affiliated with `tabby.sh` or [Eugeny/tabby](https://github.com/Eugeny/tabby).

## Why This Project

The Electron version of Tabby is mature and feature-rich, but its desktop runtime depends on Node.js, Electron IPC, dynamic plugin loading and native modules. This project explores a smaller, more auditable runtime:

- Run the terminal, SSH, SFTP, file, credential, window and networking paths in Rust.
- Let the WebView renderer access system capabilities only through explicit provider contracts and Tauri commands.
- Avoid embedding a partial Node.js or Electron compatibility runtime.
- Keep the Tabby user experience familiar while reducing startup, memory and IPC overhead.

The goal is a lighter and more controllable desktop runtime, not a claim that every path is already faster or more complete than upstream.

## Current Status

Tabby Tauri is a Windows-first MVP. Local terminal, SSH, SFTP and common file-transfer paths are usable. Advanced Electron/Node plugin workflows and several high-risk SSH features are not migrated yet.

| Area | Status | Notes |
|---|---:|---|
| Tabby UI, tabs, themes and xterm rendering | Supported | Reuses the Tabby frontend with Tauri window, menu, startup and repaint integration. |
| Local Windows terminal | Supported | Rust PTY backend covering cmd, PowerShell and pwsh. |
| SSH password and private-key authentication | Supported | Implemented in the Rust SSH backend. |
| SSH keyboard-interactive authentication | Supported | Renderer prompt channel is connected. |
| SSH host-key verification and known hosts | Supported | Host keys are checked before authentication and stored by the Rust side. |
| SSH multiple private keys | Supported | Keys are tried in configured order. |
| SFTP browsing and remote file operations | Supported | readdir, stat, read, write, mkdir, rename, unlink and chmod are Rust-backed. |
| Upload/download and native dialogs | Supported | File selection, save paths and transfers use Tauri providers. |
| OneKey credential reuse | Supported | SSH profiles and terminal password prompts can reference OneKey without writing secrets into plaintext profiles. |
| SSH local port forwarding | Supported | Rust listener with an SSH direct-tcpip provider. |
| SSH dynamic SOCKS5 forwarding | Supported | Dynamic forwarding uses a Rust SOCKS5 listener. |
| SSH remote port forwarding | Partial | Provider-backed path exists, with loopback and restricted-policy limitations. |
| Telnet and generic TCP clients | Partial | Outbound TCP client support exists; generic Node server sockets do not. |
| Third-party Electron/Node plugins | Unsupported | Only built-in/static plugins are supported; Electron plugin directories are not loaded. |
| Generic Node `fs`, `http`, `https`, `tls` and `net` runtime | Unsupported | Unsupported APIs fail explicitly instead of being silently emulated. |
| SSH agent authentication and forwarding | Unsupported | Requires a separate Windows/OpenSSH/Pageant security model. |
| SSH jump hosts, X11, ProxyCommand and outbound proxies | Unsupported | Planned as separate auditable providers. |
| Auto-update, UAC elevation and docking | Unsupported | These entry points are hidden or disabled in the Tauri MVP. |

The first Electron cleanup pass removed the `tabby-electron`, `tabby-uac` and `tabby-plugin-manager` packages. Some Electron app-layer code and dependencies still exist and are being removed incrementally. The Tauri renderer never embeds a Node.js runtime.

## Architecture

```text
Angular + xterm renderer
        |
        v
Tabby provider contracts and Tauri guards
        |
        v
Tauri host bindings (tabby-tauri)
        |
        v
Rust commands and providers (tauri-app/src-tauri)
        |
        +-- PTY and local processes
        +-- SSH, SFTP and port forwarding
        +-- Files, credentials, TCP and native dialogs
```

The renderer must not import Electron, Node.js built-ins or a dynamic plugin loader. Missing capabilities should be rejected explicitly, hidden from the UI or reported as unsupported.

## Repository Layout

| Path | Purpose |
|---|---|
| `app/` | Tabby renderer entry, shared assets, Tauri entry and Tauri webpack configuration. |
| `tabby-core/` | Core UI, services, provider contracts and shared components. |
| `tabby-terminal/` | Terminal tabs, xterm frontend and stream processing. |
| `tabby-ssh/` | SSH profiles, sessions, SFTP and forwarding UI. |
| `tabby-local/` | Local shell profiles and terminal integration. |
| `tabby-settings/` | Settings and profile management UI. |
| `tabby-tauri/` | Host binding package between the Tabby renderer and the Tauri app. |
| `tauri-app/` | Tauri v2 shell, Rust backend, capabilities, tests and measurement scripts. |
| `tauri-app/src/` | Tauri renderer bootstrap, providers and session adapters. |
| `tauri-app/src-tauri/` | Rust commands for PTY, SSH, SFTP, files, credentials and TCP. |

Provider naming convention:

- `tauri-providers`: real system capabilities backed by Tauri or Rust.
- `tauri-guards`: intentionally rejected generic Node/Electron APIs.
- `tauri-polyfills`: small browser-side helpers that do not pretend to provide system access.

## Requirements

- Windows 10/11 with WebView2.
- Node.js and npm.
- Yarn 1.x for the Tabby workspace.
- A Rust toolchain and the Tauri v2 Windows prerequisites, including the MSVC build tools.

## Quick Start

Clone the repository and install the workspace and Tauri dependencies:

```powershell
git clone git@github.com:agstar/tabby-tauri.git
cd tabby-tauri
yarn install

cd tauri-app
npm install
```

Run the desktop app in development mode:

```powershell
cd tauri-app
npm run dev
```

`npm run dev` first runs the Electron/Node import guard and builds the Tauri renderer bundle, then starts `tauri dev`.

## Build

Build only the renderer bundle:

```powershell
cd tauri-app
npm run build:tabby-web
```

Build the release executable and Windows NSIS installer:

```powershell
cd tauri-app
npm run build
```

Typical output paths:

```text
tauri-app/src-tauri/target/release/tabby-tauri.exe
tauri-app/src-tauri/target/release/bundle/nsis/
```

## Verification

Run the renderer migration tests and guard checks:

```powershell
cd tauri-app
npm test
npm run check:no-electron
npm run build:tabby-web
```

Run the Rust checks:

```powershell
cd tauri-app/src-tauri
cargo test --all-targets --no-default-features
cargo clippy --all-targets --no-default-features -- -D warnings
cargo fmt --check
```

Run the shared Tabby unit tests from the repository root:

```powershell
yarn test:unit
```

Targeted SSH and renderer tests:

```powershell
cd tauri-app
node --test tests/tauri-renderer-ssh.test.mjs
node --test tests/tauri-renderer-start-page.test.mjs
```

Performance and acceptance scripts live in `tauri-app/scripts`, including SSH acceptance, command matrices, high-output stress, idle CPU, memory, process-tree and renderer responsiveness measurements.

## Development Principles

- Preserve Tabby UX first: terminal interaction, tab switching, SSH prompts, SFTP and settings should not regress for implementation convenience.
- Prefer narrow provider contracts over broad compatibility shims.
- Do not silently no-op unsupported features. Hide, disable or reject them explicitly.
- Keep system access auditable on the Rust/Tauri side.
- When adding a capability, update provider typing, Rust commands, command registration, capabilities, UI visibility and tests together.
- Keep the Electron compatibility layer out of the Tauri renderer graph.

See [HACKING.md](HACKING.md) for the development workflow and module boundaries.

## Roadmap

Near term:

- Continue xterm output-path and inactive-tab performance work.
- Broaden real SSH/SFTP smoke coverage.
- Improve Windows packaging, icons, title and release metadata.
- Continue removing the remaining Electron app-layer code and dependencies.
- Tighten startup cost by lazy-loading settings, SFTP and SSH profile surfaces.

Longer term:

- Design a Tauri-safe plugin API instead of dynamic Electron plugin loading.
- Add SSH agent authentication and forwarding with an explicit security model.
- Add SSH jump-host and outbound proxy providers.
- Validate macOS and Linux host capabilities after the Windows MVP stabilizes.

## Upstream and License

This repository contains substantial code from the upstream [Tabby](https://github.com/Eugeny/tabby) project. Upstream code remains governed by its original MIT license in [LICENSE](LICENSE).

Report issues with this Tauri/Rust port in this repository. Issues about the official Electron-based Tabby application should go to the upstream project.
