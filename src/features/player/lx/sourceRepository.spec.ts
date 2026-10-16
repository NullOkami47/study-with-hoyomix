import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseLxScriptHeader } from './header'
import {
  computeSha256,
  createLxSourceRepository,
} from './sourceRepository'
import {
  LX_MAX_REMOTE_RESPONSE_BYTES,
  LX_MAX_SCRIPT_BYTES,
} from './types'

describe('parseLxScriptHeader', () => {
  it('extracts @name, @version, and @description from standard JSDoc header', () => {
    const script = `/**
 * @name Synthetic Source
 * @description Synthetic test source
 * @version 1.0.0
 */
console.log("hello");`

    const meta = parseLxScriptHeader(script)
    expect(meta.name).toBe('Synthetic Source')
    expect(meta.description).toBe('Synthetic test source')
    expect(meta.version).toBe('1.0.0')
  })

  it('extracts metadata from single line comments', () => {
    const script = `// @name My Custom Source
// @version 1.2.3
// @description A great source
const lx = 1;`

    const meta = parseLxScriptHeader(script)
    expect(meta.name).toBe('My Custom Source')
    expect(meta.version).toBe('1.2.3')
    expect(meta.description).toBe('A great source')
  })

  it('handles empty or missing metadata gracefully', () => {
    const meta = parseLxScriptHeader('const a = 123;')
    expect(meta.name).toBeUndefined()
    expect(meta.version).toBeUndefined()
    expect(meta.description).toBeUndefined()
  })
})

describe('LxSourceRepository', () => {
  let idbFactory: IDBFactory
  let mockNow: () => number
  let currentTime: number

  beforeEach(() => {
    idbFactory = new IDBFactory()
    currentTime = 1726588800000
    mockNow = () => currentTime
  })

  function createRepo(overrides?: {
    indexedDB?: IDBFactory
    fetch?: typeof fetch
    databaseName?: string
  }) {
    return createLxSourceRepository({
      indexedDB: overrides?.indexedDB ?? idbFactory,
      databaseName: overrides?.databaseName ?? 'test-lx-sources',
      fetch: overrides?.fetch,
      now: mockNow,
    })
  }

  describe('initialisation without bundled sources', () => {
    it('starts empty and performs no source download', async () => {
      const fetcher = vi.fn()
      const repo = createRepo({ fetch: fetcher })
      expect(await repo.list()).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('preserves user imports and enabled state across reloads', async () => {
      const first = createRepo({ databaseName: 'persistent-test-db' })
      const imported = await first.importScript('// @name Synthetic Source')
      await first.setEnabled(imported.id, false)
      const second = createRepo({ databaseName: 'persistent-test-db' })
      expect(await second.list()).toEqual([expect.objectContaining({ id: imported.id, enabled: false })])
    })

    it('starts empty in memory mode and retains imports', async () => {
      const repo = createLxSourceRepository({ indexedDB: undefined, now: mockNow })
      expect(await repo.list()).toEqual([])
      const imported = await repo.importScript('// @name Memory Source')
      await repo.setEnabled(imported.id, false)
      expect(await repo.get(imported.id)).toMatchObject({ enabled: false })
    })
  })

  describe('get and list', () => {
    it('returns a specific source by id', async () => {
      const repo = createRepo()
      const imported = await repo.importScript('// @name Synthetic Source')
      const source = await repo.get(imported.id)
      expect(source).not.toBeNull()
      expect(source?.id).toBe(imported.id)

      const nonExistent = await repo.get('does-not-exist')
      expect(nonExistent).toBeNull()
    })

    it('returns sources ordered by priority ascending', async () => {
      const repo = createRepo()
      const s1 = await repo.importScript('// @name Source A\nconsole.log(1);')
      const s2 = await repo.importScript('// @name Source B\nconsole.log(2);')

      const list = await repo.list()
      expect(list.map((s) => s.id)).toEqual([s1.id, s2.id])
      expect(list.map((s) => s.priority)).toEqual([20, 30])
    })
  })

  describe('setEnabled', () => {
    it('updates enabled status and updatedAt timestamp', async () => {
      const repo = createRepo()
      const imported = await repo.importScript('// @name Synthetic Source')
      currentTime = 1726589000000

      await repo.setEnabled(imported.id, false)
      const source = await repo.get(imported.id)
      expect(source?.enabled).toBe(false)
      expect(source?.updatedAt).toBe(1726589000000)

      await repo.setEnabled(imported.id, true)
      const updated = await repo.get(imported.id)
      expect(updated?.enabled).toBe(true)
    })

    it('throws error when setting enabled on non-existent source', async () => {
      const repo = createRepo()
      await expect(repo.setEnabled('missing-id', true)).rejects.toThrow(/not found/i)
    })
  })

  describe('importScript', () => {
    it('imports script, extracts header meta, computes sha256, and assigns priority > 10', async () => {
      const repo = createRepo()
      currentTime = 1726589100000

      const scriptContent = `/**
 * @name Test Music Source
 * @version 2.0.0
 */
const x = 42;`

      const record = await repo.importScript(scriptContent)
      expect(record.id).toMatch(/^custom-/)
      expect(record.name).toBe('Test Music Source')
      expect(record.version).toBe('2.0.0')
      expect(record.builtIn).toBe(false)
      expect(record.enabled).toBe(true)
      expect(record.priority).toBe(20)
      expect(record.importedAt).toBe(1726589100000)
      expect(record.updatedAt).toBe(1726589100000)
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(record.script).toBe(scriptContent)
    })

    it('allows overriding meta via options', async () => {
      const repo = createRepo()
      const record = await repo.importScript('const code = 1;', {
        name: 'Manual Name',
        version: '3.1.4',
        originUrl: 'https://example.com/script.js',
      })

      expect(record.name).toBe('Manual Name')
      expect(record.version).toBe('3.1.4')
      expect(record.originUrl).toBe('https://example.com/script.js')
    })

    it('rejects script exceeding LX_MAX_SCRIPT_BYTES', async () => {
      const repo = createRepo()
      const largeScript = 'a'.repeat(LX_MAX_SCRIPT_BYTES + 1)

      await expect(repo.importScript(largeScript)).rejects.toThrow(/exceeds maximum allowed size/i)
    })

    it('does NOT execute script during import', async () => {
      const repo = createRepo()
      // If executed in Node/Browser realm, this would throw or set a global variable
      const maliciousScript = 'throw new Error("I should not execute!");'
      await expect(repo.importScript(maliciousScript)).resolves.toBeDefined()
    })
  })

  describe('reorder', () => {
    it('reorders imported sources', async () => {
      const repo = createRepo()
      const s1 = await repo.importScript('// @name Custom 1')
      const s2 = await repo.importScript('// @name Custom 2')
      const s3 = await repo.importScript('// @name Custom 3')

      // Reorder custom sources: s3, s1, s2
      await repo.reorder([s3.id, s1.id, s2.id])

      const list = await repo.list()
      expect(list.map((s) => s.id)).toEqual([s3.id, s1.id, s2.id])
      expect(list.map((s) => s.priority)).toEqual([20, 30, 40])
    })


    it('rejects reorder if customSourceIds includes unknown IDs or duplicates', async () => {
      const repo = createRepo()
      const s1 = await repo.importScript('// @name Custom 1')

      await expect(repo.reorder(['unknown-id'])).rejects.toThrow(/unknown/i)
      await expect(repo.reorder([s1.id, s1.id])).rejects.toThrow(/duplicate/i)
    })
  })

  describe('delete', () => {
    it('deletes custom source and re-normalizes priorities', async () => {
      const repo = createRepo()
      const s1 = await repo.importScript('// @name Custom 1')
      const s2 = await repo.importScript('// @name Custom 2')

      await repo.delete(s1.id)

      const list = await repo.list()
      expect(list.map((s) => s.id)).toEqual([s2.id])
      expect(list.map((s) => s.priority)).toEqual([20])
      expect(await repo.get(s1.id)).toBeNull()
    })

    it('does not create records when deleting an unknown source', async () => {
      const repo = createRepo()
      await repo.delete('missing')
      expect(await repo.list()).toEqual([])
    })
  })

  describe('importRemote', () => {
    it('rejects non-HTTPS URLs', async () => {
      const repo = createRepo()
      await expect(repo.importRemote('http://example.com/script.js')).rejects.toThrow(
        /only https urls are allowed/i,
      )
      await expect(repo.importRemote('ftp://example.com/script.js')).rejects.toThrow(
        /only https urls are allowed/i,
      )
    })

    it('fetches remote script with credentials omit, redirect error, cache no-store', async () => {
      const remoteScript = `/**
 * @name Remote Source
 * @version 1.0.1
 */
console.log("remote");`

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(remoteScript, {
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        }),
      )

      const repo = createRepo({ fetch: mockFetch as unknown as typeof fetch })
      const record = await repo.importRemote('https://sources.example.com/my-source.js')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://sources.example.com/my-source.js',
        expect.objectContaining({
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        }),
      )

      expect(record.name).toBe('Remote Source')
      expect(record.version).toBe('1.0.1')
      expect(record.originUrl).toBe('https://sources.example.com/my-source.js')
      expect(record.script).toBe(remoteScript)
    })

    it('rejects on HTTP error status', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Not Found', {
          status: 404,
          statusText: 'Not Found',
        }),
      )

      const repo = createRepo({ fetch: mockFetch as unknown as typeof fetch })
      await expect(
        repo.importRemote('https://sources.example.com/not-found.js'),
      ).rejects.toThrow(/404/i)
    })

    it('rejects when remote response is text/html', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><html><body>Error</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      )

      const repo = createRepo({ fetch: mockFetch as unknown as typeof fetch })
      await expect(
        repo.importRemote('https://sources.example.com/source.html'),
      ).rejects.toThrow(/HTML/i)
    })

    it('rejects if response body exceeds LX_MAX_REMOTE_RESPONSE_BYTES', async () => {
      const largeContent = 'x'.repeat(LX_MAX_REMOTE_RESPONSE_BYTES + 10)
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(largeContent, {
          status: 200,
          headers: {
            'content-length': String(largeContent.length),
          },
        }),
      )

      const repo = createRepo({ fetch: mockFetch as unknown as typeof fetch })
      await expect(
        repo.importRemote('https://sources.example.com/too-large.js'),
      ).rejects.toThrow(/exceeds maximum allowed size/i)
    })
  })

  describe('refreshRemote', () => {
    it('refreshes remote source script and updates sha256 and updatedAt', async () => {
      const initialScript = `/**
 * @name Remote Source
 * @version 1.0.0
 */
const v = 1;`

      const updatedScript = `/**
 * @name Remote Source
 * @version 1.1.0
 */
const v = 2;`

      let currentFetchScript = initialScript
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(currentFetchScript, {
            status: 200,
          }),
        ),
      )

      const repo = createRepo({ fetch: mockFetch as unknown as typeof fetch })
      const record = await repo.importRemote('https://sources.example.com/source.js')
      const initialSha = record.sha256

      currentTime = 1726590000000
      currentFetchScript = updatedScript

      const refreshed = await repo.refreshRemote(record.id)
      expect(refreshed.id).toBe(record.id)
      expect(refreshed.version).toBe('1.1.0')
      expect(refreshed.script).toBe(updatedScript)
      expect(refreshed.sha256).not.toBe(initialSha)
      expect(refreshed.updatedAt).toBe(1726590000000)
    })

    it('rejects refresh if source has no originUrl', async () => {
      const repo = createRepo()
      const localSource = await repo.importScript('const local = true;')

      await expect(repo.refreshRemote(localSource.id)).rejects.toThrow(/no origin url/i)
    })

    it('rejects refresh for non-existent source', async () => {
      const repo = createRepo()
      await expect(repo.refreshRemote('missing')).rejects.toThrow(/not found/i)
    })
  })
})
