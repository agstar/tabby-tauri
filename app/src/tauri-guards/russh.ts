export const OPEN_READ = 0x0001
export const OPEN_WRITE = 0x0002
export const OPEN_CREATE = 0x0008

export enum SFTPFileType {
    File = 1,
    Directory = 2,
    Symlink = 3,
}

export interface SFTPDirectoryEntry { filename: string, metadata: any }
export type SFTP = any
export type SFTPFile = any
export type Channel = any
export type NewChannel = any
export type SshPublicKey = any
export type AgentConnectionSpec = any
export type AuthFailure = any
export type KeyboardInteractiveAuthenticationState = any

export function getSupportedKexAlgorithms (): string[] { return ['curve25519-sha256'] }
export function getSupportedKeyTypes (): string[] { return ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256'] }
export function getSupportedCiphers (): string[] { return ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com'] }
export function getSupportedMACs (): string[] { return ['hmac-sha2-256', 'hmac-sha2-512'] }
export function getSupportedCompressionAlgorithms (): string[] { return ['none'] }
export function parsePublicKey (contents: string): SshPublicKey { return { contents } }
export function isPageantRunning (): boolean { return false }

function unsupported (..._args: any[]): never {
    throw new Error('The Electron russh backend is unavailable in the Tauri renderer; use the Tauri SSH session factory instead')
}

export class AuthenticatedSSHClient {
    openShell (..._args: any[]): never { return unsupported() }
    openSFTP (..._args: any[]): never { return unsupported() }
    authNone (..._args: any[]): never { return unsupported() }
    authPassword (..._args: any[]): never { return unsupported() }
    authPublicKey (..._args: any[]): never { return unsupported() }
}

export class SSHClient {
    static connect (..._args: any[]): never { return unsupported() }
    authNone (..._args: any[]): never { return unsupported() }
    authPassword (..._args: any[]): never { return unsupported() }
    authPublicKey (..._args: any[]): never { return unsupported() }
    startKeyboardInteractiveAuthentication (..._args: any[]): never { return unsupported() }
}

export class SshTransport {
    static newCommand (..._args: any[]): never { return unsupported() }
    static newSshChannel (..._args: any[]): never { return unsupported() }
    static newSocksProxy (..._args: any[]): never { return unsupported() }
    static newHttpProxy (..._args: any[]): never { return unsupported() }
    static newSocket (..._args: any[]): never { return unsupported() }
}

export class SSHAgentStream {
    static connect (..._args: any[]): never { return unsupported() }
}

export class KeyPair {
    static parse (..._args: any[]): never { return unsupported() }
}
