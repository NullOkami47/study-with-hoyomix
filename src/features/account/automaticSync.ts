import { ref, watch, type Ref } from 'vue'

export type AutomaticSyncStatus = 'local' | 'restoring' | 'pending' | 'syncing' | 'synced' | 'failed'
export const automaticSyncStatus = ref<AutomaticSyncStatus>('local')
export interface SyncChannel<T extends object> {
  persistPending?: boolean
  /** Catalogue hydration is not a user edit. Real controls remain tracked. */
  isLocalChange?(): boolean
  capture(): T
  load(): Promise<T | null>
  apply(value: T): void
  save(value: T): Promise<T>
}
type Snapshot = Record<string, unknown>
export function syncChannel<T extends object>(channel: SyncChannel<T>): SyncChannel<Snapshot> {
  return channel as unknown as SyncChannel<Snapshot>
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const httpStatus = (error: unknown) => Number(String(error instanceof Error ? error.message : error).match(/(?:http_|_)(\d{3})(?:\b|$)/)?.[1])

/** One serial request pipeline per workspace; identity changes invalidate every continuation. */
export function createAutomaticSync<T extends object>(options: {
  userId: Readonly<Ref<string | null>>
  channels: SyncChannel<T>[]
  status?: Ref<AutomaticSyncStatus>
  debounceMs?: number
  pendingStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
}) {
  const status = options.status ?? ref<AutomaticSyncStatus>('local')
  const states = options.channels.map(channel => ({ channel, base: null as T | null,
    ready: false, dirty: new Set<keyof T>(), applying: false, pendingToken: null as string | null }))
  let generation = 0, destroyed = false, running = false, requested = false, failures = 0
  let activeIdentity = options.userId.value
  let timer: ReturnType<typeof setTimeout> | undefined
  let needsPull = true
  let retryNotBefore = 0, terminal = false
  const pendingKey = (index: number) => `study-with-hoyomix.sync-pending.v1.${encodeURIComponent(activeIdentity!)}.${index}`
  function persistPending(index: number) {
    const state = states[index]
    if (!activeIdentity || state.channel.persistPending === false) return
    try {
      if (state.dirty.size) {
        const stored = JSON.parse(options.pendingStorage?.getItem(pendingKey(index)) ?? 'null')
        if (stored?.token !== state.pendingToken && Array.isArray(stored?.keys) && stored.values && typeof stored.values === 'object') {
          const merged = { ...state.channel.capture() }
          for (const key of stored.keys as (keyof T)[]) {
            if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(merged, key) && !state.dirty.has(key)) {
              merged[key] = stored.values[key]
              state.dirty.add(key)
            }
          }
          // Merge disjoint edits from another live tab before replacing the
          // shared durable entry or sending a complete preference envelope.
          state.applying = true
          try { state.channel.apply(merged) } finally { state.applying = false }
        }
        state.pendingToken = crypto.randomUUID()
        options.pendingStorage?.setItem(pendingKey(index), JSON.stringify({
          token: state.pendingToken, keys: [...state.dirty], values: state.channel.capture(),
        }))
      } else if (state.pendingToken !== null) {
        const stored = JSON.parse(options.pendingStorage?.getItem(pendingKey(index)) ?? 'null')
        // A second live tab may own a newer pending edit. Only clear our exact
        // acknowledged outbox version, never an arbitrary account-wide key.
        if (stored?.token === state.pendingToken) options.pendingStorage?.removeItem(pendingKey(index))
        state.pendingToken = null
      }
    } catch { /* Device stores still retain values; failure must not block local controls. */ }
  }
  const current = (token: number) => !destroyed && token === generation && Boolean(options.userId.value)
  function schedule(delay = options.debounceMs ?? 700) {
    if (destroyed || terminal || !options.userId.value) return
    requested = true
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void run() }, Math.max(delay, retryNotBefore - Date.now()))
  }
  const stops = states.map((state, index) => watch(state.channel.capture, (value, previous) => {
    if (options.userId.value !== activeIdentity) return
    if (state.applying || state.channel.isLocalChange?.() === false) return
    let changed = false
    for (const key of Object.keys(value) as (keyof T)[]) {
      if (!equal(value[key], previous?.[key])) { state.dirty.add(key); changed = true }
    }
    if (changed) persistPending(index)
    if (changed && options.userId.value) { status.value = 'pending'; schedule() }
  }, { deep: true, flush: 'sync' }))

  async function run() {
    if (running || destroyed || terminal || !options.userId.value) return
    running = true; requested = false
    const token = generation, pull = needsPull
    needsPull = false
    try {
      let channelError: unknown
      for (const [index, state] of states.entries()) {
        if (!current(token)) return
        try {
          if (!state.ready || pull) {
            status.value = 'restoring'
            const remote = await state.channel.load()
            if (!current(token)) return
            if (remote !== null) {
              const local = state.channel.capture(), merged = { ...remote } as T
              for (const key of state.dirty) merged[key] = local[key]
              if (!equal(merged, local)) {
                state.applying = true
                try { state.channel.apply(merged) } finally { state.applying = false }
              }
            }
            state.base = remote; state.ready = true
          }
          const snapshot = state.channel.capture()
          if (equal(snapshot, state.base)) { state.dirty.clear(); persistPending(index); continue }
          status.value = 'syncing'
          const saved = await state.channel.save(snapshot)
          if (!current(token)) return
          state.base = saved
          const latest = state.channel.capture()
          for (const key of state.dirty) if (equal(latest[key], snapshot[key])) state.dirty.delete(key)
          persistPending(index)
          if (!equal(latest, state.base)) requested = true
        } catch (error) {
          const priority = (value: unknown) => [401, 403].includes(httpStatus(value)) ? 3 : httpStatus(value) === 429 ? 2 : 1
          if (!channelError || priority(error) > priority(channelError)) channelError = error
          if (httpStatus(error) === 401 || httpStatus(error) === 403) break
        }
      }
      if (channelError) throw channelError
      failures = 0
      retryNotBefore = 0
      if (current(token)) status.value = requested ? 'pending' : 'synced'
    } catch (error) {
      if (!current(token)) return
      failures += 1
      if (failures >= 3) status.value = 'failed'
      const code = httpStatus(error)
      // Never treat an unauthorised/failed read as an empty remote profile.
      if (code === 401 || code === 403) {
        status.value = 'failed'; requested = false; terminal = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
      else if ((!code || code === 409 || code === 429 || code >= 500) && failures < 5) {
        needsPull = true
        retryNotBefore = Date.now() + (code === 429 ? 60_000 : Math.min(30_000, 1000 * 2 ** (failures - 1)))
        schedule(0)
      } else { status.value = 'failed'; requested = false }
    } finally {
      running = false
      if (token !== generation && options.userId.value) schedule(0)
      else if (current(token) && requested && timer === undefined) schedule()
    }
  }
  let firstIdentity = true
  const stopIdentity = watch(options.userId, () => {
    activeIdentity = options.userId.value
    retryNotBefore = 0; terminal = false
    generation++; failures = 0; needsPull = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined; requested = false
    for (const [index, state] of states.entries()) {
      state.ready = false; state.base = null
      state.pendingToken = null
      if (!firstIdentity) state.dirty.clear()
      if (activeIdentity && state.channel.persistPending !== false) {
        try {
          const saved = JSON.parse(options.pendingStorage?.getItem(pendingKey(index)) ?? 'null')
          if (saved && Array.isArray(saved.keys) && saved.values && typeof saved.values === 'object') {
            const merged = { ...state.channel.capture() }
            for (const key of saved.keys as (keyof T)[]) {
              if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(merged, key)) {
                merged[key] = saved.values[key]; state.dirty.add(key)
              }
            }
            state.applying = true
            try { state.channel.apply(merged) } finally { state.applying = false }
            persistPending(index)
          }
        } catch { /* A malformed local outbox cannot broaden the domain allowlist. */ }
      }
    }
    if (options.userId.value) firstIdentity = false
    status.value = options.userId.value ? 'restoring' : 'local'
    if (options.userId.value) void run()
  }, { immediate: true, flush: 'sync' })
  return {
    status,
    refresh() { if (options.userId.value) { needsPull = true; failures = 0; terminal = false; schedule(0) } },
    destroy() { destroyed = true; generation++; stopIdentity(); stops.forEach(stop => stop()); if (timer !== undefined) clearTimeout(timer) },
  }
}
