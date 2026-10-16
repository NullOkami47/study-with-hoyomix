/**
 * Explicit account preferences contain only current workspace settings.
 * Credentials, library contents, history, player queue and device-only media
 * choices are deliberately excluded from this contract.
 */
export interface SyncedUserPreferences {
  locale: 'zh-Hant' | 'zh-Hans' | 'en'
  volume: number
  backgroundMode: 'ambient' | 'still'
  visualStyle: 'cinematic' | 'studio'
  studioBlur: number
  studioGlassGray: number
  studioEdge: number
  studyTipsEnabled: boolean
  backgroundPlaybackMode?: 'random' | 'sequential'
  backgroundQualityMode?: 'auto' | '1440p' | 'native'
}

export const SYNCED_USER_PREFERENCE_KEYS = [
  'locale', 'volume', 'backgroundMode', 'visualStyle',
  'studioBlur', 'studioGlassGray', 'studioEdge', 'studyTipsEnabled',
  'backgroundPlaybackMode', 'backgroundQualityMode',
] as const

const invalid = (): never => { throw new Error('invalid_synced_user_preferences') }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

export function parseSyncedUserPreferences(input: unknown): SyncedUserPreferences {
  if (!isRecord(input)) invalid()
  const candidate = { ...(input as Record<string, unknown>) }
  // Deployed records may contain this retired boolean; output never does.
  if ('lowPower' in candidate && typeof candidate.lowPower !== 'boolean') invalid()
  delete candidate.lowPower
  // Missing extension fields in deployed records mean "not saved yet", not a
  // preference for defaults. Preserve this device's existing quality/order.
  if ('backgroundPlaybackMode' in candidate && candidate.backgroundPlaybackMode !== 'random' && candidate.backgroundPlaybackMode !== 'sequential') invalid()
  if ('backgroundQualityMode' in candidate && !['auto', '1440p', 'native'].includes(String(candidate.backgroundQualityMode))) invalid()
  const fields = Object.keys(candidate)
  if (SYNCED_USER_PREFERENCE_KEYS.slice(0, 8).some(key => !(key in candidate)) ||
    fields.some(key => !(SYNCED_USER_PREFERENCE_KEYS as readonly string[]).includes(key))) invalid()
  const { locale, volume, backgroundMode, visualStyle, studioBlur,
    studioGlassGray, studioEdge, studyTipsEnabled } = candidate
  if (locale !== 'zh-Hant' && locale !== 'zh-Hans' && locale !== 'en') invalid()
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) invalid()
  if (backgroundMode !== 'ambient' && backgroundMode !== 'still') invalid()
  if (visualStyle !== 'cinematic' && visualStyle !== 'studio') invalid()
  if (!integer(studioBlur, 4, 24) || !integer(studioGlassGray, 0, 100) ||
    !integer(studioEdge, 0, 100) || typeof studyTipsEnabled !== 'boolean') invalid()
  return {
    locale: locale as SyncedUserPreferences['locale'],
    volume: volume as number,
    backgroundMode: backgroundMode as SyncedUserPreferences['backgroundMode'],
    visualStyle: visualStyle as SyncedUserPreferences['visualStyle'],
    studioBlur: studioBlur as number,
    studioGlassGray: studioGlassGray as number,
    studioEdge: studioEdge as number,
    studyTipsEnabled: studyTipsEnabled as boolean,
    ...('backgroundPlaybackMode' in candidate ? { backgroundPlaybackMode: candidate.backgroundPlaybackMode as SyncedUserPreferences['backgroundPlaybackMode'] } : {}),
    ...('backgroundQualityMode' in candidate ? { backgroundQualityMode: candidate.backgroundQualityMode as SyncedUserPreferences['backgroundQualityMode'] } : {}),
  }
}
