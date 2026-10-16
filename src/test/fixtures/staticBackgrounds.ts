/** Original synthetic metadata for engine tests; no media is bundled or downloaded. */
import type { StaticBackgroundDefinition } from '../../features/backgrounds/staticDefinitions'

export const BACKGROUND_BUCKET_ORIGIN = 'https://media.example.invalid'
export const bucketMediaUrl = (path: string): string => `${BACKGROUND_BUCKET_ORIGIN}/backgrounds/catalog/${path}`
export const isBucketMediaUrl = (url: string): boolean => url.startsWith(`${BACKGROUND_BUCKET_ORIGIN}/backgrounds/catalog/`)
export const STATIC_BACKGROUND_RIGHTS_STATUS = 'not-reviewed' as const
export const STATIC_BACKGROUND_CONTENT_TYPE = 'video/mp4'
export const STATIC_BACKGROUND_DEFINITIONS: readonly StaticBackgroundDefinition[] = [
  'zzz-belle-lofi-girl', 'zzz-astra-yao', 'zzz-qingyi', 'zzz-ellen-joe',
  'zzz-urban-stroll-anby-billy', 'zzz-urban-stroll-koleda-ben',
].map((id, index): StaticBackgroundDefinition => ({
  id, title: `Synthetic scene ${index + 1}`, titleKey: 'settings.backgrounds.untitled', game: 'zzz', collection: 'synthetic',
  mediaUrl: `/backgrounds/synthetic/${index}.mp4`, posterUrl: `/backgrounds/synthetic/${index}.jpg`,
  mediaSource: 'static', byteSize: 100, width: 1920, height: 1080, fps: 24, durationMs: 10000,
}))
export const STATIC_BACKGROUND_IDS = STATIC_BACKGROUND_DEFINITIONS.map(item => item.id)
export const isStaticBackgroundId = (id: string): boolean => STATIC_BACKGROUND_IDS.includes(id)
export const staticBackgroundDefinition = (id: string): StaticBackgroundDefinition | null =>
  STATIC_BACKGROUND_DEFINITIONS.find(item => item.id === id) ?? null
export const staticPlaybackMediaUrl = (definition: StaticBackgroundDefinition): string =>
  definition.playbackVersion?.mediaUrl ?? definition.mediaUrl
