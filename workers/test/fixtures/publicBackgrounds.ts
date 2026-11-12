import type { StaticBackgroundDefinition } from '../../../src/features/backgrounds/staticDefinitions'

// Test-only metadata. These paths do not identify bundled files or hosted media.
const scenes = [
  ['demo-room-dawn', 'Synthetic Room at Dawn', 'synthetic-room'],
  ['demo-room-noon', 'Synthetic Room at Noon', 'synthetic-room'],
  ['demo-room-night', 'Synthetic Room at Night', 'synthetic-room'],
  ['demo-garden-dawn', 'Synthetic Garden at Dawn', 'synthetic-garden'],
  ['demo-garden-noon', 'Synthetic Garden at Noon', 'synthetic-garden'],
  ['demo-garden-night', 'Synthetic Garden at Night', 'synthetic-garden'],
  ['demo-study-dawn', 'Synthetic Study at Dawn', 'synthetic-study'],
  ['demo-study-noon', 'Synthetic Study at Noon', 'synthetic-study'],
  ['demo-study-night', 'Synthetic Study at Night', 'synthetic-study'],
] as const

export const PUBLIC_BACKGROUND_DEFINITIONS: readonly StaticBackgroundDefinition[] = scenes.map(
  ([id, title, collection]): StaticBackgroundDefinition => ({
    id,
    title,
    titleKey: 'settings.backgrounds.untitled',
    game: 'zzz',
    collection,
    mediaUrl: `/test-fixtures/backgrounds/${id}.mp4`,
    mediaSource: 'static',
    posterUrl: `/test-fixtures/backgrounds/${id}.jpg`,
    byteSize: 100,
    width: 1920,
    height: 1080,
    fps: 24,
    durationMs: 10_000,
  }),
)

export const PUBLIC_BACKGROUND_IDS = PUBLIC_BACKGROUND_DEFINITIONS.map(({ id }) => id)
const definitionsById = new Map(PUBLIC_BACKGROUND_DEFINITIONS.map((definition) => [definition.id, definition]))
const staticIds = new Set(PUBLIC_BACKGROUND_IDS)

// Match the runtime slug grammar and finite membership; unknown ids stay rejected.
export const isPublicBackgroundId = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && staticIds.has(value)

export const publicBackgroundDefinition = (id: string): StaticBackgroundDefinition | null =>
  definitionsById.get(id) ?? null
