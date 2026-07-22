# Tauri 应用内消息框实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Tauri 的所有 `showMessageBox` 调用改为始终可见的应用内模态框，同时保留 Enter 默认继续粘贴、Esc 取消和关闭后恢复终端焦点的行为。

**Architecture:** 在 `tabby-core` 中提供唯一的 `MessageBoxModalComponent`，Web 与 Tauri 平台服务都通过 `NgbModal` 打开该组件。Tauri 前端不再调用 Rust `show_message_box`，Rust 主机删除 `MessageBoxW` 命令和配套逻辑；外部 `PlatformService.showMessageBox(options): Promise<MessageBoxResult>` 契约保持不变。

**Tech Stack:** Angular 15、ng-bootstrap 14、Pug、SCSS、TypeScript 4.9、Node.js `node:test`、Tauri 2、Rust 2021、PowerShell。

## Global Constraints

- Tauri 中所有 `showMessageBox` 都必须显示在 Tabby 应用窗口内部。
- 多行粘贴弹窗按 Enter 时默认继续粘贴；按 Esc、取消按钮或关闭按钮时取消。
- 详细内容必须保留换行，在受限高度内滚动，不得撑出可视区域。
- 弹窗关闭后必须恢复此前的终端输入焦点。
- 保持 `Promise<{ response: number }>`、按钮顺序、`defaultId` 和 `cancelId` 语义不变。
- 弹窗取消或关闭时返回 `options.cancelId ?? 1`，与现有 Web 行为一致。
- Electron 平台不在本次改动范围内。
- 不增加依赖，不增加消息框队列，不改变多行粘贴检测和预览长度。
- `C:/Users/25414_618jq3y/workspace/js/tabby2rust/tabby` 是 Git 仓库；`C:/Users/25414_618jq3y/workspace/js/tabby2rust/tabby-tauri` 是同一产品的非 Git Rust/Tauri 外壳。提交只包含前者，后者通过测试和构建结果验收。
- `tabby-core/src/api/index.ts` 与 `tabby-tauri/src/index.ts` 已包含用户的既有未提交改动；不得整文件暂存或回退。Core API 只交互式暂存新增导出所在的独立 hunk，Tauri 平台文件保持在工作区并通过差异与构建验证。

---

## 文件结构

- 创建 `tabby-core/src/components/messageBoxModal.component.ts`：共享消息框组件、默认按钮键盘处理和安全聚焦。
- 创建 `tabby-core/src/components/messageBoxModal.component.pug`：应用内消息框结构、关闭按钮、详情和操作按钮。
- 创建 `tabby-core/src/components/messageBoxModal.component.scss`：多行详情的换行、最大高度和内部滚动。
- 修改 `tabby-core/src/index.ts`：在 Core Angular 模块中声明并导出共享组件。
- 修改 `tabby-core/src/api/index.ts`：从 `tabby-core` 公共入口导出共享组件类型。
- 修改 `tabby-web/src/platform.ts`：改用 Core 共享组件并明确允许 Esc 关闭。
- 修改 `tabby-web/src/index.ts`：移除 Web 私有消息框声明。
- 删除 `tabby-web/src/components/messageBoxModal.component.ts`：移除重复实现。
- 删除 `tabby-web/src/components/messageBoxModal.component.pug`：移除重复模板。
- 修改 `tabby-tauri/src/index.ts`：用 `NgbModal` 打开应用内消息框并在隐藏后恢复焦点。
- 修改 `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs`：增加共享组件、平台接入和 Rust 原生命令移除的契约测试。
- 修改 `../tabby-tauri/src-tauri/src/main.rs`：删除原生消息框命令、Win32 调用、注册和专用测试。

---

### Task 1: 创建 Core 共享消息框组件

**Files:**
- Create: `tabby-core/src/components/messageBoxModal.component.ts`
- Create: `tabby-core/src/components/messageBoxModal.component.pug`
- Create: `tabby-core/src/components/messageBoxModal.component.scss`
- Modify: `tabby-core/src/index.ts:13-33,107-149`
- Modify: `tabby-core/src/api/index.ts:1-21`
- Test: `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs`

**Interfaces:**
- Consumes: `MessageBoxOptions`，字段为 `message: string`、`detail?: string`、`buttons: string[]`、`defaultId?: number`、`cancelId?: number`。
- Produces: `MessageBoxModalComponent`，公开输入 `options: MessageBoxOptions`，按钮通过 `NgbActiveModal.close(index)` 返回索引，关闭按钮通过 `NgbActiveModal.dismiss()` 进入取消路径。

- [ ] **Step 1: 写入共享组件的失败契约测试**

在 `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs` 中加入：

```js
test('Shared message box component preserves keyboard defaults and long details', () => {
  const component = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'components', 'messageBoxModal.component.ts'), 'utf8')
  const template = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'components', 'messageBoxModal.component.pug'), 'utf8')
  const styles = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'components', 'messageBoxModal.component.scss'), 'utf8')
  const coreModule = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'index.ts'), 'utf8')
  const coreApi = readFileSync(resolve(repoRoot, 'tabby', 'tabby-core', 'src', 'api', 'index.ts'), 'utf8')

  assert.match(component, /@HostListener\(['"]document:keydown['"]/, 'message box must own Enter while it is open')
  assert.match(component, /event\.key !== 'Enter'/, 'non-Enter keys must not activate the default button')
  assert.match(component, /isValidButtonIndex\(this\.options\?\.defaultId\)/, 'Enter must only use a valid defaultId')
  assert.match(component, /querySelector<HTMLButtonElement>\(['"]button\[autofocus\]['"]\)\?\.focus\(\)/, 'missing default buttons must not throw during focus')
  assert.match(component, /this\.modalInstance\.dismiss\(\)/, 'the visible close button must dismiss into the cancel path')
  assert.match(template, /button\.btn-close/, 'the in-app message box must expose a visible close button')
  assert.match(template, /pre\.message-box-detail/, 'detail text must use a whitespace-preserving element')
  assert.match(styles, /white-space:\s*pre-wrap/, 'detail text must preserve line breaks')
  assert.match(styles, /max-height:/, 'long detail text must remain bounded')
  assert.match(styles, /overflow-y:\s*auto/, 'long detail text must scroll inside the modal')
  assert.match(coreModule, /declarations:\s*\[[^\]]*MessageBoxModalComponent/, 'CoreModule must declare the shared component')
  assert.match(coreModule, /exports:\s*\[[^\]]*MessageBoxModalComponent/, 'CoreModule must export the shared component')
  assert.match(coreApi, /export \{ MessageBoxModalComponent \} from '\.\.\/components\/messageBoxModal\.component'/, 'tabby-core must export the shared component type')
})
```

- [ ] **Step 2: 运行测试并确认它因共享文件不存在而失败**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Shared message box component" tests/tauri-renderer-start-page.test.mjs
```

Expected: FAIL，错误包含 `ENOENT` 和 `messageBoxModal.component.ts`。

- [ ] **Step 3: 实现最小共享组件**

创建 `tabby-core/src/components/messageBoxModal.component.ts`：

```ts
import { AfterViewInit, Component, ElementRef, HostListener, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { MessageBoxOptions } from '../api/platform'

/** @hidden */
@Component({
    templateUrl: './messageBoxModal.component.pug',
    styleUrls: ['./messageBoxModal.component.scss'],
})
export class MessageBoxModalComponent implements AfterViewInit {
    @Input() options: MessageBoxOptions

    constructor (
        private element: ElementRef<HTMLElement>,
        private modalInstance: NgbActiveModal,
    ) { }

    ngAfterViewInit (): void {
        this.element.nativeElement.querySelector<HTMLButtonElement>('button[autofocus]')?.focus()
    }

    @HostListener('document:keydown', ['$event'])
    onKeyDown (event: KeyboardEvent): void {
        if (event.key !== 'Enter' || !this.isValidButtonIndex(this.options?.defaultId)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.modalInstance.close(this.options.defaultId)
    }

    onButton (index: number): void {
        this.modalInstance.close(index)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }

    private isValidButtonIndex (index: number | undefined): index is number {
        return index !== undefined && index >= 0 && index < this.options.buttons.length
    }
}
```

创建 `tabby-core/src/components/messageBoxModal.component.pug`：

```pug
.modal-header
    h5.modal-title {{options.message}}
    button.btn-close(
        type='button',
        aria-label='Close',
        (click)='cancel()',
    )

.modal-body(*ngIf='options.detail')
    pre.message-box-detail {{options.detail}}

.modal-footer
    .ms-auto
    button.btn(
        *ngFor='let button of options.buttons; index as i',
        type='button',
        [attr.autofocus]='i === options.defaultId ? true : null',
        [class.btn-primary]='i === options.defaultId',
        [class.btn-secondary]='i !== options.defaultId',
        (click)='onButton(i)',
    ) {{button}}
```

创建 `tabby-core/src/components/messageBoxModal.component.scss`：

```scss
.message-box-detail {
    max-height: min(50vh, 24rem);
    margin: 0;
    overflow-wrap: anywhere;
    overflow-y: auto;
    color: inherit;
    background: transparent;
    font: inherit;
    white-space: pre-wrap;
}
```

在 `tabby-core/src/index.ts` 顶部组件导入区加入：

```ts
import { MessageBoxModalComponent } from './components/messageBoxModal.component'
```

并分别在 `declarations` 与 `exports` 数组中加入：

```ts
MessageBoxModalComponent,
```

在 `tabby-core/src/api/index.ts` 的组件导出区加入：

```ts
export { MessageBoxModalComponent } from '../components/messageBoxModal.component'
```

- [ ] **Step 4: 运行共享组件契约和 TypeScript 检查**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Shared message box component" tests/tauri-renderer-start-page.test.mjs
cd ..\tabby
yarn tsc -p tsconfig.tauri.json --noEmit
```

Expected: 契约测试 PASS；TypeScript 退出码为 0。

- [ ] **Step 5: 提交共享组件**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby
git add tabby-core/src/components/messageBoxModal.component.ts tabby-core/src/components/messageBoxModal.component.pug tabby-core/src/components/messageBoxModal.component.scss tabby-core/src/index.ts
git add -p tabby-core/src/api/index.ts
git diff --cached -- tabby-core/src/api/index.ts
git commit -m "确保确认操作始终呈现在应用窗口内" -m "Constraint: Tauri 与 Web 必须共享同一消息框组件`nRejected: 在 Tauri 包内复制组件 | 会形成两套漂移实现`nConfidence: high`nScope-risk: moderate`nTested: 共享组件契约测试与 tsconfig.tauri TypeScript 检查"
```

在 `git add -p` 中，只对包含 `MessageBoxModalComponent` 导出的 hunk 输入 `y`，对包含既有 `OneKey` 导出的 hunk 输入 `n`。提交前的缓存差异不得包含 `OneKey`。契约测试位于非 Git 的同级 Tauri 外壳目录，不会进入此提交，但必须保留在工作区并在后续完整验证中执行。

---

### Task 2: 让 Web 与 Tauri 平台使用共享应用内弹窗

**Files:**
- Modify: `tabby-web/src/platform.ts:3-10,93-104`
- Modify: `tabby-web/src/index.ts:1-30`
- Delete: `tabby-web/src/components/messageBoxModal.component.ts`
- Delete: `tabby-web/src/components/messageBoxModal.component.pug`
- Modify: `tabby-tauri/src/index.ts:5-40,1097-1102,1205-1210`
- Test: `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs`

**Interfaces:**
- Consumes: Task 1 导出的 `MessageBoxModalComponent`。
- Produces: Web 与 Tauri 的 `showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult>`；关闭或 Esc 返回 `{ response: options.cancelId ?? 1 }`，按钮选择返回 `{ response: index }`。

- [ ] **Step 1: 写入平台接入的失败契约测试**

在 `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs` 中加入：

```js
test('Web and Tauri platforms open the shared in-app message box', () => {
  const tauriHost = readFileSync(resolve(repoRoot, 'tabby', 'tabby-tauri', 'src', 'index.ts'), 'utf8')
  const webPlatform = readFileSync(resolve(repoRoot, 'tabby', 'tabby-web', 'src', 'platform.ts'), 'utf8')
  const webModule = readFileSync(resolve(repoRoot, 'tabby', 'tabby-web', 'src', 'index.ts'), 'utf8')
  const oldWebComponent = resolve(repoRoot, 'tabby', 'tabby-web', 'src', 'components', 'messageBoxModal.component.ts')
  const oldWebTemplate = resolve(repoRoot, 'tabby', 'tabby-web', 'src', 'components', 'messageBoxModal.component.pug')

  assert.match(tauriHost, /MessageBoxModalComponent[\s\S]*from 'tabby-core'/, 'Tauri must import the shared Core component')
  assert.match(tauriHost, /private ngbModal: NgbModal/, 'Tauri platform service must receive NgbModal')
  assert.match(tauriHost, /this\.ngbModal\.open\(MessageBoxModalComponent,\s*\{\s*backdrop:\s*'static',\s*keyboard:\s*true,?\s*\}\)/, 'Tauri must open a static in-app modal with Escape enabled')
  assert.match(tauriHost, /modal\.hidden\.subscribe\([\s\S]*previouslyFocusedElement\.focus\(\)/, 'Tauri must restore focus after the modal is fully hidden')
  assert.match(tauriHost, /return \{ response: options\.cancelId \?\? 1 \}/, 'Tauri dismissals must preserve the Web cancel contract')
  assert.doesNotMatch(tauriHost, /invoke<MessageBoxResult>\(['"]show_message_box['"]/, 'Tauri must not call a native message box command')
  assert.match(webPlatform, /MessageBoxModalComponent[\s\S]*from 'tabby-core'/, 'Web must import the shared Core component')
  assert.match(webPlatform, /backdrop:\s*'static',[\s\S]*keyboard:\s*true/, 'Web must keep the same modal dismissal behavior')
  assert.doesNotMatch(webModule, /messageBoxModal\.component/, 'WebModule must not declare a duplicate component')
  assert.equal(existsSync(oldWebComponent), false, 'the duplicate Web component must be deleted')
  assert.equal(existsSync(oldWebTemplate), false, 'the duplicate Web template must be deleted')
})
```

同时在现有测试 `Tauri native platform methods are provider-backed or explicit unsupported` 中，将原生消息框正向断言：

```js
assert.match(
  tauriHostSource,
  /showMessageBox\s*\(options:\s*MessageBoxOptions\):\s*Promise<MessageBoxResult>\s*\{\s*return invoke<MessageBoxResult>\(['"]show_message_box['"],\s*\{\s*options\s*\}\)/,
  'Tauri showMessageBox must delegate to a native provider instead of returning response 0',
)
```

替换为：

```js
assert.match(
  tauriHostSource,
  /showMessageBox\s*\(options:\s*MessageBoxOptions\):\s*Promise<MessageBoxResult>[\s\S]*this\.ngbModal\.open\(MessageBoxModalComponent/,
  'Tauri showMessageBox must use the shared in-app modal instead of a hidden native window',
)
```

- [ ] **Step 2: 运行测试并确认它因 Tauri 仍调用原生命令而失败**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Web and Tauri platforms|Tauri native platform methods" tests/tauri-renderer-start-page.test.mjs
```

Expected: FAIL，至少包含 `Tauri must import the shared Core component` 或 `Tauri must not call a native message box command`。

- [ ] **Step 3: 修改 Web 平台并删除重复组件**

把 `tabby-web/src/platform.ts` 的 Core 导入改为包含共享组件：

```ts
import { PlatformService, ClipboardContent, MenuItemOptions, MessageBoxOptions, MessageBoxResult, MessageBoxModalComponent, FileUpload, FileUploadOptions, FileDownload, DirectoryDownload, HTMLFileUpload, DirectoryUpload } from 'tabby-core'
```

删除本地导入：

```ts
import { MessageBoxModalComponent } from './components/messageBoxModal.component'
```

将 Web 的模态框选项改为：

```ts
const modal = this.ngbModal.open(MessageBoxModalComponent, {
    backdrop: 'static',
    keyboard: true,
})
```

从 `tabby-web/src/index.ts` 删除本地组件导入和整个空的 `declarations` 数组，并删除：

```text
tabby-web/src/components/messageBoxModal.component.ts
tabby-web/src/components/messageBoxModal.component.pug
```

- [ ] **Step 4: 修改 Tauri 平台并恢复焦点**

在 `tabby-tauri/src/index.ts` 从 `tabby-core` 导入 `MessageBoxModalComponent`，并把构造函数改为：

```ts
constructor (
    @Inject(BOOTSTRAP_DATA) private bootstrapData: TauriHostBootstrapData,
    private zone: NgZone,
    private ngbModal: NgbModal,
) {
    super()
}
```

用以下实现替换单行原生调用：

```ts
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
```

- [ ] **Step 5: 运行平台契约、类型检查和 Tauri 前端构建**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Web and Tauri platforms|Tauri native platform methods" tests/tauri-renderer-start-page.test.mjs
cd ..\tabby
yarn tsc -p tsconfig.tauri.json --noEmit
cd ..\tabby-tauri
npm run build:tabby-web
```

Expected: 两个目标测试 PASS；TypeScript 退出码为 0；Webpack 输出 `compiled successfully`。

- [ ] **Step 6: 提交平台接入**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby
git add tabby-web/src/platform.ts tabby-web/src/index.ts tabby-web/src/components/messageBoxModal.component.ts tabby-web/src/components/messageBoxModal.component.pug
git diff --cached --name-only
git commit -m "让 Web 复用共享确认框交互" -m "Constraint: Enter 继续默认操作，Esc 与关闭返回 cancelId`nRejected: 保留 Web 私有组件 | 会导致平台行为漂移`nConfidence: high`nScope-risk: narrow`nTested: 平台契约测试、tsconfig.tauri TypeScript 检查、Tauri renderer 构建"
```

`tabby-tauri/src/index.ts` 因含有大量既有未提交功能，不进入本提交；不得用 `git add tabby-tauri/src/index.ts` 暂存整文件。其消息框改动通过 Task 4 的定向差异、类型检查和构建证据验收。

---

### Task 3: 删除 Rust 原生消息框命令

**Files:**
- Modify: `../tabby-tauri/src-tauri/src/main.rs:75-78,846-867,1161-1240,1934,2032-2039,2107-2134`
- Test: `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs`

**Interfaces:**
- Consumes: Task 2 已不再调用 `show_message_box`。
- Produces: Rust invoke handler 中不存在 `show_message_box`；`WindowsAndMessaging` 仍保留 `SW_SHOWNORMAL` 供 `ShellExecuteW` 使用。

- [ ] **Step 1: 写入 Rust 原生命令移除的失败契约测试**

在 `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs` 中加入：

```js
test('Rust host no longer exposes a native message box command', () => {
  const main = readFileSync(resolve(repoRoot, 'tabby-tauri', 'src-tauri', 'src', 'main.rs'), 'utf8')

  assert.doesNotMatch(main, /fn show_message_box\b/, 'Rust must not expose the obsolete native command')
  assert.doesNotMatch(main, /show_message_box,/, 'the obsolete command must not remain in the invoke handler')
  assert.doesNotMatch(main, /MessageBoxW|NativeMessageBoxOptions|NativeMessageBoxResult/, 'Win32 message box implementation must be removed')
  assert.match(main, /WindowsAndMessaging::SW_SHOWNORMAL/, 'ShellExecuteW must keep the remaining WindowsAndMessaging constant')
})
```

- [ ] **Step 2: 运行测试并确认它因 Rust 命令仍存在而失败**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Rust host no longer exposes" tests/tauri-renderer-start-page.test.mjs
```

Expected: FAIL，包含 `Rust must not expose the obsolete native command`。

- [ ] **Step 3: 删除 Rust 命令、Win32 实现和注册**

把 `../tabby-tauri/src-tauri/src/main.rs` 的 Windows 消息导入收窄为：

```rust
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
```

完整删除以下符号及其实现块：

```rust
NativeMessageBoxOptions
NativeMessageBoxResult
show_message_box
validate_message_box_options
message_box_body
map_message_box_response
show_message_box_native
```

从 `tauri::generate_handler!` 列表删除：

```rust
show_message_box,
```

把 Rust 测试模块导入收窄为不包含消息框符号：

```rust
use super::{
    fallback_fonts, format_windows_release, parse_test_tabs_from_args, parse_windows_font_name,
    parse_winscp_default_icon, validate_clipboard_text, validate_exec_allowlist_with_winscp,
    validate_external_target, validate_open_path_target, winscp_com_path, ExecAllowlistMode,
};
```

删除：

```rust
use windows_sys::Win32::UI::WindowsAndMessaging::{IDCANCEL, IDOK};
```

将 `validates_native_clipboard_and_message_box_input` 测试替换为：

```rust
#[test]
fn validates_native_clipboard_input() {
    assert!(validate_clipboard_text("copy me").is_ok());
    assert!(validate_clipboard_text("bad\0copy").is_err());
}
```

完整删除测试 `maps_native_message_box_response_to_button_indexes`。

- [ ] **Step 4: 运行 Rust 移除契约和 Rust 测试**

Run:

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
node --test --test-name-pattern="Rust host no longer exposes" tests/tauri-renderer-start-page.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: 契约测试 PASS；Rust 测试全部通过且编译输出中没有未使用的消息框导入错误。

- [ ] **Step 5: 记录非 Git 外壳的验证状态**

`tabby-tauri` 外壳目录不是 Git 仓库，因此此任务不创建提交。执行：

```powershell
rg -n "show_message_box|MessageBoxW|NativeMessageBox" C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri\src-tauri\src\main.rs
```

Expected: 无输出，退出码为 1，表示目标符号已全部移除。

---

### Task 4: 完整回归验证

**Files:**
- Verify: `tabby-core/src/components/messageBoxModal.component.*`
- Verify: `tabby-web/src/platform.ts`
- Verify: `tabby-tauri/src/index.ts`
- Verify: `../tabby-tauri/src-tauri/src/main.rs`
- Verify: `../tabby-tauri/tests/tauri-renderer-start-page.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-3 的完整应用内消息框路径。
- Produces: 可进入发布构建的前端与 Rust 验证证据。

- [ ] **Step 1: 运行 Tauri 全部 Node 契约测试**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
npm test
```

Expected: 所有测试 PASS，失败数为 0。

- [ ] **Step 2: 检查 Tauri 渲染器依赖边界**

```powershell
npm run check:no-electron
```

Expected: 两个无 Electron/Node 泄漏检查退出码均为 0。

- [ ] **Step 3: 运行变更文件 lint 与 TypeScript 检查**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby
yarn eslint tabby-core/src/components/messageBoxModal.component.ts tabby-core/src/index.ts tabby-core/src/api/index.ts tabby-web/src/index.ts tabby-web/src/platform.ts tabby-tauri/src/index.ts
yarn tsc -p tsconfig.tauri.json --noEmit
```

Expected: 两条命令退出码均为 0。

- [ ] **Step 4: 重新构建 Tauri renderer 并运行 Rust 测试**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
npm run build:tabby-web
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: Webpack `compiled successfully`；Rust 测试失败数为 0。

- [ ] **Step 5: 检查最终差异只包含预期消息框改动**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby
git diff --check -- tabby-core/src/components/messageBoxModal.component.ts tabby-core/src/components/messageBoxModal.component.pug tabby-core/src/components/messageBoxModal.component.scss tabby-core/src/index.ts tabby-core/src/api/index.ts tabby-web/src/index.ts tabby-web/src/platform.ts tabby-tauri/src/index.ts
git status --short
git diff -- tabby-core/src/components/messageBoxModal.component.ts tabby-core/src/components/messageBoxModal.component.pug tabby-core/src/components/messageBoxModal.component.scss tabby-core/src/index.ts tabby-core/src/api/index.ts tabby-web/src/index.ts tabby-web/src/platform.ts tabby-tauri/src/index.ts
```

Expected: 定向 `git diff --check` 无输出；消息框差异与本计划一致；工作区其他既有改动保持不变，`tabby-tauri/src/index.ts` 仍未被整文件暂存。

---

### Task 5: 构建发布版并替换 bin 软件

**Files:**
- Build output: `../tabby-tauri/src-tauri/target/release/tabby-tauri.exe`
- Replace: `C:/Users/25414_618jq3y/bin/tabby-tauri.exe`

**Interfaces:**
- Consumes: Task 4 验证通过的 renderer 与 Rust 主机。
- Produces: `C:/Users/25414_618jq3y/bin/tabby-tauri.exe`，其 SHA-256 与新发布构建一致。

- [ ] **Step 1: 构建 Tauri 发布版**

```powershell
cd C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri
npm run build
```

Expected: 命令退出码为 0，生成 `src-tauri/target/release/tabby-tauri.exe` 和 NSIS 包。

- [ ] **Step 2: 校验发布产物存在且非空**

```powershell
$source = 'C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri\src-tauri\target\release\tabby-tauri.exe'
$item = Get-Item -LiteralPath $source
if ($item.Length -le 0) { throw 'release executable is empty' }
Get-FileHash -Algorithm SHA256 -LiteralPath $source
```

Expected: 文件长度大于 0，并输出 SHA-256。

- [ ] **Step 3: 备份并替换 bin 中的软件**

```powershell
$source = 'C:\Users\25414_618jq3y\workspace\js\tabby2rust\tabby-tauri\src-tauri\target\release\tabby-tauri.exe'
$target = 'C:\Users\25414_618jq3y\bin\tabby-tauri.exe'
$backup = "${target}.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Get-Process -Name 'tabby-tauri' -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup }
Copy-Item -LiteralPath $source -Destination $target -Force
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash
if ($sourceHash -ne $targetHash) { throw 'bin executable hash does not match release build' }
```

Expected: 目标文件替换成功，源文件与目标文件 SHA-256 完全一致，并保留带时间戳的旧版本备份。

- [ ] **Step 4: 启动新软件并验证应用内弹窗行为**

启动可见窗口：

```powershell
$target = 'C:\Users\25414_618jq3y\bin\tabby-tauri.exe'
$process = Start-Process -FilePath $target -PassThru
Start-Sleep -Seconds 5
if ($process.HasExited) { throw "tabby-tauri exited early with code $($process.ExitCode)" }
```

使用桌面 UI 自动化完成以下固定序列：

1. 打开一个终端标签。
2. 将 `echo first`、换行、`echo second` 两行文本复制到剪贴板并粘贴。
3. 确认 Tabby 窗口内部出现带遮罩的消息框，详情区域显示两行文本，任务栏没有新增独立消息框窗口。
4. 按 Esc，确认没有粘贴且终端立即恢复输入。
5. 再次粘贴相同两行文本，按 Enter，确认两行文本进入终端。
6. 第三次打开弹窗并点击右上角关闭按钮，确认等同取消且终端恢复输入。

Expected: 三条交互路径均符合验收标准，应用无卡死、无后台原生消息框。

- [ ] **Step 5: 结束冒烟实例并记录最终证据**

```powershell
Get-Process -Name 'tabby-tauri' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Item -LiteralPath C:\Users\25414_618jq3y\bin\tabby-tauri.exe | Select-Object FullName, Length, LastWriteTime
Get-FileHash -Algorithm SHA256 -LiteralPath C:\Users\25414_618jq3y\bin\tabby-tauri.exe
```

Expected: 输出已替换文件的路径、大小、修改时间和最终 SHA-256；没有残留的 `tabby-tauri` 进程。
