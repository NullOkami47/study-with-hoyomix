import type { StaticBackgroundDefinition } from '../../features/backgrounds/staticDefinitions'
import type { PublicBackground } from '../../features/backgrounds/types'

/** Metadata only: these test URLs do not name shipped files or hosted media. */
export const PUBLIC_BACKGROUND_FIXTURE_IDS = ['fixture-scene-1', 'fixture-scene-2', 'fixture-scene-3'] as const

export function createPublicBackground(id: string = PUBLIC_BACKGROUND_FIXTURE_IDS[0], overrides: Partial<PublicBackground> = {}): PublicBackground {
  return {
    id, revision: 1, status: 'published', kind: 'video', contentType: 'video/mp4',
    byteSize: 100, width: 1920, height: 1080, durationMs: 20_000, fps: 24,
    mediaUrl: `/__test__/backgrounds/${id}.mp4`,
    posterUrl: `/__test__/backgrounds/${id}.jpg`,
    rightsStatus: 'not-reviewed', createdAt: 0, updatedAt: 0, publishedAt: 0, archivedAt: null,
    title: `Synthetic ${id}`, ...overrides,
  }
}

export function createPublicBackgrounds(): PublicBackground[] {
  return PUBLIC_BACKGROUND_FIXTURE_IDS.map(id => createPublicBackground(id))
}

/** Opt-in module replacement for specs exercising shipped-catalogue contracts. */
export function createStaticBackgroundFixture() {
  const collections = ['urban-stroll', 'lofi-girl', 'other'] as const
  const titleKeys = ['settings.backgrounds.collection.urbanStroll', 'settings.backgrounds.collection.lofiGirl', 'settings.backgrounds.collection.other'] as const
  const definitions: StaticBackgroundDefinition[] = PUBLIC_BACKGROUND_FIXTURE_IDS.map((id, index) => ({
    id, game: 'zzz', collection: collections[index]!, title: `Synthetic scene ${index + 1}`,
    titleKey: titleKeys[index]!, mediaSource: 'static',
    mediaUrl: `/__test__/backgrounds/${id}-master.mp4`,
    posterUrl: `/__test__/backgrounds/${id}.jpg`,
    byteSize: 300, width: 2560, height: 1440, fps: 30, durationMs: 20_000,
    playbackVersion: { mediaUrl: `/__test__/backgrounds/${id}.mp4`, width: 1920, height: 1080, fps: 24, byteSize: 100 },
    highQualityVersion: { mediaUrl: `/__test__/backgrounds/${id}-high.mp4`, width: 2560, height: 1440, fps: 30, byteSize: 200 },
  }))
  const byId = new Map(definitions.map(definition => [definition.id, definition]))
  return {
    STATIC_BACKGROUND_DEFINITIONS: definitions,
    STATIC_BACKGROUND_IDS: definitions.map(({ id }) => id),
    isStaticBackgroundId: (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && byId.has(id),
    staticBackgroundDefinition: (id: string) => byId.get(id) ?? null,
  }
}
