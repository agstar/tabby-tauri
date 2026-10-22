/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, HostBinding } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { FileProvidersService, OneKeyEntry, OneKeyPrivateKeyRef, OneKeyService, PlatformService, ProfilesService, PromptModalComponent, TranslateService } from 'tabby-core'

/** @hidden */
@Component({
    selector: 'onekey-settings-tab',
    templateUrl: './oneKeySettingsTab.component.pug',
})
export class OneKeySettingsTabComponent {
    entries: OneKeyEntry[] = []
    filter = ''
    selectedId: string|null = null
    secureStorageAvailable: boolean|null = null

    @HostBinding('class.content-box') true

    constructor (
        private oneKey: OneKeyService,
        private profiles: ProfilesService,
        private fileProviders: FileProvidersService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
        private translate: TranslateService,
    ) { }

    async ngOnInit (): Promise<void> {
        this.reload()
        this.secureStorageAvailable = await this.oneKey.isSecureStorageAvailable().catch(() => false)
    }

    reload (): void {
        this.entries = this.oneKey.listEntries()
        if (!this.selectedId && this.entries.length) {
            this.selectedId = this.entries[0].id
        }
        if (this.selectedId && !this.entries.some(x => x.id === this.selectedId)) {
            this.selectedId = this.entries[0]?.id ?? null
        }
    }

    get selectedEntry (): OneKeyEntry|null {
        return this.entries.find(x => x.id === this.selectedId) ?? null
    }

    get filteredEntries (): OneKeyEntry[] {
        const query = this.filter.trim().toLowerCase()
        if (!query) {
            return this.entries
        }
        return this.entries.filter(entry =>
            entry.name.toLowerCase().includes(query) ||
            entry.username.toLowerCase().includes(query) ||
            entry.privateKeys.some(key => key.path.toLowerCase().includes(query)),
        )
    }

    select (entry: OneKeyEntry): void {
        this.selectedId = entry.id
    }

    getKeyCountLabel (entry: OneKeyEntry): string {
        return this.translate.instant('{count} key(s)', { count: entry.privateKeys.length })
    }

    canStoreSecrets (): boolean {
        return this.secureStorageAvailable !== false
    }

    async createEntry (): Promise<void> {
        const name = await this.promptText(this.translate.instant('OneKey name'))
        if (!name) {
            return
        }
        const username = await this.promptText(this.translate.instant('Username'), '')
        const entry = await this.oneKey.createEntry({ name, username: username ?? '' })
        this.selectedId = entry.id
        this.reload()
    }

    async renameEntry (entry: OneKeyEntry): Promise<void> {
        const name = await this.promptText(this.translate.instant('OneKey name'), entry.name)
        if (!name) {
            return
        }
        await this.oneKey.updateEntry(entry.id, { name })
        this.reload()
    }

    async setUsername (entry: OneKeyEntry): Promise<void> {
        const username = await this.promptText(this.translate.instant('Username'), entry.username)
        if (username === null) {
            return
        }
        await this.oneKey.updateEntry(entry.id, { username })
        this.reload()
    }

    async setPassword (entry: OneKeyEntry): Promise<void> {
        if (!await this.ensureSecretStorageAvailable()) {
            return
        }
        const password = await this.promptPassword(this.translate.instant('Password'))
        if (!password) {
            return
        }
        await this.runSecretOperation(() => this.oneKey.setPassword(entry.id, password))
        this.reload()
    }

    async deletePassword (entry: OneKeyEntry): Promise<void> {
        if (!await this.ensureSecretStorageAvailable()) {
            return
        }
        await this.runSecretOperation(() => this.oneKey.deletePassword(entry.id))
        this.reload()
    }

    async addPrivateKey (entry: OneKeyEntry): Promise<void> {
        const ref = await this.fileProviders.selectAndStoreFile(`OneKey private key for ${entry.name}`).catch(() => null)
        if (!ref) {
            return
        }
        const key = await this.oneKey.addPrivateKey(entry.id, ref)
        this.reload()
        if (!this.canStoreSecrets()) {
            return
        }
        const passphrase = await this.promptPassword(this.translate.instant('Private key passphrase'), true)
        if (passphrase) {
            await this.runSecretOperation(() => this.oneKey.setPrivateKeyPassphrase(entry.id, key.id, passphrase))
            this.reload()
        }
    }

    async setPrivateKeyPassphrase (entry: OneKeyEntry, key: OneKeyPrivateKeyRef): Promise<void> {
        if (!await this.ensureSecretStorageAvailable()) {
            return
        }
        const passphrase = await this.promptPassword(this.translate.instant('Private key passphrase'))
        if (!passphrase) {
            return
        }
        await this.runSecretOperation(() => this.oneKey.setPrivateKeyPassphrase(entry.id, key.id, passphrase))
        this.reload()
    }

    async deletePrivateKeyPassphrase (entry: OneKeyEntry, key: OneKeyPrivateKeyRef): Promise<void> {
        if (!await this.ensureSecretStorageAvailable()) {
            return
        }
        await this.runSecretOperation(() => this.oneKey.deletePrivateKeyPassphrase(entry.id, key.id))
        this.reload()
    }

    async removePrivateKey (entry: OneKeyEntry, key: OneKeyPrivateKeyRef): Promise<void> {
        await this.oneKey.removePrivateKey(entry.id, key.id)
        this.reload()
    }

    async deleteEntry (entry: OneKeyEntry): Promise<void> {
        const references = await this.getReferencedProfileNames(entry)
        const message = references.length
            ? this.translate.instant('Delete OneKey credential used by {count} SSH profile(s)?', { count: references.length })
            : this.translate.instant('Delete OneKey credential?')
        const detail = references.join('\n')
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message,
            detail,
            buttons: [
                this.translate.instant('Delete'),
                this.translate.instant('Cancel'),
            ],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response !== 0) {
            return
        }
        await this.runSecretOperation(() => this.oneKey.deleteEntry(entry.id))
        this.reload()
    }

    async getReferencedProfileNames (entry: OneKeyEntry): Promise<string[]> {
        const profiles = await this.profiles.getProfiles({ includeBuiltin: false })
        return profiles
            .filter(profile => profile.type === 'ssh' && (profile.options as any)?.oneKeyId === entry.id)
            .map(profile => profile.name)
    }

    private async promptText (prompt: string, value = ''): Promise<string|null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = prompt
        modal.componentInstance.value = value
        modal.componentInstance.password = false
        const result = await modal.result.catch(() => null)
        return result?.value ?? null
    }

    private async promptPassword (prompt: string, optional = false): Promise<string|null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = prompt
        modal.componentInstance.password = true
        const result = await modal.result.catch(() => null)
        if (!optional && !result?.value) {
            return null
        }
        return result?.value ?? null
    }

    private async ensureSecretStorageAvailable (): Promise<boolean> {
        if (this.canStoreSecrets()) {
            return true
        }
        await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('OneKey credentials are disabled because secure storage is unavailable'),
            buttons: [this.translate.instant('OK')],
            defaultId: 0,
            cancelId: 0,
        })
        return false
    }

    private async runSecretOperation (operation: () => Promise<void>): Promise<void> {
        try {
            await operation()
        } catch (error) {
            await this.platform.showMessageBox({
                type: 'error',
                message: this.translate.instant('OneKey secure storage operation failed'),
                detail: this.translate.instant('Please verify that the system secure credential store is available.'),
                buttons: [this.translate.instant('OK')],
                defaultId: 0,
                cancelId: 0,
            })
        }
    }
}
