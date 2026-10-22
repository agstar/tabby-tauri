export function inherits (ctor: any, superCtor: any): void {
    if (!ctor || !superCtor) {
        return
    }
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            enumerable: false,
            writable: true,
            configurable: true,
        },
    })
}

export function format (...args: unknown[]): string {
    return args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
}

export function debuglog (): (...args: unknown[]) => void {
    return () => undefined
}

export function deprecate<T extends (...args: any[]) => any> (fn: T): T {
    return fn
}

export function inspect (value: unknown): string {
    try {
        return typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
        return String(value)
    }
}


export function promisify (fn: (...args: any[]) => any): (...args: any[]) => Promise<any> {
    return (...args: any[]) => new Promise((resolve, reject) => {
        fn(...args, (error: unknown, result: unknown) => error ? reject(error) : resolve(result))
    })
}

export const types = {}
export default { inherits, format, debuglog, deprecate, inspect, promisify, types }
