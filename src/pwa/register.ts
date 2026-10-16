import { registerSW } from 'virtual:pwa-register'
import { usePwaUpdateStatus, type PwaUpdateStatus } from './updateStatus'

let registered = false
export function registerPwa(status: PwaUpdateStatus = usePwaUpdateStatus()): void {
  if (!('serviceWorker' in navigator)) return
  if (registered) return
  registered = true
  const updateSW = registerSW({ immediate: true, onNeedRefresh: () => status.markNeedRefresh(), onOfflineReady: () => status.markOfflineReady() })
  status.setUpdateSW(updateSW)
}
