import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector, HostListener } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { GetRecoveryTokenOptions, Platform, ProfilesService, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { SSHService } from '../services/ssh.service'
import { KeyboardInteractivePrompt, SSHConnectionLike } from '../session/types'
import { SSHPortForwardingModalComponent } from './sshPortForwardingModal.component'
import { SSHProfile } from '../api'
import { SSHSessionFactory, SSHShellLikeSession, SSHShellSessionFactory } from '../session/factory'
import { SSHMultiplexerService } from '../services/sshMultiplexer.service'

/** @hidden */
@Component({
    selector: 'ssh-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./sshTab.component.pug')}`,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./sshTab.component.scss'),
    ],
    animations: BaseTerminalTabComponent.animations,
})
export class SSHTabComponent extends ConnectableTerminalTabComponent<SSHProfile> {
    Platform = Platform
    sshSession: SSHConnectionLike|null = null
    session: SSHShellLikeSession|null = null
    sftpPanelVisible = false
    sftpPath = '/'
    enableToolbar = true
    activeKIPrompt: KeyboardInteractivePrompt|null = null

    constructor (
        injector: Injector,
        public ssh: SSHService,
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
        private sshMultiplexer: SSHMultiplexerService,
        private sshSessionFactory: SSHSessionFactory,
        private sshShellSessionFactory: SSHShellSessionFactory,
    ) {
        super(injector)
        this.sessionChanged$.subscribe(() => this.clearActiveKIPrompt())
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1bOH' )
                    break
                case 'end':
                    this.sendInput('\x1bOF' )
                    break
                case 'restart-ssh-session':
                    this.reconnect()
                    break
                case 'launch-winscp':
                    if (this.sshSession) {
                        this.ssh.launchWinSCP(this.sshSession)
                    }
                    break
                case 'open-sftp':
                    this.openSFTP()
                    break
            }
        })

        super.ngOnInit()
        this.subscribeUntilDestroyed(this.focused$, () => this.scheduleTerminalSizeResync())
        this.subscribeUntilDestroyed(this.visibility$, visible => {
            if (visible) {
                this.scheduleTerminalSizeResync()
            }
        })
    }

    async setupOneSession (injector: Injector, profile: SSHProfile, multiplex = true): Promise<SSHConnectionLike> {
        let session = await this.sshMultiplexer.getSession(profile)
        if (!multiplex || !session || !profile.options.reuseSession) {
            session = await this.sshSessionFactory.create(injector, profile)

            if (profile.options.jumpHost) {
                const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)

                if (!jumpConnection) {
                    throw new Error(`${profile.options.host}: jump host "${profile.options.jumpHost}" not found in your config`)
                }

                const jumpSession = await this.setupOneSession(
                    this.injector,
                    this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection),
                )

                jumpSession.ref()
                session.willDestroy$.subscribe(() => jumpSession.unref())
                jumpSession.willDestroy$.subscribe(() => {
                    if (session?.open) {
                        session.destroy()
                    }
                })

                try {
                    session.setJumpChannel(await jumpSession.openTCPForwardChannelTo(profile.options.host, profile.options.port ?? 22))
                } catch (err) {
                    this.notifications.error(
                        this.translate.instant(_('Could not set up port forward on {host}'), { host: jumpConnection.name }),
                        err.toString(),
                    )
                    throw err
                }
            }
        }

        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
        })

        this.attachSessionHandler(session.willDestroy$, () => {
            this.clearActiveKIPrompt()
        })

        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => {
            this.clearActiveKIPrompt()
            this.activeKIPrompt = prompt
            setTimeout(() => {
                this.frontend?.scrollToBottom()
            })
        })

        if (!session.open) {
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` Connecting to ${session.profile.name}\r\n`)

            this.startSpinner(this.translate.instant(_('Connecting')))

            try {
                await session.start()
            } finally {
                this.stopSpinner()
            }

            this.sshMultiplexer.addSession(session)
        }

        return session
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` ${this.sshSession?.profile.options.host}: session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    private clearActiveKIPrompt (): void {
        if (this.activeKIPrompt) {
            this.activeKIPrompt.reject()
            this.activeKIPrompt = null
        }
    }

    private scheduleTerminalSizeResync (): void {
        for (const delay of [0, 450]) {
            setTimeout(() => {
                const session = this.session
                if (!session?.open) {
                    return
                }
                session.resize(this.size.columns, this.size.rows)
                session.resyncSize?.()
            }, delay)
        }
    }

    private async initializeSessionMaybeMultiplex (multiplex = true): Promise<void> {
        this.sshSession = await this.setupOneSession(this.injector, this.profile, multiplex)
        const session = await this.sshShellSessionFactory.create(this.injector, this.sshSession, this.profile)
        session.resize(this.size.columns, this.size.rows)

        this.setSession(session)
        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
            session.resize(this.size.columns, this.size.rows)
        })

        await session.start()

        this.session?.resize(this.size.columns, this.size.rows)
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        try {
            await this.initializeSessionMaybeMultiplex(true)
        } catch {
            try {
                await this.initializeSessionMaybeMultiplex(false)
            } catch (e) {
                console.error('SSH session initialization failed', e)
                await this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
        }
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        const token = await super.getRecoveryToken(options)
        if (this.profile.options.rememberCwd) {
            const cwd = await this.session?.getWorkingDirectory() ?? this.profile.options.cwd
            if (cwd) {
                token.profile = {
                    ...token.profile,
                    options: {
                        ...token.profile.options,
                        cwd,
                    },
                }
            }
        }
        return token
    }

    showPortForwarding (): void {
        const modal = this.ngbModal.open(SSHPortForwardingModalComponent).componentInstance as SSHPortForwardingModalComponent
        modal.session = this.sshSession!
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!this.profile.options.warnOnClose) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(_('Disconnect from {host}?'), this.profile.options),
                buttons: [
                    this.translate.instant(_('Disconnect')),
                    this.translate.instant(_('Do not close')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    async openSFTP (): Promise<void> {
        this.sftpPath = await this.session?.getWorkingDirectory() ?? this.sftpPath
        setTimeout(() => {
            this.sftpPanelVisible = true
        }, 100)
    }

    @HostListener('click')
    onClick (): void {
        this.sftpPanelVisible = false
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.charCodeAt(this.recentInputs.length - 1) === 4 ||
        this.recentInputs.endsWith('exit\r')
    }
}
