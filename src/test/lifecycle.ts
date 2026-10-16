import { disableAutoUnmount, enableAutoUnmount } from '@vue/test-utils'

type CleanupRegistrar = (callback: () => void) => void

export function installTestLifecycle(registerCleanup: CleanupRegistrar): void {
  disableAutoUnmount()
  enableAutoUnmount(registerCleanup)
  registerCleanup(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
}
