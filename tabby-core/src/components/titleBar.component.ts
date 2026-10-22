import { Component, Input } from '@angular/core'
import { HostWindowService, PlatformService } from '../api'

/** @hidden */
@Component({
    selector: 'title-bar',
    templateUrl: './titleBar.component.pug',
    styleUrls: ['./titleBar.component.scss'],
})
export class TitleBarComponent {
    @Input() hideControls: boolean

    constructor (
        public hostWindow: HostWindowService,
        private platform: PlatformService,
    ) { }

    get shouldUseTauriNativeDragRegions (): boolean {
        return this.platform.supportsWindowControls
            && this.platform.displayCapabilities.customFrame.strategy === 'decorations-false-tauri-drag-region'
            && this.platform.displayCapabilities.draggableRegions.supported
    }
}
