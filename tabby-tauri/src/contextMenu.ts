import { MenuItemOptions } from 'tabby-core'

const STYLE_ELEMENT_ID = 'tabby-tauri-context-menu-style'
const ROOT_CLASS = 'tabby-tauri-context-menu'
const PANEL_CLASS = 'tabby-tauri-context-menu-panel'
const SUBMENU_CLASS = 'tabby-tauri-context-menu-submenu'
const MENU_MARGIN = 6

let activeRoot: HTMLElement | null = null
let cleanupHandlers: Array<() => void> = []

export function showTabbyContextMenu (menu: MenuItemOptions[], event?: MouseEvent): void {
    closeTabbyContextMenu()
    ensureContextMenuStyle()

    const items = stripRedundantSeparators(menu)
    if (!items.length) {
        return
    }

    const root = renderMenu(items, true)
    document.body.appendChild(root)
    activeRoot = root

    positionMenu(root, event?.clientX ?? MENU_MARGIN, event?.clientY ?? MENU_MARGIN)
    installDismissHandlers(root)
}

export function closeTabbyContextMenu (): void {
    for (const cleanup of cleanupHandlers.splice(0)) {
        cleanup()
    }
    activeRoot?.remove()
    activeRoot = null
}

function renderMenu (items: MenuItemOptions[], isRoot = false): HTMLElement {
    const container = document.createElement('div')
    container.className = `${isRoot ? ROOT_CLASS : SUBMENU_CLASS} dropdown-menu show ${PANEL_CLASS}`
    container.setAttribute('role', 'menu')
    container.tabIndex = -1

    for (const item of stripRedundantSeparators(items)) {
        if (item.type === 'separator') {
            const separator = document.createElement('div')
            separator.className = 'dropdown-divider tabby-tauri-context-menu-separator'
            separator.setAttribute('role', 'separator')
            container.appendChild(separator)
            continue
        }

        appendMenuItem(container, item)
    }

    return container
}

function appendMenuItem (container: HTMLElement, item: MenuItemOptions): void {
    const label = item.label ?? ''
    if (!label) {
        return
    }

    const enabled = item.enabled ?? true
    const row = document.createElement('div')
    row.className = 'tabby-tauri-context-menu-row'
    row.setAttribute('role', 'none')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dropdown-item tabby-tauri-context-menu-item'
    button.disabled = !enabled
    button.setAttribute('role', 'menuitem')

    const check = document.createElement('span')
    check.className = 'tabby-tauri-context-menu-check'
    if ((item.type === 'checkbox' || item.type === 'radio') && item.checked) {
        check.textContent = '✓'
    }
    button.appendChild(check)

    const labelElement = document.createElement('span')
    labelElement.className = 'tabby-tauri-context-menu-label'
    labelElement.textContent = label
    button.appendChild(labelElement)

    const commandLabel = item.commandLabel ?? item.sublabel
    if (commandLabel) {
        const command = document.createElement('span')
        command.className = 'tabby-tauri-context-menu-command'
        command.textContent = commandLabel
        button.appendChild(command)
    }

    if (item.submenu?.length) {
        button.classList.add('tabby-tauri-context-menu-has-submenu')
        button.setAttribute('aria-haspopup', 'menu')

        const caret = document.createElement('span')
        caret.className = 'tabby-tauri-context-menu-caret'
        caret.textContent = '›'
        button.appendChild(caret)

        const submenu = renderMenu(item.submenu)
        row.appendChild(button)
        row.appendChild(submenu)

        row.addEventListener('mouseenter', () => positionSubmenu(submenu))
        button.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            if (enabled) {
                positionSubmenu(submenu)
            }
        })
    } else {
        button.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            if (!enabled) {
                return
            }
            closeTabbyContextMenu()
            item.click?.()
        })
        row.appendChild(button)
    }

    container.appendChild(row)
}

function stripRedundantSeparators (items: MenuItemOptions[]): MenuItemOptions[] {
    const result: MenuItemOptions[] = []
    for (const item of items) {
        const isSeparator = item.type === 'separator'
        const previous = result[result.length - 1]
        if (isSeparator && (!result.length || previous?.type === 'separator')) {
            continue
        }
        result.push(item)
    }
    if (result[result.length - 1]?.type === 'separator') {
        result.pop()
    }
    return result
}

function positionMenu (menu: HTMLElement, x: number, y: number): void {
    menu.style.left = `${MENU_MARGIN}px`
    menu.style.top = `${MENU_MARGIN}px`

    const rect = menu.getBoundingClientRect()
    const left = clamp(x, MENU_MARGIN, Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN))
    const top = clamp(y, MENU_MARGIN, Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN))

    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
}

function positionSubmenu (submenu: HTMLElement): void {
    submenu.style.left = ''
    submenu.style.right = ''

    const rect = submenu.getBoundingClientRect()
    if (rect.right > window.innerWidth - MENU_MARGIN) {
        submenu.style.left = 'auto'
        submenu.style.right = 'calc(100% - 4px)'
    }
}

function installDismissHandlers (root: HTMLElement): void {
    const onPointerDown = (event: MouseEvent) => {
        if (!root.contains(event.target as Node)) {
            closeTabbyContextMenu()
        }
    }
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            closeTabbyContextMenu()
        }
    }
    const onWindowBlur = () => closeTabbyContextMenu()

    const pointerListenerTimer = window.setTimeout(() => document.addEventListener('mousedown', onPointerDown, true))
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur, { once: true })

    cleanupHandlers.push(
        () => {
            window.clearTimeout(pointerListenerTimer)
            document.removeEventListener('mousedown', onPointerDown, true)
        },
        () => document.removeEventListener('keydown', onKeyDown, true),
        () => window.removeEventListener('blur', onWindowBlur),
    )
}

function clamp (value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

function ensureContextMenuStyle (): void {
    if (document.getElementById(STYLE_ELEMENT_ID)) {
        return
    }

    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent = `
.${ROOT_CLASS}.${PANEL_CLASS},
.${SUBMENU_CLASS}.${PANEL_CLASS} {
    --bs-dropdown-bg: var(--theme-bg-more);
    --bs-dropdown-color: var(--bs-body-color);
    --bs-dropdown-link-color: var(--bs-body-color);
    --bs-dropdown-link-hover-color: var(--theme-fg);
    --bs-dropdown-link-hover-bg: var(--theme-bg-more-2);
    --bs-dropdown-link-disabled-color: var(--bs-secondary-color);
    position: fixed;
    display: block;
    min-width: 220px;
    max-width: min(420px, calc(100vw - 12px));
    padding: 6px 0;
    margin: 0;
    border: 1px solid var(--bs-border-color);
    border-radius: 7px;
    background: var(--bs-dropdown-bg);
    color: var(--bs-dropdown-color);
    box-shadow: 0 12px 32px rgba(0, 0, 0, .48);
    z-index: 10000;
    user-select: none;
}

.${SUBMENU_CLASS}.${PANEL_CLASS} {
    position: absolute;
    left: calc(100% - 4px);
    top: -6px;
    display: none;
}

.tabby-tauri-context-menu-row {
    position: relative;
}

.tabby-tauri-context-menu-row:hover > .${SUBMENU_CLASS}.${PANEL_CLASS},
.tabby-tauri-context-menu-row:focus-within > .${SUBMENU_CLASS}.${PANEL_CLASS} {
    display: block;
}

.tabby-tauri-context-menu-item {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 13px;
    line-height: 1.35;
    text-align: left;
    white-space: nowrap;
}

.tabby-tauri-context-menu-item:hover:not(:disabled),
.tabby-tauri-context-menu-item:focus-visible:not(:disabled) {
    background: var(--bs-dropdown-link-hover-bg);
    color: var(--bs-dropdown-link-hover-color);
    outline: none;
}

.tabby-tauri-context-menu-item:disabled {
    opacity: .45;
}

.tabby-tauri-context-menu-check,
.tabby-tauri-context-menu-caret {
    color: var(--bs-dropdown-link-color);
    opacity: .85;
}

.tabby-tauri-context-menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
}

.tabby-tauri-context-menu-command {
    color: var(--bs-secondary-color);
    font-size: 12px;
}

.tabby-tauri-context-menu-separator {
    margin: 5px 0;
    border-top-color: var(--bs-border-color);
}
`
    document.head.appendChild(style)
}
