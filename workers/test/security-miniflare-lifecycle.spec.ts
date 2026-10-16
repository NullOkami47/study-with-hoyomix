import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

describe('ephemeral Miniflare fixture lifecycle', () => {
  let root: string
  const instances = new Set<Miniflare>()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'miniflare-lifecycle-spec-'))
    vi.stubEnv('HOYOMIX_TEST_TEMP_ROOT', root)
    vi.stubEnv('TMPDIR', root)
    vi.stubEnv('TEMP', root)
    vi.stubEnv('TMP', root)
  })

  afterEach(async () => {
    const results = await Promise.allSettled([...instances].map(instance => instance.dispose()))
    instances.clear()
    vi.unstubAllEnvs()
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    // Attempt every disposal and preserve diagnostics if runtime shutdown fails;
    // do not remove storage that another failed disposal may still be using.
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Fixture disposal failed')
    // Explicit caller persistence is retained, but native runtime scratch is
    // still cleaned asynchronously. Do not race its deletion with parent rm
    // (Windows can report EPERM for that concurrent directory removal).
    await vi.waitFor(() => expect(readdirSync(root).filter(name => name.startsWith('miniflare-'))).toEqual([]))
    await rm(root, { recursive: true, force: true })
  })

  const create = (overrides: { resourcePersistencePath?: string } = {}) => {
    const instance = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'lifecycle-fixture' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
      ...overrides,
    })
    instances.add(instance)
    return instance
  }

  const dispose = async (instance: Miniflare) => {
    await instance.dispose()
    instances.delete(instance)
  }

  const ownedStorage = () => readdirSync(root).filter(name => name.startsWith('hoyomix-miniflare-'))

  const sqliteFiles = (directory: string): string[] => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) {
      // Native scratch cleanup may remove a directory while it is inspected.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries.flatMap(entry => entry.isDirectory() ? sqliteFiles(join(directory, entry.name))
      : /\.(sqlite|sqlite3|db)(-(wal|shm|journal))?$/.test(entry.name) ? [join(directory, entry.name)] : [])
  }

  const assertDisposedStorage = async () => {
    // Our wrapper owns and awaits the SQLite resource directory. Assert that
    // immediately: polling it would hide the teardown bug this spec guards.
    expect(ownedStorage()).toEqual([])
    // Native scratch also contains Miniflare's internal email-store SQLite.
    // Only that exact direct-child namespace is asynchronous; fixture and
    // unexpected SQLite/WAL/SHM/journal files must already be gone.
    expect(sqliteFiles(root).filter(file =>
      !/^miniflare-[a-f0-9]{32}$/.test(relative(root, file).split(sep)[0]!))).toEqual([])
    // Miniflare 5 separately owns miniflare-<random> runtime scratch, and its
    // dispose() calls removeDir(..., { fireAndForget: true }). Await that native
    // scratch cleanup separately, without treating it as retained SQLite state.
    await vi.waitFor(() => expect(readdirSync(root)).toEqual([]))
    expect(sqliteFiles(root)).toEqual([])
  }

  it('awaits native email SQLite scratch cleanup separately from resource disposal', async () => {
    const scratch = join(root, `miniflare-${'a'.repeat(32)}`)
    const emailStore = join(scratch, 'email-store', 'miniflare-email-store')
    await mkdir(emailStore, { recursive: true })
    await Promise.all(['metadata.sqlite', 'metadata.sqlite-wal', 'metadata.sqlite-shm']
      .map(name => writeFile(join(emailStore, name), 'native scratch')))
    // Model the documented native fire-and-forget removal: it cannot finish
    // before the synchronous post-dispose resource assertions have run.
    const cleanup = new Promise<void>((resolve, reject) => {
      setImmediate(() => { void rm(scratch, { recursive: true }).then(() => resolve(), reject) })
    })
    try {
      await assertDisposedStorage()
    } finally {
      await cleanup
    }
  })

  it('removes ephemeral SQLite state before disposal resolves', async () => {
    const instance = create()
    const database = await instance.getD1Database('DB')
    await database.prepare('CREATE TABLE fixture (value TEXT)').run()
    await database.prepare("INSERT INTO fixture VALUES ('first')").run()

    await dispose(instance)

    // A pool can terminate immediately after the final hook. A later deletion
    // must not be required to finish cleaning this fixture's storage.
    await assertDisposedStorage()
  })

  it('isolates equal binding names and preserves a live fixture when its neighbour is disposed', async () => {
    const first = create()
    const second = create()
    const firstDatabase = await first.getD1Database('DB')
    const secondDatabase = await second.getD1Database('DB')
    for (const [database, value] of [[firstDatabase, 'first'], [secondDatabase, 'second']] as const) {
      await database.prepare('CREATE TABLE fixture (value TEXT)').run()
      await database.prepare('INSERT INTO fixture VALUES (?)').bind(value).run()
    }

    expect(await firstDatabase.prepare('SELECT value FROM fixture').first('value')).toBe('first')
    expect(ownedStorage()).toHaveLength(2)
    await dispose(first)
    expect(ownedStorage()).toHaveLength(1)
    expect(await secondDatabase.prepare('SELECT value FROM fixture').first('value')).toBe('second')
    await dispose(second)
    await assertDisposedStorage()
  })

  it('preserves explicitly requested caller persistence across disposal', async () => {
    const persistencePath = join(root, 'caller-persistence')
    const first = create({ resourcePersistencePath: persistencePath })
    const firstDatabase = await first.getD1Database('DB')
    await firstDatabase.prepare('CREATE TABLE fixture (value TEXT)').run()
    await firstDatabase.prepare("INSERT INTO fixture VALUES ('retained')").run()
    await dispose(first)

    const reopened = create({ resourcePersistencePath: persistencePath })
    const reopenedDatabase = await reopened.getD1Database('DB')
    expect(await reopenedDatabase.prepare('SELECT value FROM fixture').first('value')).toBe('retained')
    await dispose(reopened)
  })
})
