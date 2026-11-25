import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import { debugLog, DEBUG_LOG_FORMAT } from './debugLog'
import { usePreferences } from '../../stores/preferences'
import DebugLogControls from './DebugLogControls.vue'

function mountControls() {
  const player = createPlaybackStore({
    registry: new ProviderRegistry([]),
    resolve: async () => ({ ok: false as const, code: 'exhausted' as const, attempts: [] }),
  })
  return mount(DebugLogControls, { props: { player }, attachTo: document.body })
}

describe('DebugLogControls', () => {
  const created: Blob[] = []
  const clicked: Array<{ href: string; download: string }> = []
  let createObjectURL: ((blob: Blob) => string) | undefined
  let revokeObjectURL: ((url: string) => void) | undefined

  beforeEach(() => {
    usePreferences().setLocale('en')
    debugLog.clear()
    created.length = 0
    clicked.length = 0
    // jsdom has no object URLs; record the Blob the component hands to the browser.
    createObjectURL = URL.createObjectURL
    revokeObjectURL = URL.revokeObjectURL
    URL.createObjectURL = (blob: Blob) => { created.push(blob); return `blob:test/${created.length}` }
    URL.revokeObjectURL = () => {}
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (createObjectURL) URL.createObjectURL = createObjectURL
    if (revokeObjectURL) URL.revokeObjectURL = revokeObjectURL
    document.body.innerHTML = ''
  })

  it('downloads the redacted log as hoyomix-debug-log-<timestamp>.json', async () => {
    debugLog.record('play.rejected', {
      name: 'NotAllowedError', src: 'https://app.example.com/api/media/x.mp3?ticket=T-SECRET&apikey=K-SECRET',
    })
    const wrapper = mountControls()
    const button = wrapper.get('[data-debug-log-export]')
    expect(button.text()).toBe('Export debug log')
    await button.trigger('click')

    expect(clicked).toHaveLength(1)
    expect(clicked[0].href).toBe('blob:test/1')
    expect(clicked[0].download).toMatch(/^hoyomix-debug-log-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/u)
    expect(created[0].type).toBe('application/json')
    // jsdom's Blob has no text(); FileReader reads the same bytes.
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(created[0])
    })
    expect(json).not.toContain('SECRET')
    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({ format: DEBUG_LOG_FORMAT, version: 1, locale: 'en' })
    expect(parsed.format).toBe('hoyomix-debug-log')
    // The environment snapshot carries the player state summary of the panel's store.
    expect(parsed.player).toMatchObject({ trackId: null, status: expect.any(String), intent: 'paused', notices: [] })
    expect(parsed.entries.map((entry: { type: string }) => entry.type)).toEqual(['play.rejected'])
    // The temporary link is removed again.
    expect(document.querySelector('a[download]')).toBeNull()
    wrapper.unmount()
  })

  it('clears the log', async () => {
    debugLog.record('media.pause')
    const wrapper = mountControls()
    const button = wrapper.get('[data-debug-log-clear]')
    expect(button.text()).toBe('Clear debug log')
    await button.trigger('click')
    expect(debugLog.snapshot()).toEqual([])
    wrapper.unmount()
  })

  it('labels the controls in Traditional and Simplified Chinese', () => {
    usePreferences().setLocale('zh-Hant')
    let wrapper = mountControls()
    expect(wrapper.get('[data-debug-log-export]').text()).toBe('匯出除錯紀錄')
    expect(wrapper.get('[data-debug-log-clear]').text()).toBe('清除除錯紀錄')
    wrapper.unmount()
    usePreferences().setLocale('zh-Hans')
    wrapper = mountControls()
    expect(wrapper.get('[data-debug-log-export]').text()).toBe('导出调试日志')
    expect(wrapper.get('[data-debug-log-clear]').text()).toBe('清除调试日志')
    wrapper.unmount()
  })

  it('offers a share control labelled "Share debug log" when the Web Share API exists', () => {
    const nav = navigator as Navigator & { canShare?: unknown; share?: unknown }
    const had = { canShare: nav.canShare, share: nav.share }
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined })
    try {
      const wrapper = mountControls()
      expect(wrapper.get('[data-debug-log-share]').text()).toBe('Share debug log')
      wrapper.unmount()
    } finally {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: had.canShare })
      Object.defineProperty(navigator, 'share', { configurable: true, value: had.share })
    }
  })

  it('shows a visible status for every action instead of staying silent', async () => {
    const wrapper = mountControls()
    expect(wrapper.get('[data-debug-log-status]').attributes('role')).toBe('status')
    await wrapper.get('[data-debug-log-export]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-debug-log-status]').text()).toBe('Debug log exported.'))
    wrapper.unmount()
  })

  it('copies the log and says so', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mountControls()
    await wrapper.get('[data-debug-log-copy]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-debug-log-status]').text()).toBe('Debug log copied.'))
    expect(JSON.parse(writeText.mock.calls[0][0]).format).toBe('hoyomix-debug-log')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    wrapper.unmount()
  })

  it('reveals the full log in a selectable textarea when every route fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    document.execCommand = vi.fn(() => false)
    debugLog.record('media.pause')
    const wrapper = mountControls()
    expect(wrapper.find('[data-debug-log-text]').exists()).toBe(false)
    await wrapper.get('[data-debug-log-copy]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-debug-log-text]').exists()).toBe(true))
    const area = wrapper.get('[data-debug-log-text]')
    expect(area.attributes('readonly')).toBeDefined()
    expect(JSON.parse((area.element as HTMLTextAreaElement).value).format).toBe('hoyomix-debug-log')
    expect(wrapper.get('[data-debug-log-status]').text()).toBe('Copy the log manually from the box below.')
    wrapper.unmount()
  })

  it('shows a failure and falls back to copy when the download throws', async () => {
    URL.createObjectURL = () => { throw new Error('blocked') }
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mountControls()
    await wrapper.get('[data-debug-log-export]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-debug-log-status]').text()).toBe('Debug log copied.'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    wrapper.unmount()
  })

  it('shows "cancelled" for an aborted share with no fallback', async () => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('x', 'AbortError') } })
    try {
      const wrapper = mountControls()
      await wrapper.get('[data-debug-log-share]').trigger('click')
      await vi.waitFor(() => expect(wrapper.get('[data-debug-log-status]').text()).toBe('Share cancelled.'))
      expect(clicked).toHaveLength(0)
      wrapper.unmount()
    } finally {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    }
  })
})