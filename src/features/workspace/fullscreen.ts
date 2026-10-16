import { ref, type Ref } from 'vue'

export type FullscreenState = 'inactive' | 'active' | 'unavailable' | 'error'

export interface FullscreenDocument {
  fullscreenEnabled: boolean
  fullscreenElement: Element | null
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  dispatchEvent(event: Event): boolean
}

export interface FullscreenEnvironment {
  document?: FullscreenDocument
  requestFullscreen(target: HTMLElement): Promise<void>
  exitFullscreen(): Promise<void>
}

export interface WorkspaceFullscreen {
  state: Readonly<Ref<FullscreenState>>
  toggle(): Promise<void>
  destroy(): void
}

function browserEnvironment(): FullscreenEnvironment {
  const fullscreenDocument = typeof document === 'undefined' ? undefined : document
  return {
    document: fullscreenDocument,
    requestFullscreen: (target) => target.requestFullscreen(),
    exitFullscreen: () => document.exitFullscreen(),
  }
}

export function createWorkspaceFullscreen(
  target: Readonly<Ref<HTMLElement | undefined>>,
  environment: FullscreenEnvironment = browserEnvironment(),
): WorkspaceFullscreen {
  const state = ref<FullscreenState>(environment.document?.fullscreenEnabled ? 'inactive' : 'unavailable')
  const sync: EventListener = () => {
    state.value = environment.document?.fullscreenElement === target.value ? 'active' : 'inactive'
  }
  const fail: EventListener = () => { state.value = 'error' }
  environment.document?.addEventListener('fullscreenchange', sync)
  environment.document?.addEventListener('fullscreenerror', fail)

  return {
    state,
    async toggle() {
      const element = target.value
      if (!element || !environment.document?.fullscreenEnabled) {
        state.value = 'unavailable'
        return
      }
      try {
        if (environment.document.fullscreenElement) await environment.exitFullscreen()
        else await environment.requestFullscreen(element)
      } catch {
        state.value = 'error'
      }
    },
    destroy() {
      environment.document?.removeEventListener('fullscreenchange', sync)
      environment.document?.removeEventListener('fullscreenerror', fail)
    },
  }
}
