import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { createWorkspaceFullscreen, type FullscreenDocument } from './fullscreen'

function environment(enabled = true) {
  const events = new EventTarget()
  const document = {
    fullscreenEnabled: enabled,
    fullscreenElement: null as Element | null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } satisfies FullscreenDocument
  return {
    document,
    requestFullscreen: vi.fn(async () => undefined),
    exitFullscreen: vi.fn(async () => undefined),
  }
}

describe('workspace fullscreen', () => {
  it('changes active state only after the browser confirms fullscreenchange', async () => {
    const target = ref<HTMLElement>(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    await controller.toggle()
    expect(env.requestFullscreen).toHaveBeenCalledWith(target.value)
    expect(controller.state.value).toBe('inactive')

    env.document.fullscreenElement = target.value
    env.document.dispatchEvent(new Event('fullscreenchange'))
    expect(controller.state.value).toBe('active')

    await controller.toggle()
    expect(env.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('is truthful and non-throwing when unsupported, rejected, or destroyed', async () => {
    const unsupported = createWorkspaceFullscreen(ref(), environment(false))
    await expect(unsupported.toggle()).resolves.toBeUndefined()
    expect(unsupported.state.value).toBe('unavailable')

    const env = environment()
    env.requestFullscreen.mockRejectedValueOnce(new Error('denied'))
    const controller = createWorkspaceFullscreen(ref(document.createElement('main')), env)
    await expect(controller.toggle()).resolves.toBeUndefined()
    expect(controller.state.value).toBe('error')
    controller.destroy()
    env.document.fullscreenElement = document.createElement('main')
    env.document.dispatchEvent(new Event('fullscreenchange'))
    expect(controller.state.value).toBe('error')
  })

  it('starts unavailable when fullscreenEnabled is false', () => {
    const env = environment(false)
    const controller = createWorkspaceFullscreen(ref(document.createElement('main')), env)
    expect(controller.state.value).toBe('unavailable')
  })

  it('starts inactive when enabled with no fullscreenElement', () => {
    const env = environment(true)
    const controller = createWorkspaceFullscreen(ref(document.createElement('main')), env)
    expect(controller.state.value).toBe('inactive')
  })

  it('calls requestFullscreen with exact target element', async () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    await controller.toggle()

    expect(env.requestFullscreen).toHaveBeenCalledWith(target.value)
    expect(env.requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('transitions to active only after fullscreenchange with target as fullscreenElement', async () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    expect(controller.state.value).toBe('inactive')

    env.document.fullscreenElement = target.value
    env.document.dispatchEvent(new Event('fullscreenchange'))

    expect(controller.state.value).toBe('active')
  })

  it('calls exitFullscreen when toggling while fullscreenElement exists', async () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    env.document.fullscreenElement = target.value
    await controller.toggle()

    expect(env.exitFullscreen).toHaveBeenCalledTimes(1)
    expect(env.requestFullscreen).not.toHaveBeenCalled()
  })

  it('transitions to inactive after fullscreenElement becomes null', () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    env.document.fullscreenElement = target.value
    env.document.dispatchEvent(new Event('fullscreenchange'))
    expect(controller.state.value).toBe('active')

    env.document.fullscreenElement = null
    env.document.dispatchEvent(new Event('fullscreenchange'))
    expect(controller.state.value).toBe('inactive')
  })

  it('transitions to error when requestFullscreen rejects', async () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    env.requestFullscreen.mockRejectedValueOnce(new Error('Permission denied'))

    const controller = createWorkspaceFullscreen(target, env)
    await controller.toggle()

    expect(controller.state.value).toBe('error')
  })

  it('transitions to error when exitFullscreen rejects', async () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    env.exitFullscreen.mockRejectedValueOnce(new Error('Exit failed'))

    const controller = createWorkspaceFullscreen(target, env)
    env.document.fullscreenElement = target.value
    await controller.toggle()

    expect(controller.state.value).toBe('error')
  })

  it('transitions to error on fullscreenerror event', () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    env.document.dispatchEvent(new Event('fullscreenerror'))

    expect(controller.state.value).toBe('error')
  })

  it('removes listeners on destroy', () => {
    const target = ref(document.createElement('main'))
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    const initialState = controller.state.value
    controller.destroy()

    // After destroy, dispatching events should not change state
    env.document.fullscreenElement = target.value
    env.document.dispatchEvent(new Event('fullscreenchange'))
    expect(controller.state.value).toBe(initialState)

    env.document.dispatchEvent(new Event('fullscreenerror'))
    expect(controller.state.value).toBe(initialState)
  })

  it('becomes unavailable when toggling without target element', async () => {
    const target = ref<HTMLElement | undefined>(undefined)
    const env = environment()
    const controller = createWorkspaceFullscreen(target, env)

    await controller.toggle()

    expect(controller.state.value).toBe('unavailable')
    expect(env.requestFullscreen).not.toHaveBeenCalled()
  })
})
