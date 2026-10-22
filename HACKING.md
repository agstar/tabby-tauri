# Development Guide

This repository is the unofficial Tauri v2 + Rust port of Tabby. The upstream Electron application is not the default runtime here. For upstream Electron development, use [Eugeny/tabby](https://github.com/Eugeny/tabby).

## Setup

Requirements:

- Windows 10/11 with WebView2.
- Node.js, npm and Yarn 1.x.
- Rust stable and the Tauri v2 Windows prerequisites, including MSVC build tools.

Install dependencies:

```powershell
yarn install

cd tauri-app
npm install
```

Start the Tauri app:

```powershell
cd tauri-app
npm run dev
```

## Where Things Live

| Path | Responsibility |
|---|---|
| `app/` | Shared Tabby renderer entry, Tauri entry and Tauri webpack configuration. |
| `app/src/tauri-providers/` | Renderer-side implementations backed by Tauri commands. |
| `app/src/tauri-guards/` | Explicit rejections for unsupported Node/Electron APIs. |
| `app/src/tauri-polyfills/` | Small browser-side helpers with no hidden system access. |
| `tabby-core/` | Shared UI, services and provider contracts. |
| `tabby-terminal/` | Terminal tabs, xterm frontend and stream processing. |
| `tabby-ssh/` | SSH profiles, sessions, SFTP and forwarding UI. |
| `tabby-local/` | Local shell profiles and terminal integration. |
| `tabby-settings/` | Settings and profile UI. |
| `tabby-tauri/` | Host bindings between Tabby and the Tauri shell. |
| `tauri-app/src/` | Tauri renderer bootstrap, provider bridge and session adapters. |
| `tauri-app/src-tauri/src/` | Rust commands and providers for PTY, SSH, SFTP, files, credentials and TCP. |
| `tauri-app/tests/` | Renderer migration and contract tests. |
| `tauri-app/src-tauri/tests/` | Rust integration tests. |
| `tauri-app/scripts/` | Acceptance, stress and performance measurement scripts. |

## Architecture Rules

1. The renderer must not import Electron, Node.js built-ins or a dynamic Node plugin loader.
2. System access belongs behind a Tauri command and, where possible, a narrow provider contract.
3. Unsupported features must fail explicitly or be hidden from the UI. Do not silently no-op them.
4. Do not add broad compatibility shims to make an Electron module compile. Port the specific capability.
5. Keep command registration, capabilities, TypeScript provider types, UI visibility and tests in sync.
6. Preserve Tabby behavior unless the Tauri runtime requires a documented difference.

When adding a capability, the usual change set is:

- Update the provider contract and renderer implementation.
- Add or extend Rust commands in `tauri-app/src-tauri/src/`.
- Register the command and update Tauri capabilities.
- Update the relevant Tabby module and UI visibility.
- Add renderer contract tests and Rust integration tests.
- Run the full verification commands below.

## Tests

From `tauri-app`:

```powershell
npm test
npm run check:no-electron
npm run build:tabby-web
```

From `tauri-app/src-tauri`:

```powershell
cargo test --all-targets --no-default-features
cargo clippy --all-targets --no-default-features -- -D warnings
cargo fmt --check
```

From the repository root:

```powershell
yarn test:unit
```

Targeted tests can be run with:

```powershell
cd tauri-app
node --test tests/tauri-renderer-ssh.test.mjs
node --test tests/tauri-renderer-start-page.test.mjs
```

## Electron Cleanup

`tabby-electron`, `tabby-uac` and `tabby-plugin-manager` have been removed from the build. Some Electron app-layer code and dependencies remain and are being removed in stages.

Rules for the cleanup:

- Do not reintroduce Electron imports into the Tauri renderer graph.
- Keep `app/src/tauri-guards/windows-native-registry.ts` and its alias; it provides the registry-backed environment refresh used by new sessions.
- Do not delete `app/` wholesale. It still contains shared Tauri entry and webpack configuration.
- When removing a dependency, update build scripts, plugin lists and tests in the same change.

## Documentation

- `README.md`: English project overview and user-facing instructions.
- `README.zh-CN.md`: Chinese project overview.
- `HACKING.md`: development workflow and architecture rules.

Keep commands and paths relative to the repository root unless a section explicitly changes directory.
