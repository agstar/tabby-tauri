type StreamWriteCallback = () => void

interface WritableLike {
    write?: (value: string) => unknown
}

interface ReadableLike {
    on?: (event: string, handler: (data?: unknown) => void) => unknown
    off?: (event: string, handler: (data?: unknown) => void) => unknown
    removeListener?: (event: string, handler: (data?: unknown) => void) => unknown
}

interface ReadLineOptions {
    input?: ReadableLike
    output?: WritableLike
    prompt?: string
}

type Listener = (...args: any[]) => void

function writeToStream (stream: WritableLike | undefined, value: string, callback?: StreamWriteCallback): boolean {
    const result = stream?.write?.(value) ?? false
    callback?.()
    return Boolean(result)
}

export function clearLine (stream: WritableLike, _dir = 0, callback?: StreamWriteCallback): boolean {
    return writeToStream(stream, '\r\x1b[2K', callback)
}

export function cursorTo (
    stream: WritableLike,
    x = 0,
    yOrCallback?: number | StreamWriteCallback,
    callback?: StreamWriteCallback,
): boolean {
    const y = typeof yOrCallback === 'number' ? yOrCallback : null
    const cb = typeof yOrCallback === 'function' ? yOrCallback : callback
    const sequence = y === null ? `\r${x > 0 ? `\x1b[${x + 1}G` : ''}` : `\x1b[${y + 1};${x + 1}H`
    return writeToStream(stream, sequence, cb)
}

export class ReadLine {
    private listeners = new Map<string, Set<Listener>>()
    private buffer = ''
    private closed = false
    private promptValue: string
    private readonly handleDataBound = (data?: unknown): void => this.handleData(data)

    constructor (private options: ReadLineOptions = {}) {
        this.promptValue = options.prompt ?? ''
        this.options.input?.on?.('data', this.handleDataBound)
    }

    on (event: string, handler: Listener): this {
        let handlers = this.listeners.get(event)
        if (!handlers) {
            handlers = new Set()
            this.listeners.set(event, handlers)
        }
        handlers.add(handler)
        return this
    }

    once (event: string, handler: Listener): this {
        const wrapper: Listener = (...args) => {
            this.off(event, wrapper)
            handler(...args)
        }
        return this.on(event, wrapper)
    }

    off (event: string, handler: Listener): this {
        this.listeners.get(event)?.delete(handler)
        return this
    }

    removeListener (event: string, handler: Listener): this {
        return this.off(event, handler)
    }

    prompt (_preserveCursor?: boolean): void {
        writeToStream(this.options.output, this.promptValue)
    }

    setPrompt (prompt: string): void {
        this.promptValue = prompt
    }

    close (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.options.input?.off?.('data', this.handleDataBound)
        this.options.input?.removeListener?.('data', this.handleDataBound)
        this.emit('close')
    }

    private handleData (data?: unknown): void {
        if (this.closed) {
            return
        }
        const text = typeof data === 'string' ? data : data?.toString?.() ?? ''
        this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

        let newlineIndex = this.buffer.indexOf('\n')
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex)
            this.buffer = this.buffer.slice(newlineIndex + 1)
            this.emit('line', line)
            newlineIndex = this.buffer.indexOf('\n')
        }
    }

    private emit (event: string, ...args: unknown[]): void {
        for (const handler of this.listeners.get(event) ?? []) {
            handler(...args)
        }
    }
}

export function createInterface (options: ReadLineOptions = {}): ReadLine {
    return new ReadLine(options)
}

export default {
    clearLine,
    cursorTo,
    createInterface,
    ReadLine,
}
