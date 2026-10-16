import en from './messages/en'
import zhHans from './messages/zh-Hans'
import zhHant from './messages/zh-Hant'

export type Locale = 'zh-Hant' | 'zh-Hans' | 'en'
export type TranslationKey = keyof typeof en

const localeMessages: Record<Locale, Record<TranslationKey, string>> = {
  'zh-Hant': zhHant,
  'zh-Hans': zhHans,
  en,
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-Hant' || value === 'zh-Hans' || value === 'en'
}

export function mapBrowserLocale(language: string): Locale {
  const parts = language.replace('_', '-').toLowerCase().split('-')

  if (parts[0] !== 'zh') return 'en'
  if (parts.includes('hant')) return 'zh-Hant'
  if (parts.includes('hans')) return 'zh-Hans'
  if (parts.some((part) => ['tw', 'hk', 'mo'].includes(part))) {
    return 'zh-Hant'
  }

  return 'zh-Hans'
}

export function resolveLocale(browserLanguage: string, persistedLocale?: unknown): Locale {
  return isLocale(persistedLocale) ? persistedLocale : mapBrowserLocale(browserLanguage)
}

export function translate(locale: Locale, key: TranslationKey, params?: Record<string, unknown>): string {
  let msg = localeMessages[locale][key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v))
    }
  }
  return msg
}
