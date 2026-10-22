import { SessionMiddleware } from '../api/middleware'

export interface OneKeyPromptEvent {
    eventId: string
    sessionId: string
    requestedSecretKind: 'password' | 'passphrase' | 'unknown'
    promptExcerpt: string
    destination: string
    createdAt: number
    expiresAt: number
}

export interface DetectedOneKeyPrompt {
    requestedSecretKind: 'password' | 'passphrase' | 'unknown'
    promptExcerpt: string
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const PROMPT_WINDOW = 512
const EVENT_EXPIRY_MS = 60_000
const DEDUPE_COOLDOWN_MS = 5_000

const PASSPHRASE_PATTERNS = [
    /\bpassphrase\b[^\r\n]*[:：]\s*$/i,
    /\benter\s+passphrase\b[^\r\n]*$/i,
    /私钥[^\r\n]*(密码|口令)[^\r\n]*[:：]?\s*$/i,
]

const PASSWORD_PATTERNS = [
    /\bpassword\b\s*(for\s+[^\r\n:：]+)?\s*[:：]\s*$/i,
    /\benter\s+password\b[^\r\n]*[:：]?\s*$/i,
    /\[sudo\][^\r\n]*password[^\r\n]*[:：]\s*$/i,
    /\bmysql[^\r\n]*password[^\r\n]*[:：]\s*$/i,
    /(密码|口令)[^\r\n]*[:：]\s*$/i,
]

export function sanitizeOneKeyPromptExcerpt (text: string): string {
    return text
        .replace(ANSI_ESCAPE_PATTERN, '')
        .replace(CONTROL_PATTERN, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(-160)
}

export function detectOneKeyPrompt (text: string): DetectedOneKeyPrompt|null {
    const sanitized = text.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_PATTERN, '')
    const tail = sanitized.slice(-PROMPT_WINDOW)
    const line = tail.split(/\r?\n/).pop()?.trim() ?? ''
    if (!line) {
        return null
    }
    if (PASSPHRASE_PATTERNS.some(pattern => pattern.test(line))) {
        return {
            requestedSecretKind: 'passphrase',
            promptExcerpt: sanitizeOneKeyPromptExcerpt(line),
        }
    }
    if (PASSWORD_PATTERNS.some(pattern => pattern.test(line))) {
        return {
            requestedSecretKind: 'password',
            promptExcerpt: sanitizeOneKeyPromptExcerpt(line),
        }
    }
    return null
}

export class OneKeyPromptDetectionMiddleware extends SessionMiddleware {
    private tail = ''
    private lastEmittedAt = new Map<string, number>()

    constructor (
        private sessionId: string,
        private destination: string,
        private onPrompt: (event: OneKeyPromptEvent) => void,
    ) {
        super()
    }

    feedFromSession (data: Buffer): void {
        this.tail = `${this.tail}${data.toString('utf-8')}`.slice(-PROMPT_WINDOW)
        const detected = detectOneKeyPrompt(this.tail)
        if (detected) {
            const key = `${detected.requestedSecretKind}:${detected.promptExcerpt}`
            const now = Date.now()
            if (now - (this.lastEmittedAt.get(key) ?? 0) > DEDUPE_COOLDOWN_MS) {
                this.lastEmittedAt.set(key, now)
                this.onPrompt({
                    eventId: `${this.sessionId}:${now}:${Math.random().toString(36).slice(2)}`,
                    sessionId: this.sessionId,
                    requestedSecretKind: detected.requestedSecretKind,
                    promptExcerpt: detected.promptExcerpt,
                    destination: this.destination,
                    createdAt: now,
                    expiresAt: now + EVENT_EXPIRY_MS,
                })
            }
        }
        this.outputToTerminal.next(data)
    }
}
