import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'chat*.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: process.env.CHAT_E2E_OUTPUT,
  reporter: [['list'], ['json', { outputFile: process.env.CHAT_E2E_REPORT }]],
  use: {
    baseURL: process.env.CHAT_E2E_ORIGIN || 'https://localhost:4194',
    ignoreHTTPSErrors: true,
    channel: process.env.CHAT_E2E_CHANNEL || 'chromium',
    locale: 'en-GB',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
})
