import { Observable } from 'rxjs'
import { FileDownload, FileUpload } from 'tabby-core'
import { ForwardedPortConfig, SSHProfile } from '../api'

export interface Prompt {
    prompt: string
    echo?: boolean
}

export class KeyboardInteractivePrompt {
    readonly responses: string[] = []

    private _resolve: (value: string[]) => void
    private _reject: (reason: any) => void
    readonly promise = new Promise<string[]>((resolve, reject) => {
        this._resolve = resolve
        this._reject = reject
    })

    constructor (
        public name: string,
        public instruction: string,
        public prompts: Prompt[],
    ) {
        this.responses = new Array(this.prompts.length).fill('')
    }

    isAPasswordPrompt (index: number): boolean {
        return this.prompts[index].prompt.toLowerCase().includes('password') && !this.prompts[index].echo
    }

    respond (): void {
        this._resolve(this.responses)
    }

    reject (): void {
        this._reject(new Error('Keyboard-interactive auth rejected'))
    }
}

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
    fileType?: string
}

export interface SFTPDirectoryPlanEntry {
    path: string
    relativePath: string
    isDirectory: boolean
    mode: number
    size: number
}

export interface SFTPDirectoryPlan {
    rootPath: string
    entries: SFTPDirectoryPlanEntry[]
    totalSize: number
}

export interface SFTPFileHandleLike {
    position: number
    read (): Promise<Uint8Array>
    write (chunk: Uint8Array): Promise<void>
    close (): Promise<void>
}

export interface SFTPSession {
    closed$: Observable<void>
    readdir (p: string): Promise<SFTPFile[]>
    directoryPlan? (p: string): Promise<SFTPDirectoryPlan>
    readlink (p: string): Promise<string>
    realpath (p: string): Promise<string>
    stat (p: string): Promise<SFTPFile>
    open (p: string, mode: number): Promise<SFTPFileHandleLike>
    rmdir (p: string): Promise<void>
    mkdir (p: string): Promise<void>
    rename (oldPath: string, newPath: string): Promise<void>
    unlink (p: string): Promise<void>
    chmod (p: string, mode: string|number): Promise<void>
    upload (path: string, transfer: FileUpload): Promise<void>
    download (path: string, transfer: FileDownload): Promise<void>
}

export interface SSHConnectionLike {
    profile: SSHProfile
    open: boolean
    forwardedPorts: ForwardedPortConfig[]
    serviceMessage$: Observable<string>
    keyboardInteractivePrompt$: Observable<KeyboardInteractivePrompt>
    willDestroy$: Observable<void>
    activePrivateKey?: unknown|null
    authUsername?: string|null
    ref (): void
    unref (): void
    start (): Promise<void>
    destroy (): Promise<void>
    emitServiceMessage (message: string): void
    openSFTP (): Promise<SFTPSession>
    addPortForward (fw: ForwardedPortConfig): Promise<void>
    removePortForward (fw: ForwardedPortConfig): Promise<void>
    openTCPForwardChannelTo (host: string, port: number): Promise<unknown>
    setJumpChannel (channel: unknown): void
}
