import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare as MiniflareV5,
  type V4MiniflareOptions,
} from 'miniflare'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { setImmediate as yieldMacrotask } from 'node:timers/promises'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import type { Socket } from 'node:net'
import { isAbsolute, join, relative, resolve } from 'node:path'

export { Log, LogLevel }

function tolerateRejectedHandshakeReset(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ECONNRESET') throw error
}

/**
 * Miniflare 5.x removed the per-plugin `*Persist` options outright: `d1Persist`
 * does not appear anywhere in the published 5.x package, and
 * `convertV4MiniflareOptions()` silently drops it.
 *
 * Dropping it is safe only because 5.x stores resources in an ephemeral
 * per-instance temporary directory unless `resourcePersistencePath` is configured
 * — i.e. exactly what `d1Persist: false` used to select. The field is declared so
 * the specs keep their v4 option shape, and any value other than `false` is
 * rejected loudly rather than silently changing semantics.
 */
type LegacyMiniflareOptions = V4MiniflareOptions & { d1Persist?: string | boolean }

/**
 * Compatibility wrapper for the Miniflare 4.x -> 5.x upgrade.
 *
 * Miniflare 5.x turned the option shape into a strict union that requires
 * `workers: [...]`, so the flat v4 object every Worker spec passes would now be
 * rejected during option validation. Upstream exports
 * `convertV4MiniflareOptions()` for exactly this migration, but never applies it
 * internally.
 *
 * The specs keep their v4 option shape. Conversion and the lifecycle of default
 * ephemeral storage live here so fixtures do not duplicate compatibility or
 * cleanup logic. Explicit persistence continues to be owned by its caller.
 */
export class Miniflare extends MiniflareV5 {
  private readonly fixtureStoragePath: string | undefined

  constructor(options: LegacyMiniflareOptions) {
    const { d1Persist } = options
    if (d1Persist !== undefined && d1Persist !== false) {
      throw new Error(
        `miniflare-compat: d1Persist was removed in Miniflare 5.x and cannot be emulated for ${JSON.stringify(d1Persist)}. Configure resourcePersistencePath or isolatedResourcePersistencePath instead.`,
      )
    }
    // Native dispose() schedules deletion of its default scratch directory
    // without awaiting it. Vitest may terminate the pool before that deletion
    // finishes. Own the default ephemeral storage so fixture teardown waits for
    // its SQLite files too; explicit caller persistence paths remain untouched.
    const converted = convertV4MiniflareOptions(options)
    const fixtureRoot = resolve(process.env.HOYOMIX_TEST_TEMP_ROOT || join(process.cwd(), '.wrangler/test-temp'))
    mkdirSync(fixtureRoot, { recursive: true })
    const fixtureStoragePath = options.resourcePersistencePath === undefined
      && options.isolatedResourcePersistencePath === undefined
      && options.resourceTmpPath === undefined
      ? mkdtempSync(join(fixtureRoot, 'hoyomix-miniflare-'))
      : undefined
    if (fixtureStoragePath !== undefined) {
      const owned = relative(fixtureRoot, fixtureStoragePath)
      if (isAbsolute(owned) || owned.startsWith('..') || !owned.startsWith('hoyomix-miniflare-')) throw new Error('invalid_fixture_storage_path')
    }
    try {
      super(fixtureStoragePath === undefined ? converted : {
        ...converted,
        resourcePersistencePath: fixtureStoragePath,
        resourceTmpPath: fixtureStoragePath,
      })
    } catch (error) {
      if (fixtureStoragePath !== undefined) rmSync(fixtureStoragePath, { recursive: true, force: true })
      throw error
    }
    this.fixtureStoragePath = fixtureStoragePath
    // workerd closes keep-alive sockets after 5 s idle, and Miniflare's pooled
    // Node client only notices once the event loop turns. Synchronous proxy calls
    // (each `prepare()`/`bind()` blocks the thread with Atomics.wait) can keep
    // the loop busy past that window, so the next async proxy call would reuse a
    // socket workerd already closed and fail with ECONNRESET. Yield one macrotask
    // first so undici drops closed sockets. This is not a retry: nothing is
    // replayed. The proxy client captures this property during async start-up,
    // after the constructor returns, so it uses this wrapper too. The promise
    // form of setImmediate is used because Vitest fake timers replace the global.
    const dispatchFetch = this.dispatchFetch
    this.dispatchFetch = async (input, init) => {
      await yieldMacrotask()
      const upgrade = new Headers((init?.headers ?? (input instanceof Request ? input.headers : undefined)) as HeadersInit | undefined).get('upgrade')
      if (upgrade !== 'websocket') return dispatchFetch(input, init)
      // Miniflare sends WebSocket requests through `ws`. When the Worker rejects the handshake
      // (any non-101 reply, e.g. 401 visitor_invalid or 429 connection_limit), Miniflare resolves
      // the response from `unexpected-response` but never aborts the request, so the handshake
      // socket has no error listener once the body is read; workerd's later reset of that socket
      // then surfaces as an uncaught ECONNRESET. Only those rejected-handshake sockets get a
      // listener, and it tolerates only that reset; every other error is rethrown.
      const sockets: Socket[] = []
      const capture = (message: unknown) => { sockets.push((message as { socket: Socket }).socket) }
      subscribe('net.client.socket', capture)
      try {
        const response = await dispatchFetch(input, init)
        if (response.status !== 101) for (const socket of sockets) socket.on('error', tolerateRejectedHandshakeReset)
        return response
      } finally {
        unsubscribe('net.client.socket', capture)
      }
    }
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose()
    } finally {
      if (this.fixtureStoragePath !== undefined) {
        await removeFixtureStorage(this.fixtureStoragePath)
      }
    }
  }
}

/**
 * True when a refusal came from a host's bulk-delete guard rather than from the filesystem.
 *
 * Some environments wrap `fs.rm` with a policy that refuses to delete more than N entries at once
 * and answers with a distinctive code. A Miniflare scratch directory is ~70 files, so a single
 * recursive removal trips it. That refusal says nothing about the test that just ran.
 */
function isBulkDeleteRefusal(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message.includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')
}

let warnedAboutFixtureStorage = false

/**
 * Removes the fixture directory, and never lets the removal decide whether a test passed.
 *
 * The distinction matters: `dispose()` runs in `afterAll`, so anything it throws is reported against
 * every test in the file. When a host's delete guard refused the bulk removal, that turned 232
 * passing assertions into 232 failures in this suite — the tests were green, the cleanup was not.
 *
 * A refusal is therefore downgraded to a one-time warning. Any other error still propagates, because
 * a genuine filesystem fault should not be hidden.
 */
async function removeFixtureStorage(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    if (!isBulkDeleteRefusal(error)) throw error
    if (!warnedAboutFixtureStorage) {
      warnedAboutFixtureStorage = true
      console.warn(
        '[miniflare-compat] the host refused a bulk delete of a Miniflare scratch directory; ' +
          `leaving ${path} behind. This is a cleanup warning, not a test failure.`,
      )
    }
  }
}
