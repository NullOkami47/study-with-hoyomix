import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { createFocusVisibilityController } from './focusVisibility'

function visibilityDocument() {
  const events = new EventTarget()
  let visibilityState: DocumentVisibilityState = 'visible'
  return {
    document: {
      get visibilityState() { return visibilityState },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    setHidden(hidden: boolean) { visibilityState = hidden ? 'hidden' : 'visible' },
    dispatch() { events.dispatchEvent(new Event('visibilitychange')) },
  }
}

function store() {
  const status = ref<'idle' | 'running' | 'paused'>('running')
  const focusBehaviour = ref<'continue' | 'pauseWhenHidden'>('pauseWhenHidden')
  return {
    status,
    focusBehaviour,
    pause: vi.fn(() => { status.value = 'paused' }),
    resume: vi.fn(() => { status.value = 'running' }),
  }
}

describe('focus visibility ownership', () => {
  it('resumes only the pause it owns', () => {
    const visibility = visibilityDocument()
    const pomodoroStore = store()
    const controller = createFocusVisibilityController({ document: visibility.document, pomodoroStore })

    visibility.setHidden(true); visibility.dispatch()
    expect(pomodoroStore.pause).toHaveBeenCalledOnce()
    visibility.setHidden(false); visibility.dispatch()
    expect(pomodoroStore.resume).toHaveBeenCalledOnce()

    pomodoroStore.status.value = 'paused'
    visibility.setHidden(true); visibility.dispatch()
    visibility.setHidden(false); visibility.dispatch()
    expect(pomodoroStore.resume).toHaveBeenCalledOnce()
    controller.destroy()
  })

  it('clears ownership on user state, behaviour change, and destroy', () => {
    const visibility = visibilityDocument()
    const pomodoroStore = store()
    const controller = createFocusVisibilityController({ document: visibility.document, pomodoroStore })
    visibility.setHidden(true); visibility.dispatch()
    pomodoroStore.status.value = 'idle'
    visibility.setHidden(false); visibility.dispatch()
    expect(pomodoroStore.resume).not.toHaveBeenCalled()

    pomodoroStore.status.value = 'running'
    visibility.setHidden(true); visibility.dispatch()
    pomodoroStore.focusBehaviour.value = 'continue'
    visibility.setHidden(false); visibility.dispatch()
    expect(pomodoroStore.resume).not.toHaveBeenCalled()

    controller.destroy()
    pomodoroStore.status.value = 'running'
    pomodoroStore.focusBehaviour.value = 'pauseWhenHidden'
    visibility.setHidden(true); visibility.dispatch()
    expect(pomodoroStore.pause).toHaveBeenCalledTimes(2)
  })
})
