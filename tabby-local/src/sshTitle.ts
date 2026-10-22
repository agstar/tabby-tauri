export interface LocalSshDestination {
    host: string
    port: number
    username: string|null
    privateKeyPath: string|null
}

export function parseLocalSshDestinationTitle (line: string): string|null {
    return parseLocalSshDestination(line)?.host ?? null
}

export function parseLocalSshDestination (line: string): LocalSshDestination|null {
    const args = tokenizeShellCommand(line.trim())
    if (args[0] !== 'ssh') {
        return null
    }
    let username: string|null = null
    let port = 22
    let privateKeyPath: string|null = null
    for (let i = 1; i < args.length; i++) {
        const arg = args[i]
        if (!arg || arg === '--') {
            continue
        }
        if (arg === '-l') {
            username = args[++i] ?? username
            continue
        }
        if (arg.startsWith('-l') && arg.length > 2) {
            username = arg.slice(2)
            continue
        }
        if (arg === '-p') {
            port = parseInt(args[++i] ?? '', 10) || port
            continue
        }
        if (arg.startsWith('-p') && arg.length > 2) {
            port = parseInt(arg.slice(2), 10) || port
            continue
        }
        if (arg === '-i') {
            privateKeyPath = args[++i] ?? privateKeyPath
            continue
        }
        if (arg.startsWith('-i') && arg.length > 2) {
            privateKeyPath = arg.slice(2)
            continue
        }
        if (arg.startsWith('-')) {
            if (sshOptionTakesValue(arg) && !sshOptionHasInlineValue(arg)) {
                i++
            }
            continue
        }
        let destination = arg.replace(/^ssh:\/\//i, '')
        const at = destination.lastIndexOf('@')
        if (at !== -1) {
            username = destination.slice(0, at) || username
            destination = destination.slice(at + 1)
        }
        destination = destination.replace(/^\[/, '').replace(/\]$/, '')
        const colonPort = /^([^:]+):(\d+)$/.exec(destination)
        if (colonPort) {
            destination = colonPort[1]
            port = parseInt(colonPort[2], 10) || port
        }
        return destination ? { host: destination, port, username, privateKeyPath } : null
    }
    return null
}

function sshOptionTakesValue (arg: string): boolean {
    return [
        '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
        '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
    ].includes(arg)
}

function sshOptionHasInlineValue (arg: string): boolean {
    return /^-[bcDEeFIiJLlmOoQpRSWw].+/.test(arg) || arg.includes('=')
}

function tokenizeShellCommand (line: string): string[] {
    const tokens: string[] = []
    let current = ''
    let quote: '"'|"'"|null = null
    let escaping = false
    for (const char of line) {
        if (escaping) {
            current += char
            escaping = false
            continue
        }
        if (char === '\\' && quote !== "'") {
            escaping = true
            continue
        }
        if (quote) {
            if (char === quote) {
                quote = null
            } else {
                current += char
            }
            continue
        }
        if (char === '"' || char === "'") {
            quote = char
            continue
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current)
                current = ''
            }
            continue
        }
        current += char
    }
    if (current) {
        tokens.push(current)
    }
    return tokens
}
