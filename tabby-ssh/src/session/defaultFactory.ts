import { Injectable, Injector } from '@angular/core'
import { SSHProfile } from '../api'
import { SSHSessionFactory, SSHShellLikeSession, SSHShellSessionFactory } from './factory'
import { SSHConnectionLike } from './types'
import { SSHSession } from './ssh'
import { SSHShellSession } from './shell'

@Injectable()
export class DefaultSSHSessionFactory extends SSHSessionFactory {
    create (injector: Injector, profile: SSHProfile): SSHSession {
        return new SSHSession(injector, profile)
    }
}

@Injectable()
export class DefaultSSHShellSessionFactory extends SSHShellSessionFactory {
    create (injector: Injector, ssh: SSHConnectionLike, profile: SSHProfile): SSHShellLikeSession {
        if (!(ssh instanceof SSHSession)) {
            throw new Error('Default SSH shell factory requires the default SSH session implementation')
        }
        return new SSHShellSession(injector, ssh, profile)
    }
}
