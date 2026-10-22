import { Injectable } from '@angular/core'
import { CLIHandler, CLIEvent, AppService, ConfigService, HostWindowService, ProfilesService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { TerminalService } from './services/terminal.service'

function resolveCliPath (cwd: string, value: string): string {
    const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
    const isPosixAbsolute = value.startsWith('/')
    const separator = cwd.includes('\\') ? '\\' : '/'
    const joined = isWindowsAbsolute || isPosixAbsolute ? value : `${cwd.replace(/[\\/]+$/, '')}${separator}${value}`
    const root = /^[a-zA-Z]:[\\/]/.exec(joined)?.[0] ?? (joined.startsWith('\\\\') ? '\\\\' : (joined.startsWith('/') ? '/' : ''))
    const body = root ? joined.slice(root.length) : joined
    const segments: string[] = []
    for (const segment of body.split(/[\\/]+/)) {
        if (!segment || segment === '.') {
            continue
        }
        if (segment === '..') {
            segments.pop()
        } else {
            segments.push(segment)
        }
    }
    return root + segments.join(separator)
}

@Injectable()
export class TerminalCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = 0

    constructor (
        private hostWindow: HostWindowService,
        private terminal: TerminalService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        const op = event.argv._[0]

        if (op === 'open') {
            this.handleOpenDirectory(resolveCliPath(event.cwd, event.argv.directory!))
        } else if (op === 'run') {
            await this.handleRunCommand(event.argv.command!)
        } else {
            return false
        }

        return true
    }

    private async handleOpenDirectory (directory: string) {
        if (directory.length > 1 && (directory.endsWith('/') || directory.endsWith('\\'))) {
            directory = directory.substring(0, directory.length - 1)
        }
        const metadata = await this.platform.statPath(directory)
        if (metadata?.isDirectory) {
            this.terminal.openTab(undefined, directory)
            this.hostWindow.bringToFront()
        }
    }

    private async handleRunCommand (command: string[]) {
        if ((await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant(`Run "{command}"?`, { command: command.join(' ') }),
            buttons: [
                this.translate.instant('Run'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 0,
            cancelId: 1,
        })).response === 1) {
            return
        }

        this.terminal.openTab({
            type: 'local',
            name: '',
            options: {
                command: command[0],
                args: command.slice(1),
            },
        }, null, true)
        this.hostWindow.bringToFront()
    }
}


@Injectable()
export class OpenPathCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = -100

    constructor (
        private terminal: TerminalService,
        private profiles: ProfilesService,
        private hostWindow: HostWindowService,
        private notifications: NotificationsService,
        private platform: PlatformService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        const op = event.argv._[0]
        const opAsPath = op ? resolveCliPath(event.cwd, op) : null

        const profile = await this.terminal.getDefaultProfile()

        const metadata = opAsPath ? await this.platform.statPath(opAsPath) : null

        if (metadata?.isDirectory) {
            this.terminal.openTab(profile, opAsPath)
            this.hostWindow.bringToFront()
            return true
        }

        if (opAsPath && metadata) {
            if (opAsPath.endsWith('.sh') || opAsPath.endsWith('.command')) {
                profile.options!.pauseAfterExit = true
                profile.options?.args?.push(opAsPath)
                this.terminal.openTab(profile)
                this.hostWindow.bringToFront()
                return true
            } else if (opAsPath.endsWith('.bat')) {
                const psProfile = (await this.profiles.getProfiles()).find(x => x.id === 'cmd')
                if (psProfile) {
                    psProfile.options!.pauseAfterExit = true
                    psProfile.options?.args?.push(opAsPath)
                    this.terminal.openTab(psProfile)
                    this.hostWindow.bringToFront()
                    return true
                }
            } else if (opAsPath.endsWith('.ps1')) {
                const cmdProfile = (await this.profiles.getProfiles()).find(x => x.id === 'powershell')
                if (cmdProfile) {
                    cmdProfile.options!.pauseAfterExit = true
                    cmdProfile.options?.args?.push(opAsPath)
                    this.terminal.openTab(cmdProfile)
                    this.hostWindow.bringToFront()
                    return true
                }
            } else {
                this.notifications.error('Cannot handle scripts of this type')
            }
        }

        return false
    }
}

@Injectable()
export class AutoOpenTabCLIHandler extends CLIHandler {
    firstMatchOnly = true
    priority = -1000

    constructor (
        private app: AppService,
        private config: ConfigService,
        private terminal: TerminalService,
    ) {
        super()
    }

    async handle (event: CLIEvent): Promise<boolean> {
        if (!event.secondInstance && this.config.store.terminal.autoOpen && !this.config.store.enableWelcomeTab) {
            this.app.ready$.subscribe(() => {
                if (this.app.tabs.length === 0) {
                    this.terminal.openTab()
                }
            })
            return true
        }
        return false
    }
}
