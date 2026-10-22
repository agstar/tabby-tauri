declare module 'russh' {
  export const OPEN_READ: number
  export const OPEN_WRITE: number
  export const OPEN_CREATE: number

  export enum SFTPFileType {
    File = 1,
    Directory = 2,
    Symlink = 3,
  }

  export type Channel = any
  export type SFTP = any
  export type SFTPFile = any
  export type SFTPDirectoryEntry = any
  export type NewChannel = any
  export type SshPublicKey = any
  export type AgentConnectionSpec = any
  export type AuthFailure = any
  export type KeyboardInteractiveAuthenticationState = any

  export function getSupportedKexAlgorithms(): string[]
  export function getSupportedKeyTypes(): string[]
  export function getSupportedCiphers(): string[]
  export function getSupportedMACs(): string[]
  export function getSupportedCompressionAlgorithms(): string[]
  export function parsePublicKey(contents: string): SshPublicKey
  export function isPageantRunning(): boolean

  export class AuthenticatedSSHClient { [key: string]: any }
  export class SSHClient { static connect(...args: any[]): any; [key: string]: any }
  export class SshTransport {
    static newCommand(...args: any[]): any
    static newSshChannel(...args: any[]): any
    static newSocksProxy(...args: any[]): any
    static newHttpProxy(...args: any[]): any
    static newSocket(...args: any[]): any
  }
  export class SSHAgentStream { static connect(...args: any[]): any }
  export class KeyPair { static parse(...args: any[]): any }
}
