export type Listener = (...args: unknown[]) => void

const existingProcess = (globalThis as typeof globalThis & {
    process?: Record<string, any> & { env?: Record<string, string | undefined> }
}).process

const env: Record<string, string | undefined> = existingProcess?.env ?? {}

env.TERM_PROGRAM ??= 'Tabby'

const constants = {
    O_CREAT: 0x40,
    O_EXCL: 0x80,
    O_RDWR: 0x02,
    O_SYMLINK: 0,
    fs: {
        O_CREAT: 0x40,
        O_EXCL: 0x80,
        O_RDWR: 0x02,
        O_SYMLINK: 0,
    },
    EBADF: -4083,
    ENOENT: -4058,
    os: {
        errno: {
            EBADF: -4083,
            ENOENT: -4058,
        },
    },
}

const noop = () => undefined

const processProvider = {
    ...existingProcess,
    browser: true,
    type: 'renderer',
    platform: existingProcess?.platform ?? 'win32',
    arch: existingProcess?.arch ?? 'x64',
    pid: existingProcess?.pid ?? 1,
    name: existingProcess?.name ?? 'tabby-tauri',
    title: existingProcess?.title ?? 'tabby-tauri',
    version: existingProcess?.version ?? 'v0.0.0',
    versions: {
        ...existingProcess?.versions,
        node: existingProcess?.versions?.node ?? 'tauri',
        chrome: '',
        electron: undefined,
    },
    env,
    stdout: { isTTY: false, write: noop },
    stderr: { isTTY: false, write: noop },
    stdin: { isTTY: false },
    nextTick (callback: Listener, ...args: unknown[]): void {
        Promise.resolve().then(() => callback(...args))
    },
    cwd (): string {
        return 'C:\\'
    },
    chdir: noop,
    kill: noop,
    addListener: noop,
    on: noop,
    once: noop,
    off: noop,
    removeListener: noop,
    removeAllListeners: noop,
    emit: () => false,
    binding (name: string): unknown {
        const existingBinding = existingProcess?.binding?.(name)
        if (existingBinding && Object.keys(existingBinding as Record<string, unknown>).length) {
            return existingBinding
        }
        if (name === 'constants') {
            return constants
        }
        return {}
    },
}

;(globalThis as any).process = processProvider

export default processProvider
export const process = processProvider
