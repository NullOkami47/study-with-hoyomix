import { describe, expect, it, vi } from 'vitest'
import { createPwaUpdateStatus } from './updateStatus'

describe('PWA update status', () => {
  it('delegates only an explicit refresh to updateSW and keeps Later non-destructive', async () => {
    const updateSW = vi.fn(async () => undefined)
    const status = createPwaUpdateStatus()
    status.setUpdateSW(updateSW)
    status.markNeedRefresh()
    expect(status.state.value).toBe('needRefresh')
    expect(status.visible.value).toBe(true)
    status.later()
    expect(status.visible.value).toBe(false)
    expect(updateSW).not.toHaveBeenCalled()
    status.markNeedRefresh()
    await status.applyUpdate()
    expect(updateSW).toHaveBeenCalledWith(true)
  })
})
