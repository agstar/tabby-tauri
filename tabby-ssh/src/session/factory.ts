import { Injector } from '@angular/core'
import { Observable } from 'rxjs'
import { BaseSession } from 'tabby-terminal'
import { SSHProfile } from '../api'
import { SSHConnectionLike } from './types'

/**
 * Injectable seam for host runtimes that need to replace the SSH transport while
 * keeping SSHTabComponent's existing UI, service-message, and multiplexing flow.
 *
 * Runtime implementations live in host-specific modules so the Tauri bundle does
 * not pull Electron/russh transport code through this shared provider contract.
 */
export abstract class SSHSessionFactory {
    abstract create (injector: Injector, profile: SSHProfile): SSHConnectionLike|Promise<SSHConnectionLike>
}

export interface SSHShellLikeSession extends BaseSession {
    serviceMessage$: Observable<string>
    start (): Promise<void>
    resyncSize?: () => void
}

/**
 * Injectable seam for host runtimes that need to replace the shell-channel
 * session while preserving BaseTerminalTabComponent wiring.
 */
export abstract class SSHShellSessionFactory {
    abstract create (
        injector: Injector,
        ssh: SSHConnectionLike,
        profile: SSHProfile,
    ): SSHShellLikeSession|Promise<SSHShellLikeSession>
}
