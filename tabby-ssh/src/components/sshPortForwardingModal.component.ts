/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input } from '@angular/core'
import { SSHConnectionLike } from '../session/types'
import { ForwardedPortConfig } from '../api'

/** @hidden */
@Component({
    templateUrl: './sshPortForwardingModal.component.pug',
})
export class SSHPortForwardingModalComponent {
    @Input() session: SSHConnectionLike

    onForwardAdded (fw: ForwardedPortConfig) {
        this.session.addPortForward(fw)
    }

    onForwardRemoved (fw: ForwardedPortConfig) {
        this.session.removePortForward(fw)
    }
}
