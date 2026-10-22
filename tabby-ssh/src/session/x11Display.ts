export interface X11DisplaySpec {
    host?: string
    port?: number
    path?: string
}

export function resolveX11DisplaySpec (
    spec?: string|null,
    options: { isWindows?: boolean, displayEnv?: string|null } = {},
): X11DisplaySpec {
    // eslint-disable-next-line prefer-const, @typescript-eslint/no-unused-vars
    let [_, xHost, xDisplay] = /^(.+):(\d+)(?:.(\d+))$/.exec(spec ?? options.displayEnv ?? 'localhost:0') ?? [undefined, undefined, undefined]
    if (options.isWindows) {
        xHost ??= 'localhost'
    } else {
        xHost ??= 'unix'
    }

    if (spec?.startsWith('/')) {
        xHost = spec
    }

    const display = parseInt(xDisplay ?? '0')
    const port = display < 100 ? display + 6000 : display

    if (xHost === 'unix') {
        xHost = `/tmp/.X11-unix/X${display}`
    }

    if (xHost.startsWith('/')) {
        return {
            path: xHost,
        }
    } else {
        return {
            host: xHost,
            port: port,
        }
    }
}
