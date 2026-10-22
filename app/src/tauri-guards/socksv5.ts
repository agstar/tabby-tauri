function unsupported (feature: string): never {
    throw new Error(`${feature} is unsupported in the Windows-only Tauri renderer; dynamic SOCKS forwarding needs a Tauri/Rust provider`)
}

export const auth = {
    None () {
        return { type: 'none' }
    },
}

export function createServer (): never {
    return unsupported('socksv5.createServer')
}

export default { auth, createServer }
