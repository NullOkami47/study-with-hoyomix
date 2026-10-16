import { flushPromises, mount } from '@vue/test-utils'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeSha256, createLxSourceRepository } from '../player/lx/sourceRepository'
import {
  LX_MAX_SCRIPT_BYTES,
  type LxSourceRecord,
  type LxSourceRepository,
} from '../player/lx/types'
import LxSourceManager from './LxSourceManager.vue'

const LX_BUILTIN_ID = 'synthetic-pinned-source'

const ALPHA_SCRIPT = `/**
 * @name Alpha Source
 * @version 2.0.0
 */
const alpha = 1;`

const BETA_SCRIPT = `/**
 * @name Beta Source
 */
const beta = 2;`

const GAMMA_SCRIPT = `/**
 * @name Gamma Source
 */
const gamma = 3;`

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * fake-indexeddb settles across more than one microtask turn, and the manager awaits the
 * repository from onMounted, so a single flushPromises is not enough to observe its result.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function createRepository(overrides: { fetch?: typeof fetch } = {}): LxSourceRepository {
  // The production repository starts empty. Pinning is exercised with an explicit
  // synthetic IndexedDB fixture rather than shipping any third-party script.
  const indexedDB = new IDBFactory()
  const databaseName = `lx-manager-${crypto.randomUUID()}`
  const ready = new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('lx_sources', { keyPath: 'id' })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('lx_sources', 'readwrite')
      transaction.objectStore('lx_sources').put({
        id: LX_BUILTIN_ID, name: 'Synthetic Pinned Source', sha256: 'b'.repeat(64),
        enabled: true, priority: 10, script: '// Synthetic pinned test fixture',
        originUrl: 'https://sources.example.invalid/synthetic.js',
        builtIn: true, importedAt: 1, updatedAt: 1,
      })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
  const repository = createLxSourceRepository({ indexedDB, databaseName, fetch: overrides.fetch })
  return Object.fromEntries(Object.entries(repository).map(([name, method]) => [
    name, async (...args: unknown[]) => { await ready; return (method as (...values: unknown[]) => unknown)(...args) },
  ])) as unknown as LxSourceRepository
}

function mountManager(options: {
  repository: LxSourceRepository
  testRunner?: (source: LxSourceRecord) => Promise<void>
}) {
  const wrapper = mount(LxSourceManager, {
    props: {
      locale: 'en',
      repository: options.repository,
      testRunner: options.testRunner,
    },
  })
  cleanups.push(() => wrapper.unmount())
  return wrapper
}

const rowIds = (wrapper: ReturnType<typeof mountManager>): (string | undefined)[] =>
  wrapper.findAll('[data-lx-source]').map((row) => row.attributes('data-lx-source'))

const statusText = (wrapper: ReturnType<typeof mountManager>): string =>
  wrapper.get('[data-lx-status]').text()

async function importPasted(wrapper: ReturnType<typeof mountManager>, script: string): Promise<void> {
  await wrapper.get('[data-lx-import-paste]').setValue(script)
  await wrapper.get('[data-lx-import-paste-submit]').trigger('click')
  await settle()
}

describe('LxSourceManager', () => {
  describe('source list', () => {
    it('shows no source rows before the user imports a source', async () => {
      const repository = createLxSourceRepository({ indexedDB: new IDBFactory() })
      const wrapper = mountManager({ repository })
      await settle()
      expect(rowIds(wrapper)).toEqual([])
      expect(await repository.list()).toEqual([])
    })

    it('shows the synthetic pinned source pinned first with its snapshot hash', async () => {
      const wrapper = mountManager({ repository: createRepository() })
      await settle()

      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID])
      const row = wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"]`)
      expect(row.attributes('data-lx-source-builtin')).toBe('true')
      expect(row.text()).toContain('Synthetic Pinned Source')
      expect(row.get('[data-lx-source-sha]').text())
        .toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      expect(row.get('[data-lx-source-pinned-note]').text()).toMatch(/pinned/iu)
    })

    it('refuses to move or delete the built-in source while explaining why', async () => {
      const wrapper = mountManager({ repository: createRepository() })
      await settle()

      const row = wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"]`)
      expect((row.get('[data-lx-source-move-up]').element as HTMLButtonElement).disabled).toBe(true)
      expect((row.get('[data-lx-source-move-down]').element as HTMLButtonElement).disabled).toBe(true)
      expect((row.get('[data-lx-source-delete]').element as HTMLButtonElement).disabled).toBe(true)
      expect(row.get('[data-lx-source-move-up]').attributes('aria-describedby'))
        .toBe(`lx-source-${LX_BUILTIN_ID}-pinned`)
    })

    it('pins the built-in source ahead of a custom source with a lower stored priority', async () => {
      const records: LxSourceRecord[] = [
        {
          id: 'custom-low', name: 'Low Priority', sha256: 'a'.repeat(64), enabled: true,
          priority: 5, script: 'const low = 1;', builtIn: false, importedAt: 1, updatedAt: 1,
        },
        {
          id: LX_BUILTIN_ID, name: 'Synthetic Pinned Source', sha256: 'b'.repeat(64), enabled: true,
          priority: 10, script: 'const builtin = 1;', builtIn: true, importedAt: 1, updatedAt: 1,
        },
      ]
      const repository: LxSourceRepository = {
        list: async () => records.map((record) => ({ ...record })),
        get: async (id) => records.find((record) => record.id === id) ?? null,
        setEnabled: async () => undefined,
        reorder: async () => undefined,
        delete: async () => undefined,
        importScript: async () => records[0],
        importRemote: async () => records[0],
        refreshRemote: async () => records[0],
      }

      const wrapper = mountManager({ repository })
      await settle()

      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID, 'custom-low'])
    })

    it('never renders a stored script body into the page', async () => {
      const wrapper = mountManager({ repository: createRepository() })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)

      // WebCrypto/IndexedDB can outlive the fixed microtask flush under CI load.
      // Inspect the stored-source view only after import has actually completed.
      const expectedHash = await computeSha256(ALPHA_SCRIPT)
      await vi.waitFor(() => {
        expect(wrapper.findAll('[data-lx-source-sha]').map(row => row.text())).toContain(expectedHash)
        expect((wrapper.get('[data-lx-import-paste]').element as HTMLTextAreaElement).value).toBe('')
      })

      const html = wrapper.html()
      expect(html).not.toContain('const alpha')
      expect(html).not.toContain(ALPHA_SCRIPT)
      expect(html).toContain(expectedHash)
    })
  })

  describe('enable, disable, order and delete', () => {
    it('disables and re-enables a source through the repository', async () => {
      const repository = createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      const toggle = wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] input[type="checkbox"]`)
      expect((toggle.element as HTMLInputElement).checked).toBe(true)

      await toggle.setValue(false)
      await settle()

      expect((await repository.get(LX_BUILTIN_ID))?.enabled).toBe(false)
      expect(
        (wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] input[type="checkbox"]`).element as HTMLInputElement).checked,
      ).toBe(false)
    })

    it('restores the toggle when the repository rejects the change', async () => {
      const repository = createRepository()
      const failing: LxSourceRepository = {
        ...repository,
        setEnabled: async () => {
          throw new Error('storage_failure')
        },
      }
      const wrapper = mountManager({ repository: failing })
      await settle()

      const toggle = wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] input[type="checkbox"]`)
      await toggle.setValue(false)
      await settle()

      expect((toggle.element as HTMLInputElement).checked).toBe(true)
      expect((await repository.get(LX_BUILTIN_ID))?.enabled).toBe(true)
      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).not.toContain('storage_failure')
    })

    it('reorders custom sources with Move Up and Move Down, leaving the built-in pinned', async () => {
      const repository = createRepository()
      const wrapper = mountManager({ repository })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)
      await importPasted(wrapper, BETA_SCRIPT)

      const alpha = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      const beta = (await repository.list()).find((record) => record.name === 'Beta Source')!
      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID, alpha.id, beta.id])

      await wrapper.get(`[data-lx-source="${beta.id}"] [data-lx-source-move-up]`).trigger('click')
      await settle()
      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID, beta.id, alpha.id])

      await wrapper.get(`[data-lx-source="${beta.id}"] [data-lx-source-move-down]`).trigger('click')
      await settle()
      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID, alpha.id, beta.id])

      expect(
        (wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] [data-lx-source-move-down]`).element as HTMLButtonElement).disabled,
      ).toBe(true)
    })

    it('deletes a custom source and reports it', async () => {
      const repository = createRepository()
      const wrapper = mountManager({ repository })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)

      const alpha = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      await wrapper.get(`[data-lx-source="${alpha.id}"] [data-lx-source-delete]`).trigger('click')
      await settle()

      expect((await repository.list()).map((record) => record.id)).toEqual([LX_BUILTIN_ID])
      expect(rowIds(wrapper)).toEqual([LX_BUILTIN_ID])
      expect(statusText(wrapper)).toBe('Source deleted.')
    })
  })

  describe('imports', () => {
    it('imports a pasted script and shows its byte size before saving', async () => {
      const repository = createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      expect(wrapper.find('[data-lx-paste-size]').exists()).toBe(false)
      await wrapper.get('[data-lx-import-paste]').setValue(ALPHA_SCRIPT)
      expect(wrapper.get('[data-lx-paste-size]').text())
        .toBe(`${new TextEncoder().encode(ALPHA_SCRIPT).byteLength} / ${LX_MAX_SCRIPT_BYTES} bytes`)

      await wrapper.get('[data-lx-import-paste-submit]').trigger('click')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual(['Synthetic Pinned Source', 'Alpha Source'])
      expect(records[1].builtIn).toBe(false)
      expect(records[1].sha256).toBe(await computeSha256(ALPHA_SCRIPT))
      expect(statusText(wrapper)).toBe('Source imported.')
      expect((wrapper.get('[data-lx-import-paste]').element as HTMLTextAreaElement).value).toBe('')
    })

    it('rejects an oversized pasted script before it reaches the repository', async () => {
      const repository = createRepository()
      const importSpy = vi.spyOn(repository, 'importScript')
      const wrapper = mountManager({ repository })
      await settle()

      await importPasted(wrapper, 'a'.repeat(LX_MAX_SCRIPT_BYTES + 1))

      expect(importSpy).not.toHaveBeenCalled()
      expect((await repository.list()).map((record) => record.id)).toEqual([LX_BUILTIN_ID])
      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toContain(String(LX_MAX_SCRIPT_BYTES))
    })

    it('imports a .js file chosen from the device', async () => {
      const repository = createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      const input = wrapper.get('[data-lx-import-file]')
      const file = new File([GAMMA_SCRIPT], 'device-source.js', { type: 'text/javascript' })
      Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
      await input.trigger('change')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual(['Synthetic Pinned Source', 'device-source'])
      expect(records[1].sha256).toBe(await computeSha256(GAMMA_SCRIPT))
    })

    it('imports from an HTTPS URL and refuses a plain-HTTP one', async () => {
      const fetchImpl = vi.fn(async () => new Response(ALPHA_SCRIPT, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))
      const repository = createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/alpha.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual(['Synthetic Pinned Source', 'Alpha Source'])
      expect(records[1].originUrl).toBe('https://example.invalid/alpha.js')

      await wrapper.get('[data-lx-import-url]').setValue('http://example.invalid/beta.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      expect((await repository.list()).map((record) => record.name)).toEqual(['Synthetic Pinned Source', 'Alpha Source'])
      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toMatch(/https/iu)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('reports an oversized remote script with the size limit and stores nothing', async () => {
      const fetchImpl = vi.fn(async () => new Response('a'.repeat(LX_MAX_SCRIPT_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))
      const repository = createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/huge.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toContain(String(LX_MAX_SCRIPT_BYTES))
      expect((await repository.list()).map((record) => record.id)).toEqual([LX_BUILTIN_ID])
    })

    it('reports a remote import failure without echoing the raw error', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('SECRET_TRANSPORT_DETAIL') })
      const repository = createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/gone.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).not.toContain('SECRET_TRANSPORT_DETAIL')
      expect(wrapper.html()).not.toContain('SECRET_TRANSPORT_DETAIL')
    })
  })

  describe('sandbox test action', () => {
    it('reports a successful sandbox test through status text', async () => {
      const testRunner = vi.fn(async (_source: LxSourceRecord) => undefined)
      const wrapper = mountManager({ repository: createRepository(), testRunner })
      await settle()

      await wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] [data-lx-source-test]`).trigger('click')
      await settle()

      expect(testRunner).toHaveBeenCalledTimes(1)
      expect(testRunner.mock.calls[0][0].id).toBe(LX_BUILTIN_ID)
      expect(statusText(wrapper)).toBe('Source loaded in the sandbox.')
    })

    it('reports a failed sandbox test without echoing the runner message', async () => {
      const testRunner = vi.fn(async () => { throw new Error('SANDBOX_INTERNAL_DETAIL') })
      const wrapper = mountManager({ repository: createRepository(), testRunner })
      await settle()

      await wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] [data-lx-source-test]`).trigger('click')
      await settle()

      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toBe('The source failed to load in the sandbox.')
      expect(wrapper.html()).not.toContain('SANDBOX_INTERNAL_DETAIL')
    })
  })

  describe('remote refresh', () => {
    it('replaces a remote snapshot only after confirmation and shows both hashes', async () => {
      let body = ALPHA_SCRIPT
      const fetchImpl = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))
      const repository = createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/alpha.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const imported = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      const oldSha = imported.sha256
      body = BETA_SCRIPT

      await wrapper.get(`[data-lx-source="${imported.id}"] [data-lx-source-refresh]`).trigger('click')
      await flushPromises()

      // Nothing is replaced until the user confirms, and the confirmation states the
      // snapshot that would be replaced.
      expect((await repository.get(imported.id))?.sha256).toBe(oldSha)
      const confirmation = wrapper.get(`[data-lx-source="${imported.id}"] [data-lx-refresh-confirm]`)
      expect(confirmation.get('[data-lx-refresh-old-sha]').text()).toContain(oldSha)

      await wrapper.get(`[data-lx-source="${imported.id}"] [data-lx-refresh-accept]`).trigger('click')
      await settle()

      const newSha = await computeSha256(BETA_SCRIPT)
      expect((await repository.get(imported.id))?.sha256).toBe(newSha)
      const status = statusText(wrapper)
      expect(status).toContain(oldSha)
      expect(status).toContain(newSha)
      expect(wrapper.find(`[data-lx-source="${imported.id}"] [data-lx-refresh-confirm]`).exists()).toBe(false)
    })

    it('keeps the stored snapshot when the user cancels the refresh', async () => {
      const fetchImpl = vi.fn(async () => new Response(ALPHA_SCRIPT, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))
      const repository = createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      // Storage may commit before the component's asynchronous reload renders.
      const list = repository.list
      let listCalls = 0
      let releaseReload!: () => void
      const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve })
      vi.spyOn(repository, 'list').mockImplementation(async () => {
        const call = ++listCalls
        const records = await list()
        if (call === 2) await reloadGate
        return records
      })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/alpha.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const imported = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      fetchImpl.mockImplementation(async () => new Response(BETA_SCRIPT, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))

      const refreshSelector = `[data-lx-source="${imported.id}"] [data-lx-source-refresh]`
      expect(wrapper.find(refreshSelector).exists()).toBe(false)
      releaseReload()
      await vi.waitFor(() => {
        expect(wrapper.find(refreshSelector).exists()).toBe(true)
        expect((wrapper.get(refreshSelector).element as HTMLButtonElement).disabled).toBe(false)
      })
      await wrapper.get(`[data-lx-source="${imported.id}"] [data-lx-source-refresh]`).trigger('click')
      await flushPromises()
      await wrapper.get(`[data-lx-source="${imported.id}"] [data-lx-refresh-cancel]`).trigger('click')
      await settle()

      expect((await repository.get(imported.id))?.sha256).toBe(await computeSha256(ALPHA_SCRIPT))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(wrapper.find(`[data-lx-source="${imported.id}"] [data-lx-refresh-confirm]`).exists()).toBe(false)
    })

    it('offers no refresh action for a source that has no origin URL', async () => {
      const repository = createRepository()
      const importScript = repository.importScript
      let releaseImport!: () => void
      const importGate = new Promise<void>((resolve) => { releaseImport = resolve })
      vi.spyOn(repository, 'importScript').mockImplementation(async (...args: Parameters<LxSourceRepository['importScript']>) => {
        await importGate
        return importScript(...args)
      })
      // Hold the post-import reload: a stored record is not yet a rendered row.
      const list = repository.list
      let listCalls = 0
      let reloadEntered = false
      let releaseReload!: () => void
      const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve })
      vi.spyOn(repository, 'list').mockImplementation(async () => {
        const call = ++listCalls
        const records = await list()
        if (call === 2) {
          reloadEntered = true
          await reloadGate
        }
        return records
      })
      const wrapper = mountManager({ repository })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)

      try {
        expect(listCalls).toBe(1)
        releaseImport()
        await vi.waitFor(() => expect(reloadEntered).toBe(true))
        const imported = (await repository.list()).find((record) => record.name === 'Alpha Source')!
        expect(imported.originUrl).toBeUndefined()
        const selector = `[data-lx-source="${imported.id}"]`
        expect(wrapper.find(selector).exists()).toBe(false)
        releaseReload()
        await vi.waitFor(() => expect(wrapper.find(selector).exists()).toBe(true))
        const pasted = wrapper.get(selector)
        expect(pasted.findAll('[data-lx-source-refresh]')).toHaveLength(0)
        // The synthetic pinned fixture has an origin and may be refreshed explicitly.
        expect(wrapper.find(`[data-lx-source="${LX_BUILTIN_ID}"] [data-lx-source-refresh]`).exists())
          .toBe(true)
      } finally {
        releaseImport()
        releaseReload()
      }
    })
  })

  it('disables every action while a mutation is in flight', async () => {
    const repository = createRepository()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated: LxSourceRepository = {
      ...repository,
      setEnabled: async (id, enabled) => {
        await gate
        await repository.setEnabled(id, enabled)
      },
    }
    const wrapper = mountManager({ repository: gated })
    await settle()

    await wrapper.get(`[data-lx-source="${LX_BUILTIN_ID}"] input[type="checkbox"]`).setValue(false)
    await flushPromises()

    const builtin = `[data-lx-source="${LX_BUILTIN_ID}"]`
    expect((wrapper.get(`${builtin} input[type="checkbox"]`).element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.get(`${builtin} [data-lx-source-test]`).element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.get('[data-lx-import-file]').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.get('[data-lx-import-paste]').element as HTMLTextAreaElement).disabled).toBe(true)

    release()
    await settle()

    expect((wrapper.get(`${builtin} input[type="checkbox"]`).element as HTMLInputElement).disabled).toBe(false)
    expect((wrapper.get(`${builtin} [data-lx-source-test]`).element as HTMLButtonElement).disabled).toBe(false)
    expect((await repository.get(LX_BUILTIN_ID))?.enabled).toBe(false)
  })
})
