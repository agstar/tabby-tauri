interface TauriCoreApi {
    invoke<T = unknown> (command: string, args?: Record<string, unknown>): Promise<T>
    Channel?: new<T>(onmessage?: (payload: T) => void) => { onmessage?: (payload: T) => void }
}

declare const window: {
    __TAURI__?: {
        core?: TauriCoreApi
    }
}

interface TcpSessionSnapshot {
    session_id?: string
    sessionId?: string
    state?: string
}

interface TcpConnectResponse {
    session: TcpSessionSnapshot
    transport_status?: string
}

interface TcpData {
    session_id?: string
    sessionId?: string
    bytes: number[]
}

interface TcpConnectOptions {
    port: number
    host?: string
    hostname?: string
}

type SocketListener = (...args: any[]) => void
type SocketWriteCallback = (error?: Error | null) => void

function tauriCore (): TauriCoreApi {
    const core = window.__TAURI__?.core
    if (!core) {
        throw new Error('net requires the Tauri renderer native TCP provider')
    }
    return core
}

function invoke<T> (command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriCore().invoke<T>(command, args)
}

function createChannel<T> (onmessage: (payload: T) => void) {
    const Channel = tauriCore().Channel
    if (!Channel) {
        throw new Error('net requires the Tauri Channel API for TCP streams')
    }
    return new Channel<T>(onmessage)
}

function unsupported (feature: string): never {
    throw new Error(`${feature} is unsupported in the Windows-only Tauri host`)
}

function sessionIdFrom (snapshot?: TcpSessionSnapshot): string | null {
    return snapshot?.session_id ?? snapshot?.sessionId ?? null
}

function bytesFrom (data: string | Uint8Array | ArrayBuffer, encoding?: BufferEncoding): number[] {
    if (typeof data === 'string') {
        return Array.from(Buffer.from(data, encoding))
    }
    if (data instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(data))
    }
    if (ArrayBuffer.isView(data)) {
        return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
    return Array.from(Buffer.from(data))
}

function normalizeConnectArgs (
    optionsOrPort: TcpConnectOptions | number,
    hostOrCallback?: string | (() => void),
    callback?: () => void,
): { host: string, port: number, callback?: () => void } {
    if (typeof optionsOrPort === 'object') {
        return {
            host: optionsOrPort.host ?? optionsOrPort.hostname ?? '127.0.0.1',
            port: Number(optionsOrPort.port),
            callback: typeof hostOrCallback === 'function' ? hostOrCallback : callback,
        }
    }
    return {
        host: typeof hostOrCallback === 'string' ? hostOrCallback : '127.0.0.1',
        port: Number(optionsOrPort),
        callback: typeof hostOrCallback === 'function' ? hostOrCallback : callback,
    }
}

export class Socket {
    destroyed = false
    connecting = false
    writable = false
    readable = false

    private listeners = new Map<string, Set<SocketListener>>()
    private sessionId: string | null = null
    private closeEmitted = false
    private streamChannel: unknown = null

    on (event: string, listener: SocketListener): this {
        let listeners = this.listeners.get(event)
        if (!listeners) {
            listeners = new Set()
            this.listeners.set(event, listeners)
        }
        listeners.add(listener)
        return this
    }

    once (event: string, listener: SocketListener): this {
        const wrapper: SocketListener = (...args) => {
            this.off(event, wrapper)
            listener(...args)
        }
        return this.on(event, wrapper)
    }

    off (event: string, listener: SocketListener): this {
        this.listeners.get(event)?.delete(listener)
        return this
    }

    removeListener (event: string, listener: SocketListener): this {
        return this.off(event, listener)
    }

    connect (
        optionsOrPort: TcpConnectOptions | number,
        hostOrCallback?: string | (() => void),
        callback?: () => void,
    ): this {
        const options = normalizeConnectArgs(optionsOrPort, hostOrCallback, callback)
        this.connecting = true
        this.destroyed = false
        void this.openNative(options.host, options.port)
            .then(() => {
                options.callback?.()
            })
            .catch(error => this.fail(error))
        return this
    }

    write (
        data: string | Uint8Array | ArrayBuffer,
        encodingOrCallback?: BufferEncoding | SocketWriteCallback,
        callback?: SocketWriteCallback,
    ): boolean {
        if (!this.sessionId || this.destroyed) {
            return false
        }
        const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
        const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
        void invoke<TcpSessionSnapshot>('native_tcp_write', {
            sessionId: this.sessionId,
            bytes: bytesFrom(data, encoding),
        })
            .then(() => cb?.(null))
            .catch(error => {
                cb?.(error instanceof Error ? error : new Error(String(error)))
                this.fail(error)
            })
        return true
    }

    end (
        data?: string | Uint8Array | ArrayBuffer,
        encodingOrCallback?: BufferEncoding | SocketWriteCallback,
        callback?: SocketWriteCallback,
    ): void {
        if (data !== undefined) {
            this.write(data, encodingOrCallback, callback)
        } else if (typeof encodingOrCallback === 'function') {
            encodingOrCallback(null)
        } else {
            callback?.(null)
        }
        this.closeNative('client-end')
    }

    destroy (): this {
        this.closeNative('client-destroy')
        return this
    }

    private async openNative (host: string, port: number): Promise<void> {
        if (!Number.isFinite(port) || port <= 0) {
            throw new Error(`Invalid TCP port: ${port}`)
        }
        const response = await invoke<TcpConnectResponse>('native_tcp_connect', {
            request: { host, port },
        })
        this.sessionId = sessionIdFrom(response.session)
        if (!this.sessionId) {
            throw new Error('native_tcp_connect did not return a session id')
        }
        const channel = createChannel<TcpData>(data => {
            const sessionId = data.session_id ?? data.sessionId ?? this.sessionId
            const buffer = Buffer.from(data.bytes)
            this.emit('data', buffer)
            if (sessionId && buffer.length) {
                void invoke<TcpSessionSnapshot>('native_tcp_ack', {
                    sessionId,
                    length: buffer.length,
                }).catch(error => this.emit('error', error))
            }
        })
        this.streamChannel = channel
        await invoke<TcpSessionSnapshot>('native_tcp_stream', {
            sessionId: this.sessionId,
            channel,
        })
        this.connecting = false
        this.writable = true
        this.readable = true
        this.emit('connect')
    }

    private closeNative (reason: string): void {
        if (this.destroyed && this.closeEmitted) {
            return
        }
        this.destroyed = true
        this.connecting = false
        this.writable = false
        this.readable = false
        const sessionId = this.sessionId
        this.sessionId = null
        this.streamChannel = null
        if (sessionId) {
            void invoke<TcpSessionSnapshot>('native_tcp_close', { sessionId, reason })
                .catch(error => this.emit('error', error))
                .finally(() => this.emitClose())
        } else {
            queueMicrotask(() => this.emitClose())
        }
    }

    private fail (error: unknown): void {
        this.connecting = false
        this.writable = false
        this.readable = false
        this.emit('error', error)
        this.closeNative('client-error')
    }

    private emitClose (): void {
        if (this.closeEmitted) {
            return
        }
        this.closeEmitted = true
        this.emit('close')
    }

    private emit (event: string, ...args: any[]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            listener(...args)
        }
    }
}

export function connect (
    optionsOrPort: TcpConnectOptions | number,
    hostOrCallback?: string | (() => void),
    callback?: () => void,
): Socket {
    return new Socket().connect(optionsOrPort, hostOrCallback, callback)
}

export const createConnection = connect

export function createServer (): never {
    return unsupported('net.createServer')
}

export default { Socket, connect, createConnection, createServer }
