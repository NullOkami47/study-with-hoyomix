import type { StaticBackgroundDefinition } from '../../src/features/backgrounds/staticDefinitions'

// Synthetic metadata exercises shipped-media behaviour without shipping game assets.
export const STATIC_BACKGROUND_DEFINITIONS: readonly StaticBackgroundDefinition[] = [
  ['demo-stroll-one', 'Demo One'], ['demo-stroll-two', 'Demo Two'], ['demo-stroll-three', 'Demo Three'],
  ['demo-background-four', 'Demo Four'], ['demo-background-five', 'Demo Five'],
  ['demo-background-six', 'Demo Six'], ['demo-background-seven', 'Demo Seven'],
  ['demo-background-eight', 'Demo Eight'], ['demo-background-nine', 'Demo Nine'],
].map(([id, title]) => ({
  id: id!, title: title!, game: 'zzz', collection: 'urban-stroll', titleKey: 'fixture.background',
  mediaUrl: '/test-fixtures/solid-colour.mp4', mediaSource: 'static' as const,
  posterUrl: '/test-fixtures/solid-colour.jpg', byteSize: 2048, width: 1920,
  height: 1080, fps: 24, durationMs: 1000,
}))
export const STATIC_BACKGROUND_IDS = STATIC_BACKGROUND_DEFINITIONS.map(({id}) => id)
export const isStaticBackgroundId = (id: string) => STATIC_BACKGROUND_IDS.includes(id)
export const staticBackgroundDefinition = (id: string) => STATIC_BACKGROUND_DEFINITIONS.find(entry => entry.id === id) ?? null