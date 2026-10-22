# Tabby Tauri

[English](README.md) | **简体中文**

Tabby Tauri 是基于 [Tabby](https://tabby.sh) 的非官方 **Tauri v2 + Rust** 桌面移植版。它保留 Tabby 熟悉的 Angular/xterm 界面、标签页、主题、配置文件和 SSH/SFTP 工作流，同时把系统能力从 Electron/Node.js 迁移到明确的 Tauri command 和 Rust provider。

这是一个实验性的 Windows MVP，不是 Tabby 官方发行版，也不隶属于 `tabby.sh` 或 [Eugeny/tabby](https://github.com/Eugeny/tabby)。

## 为什么做这个项目

Electron 版 Tabby 功能完整、生态成熟，但桌面运行时依赖 Node.js、Electron IPC、动态插件加载和原生模块。本项目尝试另一种实现路径：

- 用 Rust 承载终端、SSH、SFTP、文件、凭据、窗口和网络等系统能力。
- 让 WebView 渲染器只通过明确的 provider 契约和 Tauri command 访问系统能力。
- 避免在 Tauri 中嵌入一个不完整的 Node.js 或 Electron 兼容运行时。
- 在保持 Tabby 使用体验的前提下，降低启动、内存和 IPC 开销。

目标是更轻、更可控的桌面运行时，并不宣称当前所有路径都已经比上游更快或更完整。

## 当前状态

Tabby Tauri 目前是 Windows 优先的 MVP。本地终端、SSH、SFTP 和常见文件传输路径已经可用；高级 Electron/Node 插件工作流和部分高风险 SSH 能力尚未迁移。

| 能力 | 状态 | 说明 |
|---|---:|---|
| Tabby UI、标签页、主题和 xterm 渲染 | 支持 | 复用 Tabby 前端，并接入 Tauri 窗口、菜单、启动页和重绘修复。 |
| 本地 Windows 终端 | 支持 | Rust PTY 后端，覆盖 cmd、PowerShell 和 pwsh。 |
| SSH 密码和私钥认证 | 支持 | 由 Rust SSH 后端实现。 |
| SSH keyboard-interactive 认证 | 支持 | 已接入渲染器提示通道。 |
| SSH host key 校验和 known hosts | 支持 | 登录前校验，由 Rust 侧保存和查询信任结果。 |
| SSH 多私钥认证 | 支持 | 按配置顺序尝试多个私钥。 |
| SFTP 浏览和远程文件操作 | 支持 | readdir、stat、read、write、mkdir、rename、unlink、chmod 均由 Rust 提供。 |
| 上传/下载和原生文件对话框 | 支持 | 文件与目录选择、保存路径和传输路径均走 Tauri provider。 |
| OneKey 凭据复用 | 支持 | SSH 配置和终端密码提示可引用 OneKey，secret 不写入明文配置。 |
| SSH 本地端口转发 | 支持 | Rust listener 加 SSH direct-tcpip provider。 |
| SSH 动态 SOCKS5 转发 | 支持 | 动态转发使用 Rust SOCKS5 listener。 |
| SSH 远程端口转发 | 部分支持 | 已有 provider 路径，但受 loopback 和受限策略限制。 |
| Telnet 和通用 TCP client | 部分支持 | 支持出站 TCP client；不支持泛用 Node server socket。 |
| 第三方 Electron/Node 插件 | 不支持 | 仅支持内置/静态插件，不加载 Electron 动态插件目录。 |
| 通用 Node `fs`、`http`、`https`、`tls`、`net` 运行时 | 不支持 | 不支持的 API 会明确失败，不会静默伪造。 |
| SSH agent 认证和转发 | 不支持 | 需要独立的 Windows/OpenSSH/Pageant 安全模型。 |
| SSH jump host、X11、ProxyCommand 和出站代理 | 不支持 | 计划作为独立、可审计的 provider 实现。 |
| 自动更新、UAC 提权和 docking | 不支持 | Tauri MVP 中隐藏或禁用这些入口。 |

第一轮 Electron 清理已经删除 `tabby-electron`、`tabby-uac` 和 `tabby-plugin-manager` 三个包。仍有部分 Electron 应用层代码和依赖，正在分阶段移除；Tauri 渲染器不会嵌入 Node.js 运行时。

## 架构

```text
Angular + xterm 渲染器
        |
        v
Tabby provider 契约和 Tauri guard
        |
        v
Tauri host bindings（tabby-tauri）
        |
        v
Rust commands 和 providers（tauri-app/src-tauri）
        |
        +-- PTY 和本地进程
        +-- SSH、SFTP 和端口转发
        +-- 文件、凭据、TCP 和原生对话框
```

渲染器不得导入 Electron、Node.js 内置模块或动态插件加载器。缺失能力应明确拒绝、从 UI 隐藏，或以 unsupported 状态报告。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `app/` | Tabby 渲染器入口、共享资源、Tauri 入口和 Tauri webpack 配置。 |
| `tabby-core/` | 核心 UI、服务、provider 契约和共享组件。 |
| `tabby-terminal/` | 终端标签页、xterm 前端和流处理。 |
| `tabby-ssh/` | SSH 配置、会话、SFTP 和端口转发 UI。 |
| `tabby-local/` | 本地 shell 配置和终端集成。 |
| `tabby-settings/` | 设置和配置管理 UI。 |
| `tabby-tauri/` | Tabby 渲染器与 Tauri 应用之间的 host binding 包。 |
| `tauri-app/` | Tauri v2 应用壳、Rust 后端、capabilities、测试和性能脚本。 |
| `tauri-app/src/` | Tauri 渲染器 bootstrap、providers 和 session adapters。 |
| `tauri-app/src-tauri/` | PTY、SSH、SFTP、文件、凭据和 TCP 的 Rust commands。 |

Provider 命名约定：

- `tauri-providers`：由 Tauri 或 Rust 支撑的真实系统能力。
- `tauri-guards`：故意拒绝的泛用 Node/Electron API。
- `tauri-polyfills`：只补齐浏览器侧行为、不伪装系统能力的小型工具。

## 环境要求

- Windows 10/11 和 WebView2。
- Node.js 和 npm。
- 用于 Tabby workspace 的 Yarn 1.x。
- Rust 工具链，以及包含 MSVC 构建工具的 Tauri v2 Windows 前置依赖。

## 快速开始

克隆仓库并安装 workspace 和 Tauri 依赖：

```powershell
git clone git@github.com:agstar/tabby-tauri.git
cd tabby-tauri
yarn install

cd tauri-app
npm install
```

启动开发模式：

```powershell
cd tauri-app
npm run dev
```

`npm run dev` 会先执行 Electron/Node 导入检查、构建 Tauri 渲染器 bundle，然后启动 `tauri dev`。

## 构建

只构建渲染器 bundle：

```powershell
cd tauri-app
npm run build:tabby-web
```

构建 release 可执行文件和 Windows NSIS 安装包：

```powershell
cd tauri-app
npm run build
```

常见输出路径：

```text
tauri-app/src-tauri/target/release/tabby-tauri.exe
tauri-app/src-tauri/target/release/bundle/nsis/
```

## 验证

运行渲染器迁移测试和 guard 检查：

```powershell
cd tauri-app
npm test
npm run check:no-electron
npm run build:tabby-web
```

运行 Rust 检查：

```powershell
cd tauri-app/src-tauri
cargo test --all-targets --no-default-features
cargo clippy --all-targets --no-default-features -- -D warnings
cargo fmt --check
```

在仓库根目录运行共享 Tabby 单元测试：

```powershell
yarn test:unit
```

运行定向 SSH 和渲染器测试：

```powershell
cd tauri-app
node --test tests/tauri-renderer-ssh.test.mjs
node --test tests/tauri-renderer-start-page.test.mjs
```

性能与验收脚本位于 `tauri-app/scripts`，包括 SSH 验收、命令矩阵、高输出压力、空闲 CPU、内存、进程树和渲染响应性测量。

## 开发原则

- 用户体验优先：终端交互、标签切换、SSH 提示、SFTP 和设置不应因为实现方便而退化。
- 优先使用窄 provider 契约，而不是宽泛的兼容 shim。
- 不要静默忽略不支持的能力；必须明确隐藏、禁用或拒绝。
- 系统访问能力应保持在 Rust/Tauri 侧并可审计。
- 新增能力时，同时更新 provider 类型、Rust command、命令注册、capabilities、UI 可见性和测试。
- 不要让 Electron 兼容层重新进入 Tauri 渲染器依赖图。

开发流程和模块边界见 [HACKING.md](HACKING.md)。

## 路线图

近期：

- 继续优化 xterm 输出路径和非活跃标签页性能。
- 扩大真实 SSH/SFTP smoke 覆盖。
- 完善 Windows 打包、图标、标题和 release 元数据。
- 继续移除剩余的 Electron 应用层代码和依赖。
- 通过延迟加载设置、SFTP 和 SSH 配置界面降低启动成本。

长期：

- 设计 Tauri 安全的插件 API，替代 Electron 动态插件加载。
- 增加带明确安全模型的 SSH agent 认证和转发。
- 增加 SSH jump host 和出站代理 provider。
- Windows MVP 稳定后，验证 macOS 和 Linux 主机能力。

## 上游与许可证

本仓库包含大量来自上游 [Tabby](https://github.com/Eugeny/tabby) 项目的代码。上游代码继续遵循 [LICENSE](LICENSE) 中的 MIT 许可证。

请在本仓库反馈 Tabby Tauri/Rust 移植相关的问题。官方 Electron 版 Tabby 的问题请提交到上游项目。
