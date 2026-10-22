import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input, Injector, Inject, Optional } from '@angular/core'
import { BaseTabProcess, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild, GetRecoveryTokenOptions } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { LocalProfile, SessionOptions, UACService } from '../api'
import { Session } from '../session'
import { parseLocalSshDestination } from '../sshTitle'

/** @hidden */
@Component({
    selector: 'terminalTab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class TerminalTabComponent extends BaseTerminalTabComponent<LocalProfile> {
    @Input() sessionOptions: SessionOptions // Deprecated
    session: Session|null = null
    private pendingInputLine = ''
    private inputEscapeMode: 'none'|'esc'|'csi' = 'none'

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        @Optional() @Inject(UACService) private uac: UACService|undefined,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        this.sessionOptions = this.profile.options

        this.logger = this.log.create('terminalTab')

        const isConPTY = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) && this.config.store.terminal.useConPTY

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput(isConPTY ? '\x1b[H' : '\x1bOH')
                    break
                case 'end':
                    this.sendInput(isConPTY ? '\x1b[F' : '\x1bOF')
                    break
            }
        })

        super.ngOnInit()
    }

    protected onFrontendReady (): void {
        this.initializeSession(this.size.columns, this.size.rows)
        this.savedStateIsLive = this.profile.options.restoreFromPTYID === this.session?.getID()
        super.onFrontendReady()
    }

    initializeSession (columns: number, rows: number): void {

        const session = new Session(this.injector)

        if (this.profile.options.runAsAdministrator && this.uac?.isAvailable) {
            this.profile = {
                ...this.profile,
                options: this.uac.patchSessionOptionsForUAC(this.profile.options),
            }
        }

        session.start({
            ...this.profile.options,
            width: columns,
            height: rows,
        })

        this.setSession(session)
        this.recoveryStateChangedHint.next()
    }

    sendInput (data: string|Buffer): void {
        this.updateTitleFromLocalSshInput(data)
        super.sendInput(data)
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        const cwd = this.session ? await this.session.getWorkingDirectory() : null
        return {
            type: 'app:local-tab',
            profile: {
                ...this.profile,
                options: {
                    ...this.profile.options,
                    cwd: cwd ?? this.profile.options.cwd,
                    restoreFromPTYID: options?.includeState && this.session?.getID(),
                },
            },
            savedState: options?.includeState && this.frontend?.saveState(),
        }
    }

    async getCurrentProcess (): Promise<BaseTabProcess|null> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return null
        }
        return {
            name: children[0].command,
        }
    }

    async canClose (): Promise<boolean> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(
                    _('"{command}" is still running. Close?'),
                    children[0],
                ),
                buttons: [
                    this.translate.instant(_('Kill')),
                    this.translate.instant(_('Cancel')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.session?.destroy()
    }

    /**
     * Return true if the user explicitly exit the session.
     * Always return true for terminalTab as the session can only be ended by the user
     */
    protected isSessionExplicitlyTerminated (): boolean {
        return true
    }

    private updateTitleFromLocalSshInput (data: string|Buffer): void {
        const text = data instanceof Buffer ? data.toString('utf-8') : data
        for (const char of text) {
            if (this.inputEscapeMode !== 'none') {
                if (this.inputEscapeMode === 'esc' && char === '[') {
                    this.inputEscapeMode = 'csi'
                    continue
                }
                if (this.inputEscapeMode === 'esc' || (char >= '@' && char <= '~')) {
                    this.inputEscapeMode = 'none'
                }
                continue
            }
            if (char === '\x1b') {
                this.inputEscapeMode = 'esc'
                continue
            }
            if (char === '\x03') {
                this.pendingInputLine = ''
                this.inputEscapeMode = 'none'
                continue
            }
            if (char === '\x08' || char === '\x7f') {
                this.pendingInputLine = this.pendingInputLine.slice(0, -1)
                continue
            }
            if (char === '\r' || char === '\n') {
                this.applySshTitleFromCommand(this.pendingInputLine)
                this.pendingInputLine = ''
                continue
            }
            if (char >= ' ' && char !== '\x7f') {
                this.pendingInputLine += char
            }
        }
    }

    private applySshTitleFromCommand (line: string): void {
        const target = parseLocalSshDestination(line)
        if (target) {
            this.disableDynamicTitle = true
            this.setTitle(target.host)
            this.customTitle = target.host
            ;(this as any).__tabbyLocalSshTarget = target
        }
    }
}
