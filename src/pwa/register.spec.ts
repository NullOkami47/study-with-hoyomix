import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSW } from 'virtual:pwa-register'
import { createPwaUpdateStatus } from './updateStatus'
import { registerPwa } from './register'

vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }))

describe('PWA registration', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} })
  })
  it('wires official refresh and offline callbacks to one status', async () => {
    const updateSW = vi.fn(async () => undefined)
    vi.mocked(registerSW).mockReturnValue(updateSW)
    const status = createPwaUpdateStatus()
    registerPwa(status)
    const options = vi.mocked(registerSW).mock.calls[0]![0]
    if (!options) throw new Error('register options missing')
    options.onNeedRefresh?.()
    expect(status.state.value).toBe('needRefresh')
    await status.applyUpdate()
    expect(updateSW).toHaveBeenCalledWith(true)
    options.onOfflineReady?.()
    expect(status.state.value).toBe('offlineReady')
    registerPwa(createPwaUpdateStatus())
    expect(registerSW).toHaveBeenCalledOnce()
  })
})
