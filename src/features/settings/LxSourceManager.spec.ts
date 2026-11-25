import { flushPromises, mount } from '@vue/test-utils'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeSha256, createLxSourceRepository, LX_STORE_SOURCES } from '../player/lx/sourceRepository'
import {
  LX_BUILTIN_ID,
  LX_MAX_SCRIPT_BYTES,
  type LxSourceRecord,
  type LxSourceRepository,
} from '../player/lx/types'
import LxSourceManager from './LxSourceManager.vue'
import type {LxGlobalSourceRepository} from '../player/lx/globalSourceRepository'

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

// Test-only stored snapshot: no bundled runtime inventory or third-party script is needed.
const PINNED_FIXTURE_ID = 'fixture-pinned-source'
const PINNED_FIXTURE_NAME = 'Synthetic Pinned Source'
const PINNED_FIXTURE_SCRIPT = '/** @name Synthetic Pinned Source */\nconst fixture = 1;'

async function createRepository(
  overrides: { fetch?: typeof fetch; pinnedId?: string } = {},
): Promise<LxSourceRepository> {
  const indexedDB = new IDBFactory()
  const databaseName = `lx-manager-${crypto.randomUUID()}`
  const snapshot: LxSourceRecord = {
    id: overrides.pinnedId ?? PINNED_FIXTURE_ID,
    name: PINNED_FIXTURE_NAME,
    script: PINNED_FIXTURE_SCRIPT,
    sha256: await computeSha256(PINNED_FIXTURE_SCRIPT),
    originUrl: 'https://example.invalid/pinned-fixture.js',
    enabled: true,
    priority: 0,
    builtIn: true,
    importedAt: 1,
    updatedAt: 1,
  }
  // importScript intentionally creates personal sources only. Seed the documented store
  // before opening the real repository so pinned-policy tests exercise its real mutations.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(LX_STORE_SOURCES, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(LX_STORE_SOURCES, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      transaction.objectStore(LX_STORE_SOURCES).put(snapshot)
    })
  } finally {
    db.close()
  }
  return createLxSourceRepository({ indexedDB, databaseName, fetch: overrides.fetch })
}

function mountManager(options: {
  repository: LxSourceRepository
  testRunner?: (source: LxSourceRecord) => Promise<void>
  globalRepository?: LxGlobalSourceRepository
}) {
  const wrapper = mount(LxSourceManager, {
    props: {
      locale: 'en',
      repository: options.repository,
      testRunner: options.testRunner,
      globalRepository: options.globalRepository ?? {list:async()=>[],revision:()=>1,pendingApproval:()=>[],invalidate:()=>{}},
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
    it('keeps the public repository empty until a source is explicitly imported', async () => {
      const repository = createLxSourceRepository({
        indexedDB: new IDBFactory(),
        databaseName: `lx-manager-empty-${crypto.randomUUID()}`,
      })
      expect(await repository.list()).toEqual([])
      const wrapper = mountManager({ repository })
      await settle()

      expect(rowIds(wrapper)).toEqual([])
      expect(wrapper.find('[data-lx-import-paste-submit]').exists()).toBe(true)
      expect(wrapper.find('[data-lx-import-url-submit]').exists()).toBe(true)
    })

    it('shows an explicitly seeded synthetic built-in source pinned first with its snapshot hash', async () => {
      const wrapper = mountManager({ repository: await createRepository() })
      await settle()

      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID])
      const row = wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"]`)
      expect(row.attributes('data-lx-source-builtin')).toBe('true')
      expect(row.text()).toContain(PINNED_FIXTURE_NAME)
      expect(row.get('[data-lx-source-sha]').text())
        .toBe(await computeSha256(PINNED_FIXTURE_SCRIPT))
      expect(row.get('[data-lx-source-pinned-note]').text()).toMatch(/pinned/iu)
    })

    it('refuses to move or delete the built-in source while explaining why', async () => {
      const wrapper = mountManager({ repository: await createRepository() })
      await settle()

      const row = wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"]`)
      expect((row.get('[data-lx-source-move-up]').element as HTMLButtonElement).disabled).toBe(true)
      expect((row.get('[data-lx-source-move-down]').element as HTMLButtonElement).disabled).toBe(true)
      expect((row.get('[data-lx-source-delete]').element as HTMLButtonElement).disabled).toBe(true)
      expect(row.get('[data-lx-source-move-up]').attributes('aria-describedby'))
        .toBe(`lx-source-${PINNED_FIXTURE_ID}-pinned`)
    })

    it('pins the built-in source ahead of a custom source with a lower stored priority', async () => {
      const records: LxSourceRecord[] = [
        {
          id: 'custom-low', name: 'Low Priority', sha256: 'a'.repeat(64), enabled: true,
          priority: 5, script: 'const low = 1;', builtIn: false, importedAt: 1, updatedAt: 1,
        },
        {
          id: PINNED_FIXTURE_ID, name: PINNED_FIXTURE_NAME, sha256: 'b'.repeat(64), enabled: true,
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

      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID, 'custom-low'])
    })

    it('never renders a stored script body into the page', async () => {
      const wrapper = mountManager({ repository: await createRepository() })
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
      const repository = await createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      const toggle = wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] input[type="checkbox"]`)
      expect((toggle.element as HTMLInputElement).checked).toBe(true)

      await toggle.setValue(false)
      await settle()

      expect((await repository.get(PINNED_FIXTURE_ID))?.enabled).toBe(false)
      expect(
        (wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] input[type="checkbox"]`).element as HTMLInputElement).checked,
      ).toBe(false)
    })

    it('restores the toggle when the repository rejects the change', async () => {
      const repository = await createRepository()
      const failing: LxSourceRepository = {
        ...repository,
        setEnabled: async () => {
          throw new Error('storage_failure')
        },
      }
      const wrapper = mountManager({ repository: failing })
      await settle()

      const toggle = wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] input[type="checkbox"]`)
      await toggle.setValue(false)
      await settle()

      expect((toggle.element as HTMLInputElement).checked).toBe(true)
      expect((await repository.get(PINNED_FIXTURE_ID))?.enabled).toBe(true)
      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).not.toContain('storage_failure')
    })

    it('reorders custom sources with Move Up and Move Down, leaving the built-in pinned', async () => {
      const repository = await createRepository()
      const wrapper = mountManager({ repository })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)
      await importPasted(wrapper, BETA_SCRIPT)

      const alpha = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      const beta = (await repository.list()).find((record) => record.name === 'Beta Source')!
      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID, alpha.id, beta.id])

      await wrapper.get(`[data-lx-source="${beta.id}"] [data-lx-source-move-up]`).trigger('click')
      await settle()
      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID, beta.id, alpha.id])

      await wrapper.get(`[data-lx-source="${beta.id}"] [data-lx-source-move-down]`).trigger('click')
      await settle()
      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID, alpha.id, beta.id])

      expect(
        (wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] [data-lx-source-move-down]`).element as HTMLButtonElement).disabled,
      ).toBe(true)
    })

    it('deletes a custom source and reports it', async () => {
      const repository = await createRepository()
      const wrapper = mountManager({ repository })
      await settle()
      await importPasted(wrapper, ALPHA_SCRIPT)

      const alpha = (await repository.list()).find((record) => record.name === 'Alpha Source')!
      await wrapper.get(`[data-lx-source="${alpha.id}"] [data-lx-source-delete]`).trigger('click')
      await settle()

      expect((await repository.list()).map((record) => record.id)).toEqual([PINNED_FIXTURE_ID])
      expect(rowIds(wrapper)).toEqual([PINNED_FIXTURE_ID])
      expect(statusText(wrapper)).toBe('Source deleted.')
    })
  })

  describe('imports', () => {
    it('imports a pasted script and shows its byte size before saving', async () => {
      const repository = await createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      expect(wrapper.find('[data-lx-paste-size]').exists()).toBe(false)
      await wrapper.get('[data-lx-import-paste]').setValue(ALPHA_SCRIPT)
      expect(wrapper.get('[data-lx-paste-size]').text())
        .toBe(`${new TextEncoder().encode(ALPHA_SCRIPT).byteLength} / ${LX_MAX_SCRIPT_BYTES} bytes`)

      await wrapper.get('[data-lx-import-paste-submit]').trigger('click')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual([PINNED_FIXTURE_NAME, 'Alpha Source'])
      expect(records[1].builtIn).toBe(false)
      expect(records[1].sha256).toBe(await computeSha256(ALPHA_SCRIPT))
      expect(statusText(wrapper)).toBe('Source imported.')
      expect((wrapper.get('[data-lx-import-paste]').element as HTMLTextAreaElement).value).toBe('')
    })

    it('rejects an oversized pasted script before it reaches the repository', async () => {
      const repository = await createRepository()
      const importSpy = vi.spyOn(repository, 'importScript')
      const wrapper = mountManager({ repository })
      await settle()

      await importPasted(wrapper, 'a'.repeat(LX_MAX_SCRIPT_BYTES + 1))

      expect(importSpy).not.toHaveBeenCalled()
      expect((await repository.list()).map((record) => record.id)).toEqual([PINNED_FIXTURE_ID])
      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toContain(String(LX_MAX_SCRIPT_BYTES))
    })

    it('imports a .js file chosen from the device', async () => {
      const repository = await createRepository()
      const wrapper = mountManager({ repository })
      await settle()

      const input = wrapper.get('[data-lx-import-file]')
      const file = new File([GAMMA_SCRIPT], 'device-source.js', { type: 'text/javascript' })
      Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
      await input.trigger('change')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual([PINNED_FIXTURE_NAME, 'device-source'])
      expect(records[1].sha256).toBe(await computeSha256(GAMMA_SCRIPT))
    })

    it('imports from an HTTPS URL and refuses a plain-HTTP one', async () => {
      const fetchImpl = vi.fn(async () => new Response(ALPHA_SCRIPT, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      }))
      const repository = await createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/alpha.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const records = await repository.list()
      expect(records.map((record) => record.name)).toEqual([PINNED_FIXTURE_NAME, 'Alpha Source'])
      expect(records[1].originUrl).toBe('https://example.invalid/alpha.js')

      await wrapper.get('[data-lx-import-url]').setValue('http://example.invalid/beta.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      expect((await repository.list()).map((record) => record.name)).toEqual([PINNED_FIXTURE_NAME, 'Alpha Source'])
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
      const repository = await createRepository({ fetch: fetchImpl as unknown as typeof fetch })
      const wrapper = mountManager({ repository })
      await settle()

      await wrapper.get('[data-lx-import-url]').setValue('https://example.invalid/huge.js')
      await wrapper.get('[data-lx-import-url-submit]').trigger('click')
      await settle()

      const status = wrapper.get('[data-lx-status]')
      expect(status.attributes('data-lx-status-tone')).toBe('error')
      expect(status.text()).toContain(String(LX_MAX_SCRIPT_BYTES))
      expect((await repository.list()).map((record) => record.id)).toEqual([PINNED_FIXTURE_ID])
    })

    it('reports a remote import failure without echoing the raw error', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('SECRET_TRANSPORT_DETAIL') })
      const repository = await createRepository({ fetch: fetchImpl as unknown as typeof fetch })
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
      const wrapper = mountManager({ repository: await createRepository(), testRunner })
      await settle()

      await wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] [data-lx-source-test]`).trigger('click')
      await settle()

      expect(testRunner).toHaveBeenCalledTimes(1)
      expect(testRunner.mock.calls[0][0].id).toBe(PINNED_FIXTURE_ID)
      expect(statusText(wrapper)).toBe('Source loaded in the sandbox.')
    })

    it('reports a failed sandbox test without echoing the runner message', async () => {
      const testRunner = vi.fn(async () => { throw new Error('SANDBOX_INTERNAL_DETAIL') })
      const wrapper = mountManager({ repository: await createRepository(), testRunner })
      await settle()

      await wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] [data-lx-source-test]`).trigger('click')
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
      const repository = await createRepository({ fetch: fetchImpl as unknown as typeof fetch })
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
      const repository = await createRepository({ fetch: fetchImpl as unknown as typeof fetch })
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
      const repository = await createRepository()
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
        // The synthetic pinned snapshot has an explicit HTTPS origin and may be refreshed.
        expect(wrapper.find(`[data-lx-source="${PINNED_FIXTURE_ID}"] [data-lx-source-refresh]`).exists())
          .toBe(true)
      } finally {
        releaseImport()
        releaseReload()
      }
    })
  })

  it('disables every action while a mutation is in flight', async () => {
    const repository = await createRepository()
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

    await wrapper.get(`[data-lx-source="${PINNED_FIXTURE_ID}"] input[type="checkbox"]`).setValue(false)
    await flushPromises()

    const builtin = `[data-lx-source="${PINNED_FIXTURE_ID}"]`
    expect((wrapper.get(`${builtin} input[type="checkbox"]`).element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.get(`${builtin} [data-lx-source-test]`).element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.get('[data-lx-import-file]').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.get('[data-lx-import-paste]').element as HTMLTextAreaElement).disabled).toBe(true)

    release()
    await settle()

    expect((wrapper.get(`${builtin} input[type="checkbox"]`).element as HTMLInputElement).disabled).toBe(false)
    expect((wrapper.get(`${builtin} [data-lx-source-test]`).element as HTMLButtonElement).disabled).toBe(false)
    expect((await repository.get(PINNED_FIXTURE_ID))?.enabled).toBe(false)
  })
  it('shows the actual administrator-published sources separately from personal imports, without leaking publication controls',async()=>{
    const repository=await createRepository()
    await repository.importScript(ALPHA_SCRIPT)
    const published:LxSourceRecord={id:'global:global-a',name:'Published Hei',version:'2.2.1',sha256:'a'.repeat(64),script:'// published',enabled:true,priority:20,builtIn:false,importedAt:0,updatedAt:0}
    const globalRepository:LxGlobalSourceRepository={managesBundledSource:true,list:async()=>[published],revision:()=>2,pendingApproval:()=>[],invalidate:()=>{}}
    const wrapper=mountManager({repository,globalRepository})
    await settle()
    expect(wrapper.get('[data-lx-source-group=published]').text()).toContain('Published Hei')
    expect(wrapper.get('[data-lx-source-group=personal]').text()).toContain('Alpha Source')
    expect(rowIds(wrapper)).toEqual(['global:global-a',expect.any(String)])
    const row=wrapper.get('[data-lx-source="global:global-a"]')
    expect(row.text()).toContain('Admin-published')
    expect(row.find('[data-lx-source-delete]').exists()).toBe(false)
    expect((row.get('input[type=checkbox]').element as HTMLInputElement).disabled).toBe(true)
    expect(await repository.get(PINNED_FIXTURE_ID)).not.toBeNull()
  })

})


it('keeps the administrator disabled policy visible without exposing a stale local test or personal mutation', async () => {
  // The managed-policy protocol reserves this ID; its stored script is synthetic.
  const repository=await createRepository({ pinnedId: LX_BUILTIN_ID })
  const runner=vi.fn()
  const globalRepository:LxGlobalSourceRepository={
    managesBundledSource:true,list:async()=>[],revision:()=>4,pendingApproval:()=>[],invalidate:()=>{},
    managedSource:()=>({id:LX_BUILTIN_ID,name:'Owner disabled synthetic source',version:'1',sha256:'a'.repeat(64),priority:10,requiredOrigins:[],enabled:false,status:'disabled'}),
  }
  const wrapper=mountManager({repository,globalRepository,testRunner:runner})
  await settle()
  expect(rowIds(wrapper)).toEqual([`global:${LX_BUILTIN_ID}`])
  const row=wrapper.get('[data-lx-source]')
  expect(row.text()).toContain('Owner disabled synthetic source')
  expect((row.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
  expect((row.get('[data-lx-source-test]').element as HTMLButtonElement).disabled).toBe(true)
  await row.get('[data-lx-source-test]').trigger('click')
  expect(runner).not.toHaveBeenCalled()
  expect((await repository.list()).find(source=>source.id===LX_BUILTIN_ID)?.enabled).toBe(true)
})

it('hides a deleted managed source and never restores its local bundled copy', async () => {
  // The managed-policy protocol reserves this ID; its stored script is synthetic.
  const repository=await createRepository({ pinnedId: LX_BUILTIN_ID })
  const globalRepository:LxGlobalSourceRepository={
    managesBundledSource:true,list:async()=>[],revision:()=>5,pendingApproval:()=>[],invalidate:()=>{},
    managedSource:()=>({id:LX_BUILTIN_ID,name:'Deleted synthetic source',version:'1',sha256:'a'.repeat(64),priority:10,requiredOrigins:[],enabled:false,status:'disabled',deleted:true}),
  }
  const wrapper=mountManager({repository,globalRepository})
  await settle()
  expect(rowIds(wrapper)).toEqual([])
  expect(wrapper.text()).not.toContain('Deleted synthetic source')
  expect((await repository.list()).find(source=>source.id===LX_BUILTIN_ID)?.enabled).toBe(true)
})
