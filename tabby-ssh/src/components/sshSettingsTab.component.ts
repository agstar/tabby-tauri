import { Component, HostBinding } from '@angular/core'
import { resolveX11DisplaySpec } from '../session/x11Display'
import { ConfigService, HostAppService, Platform } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './sshSettingsTab.component.pug',
})
export class SSHSettingsTabComponent {
    Platform = Platform
    defaultX11Display: string

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
    ) {
        const spec = resolveX11DisplaySpec(null, { isWindows: hostApp.platform === Platform.Windows })
        if (spec.path) {
            this.defaultX11Display = spec.path
        } else {
            this.defaultX11Display = `${spec.host ?? 'localhost'}:${spec.port ?? 6000}`
        }
    }
}
