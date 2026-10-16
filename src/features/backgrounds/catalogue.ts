import { translate, type Locale, type TranslationKey } from '../../i18n'
import type { PublicBackground } from './types'
import { applyOverride, type BackgroundOverrides } from './overrides'
import {
  BACKGROUND_BUCKET_ORIGIN,
  bucketMediaUrl,
  isBucketMediaUrl,
  STATIC_BACKGROUND_DEFINITIONS,
  STATIC_BACKGROUND_RIGHTS_STATUS,
  staticBackgroundDefinition,
  type StaticBackgroundDefinition,
} from './staticDefinitions'

export {
  BACKGROUND_BUCKET_ORIGIN,
  bucketMediaUrl,
  isBucketMediaUrl,
} from './staticDefinitions'

/**
 * Localised view over the canonical shipped-asset definitions.
 *
 * The media metadata itself lives in `staticDefinitions.ts` so the Worker can
 * share it; this module only adds the i18n layer (translated titles and curated
 * group labels) that the browser needs.
 */

interface CollectionDefinition {
  game: string
  collection: string
  labelKey: TranslationKey
}

/** Display order of the curated groups inside the selector. */
export const BACKGROUND_COLLECTIONS: readonly CollectionDefinition[] = [
  { game: 'zzz', collection: 'urban-stroll', labelKey: 'settings.backgrounds.collection.urbanStroll' },
  { game: 'zzz', collection: 'lofi-girl', labelKey: 'settings.backgrounds.collection.lofiGirl' },
  { game: 'zzz', collection: 'other', labelKey: 'settings.backgrounds.collection.other' },
]

export const GAME_LABEL_KEYS: Record<string, TranslationKey> = {
  zzz: 'game.zzz',
}

const definitions: readonly StaticBackgroundDefinition[] = STATIC_BACKGROUND_DEFINITIONS

const titleKeys = new Map<string, TranslationKey>(
  definitions.map((definition) => [definition.id, definition.titleKey as TranslationKey]),
)

/**
 * The shipped catalogue as the browser should present it.
 *
 * An `overrides` map, when supplied, is applied here so the very first render
 * already honours administrator availability: a cached override hides a
 * disabled clip before any network call resolves, and a stale one can never
 * re-show it. Callers that have no verified overrides yet simply omit it.
 */
export function listStaticBackgrounds(overrides?: BackgroundOverrides): PublicBackground[] {
  return definitions
    .map((definition): PublicBackground => ({
      id: definition.id,
      revision: 1,
      status: 'published',
      kind: 'video',
      contentType: 'video/mp4',
      byteSize: definition.playbackVersion?.byteSize ?? definition.byteSize,
      width: definition.playbackVersion?.width ?? definition.width,
      height: definition.playbackVersion?.height ?? definition.height,
      durationMs: definition.durationMs,
      mediaUrl: definition.playbackVersion?.mediaUrl ?? definition.mediaUrl,
      mediaSource: definition.playbackVersion ? 'static' : definition.mediaSource,
      // Existing 1080p originals serve both envelopes without inventing detail.
      highQualityVersion: definition.highQualityVersion ?? { mediaUrl: definition.mediaUrl, width: definition.width, height: definition.height, fps: definition.fps, byteSize: definition.byteSize },
      posterUrl: definition.posterUrl,
      rightsStatus: STATIC_BACKGROUND_RIGHTS_STATUS,
      createdAt: 0,
      updatedAt: 0,
      publishedAt: 0,
      archivedAt: null,
      title: definition.title,
      game: definition.game,
      collection: definition.collection,
      fps: definition.playbackVersion?.fps ?? definition.fps,
    }))
    .map((entry) => applyOverride(entry, overrides?.get(entry.id)))
    .filter((entry): entry is PublicBackground => entry !== null)
}

/**
 * Localised display title for a background, falling back to a translated label.
 *
 * An administrator override always wins, but a shipped entry arrives carrying
 * its neutral catalogue title, which must not shadow the localised copy. The
 * override is therefore detected by comparing against the shipped default: only
 * a title that actually differs is treated as an administrative override.
 */
export function backgroundTitle(background: PublicBackground, locale: Locale): string {
  const definition = staticBackgroundDefinition(background.id)
  if (definition && background.title && background.title !== definition.title) return background.title
  const key = titleKeys.get(background.id)
  if (key) return translate(locale, key)
  return background.title ?? translate(locale, 'settings.backgrounds.untitled')
}

/** Localised label for a curated collection, or null for ungrouped items. */
export function collectionLabelKey(game: string, collection: string): TranslationKey | null {
  return BACKGROUND_COLLECTIONS.find(
    (entry) => entry.game === game && entry.collection === collection,
  )?.labelKey ?? null
}

/** Localised game heading, or null when the game has no known label. */
export function gameLabelKey(game: string): TranslationKey | null {
  return Object.prototype.hasOwnProperty.call(GAME_LABEL_KEYS, game) ? GAME_LABEL_KEYS[game] ?? null : null
}
