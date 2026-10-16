import { ref, type Ref } from 'vue'
export type PwaUpdateState = 'idle' | 'offlineReady' | 'needRefresh'
export interface PwaUpdateStatus {
  state: Readonly<Ref<PwaUpdateState>>; visible: Readonly<Ref<boolean>>
  setUpdateSW(update: (reloadPage?: boolean) => Promise<void>): void
  markNeedRefresh(): void; markOfflineReady(): void; applyUpdate(): Promise<void>; later(): void; dismiss(): void
}
export function createPwaUpdateStatus(): PwaUpdateStatus {
  const state = ref<PwaUpdateState>('idle'); const visible = ref(false)
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined
  return {
    state, visible, setUpdateSW(update) { updateSW = update },
    markNeedRefresh() { state.value = 'needRefresh'; visible.value = true },
    markOfflineReady() { state.value = 'offlineReady'; visible.value = false },
    async applyUpdate() { if (state.value === 'needRefresh' && updateSW) await updateSW(true) },
    later() { if (state.value === 'needRefresh') visible.value = false }, dismiss() { visible.value = false },
  }
}
const defaultStatus = createPwaUpdateStatus()
export function usePwaUpdateStatus(): PwaUpdateStatus { return defaultStatus }
