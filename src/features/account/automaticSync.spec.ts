import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createAutomaticSync } from './automaticSync'

const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).forEach(stop => stop()); vi.useRealTimers() })
function setup(load: () => Promise<{ language: string; volume: number } | null>) {
  vi.useFakeTimers()
  const user = ref<string | null>('A')
  const local = ref({ language: 'en', volume: .5 })
  const writes: unknown[] = []
  const sync = createAutomaticSync({ userId: user, channels: [{
    capture: () => ({ ...local.value }), load,
    apply: value => { local.value = value },
    save: async value => { writes.push({ ...value }); return value },
  }] })
  disposers.push(sync.destroy)
  return { user, local, writes, sync }
}
describe('workspace automatic sync', () => {
  it('restores before uploading and never sends fresh defaults', async () => {
    const s = setup(async () => ({ language: 'zh-Hant', volume: .8 }))
    await flushPromises(); await vi.advanceTimersByTimeAsync(1000)
    expect(s.local.value).toEqual({ language: 'zh-Hant', volume: .8 })
    expect(s.writes).toEqual([])
  })
  it('retains edits during restore while restoring untouched fields', async () => {
    let finish!: (value: { language: string; volume: number }) => void
    const s = setup(() => new Promise(resolve => { finish = resolve }))
    s.local.value.volume = .2
    finish({ language: 'zh-Hant', volume: .8 }); await flushPromises()
    await vi.advanceTimersByTimeAsync(800)
    expect(s.local.value).toEqual({ language: 'zh-Hant', volume: .2 })
    expect(s.writes).toEqual([{ language: 'zh-Hant', volume: .2 }])
  })
  it('debounces rapid changes and sends the latest values', async () => {
    const s = setup(async () => ({ language: 'zh-Hant', volume: .8 }))
    await flushPromises()
    for (const volume of [.1, .2, .3]) { s.local.value.volume = volume; await vi.advanceTimersByTimeAsync(100) }
    await vi.advanceTimersByTimeAsync(800)
    expect(s.writes).toEqual([{ language: 'zh-Hant', volume: .3 }])
  })
  it('failed reads cannot cause default uploads', async () => {
    const s = setup(async () => { throw new Error('http_500') })
    s.local.value.volume = .2
    await flushPromises(); await vi.advanceTimersByTimeAsync(5000)
    expect(s.writes).toEqual([])
  })
  it('fences restores after logout', async () => {
    let finish!: (value: { language: string; volume: number }) => void
    const s = setup(() => new Promise(resolve => { finish = resolve }))
    s.user.value = null
    finish({ language: 'zh-Hant', volume: .8 }); await flushPromises()
    expect(s.local.value.language).toBe('en')
    expect(s.writes).toEqual([])
  })
  it('preserves an edit and revert made while restoration is pending', async () => {
    let finish!: (value: { language: string; volume: number }) => void
    const s = setup(() => new Promise(resolve => { finish = resolve }))
    s.local.value.volume = .2; s.local.value.volume = .5
    finish({ language: 'zh-Hant', volume: .8 }); await flushPromises()
    expect(s.local.value.volume).toBe(.5)
  })
  it('does not apply remote data after the workspace is destroyed', async () => {
    let finish!: (value: { language: string; volume: number }) => void
    const s = setup(() => new Promise(resolve => { finish = resolve }))
    s.sync.destroy(); finish({ language: 'zh-Hant', volume: .8 }); await flushPromises()
    expect(s.local.value.language).toBe('en')
  })
  it('fences the previous account while starting the new account restore', async () => {
    let finish!: (value: { language: string; volume: number }) => void
    let reads = 0
    const s = setup(() => ++reads === 1 ? new Promise(resolve => { finish = resolve })
      : Promise.resolve({ language: 'zh-Hans', volume: .9 }))
    s.user.value = 'B'; finish({ language: 'zh-Hant', volume: .8 })
    await flushPromises(); await vi.advanceTimersByTimeAsync(1); await flushPromises()
    expect(s.local.value).toEqual({ language: 'zh-Hans', volume: .9 })
    expect(s.writes).toEqual([])
  })
  it('serialises writes and keeps edits made while a write is in flight', async () => {
    vi.useFakeTimers()
    const user = ref<string | null>('A'), local = ref({ volume: .5 })
    let finish!: (value: { volume: number }) => void
    const writes: number[] = []
    const sync = createAutomaticSync({ userId: user, channels: [{
      capture: () => ({ ...local.value }), load: async () => ({ volume: .5 }),
      apply: value => { local.value = value },
      save: value => { writes.push(value.volume); return writes.length === 1
        ? new Promise(resolve => { finish = resolve }) : Promise.resolve(value) },
    }] })
    disposers.push(sync.destroy)
    await flushPromises(); local.value.volume = .2; await vi.advanceTimersByTimeAsync(800)
    local.value.volume = .7; await vi.advanceTimersByTimeAsync(800)
    expect(writes).toEqual([.2])
    finish({ volume: .2 }); await flushPromises(); await vi.advanceTimersByTimeAsync(800)
    expect(writes).toEqual([.2, .7]); expect(local.value.volume).toBe(.7)
  })
  it('preserves pending edits across a workspace reload and restores other remote fields', async () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const user = ref<string | null>('A'), local = ref({ language: 'en', volume: .5 })
    const make = (offline: boolean) => createAutomaticSync({ userId: user, pendingStorage: storage, channels: [{
      capture: () => ({ ...local.value }), load: async () => ({ language: 'zh-Hant', volume: .5 }),
      apply: value => { local.value = value },
      save: async value => { if (offline) throw new Error('network'); return value },
    }] })
    const first = make(true); await flushPromises()
    local.value.volume = .2; await vi.advanceTimersByTimeAsync(800); first.destroy()
    local.value = { language: 'en', volume: .5 }
    const second = make(false); disposers.push(second.destroy)
    await flushPromises(); await vi.advanceTimersByTimeAsync(800)
    expect(local.value).toEqual({ language: 'zh-Hant', volume: .2 })
    expect(values.size).toBe(0)
  })
  it('does not clear an unsent pending edit owned by another live tab', async () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const user = ref<string | null>('A'), a = ref({ volume: .5 }), b = ref({ volume: .5 })
    const make = (local: typeof a) => createAutomaticSync({ userId: user, pendingStorage: storage, channels: [{
      capture: () => ({ ...local.value }), load: async () => ({ volume: .5 }),
      apply: value => { local.value = value }, save: async value => value,
    }] })
    const first = make(a), second = make(b); disposers.push(second.destroy)
    await flushPromises(); a.value.volume = .2; first.destroy()
    expect(values.size).toBe(1)
    second.refresh(); await vi.advanceTimersByTimeAsync(1); await flushPromises()
    expect(values.size).toBe(1)
    const third = make(a); disposers.push(third.destroy)
    await flushPromises()
    expect(a.value.volume).toBe(.2)
    expect(values.size).toBe(0)
  })
  it('merges another live tab pending fields before saving a disjoint edit', async () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const user = ref<string | null>('A'), a = ref({ volume: .5, blur: 16 }), b = ref({ volume: .5, blur: 16 })
    const sent: typeof a.value[] = []
    const make = (local: typeof a) => createAutomaticSync({ userId: user, pendingStorage: storage, channels: [{
      capture: () => ({ ...local.value }), load: async () => ({ volume: .5, blur: 16 }),
      apply: value => { local.value = value }, save: async value => { sent.push(value); return value },
    }] })
    const first = make(a), second = make(b); disposers.push(second.destroy)
    await flushPromises(); a.value.volume = .2; first.destroy()
    b.value.blur = 20
    await vi.advanceTimersByTimeAsync(800)
    expect(sent).toEqual([{ volume: .2, blur: 20 }])
    expect(values.size).toBe(0)
  })
  it.each([401, 403, 429])('preserves HTTP %s control semantics after another channel fails first', async code => {
    vi.useFakeTimers()
    const user = ref<string | null>('A')
    let requests = 0
    const channel = (status: number) => ({ capture: () => ({ value: 1 }),
      load: async () => { requests++; throw new Error(`http_${status}`) }, apply() {}, save: async (value: { value: number }) => value })
    const sync = createAutomaticSync({ userId: user, channels: [channel(500), channel(code)] }); disposers.push(sync.destroy)
    await flushPromises()
    if (code !== 429) expect(sync.status.value).toBe('failed')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(requests).toBe(2)
  })
})
