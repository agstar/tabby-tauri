import hexdump from 'hexer'
import bufferReplace from 'buffer-replace'
import colors from 'ansi-colors'
import binstring from 'binstring'
import { interval, debounce } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

export type InputMode = null | 'local-echo' | 'readline' | 'readline-hex'
export type OutputMode = null | 'hex'
export type NewlineMode = null | 'cr' | 'lf' | 'crlf' | 'implicit_cr' | 'implicit_lf'

export interface StreamProcessingOptions {
    inputMode: InputMode
    inputNewlines: NewlineMode
    outputMode: OutputMode
    outputNewlines: NewlineMode
}

export class TerminalStreamProcessor extends SessionMiddleware {
    forceEcho = false
    private inputPromptVisible = false
    private inputLineBuffer = ''
    private started = false

    constructor (private options: StreamProcessingOptions) {
        super()
        this.outputToTerminal$.pipe(debounce(() => interval(500))).subscribe(() => {
            if (this.started) {
                this.onOutputSettled()
            }
        })
    }

    start (): void {
        this.started = true
    }

    feedFromSession (data: Buffer): void {
        if (this.options.inputMode?.startsWith('readline')) {
            if (this.inputPromptVisible) {
                this.outputToTerminal.next(Buffer.from('\r\x1b[2K'))
                this.inputPromptVisible = false
            }
        }

        data = this.replaceNewlines(data, this.options.outputNewlines)

        if (this.options.outputMode === 'hex') {
            this.outputToTerminal.next(Buffer.concat([
                Buffer.from('\r\n'),
                Buffer.from(hexdump(data, {
                    group: 1,
                    gutter: 4,
                    divide: colors.gray(' ｜ '),
                    emptyHuman: colors.gray('╳'),
                }).replaceAll('\n', '\r\n')),
                Buffer.from('\r\n\n'),
            ]))
        } else {
            this.outputToTerminal.next(data)
        }
    }

    feedFromTerminal (data: Buffer): void {
        if (this.options.inputMode === 'local-echo' || this.forceEcho) {
            this.outputToTerminal.next(this.replaceNewlines(data, 'crlf'))
        }
        if (this.options.inputMode?.startsWith('readline')) {
            this.feedReadlineInput(data)
        } else {
            this.onTerminalInput(data)
        }
    }

    resize (): void {
        if (this.options.inputMode?.startsWith('readline')) {
            this.redrawInputPrompt()
        }
    }

    close (): void {
        this.inputLineBuffer = ''
        super.close()
    }

    private feedReadlineInput (data: Buffer): void {
        for (const char of data.toString('utf-8')) {
            if (char === '\r' || char === '\n') {
                this.outputToTerminal.next(Buffer.from('\r\n'))
                this.onTerminalInput(Buffer.from(this.inputLineBuffer + '\n'))
                this.inputLineBuffer = ''
                this.resetInputPrompt()
            } else if (char === '\x7f' || char === '\b') {
                if (this.inputLineBuffer.length) {
                    this.inputLineBuffer = this.inputLineBuffer.slice(0, -1)
                    this.outputToTerminal.next(Buffer.from('\b \b'))
                }
            } else if (char === '\x03') {
                this.inputLineBuffer = ''
                this.outputToTerminal.next(Buffer.from('^C'))
                this.resetInputPrompt()
            } else if (char >= ' ') {
                this.inputLineBuffer += char
                this.outputToTerminal.next(Buffer.from(char))
            }
        }
    }

    private onTerminalInput (data: Buffer) {
        if (this.options.inputMode === 'readline-hex') {
            const tokens = data.toString().split(/\s/g)
            data = Buffer.concat(tokens.filter(t => !!t).map(t => {
                if (t.startsWith('0x')) {
                    t = t.substring(2)
                }
                return binstring(t, { 'in': 'hex' })
            }))
        }

        data = this.replaceNewlines(data, this.options.inputNewlines)
        this.outputToSession.next(data)
    }

    private onOutputSettled () {
        if (this.options.inputMode?.startsWith('readline') && !this.inputPromptVisible) {
            this.resetInputPrompt()
        }
    }

    private resetInputPrompt () {
        this.outputToTerminal.next(Buffer.from('\r\n' + this.inputPrompt()))
        this.inputPromptVisible = true
    }

    private redrawInputPrompt (): void {
        if (this.inputPromptVisible) {
            this.outputToTerminal.next(Buffer.from('\r\x1b[2K' + this.inputPrompt() + this.inputLineBuffer))
        }
    }

    private inputPrompt (): string {
        return this.options.inputMode === 'readline-hex' ? 'hex> ' : '> '
    }

    private replaceNewlines (data: Buffer, mode?: NewlineMode): Buffer {
        if (!mode) {
            return data
        } else if (mode === 'implicit_cr') {
            return bufferReplace(data, '\n', '\r\n')
        } else if (mode === 'implicit_lf') {
            return bufferReplace(data, '\r', '\r\n')
        }

        data = bufferReplace(data, '\r\n', '\n')
        data = bufferReplace(data, '\r', '\n')
        const replacement = {
            strip: '',
            cr: '\r',
            lf: '\n',
            crlf: '\r\n',
        }[mode]
        return bufferReplace(data, '\n', replacement)
    }
}
