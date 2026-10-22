export const sep = '\\'
export const delimiter = ';'
export function basename (value: string, ext = ''): string {
    const name = value.split(/[\\/]/).pop() ?? value
    return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name
}
export function dirname (value: string): string {
    const parts = value.split(/[\\/]/)
    parts.pop()
    return parts.join('\\') || '.'
}
export function join (...parts: string[]): string { return parts.filter(Boolean).join('\\').replace(/[\\/]+/g, '\\') }
export function resolve (...parts: string[]): string { return join(...parts) }
export function normalize (value: string): string { return value.replace(/[\\/]+/g, '\\') }
export function extname (value: string): string { const b = basename(value); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i) : '' }
export const win32 = { sep, delimiter, basename, dirname, join, resolve, normalize, extname }
export const posix = { sep: '/', delimiter: ':', basename, dirname, join: (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'), resolve, normalize: (v: string) => v.replace(/\/+/g, '/'), extname }
export default { sep, delimiter, basename, dirname, join, resolve, normalize, extname, win32, posix }
