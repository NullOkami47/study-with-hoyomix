import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugLog, runDebugLogExport } from './debugLog'

// The export never throws and never stays silent: every outcome is a result the UI can show.
describe('runDebugLogExport', () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const setNavigator = (name: string, value: unknown) => {
    if (!descriptors.has(name)) descriptors.set(name, Object.getOwnPropertyDescriptor(navigator, name))
    Object.defineProperty(navigator, name, { configurable: true, value })
  }
  let createObjectURL: typeof URL.createObjectURL | undefined
  beforeEach(() => {
    debugLog.clear()
    createObjectURL = URL.createObjectURL
    URL.createObjectURL = () => 'blob:test/1'
    URL.revokeObjectURL = () => {}
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    setNavigator('share', undefined)
    setNavigator('canShare', undefined)
    setNavigator('clipboard', undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (createObjectURL) URL.createObjectURL = createObjectURL
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(navigator, name, descriptor)
      else delete (navigator as unknown as Record<string, unknown>)[name]
    }
    descriptors.clear()
    document.body.innerHTML = ''
  })
  const exportEntries = () => debugLog.snapshot().filter((entry) => entry.type === 'log.export')

  // Root cause of "export does nothing": a link clicked outside the modal sheet is cancelled by it.
  it('mounts the download link inside the host element, not on document.body', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let parent: Element | null = null
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) { parent = this.parentElement })
    await runDebugLogExport('download', { host })
    expect(parent).toBe(host)
    expect(host.querySelector('a')).toBeNull()
  })

  it('reports a download', async () => {
    await expect(runDebugLogExport('download')).resolves.toEqual({ ok: true, method: 'download' })
    expect(exportEntries()[0]).toMatchObject({ kind: 'download', method: 'download', ok: true })
  })

  it('falls back to copy when the download throws, and says so', async () => {
    URL.createObjectURL = () => { throw new Error('blocked') }
    const writeText = vi.fn(async (_text: string) => undefined)
    setNavigator('clipboard', { writeText })
    await expect(runDebugLogExport('download')).resolves.toEqual({ ok: true, method: 'copy' })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(JSON.parse(writeText.mock.calls[0][0]).format).toBe('hoyomix-debug-log')
  })

  it('shares the file where the browser can share files', async () => {
    const share = vi.fn(async (_data: unknown) => undefined)
    setNavigator('canShare', () => true)
    setNavigator('share', share)
    await expect(runDebugLogExport('share')).resolves.toEqual({ ok: true, method: 'share' })
    expect(share.mock.calls[0][0]).toMatchObject({ files: [expect.any(File)] })
  })

  it('treats AbortError as a cancel and does not fall back', async () => {
    setNavigator('canShare', () => true)
    setNavigator('share', async () => { throw new DOMException('cancelled', 'AbortError') })
    const writeText = vi.fn(async (_text: string) => undefined)
    setNavigator('clipboard', { writeText })
    await expect(runDebugLogExport('share')).resolves.toEqual({ ok: true, method: 'cancelled' })
    expect(writeText).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('falls back to download when share fails for another reason', async () => {
    setNavigator('canShare', () => true)
    setNavigator('share', async () => { throw new DOMException('denied', 'NotAllowedError') })
    await expect(runDebugLogExport('share')).resolves.toEqual({ ok: true, method: 'download' })
  })

  it('falls back to copy when files cannot be shared', async () => {
    setNavigator('canShare', () => false)
    setNavigator('share', async () => undefined)
    setNavigator('clipboard', { writeText: async () => undefined })
    await expect(runDebugLogExport('share')).resolves.toEqual({ ok: true, method: 'copy' })
  })

  it('returns the text for manual copying when the clipboard and execCommand both fail', async () => {
    setNavigator('clipboard', { writeText: async () => { throw new Error('denied') } })
    document.execCommand = vi.fn(() => false)
    const result = await runDebugLogExport('copy')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('manual_copy')
      expect(JSON.parse(result.text).format).toBe('hoyomix-debug-log')
    }
    expect(exportEntries()[0]).toMatchObject({ kind: 'copy', ok: false, reason: 'manual_copy' })
  })

  it('copies through execCommand when the async clipboard is missing', async () => {
    document.execCommand = vi.fn(() => true)
    await expect(runDebugLogExport('copy')).resolves.toEqual({ ok: true, method: 'copy' })
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('never throws when the log itself cannot be built', async () => {
    const original = debugLog.exportJson
    debugLog.exportJson = () => { throw new Error('boom') }
    try {
      for (const kind of ['download', 'share', 'copy'] as const) {
        const result = await runDebugLogExport(kind)
        expect(result.ok, kind).toBe(false)
      }
    } finally {
      debugLog.exportJson = original
    }
  })
})
