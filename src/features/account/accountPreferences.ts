import type { Preferences } from '../../stores/preferences'
import type { PlaybackStore } from '../player/store'
import { useAccountSession } from './session'
import {
  parseSyncedUserPreferences,
  type SyncedUserPreferences,
} from './syncPreferences'

export type VolumeControls = Pick<PlaybackStore, 'volume' | 'setVolume'>

export interface AccountPreferencesRepository {
  load(): Promise<SyncedUserPreferences | null>
  save(preferences: SyncedUserPreferences): Promise<SyncedUserPreferences>
}

export function captureAccountPreferences(
  preferences: Preferences,
  player: VolumeControls,
): SyncedUserPreferences {
  return parseSyncedUserPreferences({
    locale: preferences.locale.value,
    volume: player.volume.value,
    backgroundMode: preferences.backgroundMode.value,
    visualStyle: preferences.visualStyle.value,
    studioBlur: preferences.studioBlur.value,
    studioGlassGray: preferences.studioGlassGray.value,
    studioEdge: preferences.studioEdge.value,
    studyTipsEnabled: preferences.studyTipsEnabled.value,
  })
}

/** Apply only the validated workspace allowlist through production setters. */
export function applyAccountPreferences(
  preferences: Preferences,
  player: VolumeControls,
  remote: SyncedUserPreferences,
): void {
  const saved = parseSyncedUserPreferences(remote)
  preferences.setLocale(saved.locale)
  preferences.setBackgroundMode(saved.backgroundMode)
  preferences.setVisualStyle(saved.visualStyle)
  preferences.setStudioBlur(saved.studioBlur)
  preferences.setStudioGlassGray(saved.studioGlassGray)
  preferences.setStudioEdge(saved.studioEdge)
  preferences.setStudyTipsEnabled(saved.studyTipsEnabled)
  player.setVolume(saved.volume)
}

export function createAccountPreferencesRepository(fetcher: typeof fetch = fetch): AccountPreferencesRepository {
  const path = '/api/account/ui-preferences'
  let revision: string | null = null
  let revisionUser: string | null = null
  const request = async (method: 'GET' | 'PUT', body?: string): Promise<SyncedUserPreferences | null> => {
    const userId = useAccountSession().userId.value
    if (revisionUser !== userId) { revision = null; revisionUser = userId }
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'x-account-preferences-schema': '2',
        // L-24 (D9): every write is conditional. The client echoes the server's ETag, quoted or
        // bare; before it has one it claims the row-less state, so an existing row is never
        // overwritten blindly (the server answers 409/412 and automatic sync re-reads). The bare
        // form is the one every Worker version accepts.
        ...(method === 'PUT' ? { 'if-match': revision ?? 'absent' } : {}),
        ...(userId ? { 'x-account-user-id': userId } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    })
    if (!response.ok) throw new Error('account_preferences_http_' + response.status)
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      throw new Error('account_preferences_invalid_response')
    }
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('account_preferences_invalid_response')
    }
    const fields = Object.keys(value)
    if (fields.length !== 1 || fields[0] !== 'preferences') {
      throw new Error('account_preferences_invalid_response')
    }
    if (useAccountSession().userId.value !== userId) throw new Error('account_session_changed')
    // Cloudflare weakens the Worker's strong ETag to W/"<n>" on compressed responses. Echo the
    // strong form so an older Worker, which rejects W/ with 400, still accepts the write.
    revision = response.headers.get('etag')?.trim().replace(/^W\//u, '') ?? null
    const prefs = (value as { preferences: unknown }).preferences
    return prefs === null ? null : parseSyncedUserPreferences(prefs)
  }
  return {
    load: () => request('GET'),
    async save(preferences) {
      const saved = await request('PUT', JSON.stringify({ preferences: parseSyncedUserPreferences(preferences) }))
      if (!saved) throw new Error('account_preferences_invalid_response')
      return saved
    },
  }
}
