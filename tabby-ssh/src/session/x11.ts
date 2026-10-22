import { Socket, SocketConnectOpts } from 'net'
import { Subject } from 'rxjs'
import { resolveX11DisplaySpec } from './x11Display'

export class X11Socket {
    error$ = new Subject<Error>()
    private socket: Socket | null = null

    static resolveDisplaySpec (spec?: string|null): SocketConnectOpts {
        return resolveX11DisplaySpec(spec, {
            displayEnv: process.env.DISPLAY,
            isWindows: process.platform === 'win32',
        }) as SocketConnectOpts
    }

    connect (spec: string): Promise<Socket> {
        this.socket = new Socket()
        return new Promise((resolve, reject) => {
            this.socket!.on('connect', () => {
                resolve(this.socket!)
            })
            this.socket!.on('error', e => {
                this.error$.next(e)
                reject(e)
            })
            this.socket!.connect(X11Socket.resolveDisplaySpec(spec))
        })
    }

    destroy (): void {
        this.socket?.destroy()
    }
}
