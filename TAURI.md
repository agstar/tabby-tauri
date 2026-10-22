# Tabby Tauri

基于 [Tabby](https://tabby.sh) 前端体验的非官方 **Tauri v2 + Rust 后端移植版**。

本项目保留 Tabby 熟悉的 Angular/xterm UI、主题、标签页和 SSH/SFTP 工作流，同时把 Electron/Node.js 负责的真实系统能力逐步迁移到可审计、可测试的 Rust/Tauri provider。当前主要验证目标是 **Windows + WebView2**。

> 本仓库不是 Tabby 官方发行版，也不隶属于 `tabby.sh` 或 [Eugeny/tabby](https://github.com/Eugeny/tabby)。`Tabby Tauri` 是用于说明移植方向的工作名：它表示“Tabby 的 Tauri/Rust 移植实验”，不是独立声明的上游品牌。

## Why This Exists

Electron 版 Tabby 功能完整、生态成熟，但它的桌面运行时依赖 Node.js、Electron IPC、动态插件加载和部分原生模块。本项目尝试另一条路径：

- 用 Rust/Tauri 承载本地终端、SSH、SFTP、文件、凭据、窗口和网络能力。
- 让 WebView 前端只通过明确的 provider/command 访问系统能力。
- 避免在 Tauri 里伪造完整 Node/Electron 运行时。
- 在不牺牲用户体验的前提下，降低启动、内存、IPC 和渲染路径的成本。

性能目标是“更轻、更可控”，但不把它包装成已经全面超过上游。真实结论应以本仓库的测量脚本和具体场景数据为准。

## Current Status

这是一个实验性 Windows MVP。日常 SSH、本地终端、SFTP 和常见文件传输路径正在向可用状态收敛；高级 Electron/Node 插件生态和部分 SSH 高风险能力仍未迁移。

状态说明：

- `Supported`：已有 Tauri/Rust provider 或 Tauri 专用实现。
- `Partial`：主路径可用，但和 Electron 版仍有范围差异。
- `Unsupported`：明确隐藏、禁用或以 explicit unsupported 方式拒绝。

| Area | Status | Notes |
|---|---:|---|
| Tabby UI, tabs, themes, xterm rendering | Supported | 复用 Tabby 前端，并加入 Tauri 启动页、窗口控制、菜单、resize/repaint 修复。 |
| Local Windows terminal | Supported | Rust PTY 后端，覆盖 cmd、PowerShell、pwsh 等主路径。 |
| SSH password/private-key auth | Supported | Rust SSH 后端，不走 Electron `russh` 路径。 |
| SSH keyboard-interactive auth | Supported | renderer prompt 通道已接入。 |
| SSH host key trust / known hosts | Supported | 登录前校验，信任结果由 Tauri/Rust 侧保存和查询。 |
| SSH multiple private keys | Supported | 按配置顺序尝试多个私钥。 |
| SFTP browsing and remote file ops | Supported | readdir、stat、read、write、mkdir、rename、unlink、chmod 等由 Rust 提供。 |
| Upload/download and native dialogs | Supported | 文件与目录选择、保存路径、传输路径走 Tauri/Rust provider。 |
| OneKey credential reuse | Supported | SSH 配置和终端内密码提示可引用 OneKey，secret 不写入明文配置。 |
| SSH local port forwarding | Supported | Rust listener + SSH direct-tcpip provider。 |
| SSH dynamic SOCKS5 forwarding | Supported | SSH profile 动态转发走 Rust SOCKS5 listener。 |
| SSH remote port forwarding | Partial | 已有 provider-backed 路径，当前以 loopback/受限策略为主。 |
| Telnet / TCP client | Partial | 出站 TCP client provider 可用，泛用 Node server socket 不支持。 |
| Third-party Electron/Node plugins | Unsupported | Tauri MVP 只支持内置/静态插件；不加载 Electron 动态插件目录。 |
| SSH agent auth / forwarding | Unsupported | 需要单独的 Windows/OpenSSH/Pageant 安全策略。 |
| SSH jump host, X11, ProxyCommand, outbound proxy | Unsupported | 需要独立 provider、host key 策略和命令执行审计。 |
| Auto-update / UAC elevation / docking | Unsupported | 当前 Windows MVP 隐藏或禁用这些入口。 |
| Generic Node `fs/http/https/tls/net` runtime | Unsupported | 不提供假 Node runtime；需要具体产品能力时再迁移为窄 provider。 |

更细的支持矩阵见：

- [.omx/plans/tauri-unsupported-matrix.md](.omx/plans/tauri-unsupported-matrix.md)
- [.omx/plans/tauri-node-electron-migration-matrix.md](.omx/plans/tauri-node-electron-migration-matrix.md)

## Product Name

目前建议公开使用 **Tabby Tauri**，原因很简单：

- 它诚实表达了项目性质：这是 Tabby 的 Tauri/Rust 移植，不是从零开始的新终端。
- 用户一眼能看懂差异点，不需要学习一个陌生品牌。
- README 已明确“非官方、不隶属上游”，能降低和官方 Tabby 混淆的风险。

如果未来要做独立发行版、官网、包管理器发布或商业化，再统一改为全新品牌更合适。那时需要一起修改应用名、bundle identifier、图标、README、release 包名和上游归属说明。

## Repository Layout

| Path | Purpose |
|---|---|
| `tabby/` | 上游 Tabby 前端、共享模块，以及 Tauri 入口、provider、guard、polyfill。 |
| `tabby/tauri-app/` | Tauri v2 应用壳、Rust 后端、构建脚本、迁移测试和性能测量脚本。 |
| `.omx/plans/` | 迁移矩阵、能力台账和性能/验证记录。 |

Tauri 路径命名约定：

- `tauri-providers`：真实系统能力，由 Tauri/Rust 后端支持。
- `tauri-guards`：故意拒绝的泛用 Node/Electron API。
- `tauri-polyfills`：只补齐浏览器行为的小型工具，不伪装系统能力。

## Build And Run

Prerequisites:

- Windows 10/11 with WebView2.
- Node.js and npm.
- Yarn for the upstream Tabby workspace.
- Rust toolchain and Tauri v2 prerequisites.

Install dependencies:

```powershell
yarn install

cd tauri-app
npm install
```

Run the Tauri app in development mode:

```powershell
cd tauri-app
npm run dev
```

Build the Tauri renderer bundle:

```powershell
cd tauri-app
npm run build:tabby-web
```

Build a release package:

```powershell
cd tauri-app
npm run build
```

The Windows release executable is usually generated at:

```text
tauri-app/src-tauri/target/release/tabby-tauri.exe
```

## Verification

Before publishing changes, run:

```powershell
cd tauri-app
npm test
npm run check:no-electron
npm run build:tabby-web
```

Useful targeted checks:

```powershell
# Guard that Electron/Node runtime paths do not re-enter the Tauri renderer graph
npm run check:no-electron

# SSH/SFTP and renderer migration tests
node --test tests/tauri-renderer-ssh.test.mjs
node --test tests/tauri-renderer-start-page.test.mjs
```

Performance and smoke scripts are available under `tauri-app/scripts`, including SSH acceptance, command matrix, high-output stress, memory, process tree, idle CPU and renderer responsiveness measurements.

## Development Principles

- Preserve Tabby UX first: no performance optimization should make terminal interaction, tab switching, SFTP, SSH prompts or settings feel worse.
- Prefer narrow provider contracts over broad compatibility shims.
- Do not silently no-op unsupported features; hide, disable or reject them explicitly.
- Keep system access auditable on the Rust/Tauri side.
- Every newly supported capability should update provider typing, Rust commands, command registration/capabilities, UI visibility, migration matrix and tests together.

## Roadmap

Near-term work:

- Continue xterm output-path and inactive-tab performance tuning.
- Broaden real SSH/SFTP smoke coverage.
- Improve Windows packaging polish, icons, title and release metadata.
- Tighten startup cost by lazy-loading settings, plugin manager, SFTP and SSH profile surfaces.

Future work:

- Tauri-safe plugin API instead of Electron dynamic plugin loading.
- SSH agent auth and forwarding with an explicit security model.
- SSH jump host and outbound proxy providers.
- macOS/Linux host capability validation after Windows MVP is stable.

## Relationship To Upstream

This repository includes substantial code from the upstream [Tabby](https://github.com/Eugeny/tabby) project. The upstream source under `tabby/` remains governed by its original MIT license notice in [tabby/LICENSE](tabby/LICENSE).

Please report issues with this Tauri/Rust port in this repository. Issues about the official Electron-based Tabby application should go to the upstream project.
