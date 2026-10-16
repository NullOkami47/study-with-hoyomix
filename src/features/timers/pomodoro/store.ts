import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { safeLocalStorage, type SafeStorage } from '../../../utils/safeStorage'
import { systemTimerClock, type TimerClock } from '../clock'

export const POMODORO_STORAGE_KEY = 'study-with-hoyomix.pomodoro-timer.v1'
export const MAX_PENDING_FOCUS_FINALIZATIONS = 1_024

export type PomodoroFocusQueueCapacityErrorCode = 'pending_overflow' | 'overflow_full'

export class PomodoroFocusQueueCapacityError extends Error {
  readonly capacity = MAX_PENDING_FOCUS_FINALIZATIONS
  readonly code: PomodoroFocusQueueCapacityErrorCode
  readonly fatal: boolean

  constructor(code: PomodoroFocusQueueCapacityErrorCode) {
    super(code === 'overflow_full'
      ? 'Pomodoro Focus pending and page overflow queues are full'
      : 'Pomodoro Focus finalisation moved to the page overflow queue')
    this.name = 'PomodoroFocusQueueCapacityError'
    this.code = code
    this.fatal = code === 'overflow_full'
  }
}

export type PomodoroPhase = 'focus' | 'break' | 'longBreak'
export type FocusBehaviour = 'continue' | 'pauseWhenHidden'
export type TimerStatus = 'idle' | 'running' | 'paused'

export type PomodoroControlEvent =
  | { type: 'reset' }
  | { type: 'selectPhase'; phase: PomodoroPhase }

export interface PomodoroPhaseExpired {
  catchUpCapped: boolean
  durationSeconds: number
  phase: PomodoroPhase
  expiredAt: number
  isLastInBatch: boolean
  nextPhase: PomodoroPhase
  pauseMusicDuringBreak: boolean
}

export interface PomodoroFocusRun {
  id: string
  startedAt: number
  plannedFocusSeconds: number
}

export interface PomodoroFocusSessionFinalized {
  run: PomodoroFocusRun
  endedAt: number
  actualFocusSeconds: number
  status: 'completed' | 'interrupted'
  presentSummary: boolean
}

interface PomodoroPageFocusQueueState {
  overflow: PomodoroFocusSessionFinalized[]
  pending: PomodoroFocusSessionFinalized[]
}

const pomodoroPageFocusQueues = new WeakMap<object, PomodoroPageFocusQueueState>()

function pomodoroPageFocusQueueFor(storage: SafeStorage): PomodoroPageFocusQueueState {
  const existing = pomodoroPageFocusQueues.get(storage)
  if (existing) return existing
  const created: PomodoroPageFocusQueueState = { overflow: [], pending: [] }
  pomodoroPageFocusQueues.set(storage, created)
  return created
}

type PomodoroPhaseTransition = Omit<
  PomodoroPhaseExpired,
  'catchUpCapped' | 'isLastInBatch' | 'pauseMusicDuringBreak'
>

const MAX_CATCH_UP_TRANSITIONS = 1_000

interface PomodoroSnapshot {
  breakMinutes: number
  completedPomodoros: number
  cycleCount: number
  deadline: number | null
  focusMinutes: number
  focusBehaviour: FocusBehaviour
  longBreakMinutes: number
  pauseMusicDuringBreak: boolean
  phase: PomodoroPhase
  remainingSeconds: number
  status: TimerStatus
  focusRun: PomodoroFocusRun | null
  pendingFocusFinalizations: PomodoroFocusSessionFinalized[]
}

export interface PomodoroStoreOptions {
  autoTick?: boolean
  breakMinutes?: number
  clock?: TimerClock
  cycleCount?: number
  focusMinutes?: number
  focusBehaviour?: FocusBehaviour
  longBreakMinutes?: number
  pauseMusicDuringBreak?: boolean
  onFocusRunStarted?: (run: PomodoroFocusRun) => void
  onControl?: (event: PomodoroControlEvent) => void
  onFocusSessionError?: (error: PomodoroFocusQueueCapacityError) => void
  onFocusSessionFinalized?: (event: PomodoroFocusSessionFinalized) => boolean
  onPhaseExpired?: (event: PomodoroPhaseExpired) => void
  onSettingsChanged?: (settings: {
    breakMinutes: number
    cycleCount: number
    focusMinutes: number
    focusBehaviour: FocusBehaviour
    longBreakMinutes: number
    pauseMusicDuringBreak: boolean
  }) => void
  storage?: SafeStorage
  timers?: {
    clearTimeout(handle: ReturnType<typeof setTimeout>): void
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  }
}

export interface PomodoroStore {
  breakMinutes: Readonly<Ref<number>>
  completedPomodoros: Readonly<Ref<number>>
  cycleCount: Readonly<Ref<number>>
  focusMinutes: Readonly<Ref<number>>
  focusBehaviour: Readonly<Ref<FocusBehaviour>>
  longBreakMinutes: Readonly<Ref<number>>
  pauseMusicDuringBreak: Readonly<Ref<boolean>>
  formattedTime: ComputedRef<string>
  phase: Readonly<Ref<PomodoroPhase>>
  remainingSeconds: Readonly<Ref<number>>
  status: Readonly<Ref<TimerStatus>>
  destroy(): void
  pause(): void
  reset(): void
  resume(): void
  selectPhase(phase: PomodoroPhase): void
  setBreakMinutes(minutes: number): void
  setCycleCount(count: number): void
  setFocusMinutes(minutes: number): void
  setFocusBehaviour(behaviour: FocusBehaviour): void
  setLongBreakMinutes(minutes: number): void
  setPauseMusicDuringBreak(enabled: boolean): void
  start(): void
  tick(): void
}

function positiveInteger(value: unknown, fallback: number, maximum = 180): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const FOCUS_RUN_KEYS = new Set(['id', 'startedAt', 'plannedFocusSeconds'])
const FOCUS_FINALIZATION_KEYS = new Set([
  'run',
  'endedAt',
  'actualFocusSeconds',
  'status',
  'presentSummary',
])

function hasExactKeys(value: unknown, keys: Set<string>): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.size && ownKeys.every(
    (key) => typeof key === 'string' && keys.has(key),
  )
}

function safeInteger(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && (!positive || value > 0)
}

function parseFocusRun(value: unknown): PomodoroFocusRun | null {
  if (!hasExactKeys(value, FOCUS_RUN_KEYS)) return null
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    !safeInteger(value.startedAt) ||
    !safeInteger(value.plannedFocusSeconds, true)
  ) return null
  return {
    id: value.id.toLowerCase(),
    startedAt: value.startedAt,
    plannedFocusSeconds: value.plannedFocusSeconds,
  }
}

function parseFocusFinalization(value: unknown): PomodoroFocusSessionFinalized | undefined {
  if (!hasExactKeys(value, FOCUS_FINALIZATION_KEYS)) return undefined
  const run = parseFocusRun(value.run)
  if (
    !run ||
    !safeInteger(value.endedAt) ||
    value.endedAt < run.startedAt ||
    !safeInteger(value.actualFocusSeconds, true) ||
    value.actualFocusSeconds > run.plannedFocusSeconds ||
    (value.status !== 'completed' && value.status !== 'interrupted') ||
    (value.status === 'completed' && value.actualFocusSeconds !== run.plannedFocusSeconds) ||
    typeof value.presentSummary !== 'boolean'
  ) return undefined
  return {
    run,
    endedAt: value.endedAt,
    actualFocusSeconds: value.actualFocusSeconds,
    status: value.status,
    presentSummary: value.presentSummary,
  }
}

function parsePendingFocusFinalizations(value: unknown): PomodoroFocusSessionFinalized[] {
  if (!Array.isArray(value)) return []
  const pending: PomodoroFocusSessionFinalized[] = []
  const ids = new Set<string>()
  for (const candidate of value.slice(0, MAX_PENDING_FOCUS_FINALIZATIONS)) {
    const parsed = parseFocusFinalization(candidate)
    if (!parsed || ids.has(parsed.run.id)) continue
    ids.add(parsed.run.id)
    pending.push(parsed)
  }
  return pending
}

function cloneFocusFinalization(
  event: PomodoroFocusSessionFinalized,
): PomodoroFocusSessionFinalized {
  return { ...event, run: { ...event.run } }
}

function mergeFocusFinalizations(
  ...queues: PomodoroFocusSessionFinalized[][]
): PomodoroFocusSessionFinalized[] {
  const merged: PomodoroFocusSessionFinalized[] = []
  const ids = new Set<string>()
  for (const queue of queues) {
    for (const event of queue) {
      if (ids.has(event.run.id)) continue
      ids.add(event.run.id)
      merged.push(cloneFocusFinalization(event))
    }
  }
  return merged
}

function createUuid(): string {
  const crypto = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function readSnapshot(storage: SafeStorage): PomodoroSnapshot | undefined {
  try {
    const raw = storage.getItem(POMODORO_STORAGE_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<PomodoroSnapshot>
    if (
      !['focus', 'break', 'longBreak'].includes(value.phase ?? '') ||
      !['idle', 'running', 'paused'].includes(value.status ?? '')
    ) return undefined
    const breakMinutes = positiveInteger(value.breakMinutes, 5, 60)
    return {
      breakMinutes,
      completedPomodoros: Math.max(0, Math.floor(Number(value.completedPomodoros) || 0)),
      cycleCount: positiveInteger(value.cycleCount, 4, 12),
      deadline: typeof value.deadline === 'number' && Number.isFinite(value.deadline) ? value.deadline : null,
      focusMinutes: positiveInteger(value.focusMinutes, 25, 120),
      focusBehaviour: value.focusBehaviour === 'pauseWhenHidden' ? 'pauseWhenHidden' : 'continue',
      longBreakMinutes: positiveInteger(value.longBreakMinutes, breakMinutes * 2, 120),
      pauseMusicDuringBreak: typeof value.pauseMusicDuringBreak === 'boolean'
        ? value.pauseMusicDuringBreak
        : true,
      phase: value.phase as PomodoroPhase,
      remainingSeconds: Math.max(0, Math.floor(Number(value.remainingSeconds) || 0)),
      status: value.status === 'running' && !(typeof value.deadline === 'number' && Number.isFinite(value.deadline))
        ? 'paused'
        : value.status as TimerStatus,
      focusRun: parseFocusRun(value.focusRun),
      pendingFocusFinalizations: parsePendingFocusFinalizations(value.pendingFocusFinalizations),
    }
  } catch {
    return undefined
  }
}

export function createPomodoroStore(options: PomodoroStoreOptions = {}): PomodoroStore {
  const clock = options.clock ?? systemTimerClock
  const storage = options.storage ?? safeLocalStorage
  const clearOwnedTimeout = options.timers?.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  const setOwnedTimeout = options.timers?.setTimeout ?? globalThis.setTimeout.bind(globalThis)
  const recovered = readSnapshot(storage)
  const focusMinutes = ref(positiveInteger(options.focusMinutes ?? recovered?.focusMinutes, 25, 120))
  const focusBehaviour = ref<FocusBehaviour>(
    options.focusBehaviour === 'pauseWhenHidden' ? 'pauseWhenHidden' : recovered?.focusBehaviour ?? 'continue',
  )
  const breakMinutes = ref(positiveInteger(options.breakMinutes ?? recovered?.breakMinutes, 5, 60))
  const longBreakMinutes = ref(positiveInteger(
    options.longBreakMinutes ?? recovered?.longBreakMinutes,
    breakMinutes.value * 2,
    120,
  ))
  const pauseMusicDuringBreak = ref(
    typeof options.pauseMusicDuringBreak === 'boolean'
      ? options.pauseMusicDuringBreak
      : recovered?.pauseMusicDuringBreak ?? true,
  )
  const cycleCount = ref(positiveInteger(options.cycleCount ?? recovered?.cycleCount, 4, 12))
  const phase = ref<PomodoroPhase>(recovered?.phase ?? 'focus')
  const status = ref<TimerStatus>(recovered?.status ?? 'idle')
  const completedPomodoros = ref(recovered?.completedPomodoros ?? 0)
  const remainingSeconds = ref(recovered?.remainingSeconds || focusMinutes.value * 60)
  let deadline = recovered?.deadline ?? null
  let focusRun = recovered?.focusRun ?? null
  const pageFocusQueues = pomodoroPageFocusQueueFor(storage)
  const restoredFocusFinalizations = mergeFocusFinalizations(
    recovered?.pendingFocusFinalizations ?? [],
    pageFocusQueues.pending,
    pageFocusQueues.overflow,
  )
  let pendingFocusFinalizations = restoredFocusFinalizations.slice(
    0,
    MAX_PENDING_FOCUS_FINALIZATIONS,
  )
  pageFocusQueues.pending = pendingFocusFinalizations.map(cloneFocusFinalization)
  pageFocusQueues.overflow = restoredFocusFinalizations.slice(
    MAX_PENDING_FOCUS_FINALIZATIONS,
    MAX_PENDING_FOCUS_FINALIZATIONS * 2,
  ).map(cloneFocusFinalization)
  const droppedRestoredFocusFinalizations = Math.max(
    0,
    restoredFocusFinalizations.length - MAX_PENDING_FOCUS_FINALIZATIONS * 2,
  )
  let scheduledTick: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  if (phase.value !== 'focus' || status.value === 'idle') focusRun = null
  let focusRunUntracked = phase.value === 'focus' && !focusRun && (
    status.value === 'running' || remainingSeconds.value < focusMinutes.value * 60
  )

  const phaseSeconds = (value: PomodoroPhase): number => {
    if (value === 'focus') return focusMinutes.value * 60
    if (value === 'longBreak') return longBreakMinutes.value * 60
    return breakMinutes.value * 60
  }

  const formattedTime = computed(() => {
    const minutes = Math.floor(remainingSeconds.value / 60).toString().padStart(2, '0')
    const seconds = (remainingSeconds.value % 60).toString().padStart(2, '0')
    return `${minutes}:${seconds}`
  })

  function persist(): void {
    pageFocusQueues.pending = pendingFocusFinalizations.map(cloneFocusFinalization)
    try {
      storage.setItem(POMODORO_STORAGE_KEY, JSON.stringify({
        breakMinutes: breakMinutes.value,
        completedPomodoros: completedPomodoros.value,
        cycleCount: cycleCount.value,
        deadline,
        focusMinutes: focusMinutes.value,
        focusBehaviour: focusBehaviour.value,
        longBreakMinutes: longBreakMinutes.value,
        pauseMusicDuringBreak: pauseMusicDuringBreak.value,
        phase: phase.value,
        remainingSeconds: remainingSeconds.value,
        status: status.value,
        focusRun,
        pendingFocusFinalizations,
      } satisfies PomodoroSnapshot))
    } catch { /* Timer truth remains page-local when snapshot storage is unavailable. */ }
  }

  function reportFocusSessionError(error: PomodoroFocusQueueCapacityError): void {
    try { options.onFocusSessionError?.(error) } catch {
      // Error observers cannot affect timer transitions or queue ownership.
    }
  }

  for (let index = 0; index < droppedRestoredFocusFinalizations; index += 1) {
    reportFocusSessionError(new PomodoroFocusQueueCapacityError('overflow_full'))
  }

  function deliverFocusFinalization(event: PomodoroFocusSessionFinalized): boolean {
    if (!options.onFocusSessionFinalized) return false
    try {
      return options.onFocusSessionFinalized(cloneFocusFinalization(event)) === true
    } catch {
      return false
    }
  }

  function stageFocusFinalizations(
    events: PomodoroFocusSessionFinalized[],
  ): PomodoroFocusSessionFinalized[] {
    if (!options.onFocusSessionFinalized || events.length === 0) return []
    const ids = new Set([
      ...pendingFocusFinalizations.map(({ run }) => run.id),
      ...pageFocusQueues.overflow.map(({ run }) => run.id),
    ])
    const directHandoffs: PomodoroFocusSessionFinalized[] = []
    for (const event of events) {
      if (ids.has(event.run.id)) continue
      ids.add(event.run.id)
      if (pendingFocusFinalizations.length < MAX_PENDING_FOCUS_FINALIZATIONS) {
        pendingFocusFinalizations.push(cloneFocusFinalization(event))
      } else {
        directHandoffs.push(cloneFocusFinalization(event))
      }
    }
    pageFocusQueues.pending = pendingFocusFinalizations.map(cloneFocusFinalization)
    return directHandoffs
  }

  function deliverPendingFocusFinalizations(): boolean {
    if (!options.onFocusSessionFinalized || pendingFocusFinalizations.length === 0) return false
    const acknowledged = new Set<string>()
    for (const event of pendingFocusFinalizations) {
      if (deliverFocusFinalization(event)) acknowledged.add(event.run.id)
    }
    if (acknowledged.size === 0) return false
    pendingFocusFinalizations = pendingFocusFinalizations.filter(
      ({ run }) => !acknowledged.has(run.id),
    )
    persist()
    return true
  }

  function retainOverflow(event: PomodoroFocusSessionFinalized): void {
    if (pageFocusQueues.overflow.length < MAX_PENDING_FOCUS_FINALIZATIONS) {
      pageFocusQueues.overflow.push(cloneFocusFinalization(event))
      reportFocusSessionError(new PomodoroFocusQueueCapacityError('pending_overflow'))
      return
    }
    reportFocusSessionError(new PomodoroFocusQueueCapacityError('overflow_full'))
  }

  function deliverDirectHandoffs(events: PomodoroFocusSessionFinalized[]): void {
    for (const event of events) {
      if (!deliverFocusFinalization(event)) retainOverflow(event)
    }
  }

  function promoteOverflowToPending(): boolean {
    const available = MAX_PENDING_FOCUS_FINALIZATIONS - pendingFocusFinalizations.length
    if (available <= 0 || pageFocusQueues.overflow.length === 0) return false
    const promoted = pageFocusQueues.overflow.splice(0, available)
    pendingFocusFinalizations.push(...promoted.map(cloneFocusFinalization))
    persist()
    return promoted.length > 0
  }

  function retryQueuedFocusFinalizations(): void {
    if (!options.onFocusSessionFinalized) return
    deliverPendingFocusFinalizations()
    while (
      pageFocusQueues.overflow.length > 0 &&
      pendingFocusFinalizations.length < MAX_PENDING_FOCUS_FINALIZATIONS
    ) {
      if (!promoteOverflowToPending()) break
      const acknowledged = deliverPendingFocusFinalizations()
      if (!acknowledged && pendingFocusFinalizations.length >= MAX_PENDING_FOCUS_FINALIZATIONS) break
    }
    if (pendingFocusFinalizations.length < MAX_PENDING_FOCUS_FINALIZATIONS) return

    const remainingOverflow: PomodoroFocusSessionFinalized[] = []
    for (const event of pageFocusQueues.overflow) {
      if (!deliverFocusFinalization(event)) remainingOverflow.push(event)
    }
    pageFocusQueues.overflow = remainingOverflow.map(cloneFocusFinalization)
  }

  function beginFocusRun(startedAt: number): PomodoroFocusRun {
    focusRunUntracked = false
    const run = {
      id: createUuid(),
      startedAt,
      plannedFocusSeconds: phaseSeconds('focus'),
    }
    options.onFocusRunStarted?.(run)
    return run
  }

  function clearScheduledTick(): void {
    if (scheduledTick === undefined) return
    clearOwnedTimeout(scheduledTick)
    scheduledTick = undefined
  }

  function schedule(): void {
    clearScheduledTick()
    if (destroyed || options.autoTick === false || status.value !== 'running' || deadline === null) return
    const remainingMilliseconds = Math.max(0, deadline - clock.now())
    const delay = remainingMilliseconds === 0 ? 0 : (remainingMilliseconds % 1_000 || 1_000)
    scheduledTick = setOwnedTimeout(() => {
      scheduledTick = undefined
      tick()
    }, delay)
  }

  function moveToNextPhase(
    expiredAt: number,
    focusFinalizations: PomodoroFocusSessionFinalized[],
  ): PomodoroPhaseTransition {
    const expiredPhase = phase.value
    const durationSeconds = phaseSeconds(expiredPhase)
    if (expiredPhase === 'focus') {
      if (focusRun) {
        focusFinalizations.push({
          run: focusRun,
          endedAt: expiredAt,
          actualFocusSeconds: focusRun.plannedFocusSeconds,
          status: 'completed',
          presentSummary: false,
        })
      }
      focusRun = null
      focusRunUntracked = false
      completedPomodoros.value += 1
      phase.value = completedPomodoros.value % cycleCount.value === 0 ? 'longBreak' : 'break'
    } else {
      phase.value = 'focus'
      focusRun = beginFocusRun(expiredAt)
    }
    deadline = expiredAt + phaseSeconds(phase.value) * 1_000
    return { durationSeconds, phase: expiredPhase, expiredAt, nextPhase: phase.value }
  }

  function tick(): void {
    if (status.value !== 'running' || deadline === null) return
    retryQueuedFocusFinalizations()
    const now = clock.now()
    const expiredEvents: PomodoroPhaseTransition[] = []
    const focusFinalizations: PomodoroFocusSessionFinalized[] = []
    let guard = 0
    while (now >= deadline && guard < MAX_CATCH_UP_TRANSITIONS) {
      const expiredAt = deadline
      expiredEvents.push(moveToNextPhase(expiredAt, focusFinalizations))
      guard += 1
    }
    const catchUpCapped = now >= deadline
    if (catchUpCapped) {
      status.value = 'paused'
      deadline = null
      remainingSeconds.value = phaseSeconds(phase.value)
      if (phase.value === 'focus') {
        focusRun = null
        focusRunUntracked = false
      }
    } else {
      remainingSeconds.value = Math.max(0, Math.ceil((deadline - now) / 1_000))
    }
    let directHandoffs: PomodoroFocusSessionFinalized[] = []
    if (focusFinalizations.length > 0) {
      focusFinalizations[focusFinalizations.length - 1].presentSummary = true
      directHandoffs = stageFocusFinalizations(focusFinalizations)
    }
    persist()
    deliverPendingFocusFinalizations()
    deliverDirectHandoffs(directHandoffs)
    expiredEvents.forEach((event, index) => {
      const isLastInBatch = index === expiredEvents.length - 1
      options.onPhaseExpired?.({
        ...event,
        catchUpCapped: catchUpCapped && isLastInBatch,
        isLastInBatch,
        pauseMusicDuringBreak: pauseMusicDuringBreak.value,
      })
    })
    schedule()
  }

  function start(): void {
    if (status.value === 'running') return
    if (remainingSeconds.value <= 0) remainingSeconds.value = phaseSeconds(phase.value)
    if (
      phase.value === 'focus' &&
      !focusRun &&
      !focusRunUntracked &&
      remainingSeconds.value === phaseSeconds('focus')
    ) focusRun = beginFocusRun(clock.now())
    status.value = 'running'
    deadline = clock.now() + remainingSeconds.value * 1_000
    persist()
    schedule()
  }

  function pause(): void {
    if (status.value !== 'running') return
    tick()
    status.value = 'paused'
    deadline = null
    clearScheduledTick()
    persist()
  }

  function reset(): void {
    if (status.value === 'running') tick()
    else retryQueuedFocusFinalizations()
    clearScheduledTick()
    const actualFocusSeconds = focusRun && phase.value === 'focus'
      ? focusRun.plannedFocusSeconds - remainingSeconds.value
      : 0
    let directHandoffs: PomodoroFocusSessionFinalized[] = []
    if (focusRun && phase.value === 'focus' && actualFocusSeconds > 0) {
      directHandoffs = stageFocusFinalizations([{
        run: focusRun,
        endedAt: clock.now(),
        actualFocusSeconds,
        status: 'interrupted',
        presentSummary: true,
      }])
    }
    status.value = 'idle'
    phase.value = 'focus'
    remainingSeconds.value = focusMinutes.value * 60
    deadline = null
    focusRun = null
    focusRunUntracked = false
    persist()
    deliverPendingFocusFinalizations()
    deliverDirectHandoffs(directHandoffs)
    options.onControl?.({ type: 'reset' })
  }

  function selectPhase(nextPhase: PomodoroPhase): void {
    if (!['focus', 'break', 'longBreak'].includes(nextPhase) || status.value === 'running') return
    retryQueuedFocusFinalizations()
    clearScheduledTick()
    const actualFocusSeconds = focusRun && phase.value === 'focus'
      ? focusRun.plannedFocusSeconds - remainingSeconds.value
      : 0
    let directHandoffs: PomodoroFocusSessionFinalized[] = []
    if (
      status.value === 'paused' &&
      phase.value === 'focus' &&
      nextPhase !== 'focus' &&
      focusRun &&
      actualFocusSeconds > 0
    ) {
      directHandoffs = stageFocusFinalizations([{
        run: focusRun,
        endedAt: clock.now(),
        actualFocusSeconds,
        status: 'interrupted',
        presentSummary: true,
      }])
    }
    status.value = 'idle'
    deadline = null
    phase.value = nextPhase
    remainingSeconds.value = phaseSeconds(nextPhase)
    focusRun = null
    focusRunUntracked = false
    persist()
    deliverPendingFocusFinalizations()
    deliverDirectHandoffs(directHandoffs)
    options.onControl?.({ type: 'selectPhase', phase: nextPhase })
  }

  function notifySettingsChanged(): void {
    options.onSettingsChanged?.({
      breakMinutes: breakMinutes.value,
      cycleCount: cycleCount.value,
      focusMinutes: focusMinutes.value,
      focusBehaviour: focusBehaviour.value,
      longBreakMinutes: longBreakMinutes.value,
      pauseMusicDuringBreak: pauseMusicDuringBreak.value,
    })
  }

  function setDuration(target: Ref<number>, value: number, maximum: number): void {
    target.value = positiveInteger(value, target.value, maximum)
    if (status.value !== 'running' && !(phase.value === 'focus' && focusRun)) {
      remainingSeconds.value = phaseSeconds(phase.value)
    }
    persist()
    notifySettingsChanged()
  }

  function destroy(): void {
    destroyed = true
    clearScheduledTick()
  }

  const store: PomodoroStore = {
    breakMinutes, completedPomodoros, cycleCount, focusMinutes, focusBehaviour, longBreakMinutes, pauseMusicDuringBreak,
    formattedTime, phase, remainingSeconds, status,
    destroy, pause, reset, resume: start, selectPhase,
    setBreakMinutes: (minutes) => setDuration(breakMinutes, minutes, 60),
    setCycleCount: (count) => {
      cycleCount.value = positiveInteger(count, cycleCount.value, 12)
      persist()
      notifySettingsChanged()
    },
    setFocusMinutes: (minutes) => setDuration(focusMinutes, minutes, 120),
    setFocusBehaviour: (behaviour) => {
      if (behaviour !== 'continue' && behaviour !== 'pauseWhenHidden') return
      focusBehaviour.value = behaviour
      persist()
      notifySettingsChanged()
    },
    setLongBreakMinutes: (minutes) => setDuration(longBreakMinutes, minutes, 120),
    setPauseMusicDuringBreak: (enabled) => {
      if (typeof enabled !== 'boolean') return
      pauseMusicDuringBreak.value = enabled
      persist()
      notifySettingsChanged()
    },
    start, tick,
  }

  persist()
  if (status.value === 'running' && deadline !== null) tick()
  else retryQueuedFocusFinalizations()
  return store
}
