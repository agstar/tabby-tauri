function unsupported (feature: string): never {
    throw new Error(`${feature} is unsupported in the Windows-only Tauri renderer; use a Tauri/Rust provider or browser fetch instead`)
}

export class TLSSocket {}

export function connect (): never {
    return unsupported('tls.connect')
}

export function createSecureContext (): never {
    return unsupported('tls.createSecureContext')
}

export default { TLSSocket, connect, createSecureContext }
