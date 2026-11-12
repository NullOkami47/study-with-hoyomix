import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
// CI sets VITEST_JSON_REPORT to keep per-test durations as a run artefact (P95-06).
const jsonReport = process.env.VITEST_JSON_REPORT

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwaRegisterMock.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/test/setup.ts'],
    ...(jsonReport ? { reporters: ['default', 'json'], outputFile: { json: jsonReport } } : {}),
  },
})
