import * as fsPromises from '../tauri-providers/fs-promises'

function unsupportedSync (method: string): never {
    throw new Error(`${method} is not available synchronously in the Tauri renderer; use fs/promises or a Tauri provider`)
}

export function readdirSync (_path: string): never { return unsupportedSync('fs.readdirSync') }
export function existsSync (_path: string): never { return unsupportedSync('fs.existsSync') }
export function statSync (_path: string): never { return unsupportedSync('fs.statSync') }
export function readFileSync (): never { return unsupportedSync('fs.readFileSync') }
export function writeFileSync (): never { return unsupportedSync('fs.writeFileSync') }
export function unlinkSync (): never { return unsupportedSync('fs.unlinkSync') }
export function mkdirSync (): never { return unsupportedSync('fs.mkdirSync') }
export function open (): never { return unsupportedSync('fs.open') }
export function close (): never { return unsupportedSync('fs.close') }
export function closeSync (): never { return unsupportedSync('fs.closeSync') }
export function realpathSync (_path: string): never { return unsupportedSync('fs.realpathSync') }

export const promises = fsPromises

export default {
    readdirSync,
    existsSync,
    statSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    mkdirSync,
    open,
    close,
    closeSync,
    realpathSync,
    promises,
}
