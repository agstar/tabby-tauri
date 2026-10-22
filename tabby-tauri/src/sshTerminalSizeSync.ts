export interface SshTerminalSize {
    cols: number
    rows: number
}

export class SshTerminalSizeSync {
    private desired: SshTerminalSize
    private applied: SshTerminalSize|null = null
    private opened = false
    private queue = Promise.resolve()

    constructor (
        initial: SshTerminalSize,
        private send: (size: SshTerminalSize) => Promise<void>,
        private reportError: (error: unknown) => void = () => undefined,
    ) {
        this.desired = { ...initial }
    }

    get current (): SshTerminalSize {
        return { ...this.desired }
    }

    update (cols: number, rows: number): Promise<void> {
        this.desired = { cols, rows }
        return this.opened ? this.enqueue(this.desired) : Promise.resolve()
    }

    resync (): Promise<void> {
        return this.opened ? this.enqueue(this.desired, true) : Promise.resolve()
    }

    markOpened (openedSize: SshTerminalSize): Promise<void> {
        this.opened = true
        this.applied = { ...openedSize }
        if (this.isSameSize(this.applied, this.desired)) {
            return this.queue
        }
        return this.enqueue(this.desired)
    }

    private enqueue (size: SshTerminalSize, force = false): Promise<void> {
        const requested = { ...size }
        this.queue = this.queue.then(async () => {
            if (!force && this.isSameSize(this.applied, requested)) {
                return
            }
            await this.send(requested)
            this.applied = requested
        }).catch(error => this.reportError(error))
        return this.queue
    }

    private isSameSize (left: SshTerminalSize|null, right: SshTerminalSize): boolean {
        return left?.cols === right.cols && left.rows === right.rows
    }
}
