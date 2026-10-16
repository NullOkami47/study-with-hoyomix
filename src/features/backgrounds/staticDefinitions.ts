/**
 * Background integration contracts for the public source distribution.
 * Modified on 2026-10-16: bundled third-party media and infrastructure removed.
 * Operators may add media only when they have redistribution permission.
 */
export type StaticBackgroundMediaSource = 'static' | 'bucket'

export interface StaticBackgroundMediaVariant {
  mediaUrl: string
  width: number
  height: number
  fps: number
  byteSize: number
}

export interface StaticBackgroundDefinition {
  id: string
  game: string
  collection: string
  /** Neutral display title; the i18n key carries the localised copy. */
  title: string
  /** Translation key resolved by `catalogue.ts`; kept as a plain string here. */
  titleKey: string
  mediaUrl: string
  /** Whether `mediaUrl` is a shipped static file or an R2 bucket object. */
  mediaSource: StaticBackgroundMediaSource
  posterUrl: string
  byteSize: number
  width: number
  height: number
  fps: number
  durationMs: number
  highQualityVersion?: StaticBackgroundMediaVariant
  playbackVersion?: StaticBackgroundMediaVariant
}

/** Empty by default: this distribution does not point to a hosted media bucket. */
export const BACKGROUND_BUCKET_ORIGIN = ''
const BUCKET_MEDIA_PREFIX = 'backgrounds/catalog/'

/** No bucket URL is available until the operator supplies a trusted origin. */
export const bucketMediaUrl = (path: string): string =>
  BACKGROUND_BUCKET_ORIGIN ? `${BACKGROUND_BUCKET_ORIGIN}/${BUCKET_MEDIA_PREFIX}${path}` : ''

export const isBucketMediaUrl = (url: string): boolean =>
  Boolean(BACKGROUND_BUCKET_ORIGIN) && url.startsWith(`${BACKGROUND_BUCKET_ORIGIN}/${BUCKET_MEDIA_PREFIX}`)

/** No third-party assets are represented as rights-cleared by this release. */
export const STATIC_BACKGROUND_CONTENT_TYPE = 'video/mp4' as const
export const STATIC_BACKGROUND_RIGHTS_STATUS = 'not-reviewed' as const
export const STATIC_BACKGROUND_DEFINITIONS: readonly StaticBackgroundDefinition[] = []
const definitionsById = new Map<string, StaticBackgroundDefinition>(
  STATIC_BACKGROUND_DEFINITIONS.map((definition) => [definition.id, definition]),
)

/** Stable IDs of every shipped background, in catalogue order. */
export const STATIC_BACKGROUND_IDS: readonly string[] = STATIC_BACKGROUND_DEFINITIONS.map(({ id }) => id)

const staticIds = new Set<string>(STATIC_BACKGROUND_IDS)

/**
 * Static IDs are lower-case kebab slugs. Anything else (an upload UUID, a path
 * traversal attempt, a random string) is not a shipped background.
 */
const STATIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isStaticBackgroundId(value: string): boolean {
  return STATIC_ID_PATTERN.test(value) && staticIds.has(value)
}

export function staticBackgroundDefinition(id: string): StaticBackgroundDefinition | null {
  return definitionsById.get(id) ?? null
}

/** Playback media URL: the 1080p derivative when present, else the master. */
export function staticPlaybackMediaUrl(definition: StaticBackgroundDefinition): string {
  return definition.playbackVersion?.mediaUrl ?? definition.mediaUrl
}
