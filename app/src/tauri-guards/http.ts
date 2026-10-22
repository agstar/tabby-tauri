export class Agent {
    maxSockets = Infinity
    maxTotalSockets = Infinity
    sockets: Record<string, unknown[]> = {}
    freeSockets: Record<string, unknown[]> = {}
    requests: Record<string, unknown[]> = {}

    constructor (_opts?: unknown) {}

    addRequest (): void {}
    createConnection (): never {
        throw new Error('Node http.Agent connections are not available in the Tauri renderer')
    }
    destroy (): void {}
}

export function request (): never {
    throw new Error('Node http.request is not available in the Tauri renderer')
}

export function get (): never {
    throw new Error('Node http.get is not available in the Tauri renderer')
}

export const globalAgent = new Agent()
export const METHODS: string[] = []
export const STATUS_CODES: Record<number, string> = {}

export default { Agent, request, get, globalAgent, METHODS, STATUS_CODES }
