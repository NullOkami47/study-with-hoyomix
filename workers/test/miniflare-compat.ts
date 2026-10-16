import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare as MiniflareV5,
  type V4MiniflareOptions,
} from 'miniflare'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export { Log, LogLevel }

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
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose()
    } finally {
      if (this.fixtureStoragePath !== undefined) {
        await rm(this.fixtureStoragePath, { recursive: true, force: true })
      }
    }
  }
}
