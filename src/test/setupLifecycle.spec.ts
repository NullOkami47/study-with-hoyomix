import { mount } from '@vue/test-utils'
import { defineComponent, onUnmounted } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { installTestLifecycle } from './lifecycle'

describe('component test lifecycle', () => {
  it('unmounts wrappers and clears browser storage through registered cleanup', () => {
    const cleanupCallbacks: Array<() => void> = []
    const onUnmount = vi.fn()
    const Component = defineComponent({
      setup() {
        onUnmounted(onUnmount)
        return () => 'timer owner'
      },
    })

    installTestLifecycle((callback) => cleanupCallbacks.push(callback))
    mount(Component)
    localStorage.setItem('test-lifecycle-state', 'leaked')
    sessionStorage.setItem('test-session-state', 'leaked')
    expect(onUnmount).not.toHaveBeenCalled()

    cleanupCallbacks.forEach((cleanup) => cleanup())

    expect(onUnmount).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('test-lifecycle-state')).toBeNull()
    expect(sessionStorage.getItem('test-session-state')).toBeNull()
  })
})
