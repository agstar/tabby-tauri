interface TauriCoreApi {
    invoke<T = unknown> (command: string, args?: Record<string, unknown>): Promise<T>
}

declare const window: {
    __TAURI__?: {
        core?: TauriCoreApi
    }
}

interface NativeFileMetadata {
    path: string
    name: string
    size: number
    mode: number
    isDirectory: boolean
}

interface ReaddirOptions {
    withFileTypes?: boolean
}

interface WriteOptions {
    encoding?: BufferEncoding
}

interface MkdirOptions {
    recursive?: boolean
}

interface NativeStats {
    path: string
    name: string
    size: number
    mode: number
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
}

interface NativeDirent {
    name: string
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
}

function tauriCore (): TauriCoreApi {
    const core = window.__TAURI__?.core
    if (!core) {
        throw new Error('fs/promises requires the Tauri renderer native provider')
    }
    return core
}

function invoke<T> (command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriCore().invoke<T>(command, args)
}

function statsFromNative (metadata: NativeFileMetadata): NativeStats {
    return {
        path: metadata.path,
        name: metadata.name,
        size: metadata.size,
        mode: metadata.mode,
        isDirectory: () => metadata.isDirectory,
        isFile: () => !metadata.isDirectory,
        isSymbolicLink: () => false,
    }
}

function direntFromNative (metadata: NativeFileMetadata): NativeDirent {
    return {
        name: metadata.name,
        isDirectory: () => metadata.isDirectory,
        isFile: () => !metadata.isDirectory,
        isSymbolicLink: () => false,
    }
}

function normalizeEncoding (options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): BufferEncoding | null {
    if (typeof options === 'string') {
        return options
    }
    return options?.encoding ?? null
}

function normalizeContent (content: string | Uint8Array, options?: WriteOptions | BufferEncoding | null): string {
    if (typeof content === 'string') {
        return content
    }
    const encoding = normalizeEncoding(options) ?? 'utf8'
    return Buffer.from(content).toString(encoding)
}

export async function readFile (
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
): Promise<string | Buffer> {
    const content = await invoke<string>('native_fs_read_text', { path })
    const encoding = normalizeEncoding(options)
    return encoding ? content : Buffer.from(content, 'utf8')
}

export async function writeFile (
    path: string,
    content: string | Uint8Array,
    options?: WriteOptions | BufferEncoding | null,
): Promise<void> {
    await invoke<void>('native_fs_write_text', { path, content: normalizeContent(content, options) })
}

export async function mkdir (path: string, options: MkdirOptions | boolean = {}): Promise<void> {
    const recursive = typeof options === 'boolean' ? options : !!options.recursive
    await invoke<void>('native_fs_mkdir', { path, recursive })
}

export async function access (path: string): Promise<void> {
    await invoke<void>('native_fs_access', { path })
}

export async function stat (path: string): Promise<NativeStats> {
    return statsFromNative(await invoke<NativeFileMetadata>('native_fs_stat', { path }))
}

export async function readdir (
    path: string,
    options: ReaddirOptions | BufferEncoding | null = null,
): Promise<string[] | NativeDirent[]> {
    const entries = await invoke<NativeFileMetadata[]>('native_fs_readdir', { path })
    if (typeof options === 'object' && options?.withFileTypes) {
        return entries.map(direntFromNative)
    }
    return entries.map(entry => entry.name)
}

export async function realpath (path: string): Promise<string> {
    return invoke<string>('native_fs_realpath', { path })
}

export async function unlink (path: string): Promise<void> {
    await invoke<void>('native_fs_unlink', { path })
}

export default { readFile, writeFile, mkdir, access, stat, readdir, realpath, unlink }
