import { InjectionToken } from '@angular/core'

export const MESSAGE_FORMAT_CONFIG = new InjectionToken<string[]>('MESSAGE_FORMAT_CONFIG')

type TranslationParams = Record<string, unknown>
type CompiledTranslation = string | ((params?: TranslationParams) => string)

const placeholderPattern = /\{([A-Za-z0-9_.-]+)\}/g

function getParamValue (params: TranslationParams | undefined, key: string): unknown {
    if (!params) {
        return undefined
    }

    let value: unknown = params
    for (const part of key.split('.')) {
        if (!value || typeof value !== 'object' || !(part in value)) {
            return undefined
        }
        value = (value as TranslationParams)[part]
    }
    return value
}

function interpolate (message: string, params?: TranslationParams): string {
    return message.replace(placeholderPattern, (match, key: string) => {
        const value = getParamValue(params, key)
        return value === undefined || value === null ? match : String(value)
    })
}

export class TranslateMessageFormatCompiler {
    compile (value: CompiledTranslation, _lang?: string): CompiledTranslation {
        if (typeof value === 'string' && placeholderPattern.test(value)) {
            placeholderPattern.lastIndex = 0
            return (params?: TranslationParams) => interpolate(value, params)
        }
        placeholderPattern.lastIndex = 0
        return value
    }

    compileTranslations (translations: Record<string, unknown>, lang?: string): Record<string, unknown> {
        const compiled: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(translations)) {
            if (typeof value === 'string' || typeof value === 'function') {
                compiled[key] = this.compile(value as CompiledTranslation, lang)
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                compiled[key] = this.compileTranslations(value as Record<string, unknown>, lang)
            } else {
                compiled[key] = value
            }
        }
        return compiled
    }
}

export default { TranslateMessageFormatCompiler, MESSAGE_FORMAT_CONFIG }
