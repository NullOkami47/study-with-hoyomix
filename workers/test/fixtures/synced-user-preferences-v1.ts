// Frozen v1 client contract fixture.
/**
 * Explicit account preferences contain only current workspace settings.
 * Credentials, library contents, history, player queue and device-only media
 * choices are deliberately excluded from this contract.
 */
export interface SyncedUserPreferences {
  locale: 'zh-Hant' | 'zh-Hans' | 'en'
  volume: number
  lowPower: boolean
  backgroundMode: 'ambient' | 'still'
  visualStyle: 'cinematic' | 'studio'
  studioBlur: number
  studioGlassGray: number
  studioEdge: number
  studyTipsEnabled: boolean
}

export const SYNCED_USER_PREFERENCE_KEYS = [
  'locale', 'volume', 'lowPower', 'backgroundMode', 'visualStyle',
  'studioBlur', 'studioGlassGray', 'studioEdge', 'studyTipsEnabled',
] as const

const invalid = (): never => { throw new Error('invalid_synced_user_preferences') }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

export function parseSyncedUserPreferences(input: unknown): SyncedUserPreferences {
  if (!isRecord(input)) invalid()
  const candidate = input as Record<string, unknown>
  const fields = Object.keys(candidate)
  if (fields.length !== SYNCED_USER_PREFERENCE_KEYS.length ||
    fields.some(key => !(SYNCED_USER_PREFERENCE_KEYS as readonly string[]).includes(key))) invalid()
  const { locale, volume, lowPower, backgroundMode, visualStyle, studioBlur,
    studioGlassGray, studioEdge, studyTipsEnabled } = candidate
  if (locale !== 'zh-Hant' && locale !== 'zh-Hans' && locale !== 'en') invalid()
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) invalid()
  if (typeof lowPower !== 'boolean') invalid()
  if (backgroundMode !== 'ambient' && backgroundMode !== 'still') invalid()
  if (visualStyle !== 'cinematic' && visualStyle !== 'studio') invalid()
  if (!integer(studioBlur, 4, 24) || !integer(studioGlassGray, 0, 100) ||
    !integer(studioEdge, 0, 100) || typeof studyTipsEnabled !== 'boolean') invalid()
  return {
    locale: locale as SyncedUserPreferences['locale'],
    volume: volume as number,
    lowPower: lowPower as boolean,
    backgroundMode: backgroundMode as SyncedUserPreferences['backgroundMode'],
    visualStyle: visualStyle as SyncedUserPreferences['visualStyle'],
    studioBlur: studioBlur as number,
    studioGlassGray: studioGlassGray as number,
    studioEdge: studioEdge as number,
    studyTipsEnabled: studyTipsEnabled as boolean,
  }
}
