import { afterEach, describe, expect, it, vi } from 'vitest'

import { safeLocalStorage } from './safeStorage'

afterEach(() => { vi.restoreAllMocks() })

describe('safe storage', () => {
  it.each([
    new DOMException('Denied', 'SecurityError'),
    new DOMException('Full', 'QuotaExceededError'),
    Object.assign(new Error('Firefox quota'), { code: 1014, name: 'NS_ERROR_DOM_QUOTA_REACHED' }),
  ])('degrades only recognised storage denial errors', (denial) => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw denial })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw denial })

    expect(safeLocalStorage.getItem('test')).toBeNull()
    expect(() => safeLocalStorage.setItem('test', 'value')).not.toThrow()
  })

  it.each([
    new TypeError('Programming error'),
    new DOMException('Wrong lifecycle', 'InvalidStateError'),
  ])('rethrows non-storage failures', (error) => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw error })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw error })

    const capture = (operation: () => unknown): unknown => {
      try { operation() } catch (caught) { return caught }
      return undefined
    }
    expect(capture(() => safeLocalStorage.getItem('test'))).toBe(error)
    expect(capture(() => safeLocalStorage.setItem('test', 'value'))).toBe(error)
  })
})
