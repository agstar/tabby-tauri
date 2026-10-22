import process from './process'

export function tmpdir (): string { return process.env.TMP ?? process.env.TEMP ?? 'C:\\Windows\\Temp' }
export function homedir (): string { return process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users' }
export function release (): string { return '10.0.19045' }
export function platform (): string { return 'win32' }
export function arch (): string { return 'x64' }
export default { tmpdir, homedir, release, platform, arch }
