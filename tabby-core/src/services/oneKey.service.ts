import { Injectable } from '@angular/core'
import { v4 as uuidv4 } from 'uuid'
import { ConfigService } from './config.service'

export type OneKeySecretKind = 'password' | 'passphrase' | 'unknown'

export interface OneKeyPrivateKeyRef {
    id: string
    path: string
    hasPassphrase: boolean
    pathFingerprint?: string
}

export interface OneKeyEntry {
    id: string
    name: string
    username: string
    privateKeys: OneKeyPrivateKeyRef[]
    hasPassword: boolean
    createdAt: string
    updatedAt: string
}

export interface OneKeyEntryDraft {
    name: string
    username?: string
}

export interface OneKeySecretChoice {
    entryId: string
    entryName: string
    kind: Exclude<OneKeySecretKind, 'unknown'>
    label: string
    description?: string
    privateKeyId?: string
    privateKeyPath?: string
}

export class OneKeySecureStorageUnavailableError extends Error {
    constructor (message = 'OneKey secure credential storage is unavailable') {
        super(message)
        this.name = 'OneKeySecureStorageUnavailableError'
    }
}

@Injectable({ providedIn: 'root' })
export class OneKeySecretStorageProvider {
    async probe (): Promise<boolean> {
        return false
    }

    async getSecret (_target: string): Promise<string|null> {
        throw new OneKeySecureStorageUnavailableError()
    }

    async setSecret (_target: string, _value: string): Promise<void> {
        throw new OneKeySecureStorageUnavailableError()
    }

    async deleteSecret (_target: string): Promise<void> {
        throw new OneKeySecureStorageUnavailableError()
    }
}

@Injectable({ providedIn: 'root' })
export class OneKeyService {
    constructor (
        private config: ConfigService,
        private secretStorage: OneKeySecretStorageProvider,
    ) { }

    listEntries (): OneKeyEntry[] {
        return [...this.getStore().entries]
    }

    getEntry (id: string): OneKeyEntry|null {
        return this.getStore().entries.find(x => x.id === id) ?? null
    }

    async isSecureStorageAvailable (): Promise<boolean> {
        return this.secretStorage.probe()
    }

    async createEntry (draft: OneKeyEntryDraft): Promise<OneKeyEntry> {
        const now = new Date().toISOString()
        const entry: OneKeyEntry = {
            id: uuidv4(),
            name: this.normalizeName(draft.name),
            username: draft.username?.trim() ?? '',
            privateKeys: [],
            hasPassword: false,
            createdAt: now,
            updatedAt: now,
        }
        this.getStore().entries = [...this.getStore().entries, entry]
        await this.config.save()
        return entry
    }

    async updateEntry (id: string, patch: Partial<Pick<OneKeyEntry, 'name' | 'username'>>): Promise<OneKeyEntry> {
        const entry = this.requireEntry(id)
        if (patch.name !== undefined) {
            entry.name = this.normalizeName(patch.name)
        }
        if (patch.username !== undefined) {
            entry.username = patch.username.trim()
        }
        this.touch(entry)
        await this.config.save()
        return entry
    }

    async deleteEntry (id: string): Promise<void> {
        const entry = this.requireEntry(id)
        const cleanupTargets = [
            ...(entry.hasPassword ? [this.getPasswordTarget(id)] : []),
            ...entry.privateKeys
                .filter(key => key.hasPassphrase)
                .map(key => this.getPrivateKeyPassphraseTarget(id, key.id)),
        ]
        for (const target of cleanupTargets) {
            await this.secretStorage.deleteSecret(target)
        }
        this.getStore().entries = this.getStore().entries.filter(x => x.id !== id)
        await this.config.save()
    }

    async setPassword (id: string, password: string): Promise<void> {
        const entry = this.requireEntry(id)
        await this.secretStorage.setSecret(this.getPasswordTarget(id), password)
        entry.hasPassword = true
        this.touch(entry)
        await this.config.save()
    }

    async deletePassword (id: string): Promise<void> {
        const entry = this.requireEntry(id)
        await this.secretStorage.deleteSecret(this.getPasswordTarget(id))
        entry.hasPassword = false
        this.touch(entry)
        await this.config.save()
    }

    async loadPassword (id: string): Promise<string|null> {
        const entry = this.requireEntry(id)
        if (!entry.hasPassword) {
            return null
        }
        return this.secretStorage.getSecret(this.getPasswordTarget(id))
    }

    async addPrivateKey (entryId: string, path: string): Promise<OneKeyPrivateKeyRef> {
        const entry = this.requireEntry(entryId)
        const key: OneKeyPrivateKeyRef = {
            id: uuidv4(),
            path,
            hasPassphrase: false,
        }
        entry.privateKeys = [...entry.privateKeys, key]
        this.touch(entry)
        await this.config.save()
        return key
    }

    async removePrivateKey (entryId: string, privateKeyId: string): Promise<void> {
        const entry = this.requireEntry(entryId)
        const key = this.requirePrivateKey(entry, privateKeyId)
        if (key.hasPassphrase) {
            await this.secretStorage.deleteSecret(this.getPrivateKeyPassphraseTarget(entryId, privateKeyId))
        }
        entry.privateKeys = entry.privateKeys.filter(x => x.id !== privateKeyId)
        this.touch(entry)
        await this.config.save()
    }

    async setPrivateKeyPassphrase (entryId: string, privateKeyId: string, passphrase: string): Promise<void> {
        const entry = this.requireEntry(entryId)
        const key = this.requirePrivateKey(entry, privateKeyId)
        await this.secretStorage.setSecret(this.getPrivateKeyPassphraseTarget(entryId, privateKeyId), passphrase)
        key.hasPassphrase = true
        this.touch(entry)
        await this.config.save()
    }

    async deletePrivateKeyPassphrase (entryId: string, privateKeyId: string): Promise<void> {
        const entry = this.requireEntry(entryId)
        const key = this.requirePrivateKey(entry, privateKeyId)
        await this.secretStorage.deleteSecret(this.getPrivateKeyPassphraseTarget(entryId, privateKeyId))
        key.hasPassphrase = false
        this.touch(entry)
        await this.config.save()
    }

    async loadPrivateKeyPassphrase (entryId: string, privateKeyId: string): Promise<string|null> {
        const entry = this.requireEntry(entryId)
        const key = this.requirePrivateKey(entry, privateKeyId)
        if (!key.hasPassphrase) {
            return null
        }
        return this.secretStorage.getSecret(this.getPrivateKeyPassphraseTarget(entryId, privateKeyId))
    }

    getPasswordTarget (entryId: string): string {
        return `onekey:${entryId}/password`
    }

    getPrivateKeyPassphraseTarget (entryId: string, privateKeyId: string): string {
        return `onekey:${entryId}/private-key:${privateKeyId}/passphrase`
    }

    getSecretChoices (requestedKind: OneKeySecretKind = 'unknown'): OneKeySecretChoice[] {
        const choices: OneKeySecretChoice[] = []
        for (const entry of this.listEntries()) {
            if (entry.hasPassword && requestedKind !== 'passphrase') {
                choices.push({
                    entryId: entry.id,
                    entryName: entry.name,
                    kind: 'password',
                    label: `${entry.name} — Password`,
                    description: entry.username,
                })
            }
            if (requestedKind !== 'password') {
                for (const key of entry.privateKeys.filter(x => x.hasPassphrase)) {
                    choices.push({
                        entryId: entry.id,
                        entryName: entry.name,
                        kind: 'passphrase',
                        privateKeyId: key.id,
                        privateKeyPath: key.path,
                        label: `${entry.name} — Key passphrase`,
                        description: key.path,
                    })
                }
            }
        }
        return choices
    }

    async loadSecretChoice (choice: OneKeySecretChoice): Promise<string|null> {
        if (choice.kind === 'password') {
            return this.loadPassword(choice.entryId)
        }
        if (!choice.privateKeyId) {
            throw new Error('OneKey private-key passphrase choice is missing a key reference')
        }
        return this.loadPrivateKeyPassphrase(choice.entryId, choice.privateKeyId)
    }

    redactedEntries (): OneKeyEntry[] {
        return this.listEntries().map(entry => ({
            ...entry,
            privateKeys: entry.privateKeys.map(key => ({ ...key })),
        }))
    }

    private getStore (): { entries: OneKeyEntry[] } {
        if (!this.config.store.oneKey) {
            this.config.store.oneKey = { entries: [] }
        }
        if (!Array.isArray(this.config.store.oneKey.entries)) {
            this.config.store.oneKey.entries = []
        }
        return this.config.store.oneKey
    }

    private requireEntry (id: string): OneKeyEntry {
        const entry = this.getEntry(id)
        if (!entry) {
            throw new Error(`OneKey entry not found: ${id}`)
        }
        return entry
    }

    private requirePrivateKey (entry: OneKeyEntry, privateKeyId: string): OneKeyPrivateKeyRef {
        const key = entry.privateKeys.find(x => x.id === privateKeyId)
        if (!key) {
            throw new Error(`OneKey private key not found: ${privateKeyId}`)
        }
        return key
    }

    private normalizeName (name: string): string {
        const normalized = name.trim()
        if (!normalized) {
            throw new Error('OneKey name is required')
        }
        return normalized
    }

    private touch (entry: OneKeyEntry): void {
        entry.updatedAt = new Date().toISOString()
    }
}
