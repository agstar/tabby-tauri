/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { firstBy } from 'thenby'

import { FileProvidersService, Platform, PlatformService, HostAppService, PromptModalComponent, PartialProfile, ProfilesService, ProfileSettingsComponent, FullyDefined, ProxifiedConfig, OneKeyEntry, OneKeyService, TranslateService } from 'tabby-core'
import { LoginScriptsSettingsComponent } from 'tabby-terminal'
import { PasswordStorageService } from '../services/passwordStorage.service'
import { ForwardedPortConfig, PortForwardType, SSHAlgorithmType, SSHProfile } from '../api'
import { supportedAlgorithms } from '../algorithms'
import { SSHProfilesService } from '../profiles'

type TauriSshFeature =
    'agentAuth' |
    'keyboardInteractive' |
    'multiplePrivateKeys' |
    'jumpHost' |
    'proxyCommand' |
    'socksProxy' |
    'httpProxy' |
    'portForwarding' |
    'x11Forwarding' |
    'agentForwarding'

type TauriSshCapabilities = Record<TauriSshFeature, boolean>

const ELECTRON_SSH_CAPABILITIES: TauriSshCapabilities = {
    agentAuth: true,
    keyboardInteractive: true,
    multiplePrivateKeys: true,
    jumpHost: true,
    proxyCommand: true,
    socksProxy: true,
    httpProxy: true,
    portForwarding: true,
    x11Forwarding: true,
    agentForwarding: true,
}

const TAURI_SSH_CAPABILITIES: TauriSshCapabilities = {
    agentAuth: false,
    keyboardInteractive: true,
    multiplePrivateKeys: true,
    jumpHost: false,
    proxyCommand: false,
    socksProxy: false,
    httpProxy: false,
    portForwarding: true,
    x11Forwarding: false,
    agentForwarding: false,
}

/** @hidden */
@Component({
    templateUrl: './sshProfileSettings.component.pug',
})
export class SSHProfileSettingsComponent implements ProfileSettingsComponent<SSHProfile, SSHProfilesService> {
    Platform = Platform
    profile: ProxifiedConfig<FullyDefined<SSHProfile>>
    hasSavedPassword: boolean

    connectionMode: 'direct'|'proxyCommand'|'jumpHost'|'socksProxy'|'httpProxy' = 'direct'

    supportedAlgorithms = supportedAlgorithms
    sshCapabilities: TauriSshCapabilities = ELECTRON_SSH_CAPABILITIES
    algorithms: Record<string, Record<string, boolean>> = {}
    jumpHosts: PartialProfile<SSHProfile>[]
    oneKeys: OneKeyEntry[] = []
    @ViewChild('loginScriptsSettings') loginScriptsSettings: LoginScriptsSettingsComponent|null

    constructor (
        public hostApp: HostAppService,
        private profilesService: ProfilesService,
        private passwordStorage: PasswordStorageService,
        private oneKey: OneKeyService,
        private translate: TranslateService,
        private ngbModal: NgbModal,
        private fileProviders: FileProvidersService,
        private platform: PlatformService,
    ) { }

    async ngOnInit () {
        this.sshCapabilities = this.isTauriHost() ? TAURI_SSH_CAPABILITIES : ELECTRON_SSH_CAPABILITIES
        this.oneKeys = this.oneKey.listEntries()
        this.profile.options.credentialMode ??= this.profile.options.oneKeyId ? 'oneKey' : 'direct'
        this.jumpHosts = (await this.profilesService.getProfiles({ includeBuiltin: false })).filter(x => x.type === 'ssh' && x !== this.profile)
        this.jumpHosts.sort(firstBy(x => this.getJumpHostLabel(x)))

        for (const k of Object.values(SSHAlgorithmType)) {
            this.algorithms[k] = {}
            for (const alg of this.profile.options.algorithms[k]) {
                this.algorithms[k][alg] = true
            }
        }

        if (this.profile.options.proxyCommand) {
            this.connectionMode = 'proxyCommand'
        } else if (this.profile.options.jumpHost) {
            this.connectionMode = 'jumpHost'
        } else if (this.profile.options.socksProxyHost) {
            this.connectionMode = 'socksProxy'
        } else if (this.profile.options.httpProxyHost) {
            this.connectionMode = 'httpProxy'
        }

        if (!this.isUsingOneKey() && this.profile.options.user) {
            try {
                const savedPassword = await this.passwordStorage.loadPassword(this.profile)
                this.hasSavedPassword = savedPassword != null
            } catch (e) {
                console.error('Could not check for saved password', e)
            }
        }
    }

    isTauriHost (): boolean {
        const candidate = globalThis as typeof globalThis & {
            __TAURI_INTERNALS__?: unknown
            __TAURI__?: unknown
            window?: Window & { __TAURI_INTERNALS__?: unknown, __TAURI__?: unknown }
        }
        return Boolean(candidate.__TAURI_INTERNALS__ ?? candidate.__TAURI__ ?? candidate.window?.__TAURI_INTERNALS__ ?? candidate.window?.__TAURI__)
    }

    isSshFeatureAvailable (feature: TauriSshFeature): boolean {
        return this.sshCapabilities[feature]
    }

    isUsingOneKey (): boolean {
        return this.profile.options.credentialMode === 'oneKey'
    }

    setCredentialMode (mode: 'direct'|'oneKey'): void {
        this.profile.options.credentialMode = mode
        if (mode === 'direct') {
            this.profile.options.oneKeyId = null
        } else if (!this.profile.options.oneKeyId && this.oneKeys.length) {
            this.profile.options.oneKeyId = this.oneKeys[0].id
        }
    }

    getSelectedOneKey (): OneKeyEntry|null {
        if (!this.profile.options.oneKeyId) {
            return null
        }
        return this.oneKeys.find(x => x.id === this.profile.options.oneKeyId) ?? null
    }

    getSelectedOneKeySummary (): string {
        const entry = this.getSelectedOneKey()
        if (!entry) {
            return this.translate.instant('Select a OneKey credential')
        }
        const parts = [
            entry.username || this.translate.instant('No username'),
            entry.hasPassword ? this.translate.instant('password saved') : this.translate.instant('no password'),
            this.translate.instant('{count} key(s)', { count: entry.privateKeys.length }),
        ]
        return parts.join(' · ')
    }

    canAddPrivateKey (): boolean {
        return this.isSshFeatureAvailable('multiplePrivateKeys') || this.profile.options.privateKeys.length === 0
    }

    getSupportedForwardTypes (): PortForwardType[] {
        return [PortForwardType.Local, PortForwardType.Remote, PortForwardType.Dynamic]
    }

    getJumpHostLabel (p: PartialProfile<SSHProfile>) {
        return p.group ? `${this.profilesService.resolveProfileGroupName(p.group)} / ${p.name}` : p.name
    }

    async setPassword () {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = `Password for ${this.profile.options.user}@${this.profile.options.host}`
        modal.componentInstance.password = true
        try {
            const result = await modal.result.catch(() => null)
            // Allow saving a blank password (servers with PermitEmptyPasswords),
            // but guard against a malformed modal result carrying no string value.
            if (typeof result?.value !== 'string') {
                return
            }
            // An empty field is far more often an accidental OK than a deliberate
            // blank password, and a stored blank is then offered - and rejected -
            // on every connection, so make the intent explicit.
            if (result.value === '' && !await this.confirmBlankPassword()) {
                return
            }
            this.passwordStorage.savePassword(this.profile, result.value)
            this.hasSavedPassword = true
        } catch { }
    }

    private async confirmBlankPassword (): Promise<boolean> {
        return (await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant(_('Save an empty password?')),
            detail: this.translate.instant(_('This only works if the server permits empty passwords. Tabby will offer it on every connection.')),
            buttons: [
                this.translate.instant(_('Save')),
                this.translate.instant(_('Cancel')),
            ],
            defaultId: 0,
            cancelId: 1,
        })).response === 0
    }

    clearSavedPassword () {
        this.hasSavedPassword = false
        this.passwordStorage.deletePassword(this.profile)
    }

    async addPrivateKey () {
        const ref = await this.fileProviders.selectAndStoreFile(`private key for ${this.profile.name}`).catch(() => null)
        if (ref) {
            this.profile.options.privateKeys = [
                ...this.profile.options.privateKeys,
                ref,
            ]
        }
    }

    removePrivateKey (path: string) {
        this.profile.options.privateKeys = this.profile.options.privateKeys.filter(x => x !== path)
    }

    save () {
        for (const k of Object.values(SSHAlgorithmType)) {
            this.profile.options.algorithms[k] = Object.entries(this.algorithms[k])
                .filter(([, v]) => !!v)
                .map(([key]) => key)
            if(k !== SSHAlgorithmType.COMPRESSION) { this.profile.options.algorithms[k].sort() }
        }

        if (!this.isUsingOneKey()) {
            this.profile.options.oneKeyId = null
        }
        if (this.profile.options.oneKeyId) {
            this.profile.options.credentialMode = 'oneKey'
        }

        if (this.connectionMode !== 'jumpHost') {
            this.profile.options.jumpHost = null
        }
        if (this.connectionMode !== 'proxyCommand') {
            this.profile.options.proxyCommand = null
        }
        if (this.connectionMode !== 'socksProxy') {
            this.profile.options.socksProxyHost = null
            this.profile.options.socksProxyPort = null
        }
        if (this.connectionMode !== 'httpProxy') {
            this.profile.options.httpProxyHost = null
            this.profile.options.httpProxyPort = null
        }

        this.loginScriptsSettings?.save()
    }

    onForwardAdded (fw: ForwardedPortConfig) {
        this.profile.options.forwardedPorts.push(fw)
    }

    onForwardRemoved (fw: ForwardedPortConfig) {
        this.profile.options.forwardedPorts = this.profile.options.forwardedPorts.filter(x => x !== fw)
    }

    getConnectionDropdownTitle () {
        return {
            direct: 'Direct',
            proxyCommand: 'Proxy command',
            jumpHost: 'Jump host',
            socksProxy: 'SOCKS proxy',
            httpProxy: 'HTTP proxy',
        }[this.connectionMode]
    }
}
