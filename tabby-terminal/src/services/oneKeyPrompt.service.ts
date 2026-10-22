import { Injectable } from '@angular/core'
import { NotificationsService, OneKeySecretChoice, OneKeyService, TranslateService } from 'tabby-core'
import { BaseSession } from '../session'
import { OneKeyPromptEvent } from '../middleware/oneKeyPromptDetection'

export interface OneKeyPromptAnchor {
    left: number
    top: number
    lineHeight: number
    terminalElement?: HTMLElement|null
}

export interface OneKeyPromptSendTarget {
    session: BaseSession|null
    hasFocus: boolean
    title: string
    sendInput: (data: string|Buffer) => void
    getOneKeyPromptAnchor?: () => OneKeyPromptAnchor|null
    focusTerminal?: () => void
}

interface ActiveOneKeyInlineMenu {
    event: OneKeyPromptEvent
    target: OneKeyPromptSendTarget
    session: BaseSession
    element: HTMLElement
    options: HTMLElement[]
    choices: OneKeySecretChoice[]
    selectedIndex: number
    keydownHandler: (event: KeyboardEvent) => void
    pasteHandler: () => void
    mouseDownHandler: (event: MouseEvent) => void
    closeTimer: ReturnType<typeof setTimeout>
    sending: boolean
}

@Injectable({ providedIn: 'root' })
export class OneKeyPromptService {
    private activeMenu: ActiveOneKeyInlineMenu|null = null
    private promptGeneration = 0

    constructor (
        private oneKey: OneKeyService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    async handlePrompt (event: OneKeyPromptEvent, target: OneKeyPromptSendTarget, session: BaseSession): Promise<void> {
        const choices = this.oneKey.getSecretChoices(event.requestedSecretKind)
        if (!choices.length || !this.isTargetStillValid(event, target, session)) {
            return
        }

        const generation = ++this.promptGeneration
        this.closeInlineMenu()
        await this.waitForTerminalRender()
        if (generation !== this.promptGeneration || !this.isTargetStillValid(event, target, session)) {
            return
        }
        this.showInlineMenu(event, target, session, choices)
    }

    handleTerminalInput (target: OneKeyPromptSendTarget): void {
        this.promptGeneration++
        if (this.activeMenu?.target === target) {
            this.closeInlineMenu()
        }
    }

    private showInlineMenu (
        event: OneKeyPromptEvent,
        target: OneKeyPromptSendTarget,
        session: BaseSession,
        choices: OneKeySecretChoice[],
    ): void {
        this.closeInlineMenu()
        this.installInlineMenuStyles()

        const menu = document.createElement('div')
        menu.className = 'onekey-inline-menu'
        menu.setAttribute('role', 'listbox')
        menu.setAttribute('aria-label', this.translate.instant('Send OneKey credential'))

        const optionElements = choices.map((choice, index) => {
            const option = document.createElement('button')
            option.type = 'button'
            option.className = 'onekey-inline-menu-option'
            option.setAttribute('role', 'option')
            const label = document.createElement('span')
            label.className = 'onekey-inline-menu-label'
            label.textContent = choice.label
            const kind = document.createElement('span')
            kind.className = 'onekey-inline-menu-kind'
            kind.textContent = choice.kind === 'password'
                ? this.translate.instant('Password')
                : this.translate.instant('Private key passphrase')
            option.appendChild(label)
            option.appendChild(kind)
            option.addEventListener('click', clickEvent => {
                clickEvent.preventDefault()
                clickEvent.stopPropagation()
                const activeMenu = this.activeMenu
                if (activeMenu) {
                    void this.sendChoice(activeMenu, index)
                }
            })
            menu.appendChild(option)
            return option
        })

        const keydownHandler = (keyboardEvent: KeyboardEvent) => {
            const activeMenu = this.activeMenu
            if (!activeMenu || activeMenu.element !== menu) {
                return
            }
            if (!this.isMenuNavigationKey(keyboardEvent)) {
                if (this.isManualTypingKey(keyboardEvent)) {
                    this.closeInlineMenu()
                }
                return
            }
            keyboardEvent.preventDefault()
            keyboardEvent.stopPropagation()
            if (keyboardEvent.key === 'ArrowDown') {
                this.selectOption(activeMenu, activeMenu.selectedIndex + 1)
            } else if (keyboardEvent.key === 'ArrowUp') {
                this.selectOption(activeMenu, activeMenu.selectedIndex - 1)
            } else if (keyboardEvent.key === 'Enter') {
                void this.sendChoice(activeMenu, activeMenu.selectedIndex)
            } else if (keyboardEvent.key === 'Escape') {
                this.closeInlineMenu()
                target.focusTerminal?.()
            }
        }
        const pasteHandler = () => {
            this.closeInlineMenu()
        }
        const mouseDownHandler = (mouseEvent: MouseEvent) => {
            if (!menu.contains(mouseEvent.target as Node|null)) {
                this.closeInlineMenu()
            }
        }

        const closeDelay = Math.max(1000, Math.min(60_000, event.expiresAt - Date.now()))
        const activeMenu: ActiveOneKeyInlineMenu = {
            event,
            target,
            session,
            element: menu,
            options: optionElements,
            choices,
            selectedIndex: 0,
            keydownHandler,
            pasteHandler,
            mouseDownHandler,
            closeTimer: setTimeout(() => this.closeInlineMenu(), closeDelay),
            sending: false,
        }
        this.activeMenu = activeMenu

        document.body.appendChild(menu)
        this.positionInlineMenu(menu, target.getOneKeyPromptAnchor?.())
        this.refreshInlineMenuPosition(activeMenu)
        this.selectOption(activeMenu, 0)

        document.addEventListener('keydown', keydownHandler, true)
        document.addEventListener('paste', pasteHandler, true)
        document.addEventListener('mousedown', mouseDownHandler, true)
    }

    private async waitForTerminalRender (): Promise<void> {
        await new Promise<void>(resolve => {
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                    setTimeout(resolve, 0)
                })
            })
        })
    }

    private async sendChoice (menu: ActiveOneKeyInlineMenu, choiceIndex: number): Promise<void> {
        if (menu.sending || this.activeMenu !== menu) {
            return
        }
        const choice = menu.choices[choiceIndex]
        if (!choice) {
            return
        }
        menu.sending = true

        if (!this.isTargetStillValid(menu.event, menu.target, menu.session)) {
            this.closeInlineMenu()
            this.notifications.error(this.translate.instant('OneKey credential was not sent because the terminal is no longer active'))
            return
        }

        this.closeInlineMenu()
        const secret = await this.loadSecretChoice(choice)
        if (secret === undefined) {
            menu.target.focusTerminal?.()
            return
        }
        if (!secret) {
            this.notifications.error(this.translate.instant('Selected OneKey secret is not saved'))
            menu.target.focusTerminal?.()
            return
        }
        if (!this.isTargetStillValid(menu.event, menu.target, menu.session)) {
            this.notifications.error(this.translate.instant('OneKey credential was not sent because the terminal is no longer active'))
            menu.target.focusTerminal?.()
            return
        }

        menu.target.sendInput(`${secret}\r`)
        menu.target.focusTerminal?.()
    }

    private selectOption (menu: ActiveOneKeyInlineMenu, index: number): void {
        const length = menu.options.length
        if (!length) {
            return
        }
        menu.selectedIndex = (index + length) % length
        for (const [optionIndex, option] of menu.options.entries()) {
            const selected = optionIndex === menu.selectedIndex
            option.classList.toggle('active', selected)
            option.setAttribute('aria-selected', selected ? 'true' : 'false')
        }
    }

    private isMenuNavigationKey (event: KeyboardEvent): boolean {
        return event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Enter' ||
            event.key === 'Escape'
    }

    private isManualTypingKey (event: KeyboardEvent): boolean {
        return !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete')
    }

    private closeInlineMenu (): void {
        const menu = this.activeMenu
        if (!menu) {
            return
        }
        this.activeMenu = null
        clearTimeout(menu.closeTimer)
        document.removeEventListener('keydown', menu.keydownHandler, true)
        document.removeEventListener('paste', menu.pasteHandler, true)
        document.removeEventListener('mousedown', menu.mouseDownHandler, true)
        menu.element.remove()
    }

    private refreshInlineMenuPosition (menu: ActiveOneKeyInlineMenu): void {
        const reposition = () => {
            if (this.activeMenu === menu) {
                this.positionInlineMenu(menu.element, menu.target.getOneKeyPromptAnchor?.())
            }
        }
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(reposition)
        })
        setTimeout(reposition, 80)
    }

    private positionInlineMenu (menu: HTMLElement, anchor?: OneKeyPromptAnchor|null): void {
        const lineHeight = anchor?.lineHeight ?? 18
        const preferredLeft = anchor?.left ?? window.innerWidth / 3
        const preferredTop = anchor ? anchor.top + lineHeight + 4 : window.innerHeight / 2

        const width = Math.max(menu.offsetWidth, 280)
        const height = menu.offsetHeight
        const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8))
        let top = preferredTop
        if (top + height > window.innerHeight - 8 && anchor) {
            top = anchor.top - height - 4
        }
        top = Math.max(8, Math.min(top, window.innerHeight - height - 8))

        menu.style.left = `${Math.round(left)}px`
        menu.style.top = `${Math.round(top)}px`
    }

    private installInlineMenuStyles (): void {
        if (document.getElementById('tabby-onekey-inline-menu-styles')) {
            return
        }

        const style = document.createElement('style')
        style.id = 'tabby-onekey-inline-menu-styles'
        style.textContent = `
            .onekey-inline-menu {
                position: fixed;
                min-width: 260px;
                max-width: min(340px, calc(100vw - 16px));
                padding: 4px;
                z-index: 10000;
                color: var(--theme-fg, var(--bs-body-color, #ddd));
                background: var(--theme-bg-more, var(--bs-body-bg, #1d272d));
                border: 1px solid var(--theme-bg-more-2, var(--bs-border-color, rgba(255, 255, 255, .14)));
                border-radius: 7px;
                box-shadow: 0 12px 32px rgba(0, 0, 0, .42);
                font: 12px/1.35 var(--font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            }
            .onekey-inline-menu-option {
                display: flex;
                width: 100%;
                gap: 10px;
                align-items: center;
                justify-content: space-between;
                padding: 6px 8px;
                color: inherit;
                background: transparent;
                border: 0;
                border-radius: 5px;
                text-align: left;
            }
            .onekey-inline-menu-option:hover,
            .onekey-inline-menu-option.active {
                color: var(--theme-primary-fg, #fff);
                background: var(--theme-primary, var(--bs-primary, #268bd2));
            }
            .onekey-inline-menu-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .onekey-inline-menu-kind {
                flex: 0 0 auto;
                color: var(--theme-fg-less, var(--bs-secondary-color, #999));
                font-size: 11px;
            }
            .onekey-inline-menu-option:hover .onekey-inline-menu-kind,
            .onekey-inline-menu-option.active .onekey-inline-menu-kind {
                color: currentColor;
                opacity: .9;
            }
        `
        document.head.appendChild(style)
    }

    private isTargetStillValid (event: OneKeyPromptEvent, target: OneKeyPromptSendTarget, session: BaseSession): boolean {
        return Date.now() <= event.expiresAt &&
            target.session === session &&
            session.open &&
            target.hasFocus
    }

    private async loadSecretChoice (choice: OneKeySecretChoice): Promise<string|null|undefined> {
        try {
            const secret = await this.oneKey.loadSecretChoice(choice)
            return secret
        } catch {
            this.notifications.error(this.translate.instant('OneKey secure storage operation failed'))
            return undefined
        }
    }
}
