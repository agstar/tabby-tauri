import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { AsyncSubject, Subject, Observable } from 'rxjs'
import { wrapPromise, serializeFunction } from '../utils'
import { UnlockVaultModalComponent } from '../components/unlockVaultModal.component'
import { NotificationsService } from './notifications.service'
import { SelectorService } from './selector.service'
import { FileProvider } from '../api/fileProvider'
import { PlatformService } from '../api/platform'

const PBKDF_ITERATIONS = 100000
const PBKDF_WEB_DIGEST = 'SHA-512'
const PBKDF_SALT_LENGTH = 64 / 8
const CRYPT_KEY_LENGTH = 256 / 8
const CRYPT_IV_LENGTH = 128 / 8

export interface StoredVault {
    version: number
    contents: string
    keySalt: string
    iv: string
}

export interface VaultSecret {
    type: string
    key: VaultSecretKey
    value: string
}

export interface VaultFileSecret extends VaultSecret {
    key: {
        id: string
        description: string
    }
}

export interface Vault {
    config: any
    secrets: VaultSecret[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface VaultSecretKey { }

function migrateVaultContent (content: any): Vault {
    return {
        config: content.config,
        secrets: content.secrets ?? [],
    }
}

export const VAULT_SECRET_TYPE_FILE = 'file'

// Don't make it accessible through VaultService fields
let _rememberedPassphrase: string|null = null

function getSubtleCrypto (): SubtleCrypto {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) {
        throw new Error('Vault crypto requires WebCrypto or a native crypto provider')
    }
    return subtle
}

function getRandomValues (buffer: Uint8Array): Uint8Array {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error('Vault random bytes require WebCrypto or a native crypto provider')
    }
    return globalThis.crypto.getRandomValues(buffer)
}

function randomBytes (length: number): Buffer {
    const output = new Uint8Array(length)
    for (let offset = 0; offset < output.length; offset += 65536) {
        getRandomValues(output.subarray(offset, Math.min(output.length, offset + 65536)))
    }
    return Buffer.from(output)
}

async function deriveWebVaultKey (passphrase: string, salt: Buffer): Promise<CryptoKey> {
    const subtle = getSubtleCrypto()
    const material = await subtle.importKey(
        'raw',
        Buffer.from(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    )
    return subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: PBKDF_ITERATIONS,
            hash: PBKDF_WEB_DIGEST,
        },
        material,
        { name: 'AES-CBC', length: CRYPT_KEY_LENGTH * 8 },
        false,
        ['encrypt', 'decrypt'],
    )
}

@Injectable({ providedIn: 'root' })
export class VaultCryptoProvider {
    async encrypt (content: Vault, passphrase: string): Promise<StoredVault> {
        const keySalt = randomBytes(PBKDF_SALT_LENGTH)
        const iv = randomBytes(CRYPT_IV_LENGTH)
        const key = await deriveWebVaultKey(passphrase, keySalt)
        const encrypted = await getSubtleCrypto().encrypt(
            { name: 'AES-CBC', iv },
            key,
            Buffer.from(JSON.stringify(content), 'utf-8'),
        )

        return {
            version: 1,
            contents: Buffer.from(encrypted).toString('base64'),
            keySalt: keySalt.toString('hex'),
            iv: iv.toString('hex'),
        }
    }

    async decrypt (vault: StoredVault, passphrase: string): Promise<Vault> {
        if (vault.version !== 1) {
            throw new Error(`Unsupported vault format version ${vault.version}`)
        }
        const keySalt = Buffer.from(vault.keySalt, 'hex')
        const key = await deriveWebVaultKey(passphrase, keySalt)
        const iv = Buffer.from(vault.iv, 'hex')
        const encrypted = Buffer.from(vault.contents, 'base64')
        const plaintext = await getSubtleCrypto().decrypt(
            { name: 'AES-CBC', iv },
            key,
            encrypted,
        )
        return migrateVaultContent(JSON.parse(Buffer.from(plaintext).toString('utf-8')))
    }

    async randomBytes (length: number): Promise<Buffer> {
        return randomBytes(length)
    }
}

@Injectable({ providedIn: 'root' })
export class VaultService {
    /** Fires once when the config is loaded */
    get ready$ (): Observable<boolean> { return this.ready }

    get contentChanged$ (): Observable<void> { return this.contentChanged }

    store: StoredVault|null = null
    private ready = new AsyncSubject<boolean>()
    private contentChanged = new Subject<void>()

    /** @hidden */
    private constructor (
        private zone: NgZone,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
        private vaultCrypto: VaultCryptoProvider,
    ) {
        this.getPassphrase = serializeFunction(this.getPassphrase.bind(this))
    }

    async setEnabled (enabled: boolean, passphrase?: string): Promise<void> {
        if (enabled) {
            if (!this.store) {
                await this.save(migrateVaultContent({}), passphrase)
            }
        } else {
            this.store = null
            this.contentChanged.next()
        }
    }

    isOpen (): boolean {
        return !!_rememberedPassphrase
    }

    forgetPassphrase (): void {
        _rememberedPassphrase = null
    }

    async decrypt (storage: StoredVault, passphrase?: string): Promise<Vault> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        try {
            return await wrapPromise(this.zone, this.vaultCrypto.decrypt(storage, passphrase))
        } catch (e) {
            this.forgetPassphrase()
            if (e.toString().includes('BAD_DECRYPT') || e.toString().includes('OperationError')) {
                this.notifications.error('Incorrect passphrase')
            }
            throw e
        }
    }

    async load (passphrase?: string): Promise<Vault|null> {
        if (!this.store) {
            return null
        }
        return this.decrypt(this.store, passphrase)
    }

    async encrypt (vault: Vault, passphrase?: string): Promise<StoredVault|null> {
        if (!passphrase) {
            passphrase = await this.getPassphrase()
        }
        if (_rememberedPassphrase) {
            _rememberedPassphrase = passphrase
        }
        return wrapPromise(this.zone, this.vaultCrypto.encrypt(vault, passphrase))
    }

    async save (vault: Vault, passphrase?: string): Promise<void> {
        await this.ready$.toPromise()
        this.store = await this.encrypt(vault, passphrase)
        this.contentChanged.next()
    }

    async getPassphrase (): Promise<string> {
        if (!_rememberedPassphrase) {
            const modal = this.ngbModal.open(UnlockVaultModalComponent)
            const { passphrase, rememberFor } = await modal.result
            setTimeout(() => {
                _rememberedPassphrase = null
                // avoid multiple consequent prompts
            }, Math.max(1000, rememberFor * 60000))
            _rememberedPassphrase = passphrase
        }

        return _rememberedPassphrase!
    }

    async getSecret (type: string, key: VaultSecretKey): Promise<VaultSecret|null> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return null
        }
        let vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        if (!vaultSecret) {
            // search for secret without host in vault (like a default user/password used in multiple servers)
            key['host'] = null
            vaultSecret = vault.secrets.find(s => s.type === type && this.keyMatches(key, s))
        }
        return vaultSecret ?? null
    }

    async addSecret (secret: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== secret.type || !this.keyMatches(secret.key, s))
        vault.secrets.push(secret)
        await this.save(vault)
    }

    async updateSecret (secret: VaultSecret, update: VaultSecret): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        const target = vault.secrets.find(s => s.type === secret.type && this.keyMatches(secret.key, s))
        if (!target) {
            return
        }
        Object.assign(target, update)
        await this.save(vault)
    }

    async removeSecret (type: string, key: VaultSecretKey): Promise<void> {
        await this.ready$.toPromise()
        const vault = await this.load()
        if (!vault) {
            return
        }
        vault.secrets = vault.secrets.filter(s => s.type !== type || !this.keyMatches(key, s))
        await this.save(vault)
    }

    private keyMatches (key: VaultSecretKey, secret: VaultSecret): boolean {
        return Object.keys(key).every(k => secret.key[k] === key[k])
    }

    setStore (store: StoredVault): void {
        this.store = store
        this.ready.next(true)
        this.ready.complete()
    }

    isEnabled (): boolean {
        return !!this.store
    }
}


@Injectable()
export class VaultFileProvider extends FileProvider {
    name = 'Vault'
    prefix = 'vault://'

    constructor (
        private vault: VaultService,
        private platform: PlatformService,
        private selector: SelectorService,
        private zone: NgZone,
        private vaultCrypto: VaultCryptoProvider,
    ) {
        super()
    }

    async isAvailable (): Promise<boolean> {
        return this.vault.isEnabled()
    }

    async selectAndStoreFile (description: string): Promise<string> {
        const vault = await this.vault.load()
        if (!vault) {
            throw new Error('Vault is locked')
        }
        const files = vault.secrets.filter(x => x.type === VAULT_SECRET_TYPE_FILE) as VaultFileSecret[]
        if (files.length) {
            const result = await this.selector.show<VaultFileSecret|null>('Select file', [
                {
                    name: 'Add a new file',
                    icon: 'fas fa-plus',
                    result: null,
                },
                ...files.map(f => ({
                    name: f.key.description,
                    icon: 'fas fa-file',
                    result: f,
                })),
            ]).catch(() => null)
            if (result) {
                return `${this.prefix}${result.key.id}`
            }
        }
        return this.addNewFile(description)
    }

    async addNewFile (description: string): Promise<string> {
        const transfers = await this.platform.startUpload()
        if (!transfers.length) {
            throw new Error('Nothing selected')
        }
        const transfer = transfers[0]
        const id = (await wrapPromise(this.zone, this.vaultCrypto.randomBytes(32))).toString('hex')
        await this.vault.addSecret({
            type: VAULT_SECRET_TYPE_FILE,
            key: {
                id,
                description: `${description} (${transfer.getName()})`,
            },
            value: Buffer.from(await transfer.readAll()).toString('base64'),
        })
        return `${this.prefix}${id}`
    }

    async retrieveFile (key: string): Promise<Buffer> {
        if (!key.startsWith(this.prefix)) {
            throw new Error('Incorrect type')
        }
        const secret = await this.vault.getSecret(VAULT_SECRET_TYPE_FILE, { id: key.substring(this.prefix.length) })
        if (!secret) {
            throw new Error('Not found')
        }
        return Buffer.from(secret.value, 'base64')
    }
}
