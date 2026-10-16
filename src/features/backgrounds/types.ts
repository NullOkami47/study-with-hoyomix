/**
 * Rotation interval in seconds. The canonical user-facing choices are whole
 * minutes (10/20/30/60); the short values are what older builds persisted and
 * are still read, still rotated with, and still accepted by account sync so an
 * existing preference is never discarded on upgrade.
 */
export type BackgroundIntervalSeconds = 600 | 1200 | 1800 | 3600 | 15 | 30 | 60 | 300

/** Choices offered in the selector for new and updated preferences. */
export const BACKGROUND_INTERVAL_CHOICES: readonly BackgroundIntervalSeconds[] = [600, 1200, 1800, 3600]

/** Values written by earlier builds; readable and syncable, never offered. */
export const BACKGROUND_INTERVAL_LEGACY: readonly BackgroundIntervalSeconds[] = [15, 30, 60, 300]

/** Every interval value the app and the worker may read or write. */
export const BACKGROUND_INTERVAL_VALUES: readonly BackgroundIntervalSeconds[] = [
  ...BACKGROUND_INTERVAL_CHOICES,
  ...BACKGROUND_INTERVAL_LEGACY,
]

/** First-use rotation cadence: 20 minutes. */
export const DEFAULT_BACKGROUND_INTERVAL_SECONDS: BackgroundIntervalSeconds = 1200

export type BackgroundPlaybackMode = 'random' | 'sequential'
export type BackgroundQualityMode = 'auto' | 'native' | '1440p'

/** First-use rotation order; a persisted preference always wins. */
export const DEFAULT_BACKGROUND_PLAYBACK_MODE: BackgroundPlaybackMode = 'random'

/**
 * Where a background's video bytes are served from: a file shipped in
 * `public/`, or the project's R2 bucket for clips that exceed the Workers
 * static-asset per-file limit.
 */
export type BackgroundMediaSource = 'static' | 'bucket'

export interface PublicBackground {
  id: string
  revision: number
  status: 'published'
  kind: 'image' | 'video'
  contentType: string
  byteSize: number
  width: number
  height: number
  durationMs: number | null
  mediaUrl: string
  posterUrl: string | null
  rightsStatus: string
  createdAt: number
  updatedAt: number
  publishedAt: number
  archivedAt: null
  /**
   * Catalogue display title. Optional, and explicitly nullable: both the public
   * and admin endpoints emit the same four metadata keys with `null` when the
   * administrator has not set them, so the gallery and the admin catalogue can
   * never disagree about a row.
   */
  title?: string | null
  /** Game the background belongs to, e.g. `zzz`. */
  game?: string | null
  /** Collection/source the background belongs to, e.g. `urban-stroll`. */
  collection?: string | null
  /** Administrator-set ordering hint; lower values sort first when provided. */
  displayOrder?: number | null
  /** Frame rate of the public playback media (at most 30 for registered videos). */
  fps?: number
  /**
   * Where `mediaUrl` resolves. Omitted for API rows, which are always
   * same-origin worker routes; the shipped catalogue declares `static` or
   * `bucket` so the playback layer never has to infer it.
   */
  mediaSource?: BackgroundMediaSource
  /** Legacy/custom repository recovery derivative; shipped entries already point to capped playback media. */
  playbackFallback?: { mediaUrl: string; width: number; height: number; fps: number; byteSize: number }
  /** Separately stored 1440p30 companion; normal playback uses the 1080p version. */
  highQualityVersion?: { mediaUrl: string; width: number; height: number; fps: number; byteSize: number }
}

export interface BackgroundSelection {
  selectedIds: string[]
  autoRotate: boolean
  intervalSeconds: BackgroundIntervalSeconds
}

export interface BackgroundRepository {
  list(): Promise<PublicBackground[]>
  getAccountSelection(): Promise<BackgroundSelection | null>
  saveAccountSelection(selection: BackgroundSelection): Promise<BackgroundSelection>
}
