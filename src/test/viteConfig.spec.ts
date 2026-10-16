// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createAnalyticsPlugin } from '../../vite.config'

describe('analytics build injection', () => {
  it('returns one descriptor only for a valid HTTPS URL and bounded identifier', () => {
    const plugin = createAnalyticsPlugin(() => ({
      VITE_ANALYTICS_ID: 'site-test',
      VITE_ANALYTICS_URL: 'https://analytics.invalid/script.js',
    }))
    expect(plugin.transformIndexHtml?.('<head></head>')).toEqual([{
      tag: 'script', injectTo: 'head',
      attrs: { defer: true, src: 'https://analytics.invalid/script.js', 'data-website-id': 'site-test' },
    }])
  })

  it('accepts a bracketed IPv6 host when no port is written', () => {
    const plugin = createAnalyticsPlugin(() => ({
      VITE_ANALYTICS_ID: 'site-test',
      VITE_ANALYTICS_URL: 'https://[::1]/script.js',
    }))
    expect(plugin.transformIndexHtml?.('<head></head>')).toEqual([{
      tag: 'script', injectTo: 'head',
      attrs: { defer: true, src: 'https://[::1]/script.js', 'data-website-id': 'site-test' },
    }])
  })

  it.each([
    { VITE_ANALYTICS_ID: 'site-test' },
    { VITE_ANALYTICS_URL: 'https://analytics.invalid/a.js' },
    { VITE_ANALYTICS_ID: ' ', VITE_ANALYTICS_URL: 'https://analytics.invalid/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'http://analytics.invalid/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://name:secret@analytics.invalid/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://analytics.invalid:8443/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://analytics.invalid:443/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://[::1]:443/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https:analytics.invalid:443/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https:/analytics.invalid:443/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: String.raw`https:\analytics.invalid:443\a.js` },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: String.raw`https:\\analytics.invalid:443\a.js` },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'HTTPS://analytics.invalid/a.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://analytics.invalid/a\t.js' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://analytics.invalid/a.js?token=secret' },
    { VITE_ANALYTICS_ID: 'site-test', VITE_ANALYTICS_URL: 'https://analytics.invalid/a.js#fragment' },
    { VITE_ANALYTICS_ID: '<script>', VITE_ANALYTICS_URL: 'https://analytics.invalid/a.js' },
  ])('returns no descriptor for incomplete or unsafe config', (environment) => {
    expect(createAnalyticsPlugin(() => environment).transformIndexHtml?.('<head></head>')).toEqual([])
  })
})
