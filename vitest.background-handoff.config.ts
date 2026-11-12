import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// Convenience command for the background handoff regressions, also in the normal suite.
// Preserved alongside the original red-run evidence.
export default defineConfig({ ...base, test: { ...base.test, include: ['src/features/player/PlayerBar.backgroundHandoff.spec.ts'] } })
