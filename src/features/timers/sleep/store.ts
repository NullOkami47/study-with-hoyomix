import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { isStorageDenied, safeLocalStorage, type SafeStorage } from '../../../utils/safeStorage'
import { systemTimerClock, type TimerClock } from '../clock'

export const SLEEP_STORAGE_KEY = 'study-with-hoyomix.sleep-timer.v1'
export const SLEEP_PRESETS = [15, 30, 45, 60, 90] as const

export interface SleepPlayerCommands {
  pause(): void
  stop(): void
}

export type SleepTimerStatus = 'idle' | 'running' | 'paused' | 'expired'

interface SleepSnapshot {
  customMinutes: number
  deadline: number | null
  remainingSeconds: number
  selectedMinutes: number
  status: SleepTimerStatus
}

export interface SleepTimerOptions {
  autoTick?: boolean
  clock?: TimerClock
  player: SleepPlayerCommands
  storage?: SafeStorage
}

export interface SleepTimerStore {
  customMinutes: Readonly<Ref<number>>
  formattedTime: ComputedRef<string>
  remainingSeconds: Readonly<Ref<number>>
  selectedMinutes: Readonly<Ref<number>>
  status: Readonly<Ref<SleepTimerStatus>>
  cancel(): void
  destroy(): void
  pause(): void
  resume(): void
  selectDuration(minutes: number): void
  setCustomDuration(minutes: number): void
  start(): void
  tick(): void
}

function duration(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_440 ? parsed : fallback
}

function readSnapshot(storage: SafeStorage): SleepSnapshot | undefined {
  try {
    const raw = storage.getItem(SLEEP_STORAGE_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<SleepSnapshot>
    if (!['idle', 'running', 'paused', 'expired'].includes(value.status ?? '')) return undefined
    return {
      customMinutes: duration(value.customMinutes, 15),
      deadline: typeof value.deadline === 'number' && Number.isFinite(value.deadline) ? value.deadline : null,
      remainingSeconds: Math.max(0, Math.floor(Number(value.remainingSeconds) || 0)),
      selectedMinutes: duration(value.selectedMinutes, 15),
      status: value.status === 'running' && !(typeof value.deadline === 'number' && Number.isFinite(value.deadline))
        ? 'paused'
        : value.status as SleepTimerStatus,
    }
  } catch (error) {
    if (error instanceof SyntaxError || isStorageDenied(error)) return undefined
    throw error
  }
}

export function createSleepTimerStore(options: SleepTimerOptions): SleepTimerStore {
  const clock = options.clock ?? systemTimerClock
  const storage = options.storage ?? safeLocalStorage
  const recovered = readSnapshot(storage)
  const customMinutes = ref(recovered?.customMinutes ?? 15)
  const selectedMinutes = ref(recovered?.selectedMinutes ?? 15)
  const remainingSeconds = ref(recovered?.remainingSeconds ?? selectedMinutes.value * 60)
  const status = ref<SleepTimerStatus>(recovered?.status ?? 'idle')
  let deadline = recovered?.deadline ?? null
  let scheduledTick: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  const formattedTime = computed(() => {
    const minutes = Math.floor(remainingSeconds.value / 60).toString().padStart(2, '0')
    const seconds = (remainingSeconds.value % 60).toString().padStart(2, '0')
    return `${minutes}:${seconds}`
  })

  function persist(): void {
    try {
      storage.setItem(SLEEP_STORAGE_KEY, JSON.stringify({
        customMinutes: customMinutes.value,
        deadline,
        remainingSeconds: remainingSeconds.value,
        selectedMinutes: selectedMinutes.value,
        status: status.value,
      } satisfies SleepSnapshot))
    } catch (error) {
      if (!isStorageDenied(error)) throw error
    }
  }

  function schedule(): void {
    if (scheduledTick) clearTimeout(scheduledTick)
    if (destroyed || options.autoTick === false || status.value !== 'running' || deadline === null) return
    const remainingMilliseconds = Math.max(0, deadline - clock.now())
    const delay = remainingMilliseconds === 0 ? 0 : (remainingMilliseconds % 1_000 || 1_000)
    scheduledTick = setTimeout(tick, delay)
  }

  function expire(): void {
    status.value = 'expired'
    remainingSeconds.value = 0
    deadline = null
    if (scheduledTick) clearTimeout(scheduledTick)
    options.player.stop()
    persist()
  }

  function tick(): void {
    if (status.value !== 'running' || deadline === null) return
    const remainingMilliseconds = deadline - clock.now()
    if (remainingMilliseconds <= 0) {
      expire()
      return
    }
    remainingSeconds.value = Math.ceil(remainingMilliseconds / 1_000)
    persist()
    schedule()
  }

  function selectDuration(minutes: number): void {
    selectedMinutes.value = duration(minutes, selectedMinutes.value)
    if (status.value !== 'running') remainingSeconds.value = selectedMinutes.value * 60
    persist()
  }

  function setCustomDuration(minutes: number): void {
    customMinutes.value = duration(minutes, customMinutes.value)
    selectDuration(customMinutes.value)
  }

  function start(): void {
    status.value = 'running'
    remainingSeconds.value = selectedMinutes.value * 60
    deadline = clock.now() + remainingSeconds.value * 1_000
    persist()
    schedule()
  }

  function pause(): void {
    if (status.value !== 'running') return
    tick()
    if (status.value !== 'running') return
    status.value = 'paused'
    deadline = null
    if (scheduledTick) clearTimeout(scheduledTick)
    persist()
  }

  function resume(): void {
    if (status.value !== 'paused') return
    status.value = 'running'
    deadline = clock.now() + remainingSeconds.value * 1_000
    persist()
    schedule()
  }

  function cancel(): void {
    status.value = 'idle'
    remainingSeconds.value = selectedMinutes.value * 60
    deadline = null
    if (scheduledTick) clearTimeout(scheduledTick)
    persist()
  }

  function destroy(): void {
    destroyed = true
    if (scheduledTick) clearTimeout(scheduledTick)
  }

  const store: SleepTimerStore = {
    customMinutes, formattedTime, remainingSeconds, selectedMinutes, status,
    cancel, destroy, pause, resume, selectDuration, setCustomDuration, start, tick,
  }
  if (status.value === 'running' && deadline !== null) tick()
  else persist()
  return store
}
