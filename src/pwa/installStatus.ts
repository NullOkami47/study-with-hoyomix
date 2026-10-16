import { ref, type Ref } from 'vue'

interface MediaQueryLike {
  matches: boolean
  addEventListener?(type: 'change', listener: EventListener): void
  removeEventListener?(type: 'change', listener: EventListener): void
}

interface InstallWindowLike {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  matchMedia?(query: string): MediaQueryLike
}

interface InstallNavigatorLike {
  standalone?: boolean
}

export interface PwaInstallStatusEnvironment {
  navigator?: InstallNavigatorLike
  window?: InstallWindowLike
}

export interface PwaInstallStatus {
  runningStandalone: Readonly<Ref<boolean>>
  installedThisSession: Readonly<Ref<boolean>>
  installPromptAvailable: Readonly<Ref<boolean>>
  destroy(): void
}

export type PwaInstallState =
  | 'runningStandalone'
  | 'installedThisSession'
  | 'promptAvailable'
  | 'unknown'

export function resolvePwaInstallState(status: {
  runningStandalone: boolean
  installedThisSession: boolean
  installPromptAvailable: boolean
}): PwaInstallState {
  if (status.runningStandalone) return 'runningStandalone'
  if (status.installedThisSession) return 'installedThisSession'
  if (status.installPromptAvailable) return 'promptAvailable'
  return 'unknown'
}

function browserEnvironment(): PwaInstallStatusEnvironment {
  return {
    navigator: typeof navigator === 'undefined' ? undefined : navigator as InstallNavigatorLike,
    window: typeof window === 'undefined' ? undefined : window,
  }
}

export function createPwaInstallStatus(
  environment: PwaInstallStatusEnvironment = browserEnvironment(),
): PwaInstallStatus {
  const displayMode = environment.window?.matchMedia?.('(display-mode: standalone)')
  const runningStandalone = ref(Boolean(displayMode?.matches || environment.navigator?.standalone))
  const installedThisSession = ref(false)
  const installPromptAvailable = ref(false)

  const onBeforeInstallPrompt: EventListener = () => {
    if (!runningStandalone.value && !installedThisSession.value) installPromptAvailable.value = true
  }
  const onAppInstalled: EventListener = () => {
    installedThisSession.value = true
    installPromptAvailable.value = false
  }
  const onDisplayModeChange: EventListener = () => {
    runningStandalone.value = Boolean(displayMode?.matches || environment.navigator?.standalone)
    if (runningStandalone.value) installPromptAvailable.value = false
  }

  environment.window?.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  environment.window?.addEventListener('appinstalled', onAppInstalled)
  displayMode?.addEventListener?.('change', onDisplayModeChange)

  return {
    runningStandalone,
    installedThisSession,
    installPromptAvailable,
    destroy() {
      environment.window?.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      environment.window?.removeEventListener('appinstalled', onAppInstalled)
      displayMode?.removeEventListener?.('change', onDisplayModeChange)
    },
  }
}

const pwaInstallStatus = createPwaInstallStatus()

export function usePwaInstallStatus(): PwaInstallStatus {
  return pwaInstallStatus
}
