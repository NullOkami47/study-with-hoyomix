import { watch, type Ref } from 'vue'

import type { FocusBehaviour, TimerStatus } from '../timers/pomodoro/store'

interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: EventListener): void
  removeEventListener(type: 'visibilitychange', listener: EventListener): void
}

interface VisibilityPomodoroStore {
  status: Readonly<Ref<TimerStatus>>
  focusBehaviour: Readonly<Ref<FocusBehaviour>>
  pause(): void
  resume(): void
}

export function createFocusVisibilityController(options: {
  document: VisibilityDocument
  pomodoroStore: VisibilityPomodoroStore
}): { destroy(): void } {
  const store = options.pomodoroStore
  let pausedByVisibility = false
  let pausingForVisibility = false
  const stopStatus = watch(store.status, (status) => {
    if (!pausingForVisibility && status !== 'running') pausedByVisibility = false
  }, { flush: 'sync' })
  const stopBehaviour = watch(store.focusBehaviour, (behaviour) => {
    if (behaviour !== 'pauseWhenHidden') pausedByVisibility = false
  }, { flush: 'sync' })
  const onVisibilityChange: EventListener = () => {
    if (options.document.visibilityState === 'hidden') {
      if (store.focusBehaviour.value === 'pauseWhenHidden' && store.status.value === 'running') {
        pausingForVisibility = true
        store.pause()
        pausedByVisibility = true
        pausingForVisibility = false
      }
      return
    }
    const resumeOwnedPause = pausedByVisibility
      && store.focusBehaviour.value === 'pauseWhenHidden'
      && store.status.value === 'paused'
    pausedByVisibility = false
    if (resumeOwnedPause) store.resume()
  }
  options.document.addEventListener('visibilitychange', onVisibilityChange)
  return {
    destroy() {
      pausedByVisibility = false
      stopStatus()
      stopBehaviour()
      options.document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}
