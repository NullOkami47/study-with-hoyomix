import { describe, expect, it, vi } from 'vitest'
import { configuredDefaultSource } from '../lx/defaultSource'
import { defaultManagedLxSource, materializeManagedLxSource, MANAGED_LX_SOURCE_ID } from '../lx/globalSources'

describe('public empty managed source', () => {
  it('does not ship an executable default or materialise a bundled snapshot', () => {
    const prepare = vi.fn()
    expect(configuredDefaultSource()).toBeNull()
    expect(defaultManagedLxSource()).toBeNull()
    expect(materializeManagedLxSource({ prepare } as never, MANAGED_LX_SOURCE_ID, 0)).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })
})
