import { AfterViewInit, Component, ElementRef, HostListener, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { MessageBoxOptions } from '../api/platform'

/** @hidden */
@Component({
    templateUrl: './messageBoxModal.component.pug',
    styleUrls: ['./messageBoxModal.component.scss'],
})
export class MessageBoxModalComponent implements AfterViewInit {
    @Input() options: MessageBoxOptions

    constructor (
        private element: ElementRef<HTMLElement>,
        private modalInstance: NgbActiveModal,
    ) { }

    ngAfterViewInit (): void {
        this.element.nativeElement.querySelector<HTMLButtonElement>('button[autofocus]')?.focus()
    }

    @HostListener('document:keydown', ['$event'])
    onKeyDown (event: KeyboardEvent): void {
        if (event.key !== 'Enter' || !this.isValidButtonIndex(this.options.defaultId)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.modalInstance.close(this.options.defaultId)
    }

    onButton (index: number): void {
        this.modalInstance.close(index)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }

    private isValidButtonIndex (index: number | undefined): index is number {
        return index !== undefined && index >= 0 && index < this.options.buttons.length
    }
}
