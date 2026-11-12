// Global (server-owned) LX source registry.
//
// The personal LX sources a user imports stay in their own IndexedDB and are never touched here.
// This module owns the registry the Owner publishes for everybody: the metadata rows, the
// immutable script snapshots, and the static analysis that decides whether a script may be
// published at all.
//
// Nothing in this file executes a script. Execution happens only in the user's browser, inside the
// QuickJS Web Worker sandbox. The server's job is to decide *what may be published*, to store it
// immutably, and to publish it in a form the client can cache safely.

import type { D1Database } from '../env'
import { tokenizer, type Token } from 'acorn'
import { configuredDefaultSource } from './defaultSource'
import { LX_BUILTIN_ID } from '../../src/features/player/lx/types'
import { fetchScriptBounded, validateOutboundScriptUrl } from './outbound'
import { isHeaderValue, scanScript } from './scriptScan'

/** The same bound the sandbox enforces on a script it is asked to load. */
export const LX_GLOBAL_MAX_SCRIPT_BYTES = 512 * 1024

/** The same bound the sandbox enforces on a response it reads. */
export const LX_GLOBAL_MAX_FETCH_BYTES = 512 * 1024

/** Longest origin URL accepted for a source. */
export const LX_GLOBAL_MAX_ORIGIN_URL_LENGTH = 2048

export type LxGlobalSourceStatus =
  | 'active'
  | 'disabled'
  | 'pending_network_approval'
  | 'failed'

export type LxGlobalOriginKind = 'url' | 'upload'

export interface LxGlobalSourceRow {
  id: string
  name: string
  version: string | null
  originUrl: string
  activeSha256: string
  enabled: boolean
  priority: number
  status: LxGlobalSourceStatus
  requiredOrigins: string[]
  pendingOrigins: string[]
  originKind: LxGlobalOriginKind
  createdAt: number
  updatedAt: number
  lastCheckedAt: number | null
  lastCheckNote: string | null
}

export interface LxGlobalSnapshot {
  sourceId: string
  sha256: string
  version: string | null
  createdAt: number
  note: string | null
}

/** What the static analysis found in a candidate script. */
export interface LxScriptAnalysis {
  /** Absolute HTTPS origins the script uses as request destinations, sorted. */
  httpsOrigins: string[]
  /** Absolute plaintext origins. These can never be reached from an HTTPS page. */
  plaintextOrigins: string[]
  /**
   * Origins that appear only as the value of a header-shaped key (`Referer`, `Origin`, …). They are
   * reported so the Admin console can show them, but they are not destinations and must not gate
   * publication: a script that sends `Referer: https://music.migu.cn/` does not connect to Migu.
   */
  headerOrigins: string[]
  /**
   * Names of credential-shaped assignments found in the script. The *values* are never recorded:
   * only the key names, so an analysis result can be logged and shown in the Admin console.
   */
  credentialKeys: string[]
  /** The `@name` / `@version` header fields, when present. */
  name: string | null
  version: string | null
  byteLength: number
  invalidSyntax?: boolean
}

export interface LxImportRejection {
  code:
    | 'too_large'
    | 'not_text'
    | 'embedded_credentials'
    | 'plaintext_origin'
    | 'invalid_origin_url'
    | 'blocked_host'
    | 'redirect_refused'
    | 'fetch_failed'
    | 'not_javascript'
  message: string
}

/** Absolute URL-ish tokens in a script. Deliberately conservative: it only needs the origin. */
const ABSOLUTE_URL = /https?:\/\/[^\s'"`()<>\\]+/giu

/**
 * Credential-shaped assignments. The value is matched but never captured into the result: only
 * the key name is kept, so an analysis can be stored and displayed without leaking the secret.
 */
const CREDENTIAL_KEY = /^(api[_-]?key|apikey|secret|sign[_-]?salt|signsalt|token|password|passwd|pwd|cookie|authorization|auth)$/iu

const HEADER_LITERAL = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/u

/** Unlike advisory URL discovery, credential publication must understand regexp and templates. */
function credentialFindings(script: string): { keys: string[]; invalidSyntax: boolean } {
  const keys = new Set<string>()
  // Acorn's runtime tokens carry decoded values; its Token declaration omits that property.
  type ValueToken = Token & { value?: unknown }
  const previous: ValueToken[] = []
  let invalidSyntax = false
  try {
    for (const rawToken of tokenizer(script, { ecmaVersion: 'latest' })) {
      const token = rawToken as ValueToken
      const label = token.type.label
      if ((label === 'string' || label === 'template') && typeof token.value === 'string') {
        if (HEADER_LITERAL.test(token.value)) keys.add('authorization_header')
        const offset = label === 'template' && previous.at(-1)?.type.label === '`' ? 1 : 0
        const operator = previous.at(-1 - offset)
        const key = previous.at(-2 - offset)
        if (token.value.length >= 8 && (operator?.type.label === '=' || operator?.type.label === ':')
          && (key?.type.label === 'name' || key?.type.label === 'string')
          && typeof key.value === 'string' && CREDENTIAL_KEY.test(key.value)) {
          keys.add(key.value.toLowerCase())
        }
      }
      previous.push(token)
      if (previous.length > 3) previous.shift()
    }
  } catch {
    // Do not include a parser error: it can quote an embedded private value.
    invalidSyntax = true
  }
  return { keys: [...keys].sort(), invalidSyntax }
}

/**
 * Parses the LX script header (`@name`, `@version`, `@description`), mirroring the client-side
 * parser so both sides agree on a source's name.
 */
export function parseLxScriptHeader(script: string): { name: string | null; version: string | null } {
  const lines = script.slice(0, 4096).split(/\r?\n/)
  let name: string | null = null
  let version: string | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!name) {
      const match = trimmed.match(/(?:^|\*|\/\/)\s*@name\s*[:\s]\s*([^*]+)/u)
      if (match) name = match[1].replace(/\*\/$/u, '').trim()
    }
    if (!version) {
      const match = trimmed.match(/(?:^|\*|\/\/)\s*@version\s*[:\s]\s*([^*]+)/u)
      if (match) version = match[1].replace(/\*\/$/u, '').trim()
    }
  }
  return { name: name || null, version: version || null }
}

/**
 * Static analysis of a candidate script.
 *
 * This is the gate that decides whether a script may be published. It is intentionally simple and
 * conservative: it does not try to prove the script is safe, only to refuse the two things that
 * are unacceptable by policy — an embedded credential and a plaintext origin — and to report the
 * HTTPS origins so the client's CSP can be checked against them.
 */
export function analyseLxScript(script: string): LxScriptAnalysis {
  const scan = scanScript(script)
  const httpsOrigins = new Set<string>()
  const plaintextOrigins = new Set<string>()
  const headerOrigins = new Set<string>()

  // Only string literals can hold a URL: a bare `https://` in code is a syntax error, and a URL in
  // a comment is documentation. `scanScript` is what makes that distinction.
  for (const literal of scan.literals) {
    if (!literal.value.includes('://')) continue
    // `literal.start` is the first character *inside* the quotes, so the window ends one character
    // earlier: the opening quote must not be part of the `key:` match.
    const isHeader = isHeaderValue(script.slice(Math.max(0, literal.start - 161), literal.start - 1))
    for (const match of literal.value.matchAll(ABSOLUTE_URL)) {
      let parsed: URL
      try {
        parsed = new URL(match[0])
      } catch {
        continue
      }
      if (parsed.protocol === 'https:') (isHeader ? headerOrigins : httpsOrigins).add(parsed.origin)
      else if (parsed.protocol === 'http:') (isHeader ? headerOrigins : plaintextOrigins).add(parsed.origin)
    }
  }

  // Comments are excluded: a comment that mentions `token: '…'` documents a format, it does not
  // embed a credential.
  const credentials = credentialFindings(script)

  const header = parseLxScriptHeader(script)
  return {
    httpsOrigins: [...httpsOrigins].sort(),
    plaintextOrigins: [...plaintextOrigins].sort(),
    headerOrigins: [...headerOrigins].sort(),
    credentialKeys: credentials.keys,
    ...(credentials.invalidSyntax ? { invalidSyntax: true } : {}),
    name: header.name,
    version: header.version,
    byteLength: new TextEncoder().encode(script).length,
  }
}

/**
 * The policy gate for a candidate script. Returns the rejection, or null when the script may be
 * stored. A rejection is a refusal with a reason, never a silent drop.
 */
export function screenLxScript(script: string, options: { allowPlaintextOrigins?: boolean; allowEmbeddedCredentials?: boolean } = {}): LxImportRejection | null {
  const analysis = analyseLxScript(script)

  if (analysis.byteLength > LX_GLOBAL_MAX_SCRIPT_BYTES) {
    return {
      code: 'too_large',
      message: `Script is ${analysis.byteLength} bytes, over the ${LX_GLOBAL_MAX_SCRIPT_BYTES} byte limit`,
    }
  }
  if (!script.trim()) {
    return { code: 'not_text', message: 'Script is empty' }
  }
  // A script that cannot even be parsed as text will not load in the sandbox either.
  if (script.includes('\u0000')) {
    return { code: 'not_javascript', message: 'Script contains NUL bytes and is not valid JavaScript text' }
  }
  if (analysis.invalidSyntax) return { code: 'not_javascript', message: 'Script contains invalid JavaScript tokens' }
  if (analysis.credentialKeys.length > 0 && !options.allowEmbeddedCredentials) {
    return {
      code: 'embedded_credentials',
      message: `Script embeds credential-shaped values (${analysis.credentialKeys.join(', ')})`,
    }
  }
  if (analysis.plaintextOrigins.length > 0 && !options.allowPlaintextOrigins) {
    return {
      code: 'plaintext_origin',
      message: `Script references plaintext origins (${analysis.plaintextOrigins.join(', ')}) that an HTTPS page can never reach`,
    }
  }
  return null
}

/**
 * Validates an origin URL a source is published from.
 *
 * Delegates to the outbound policy so the URL a source is stored under and the URL the Worker will
 * fetch are validated by the same rules: HTTPS, default port, no credentials, a `.js` path, and a
 * host that is actually on the public internet.
 */
export function validateOriginUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  const validated = validateOutboundScriptUrl(raw)
  if (!validated.ok) return { ok: false, reason: validated.rejection.message }
  return { ok: true, url: validated.url.toString() }
}

/** SHA-256 of a script, lower-case hex. */
export async function sha256Hex(script: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fetches a candidate script from its origin URL.
 *
 * All of the policy lives in `fetchScriptBounded`: HTTPS only, public host only, redirects refused,
 * a bounded body and a timeout. This function only adapts its result to the import rejection shape
 * the Admin API already returns.
 */
export async function fetchRemoteScript(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<{ ok: true; script: string; finalUrl: string } | { ok: false; rejection: LxImportRejection }> {
  const fetched = await fetchScriptBounded(url, { fetchImpl })
  if (!fetched.ok) {
    const code = fetched.rejection.code === 'insecure_url' || fetched.rejection.code === 'invalid_url'
      ? 'invalid_origin_url'
      : fetched.rejection.code
    return { ok: false, rejection: { code, message: fetched.rejection.message } }
  }
  return { ok: true, script: fetched.script, finalUrl: fetched.finalUrl }
}

export interface LxRegistrySnapshot {
  revision: number
  sources: LxGlobalSourceRow[]
}

const parseJsonArray = (value: unknown): string[] => {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

const toRow = (raw: Record<string, unknown>): LxGlobalSourceRow => ({
  id: String(raw.id),
  name: String(raw.name),
  version: raw.version === null || raw.version === undefined ? null : String(raw.version),
  originUrl: String(raw.originUrl),
  activeSha256: String(raw.activeSha256),
  enabled: raw.enabled === 1 || raw.enabled === true,
  priority: Number(raw.priority ?? 100),
  status: String(raw.status) as LxGlobalSourceStatus,
  requiredOrigins: parseJsonArray(raw.requiredOrigins),
  pendingOrigins: parseJsonArray(raw.pendingOrigins),
  originKind: String(raw.originKind) as LxGlobalOriginKind,
  createdAt: Number(raw.createdAt ?? 0),
  updatedAt: Number(raw.updatedAt ?? 0),
  lastCheckedAt: raw.lastCheckedAt === null || raw.lastCheckedAt === undefined ? null : Number(raw.lastCheckedAt),
  lastCheckNote: raw.lastCheckNote === null || raw.lastCheckNote === undefined ? null : String(raw.lastCheckNote),
})

const SOURCE_COLUMNS = `id, name, version, origin_url AS originUrl, active_sha256 AS activeSha256,
  enabled, priority, status, required_origins AS requiredOrigins, pending_origins AS pendingOrigins,
  origin_kind AS originKind, created_at AS createdAt, updated_at AS updatedAt,
  last_checked_at AS lastCheckedAt, last_check_note AS lastCheckNote`

export async function readRegistryRevision(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT revision FROM lx_global_registry WHERE id = 1').first<{ revision: number }>()
  return row?.revision ?? 1
}

export async function readGlobalSources(db: D1Database): Promise<LxGlobalSourceRow[]> {
  const result = await db
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM lx_global_sources ORDER BY priority ASC, id ASC`)
    .all<Record<string, unknown>>()
  return (result.results ?? []).map(toRow)
}

export async function readGlobalSource(db: D1Database, id: string): Promise<LxGlobalSourceRow | null> {
  const row = await db.prepare(`SELECT ${SOURCE_COLUMNS} FROM lx_global_sources WHERE id = ?`).bind(id).first<Record<string, unknown>>()
  return row ? toRow(row) : null
}

export async function readGlobalSnapshots(db: D1Database, sourceId: string): Promise<LxGlobalSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT source_id AS sourceId, sha256, version, created_at AS createdAt, note
       FROM lx_global_source_snapshots WHERE source_id = ? ORDER BY created_at DESC`,
    )
    .bind(sourceId)
    .all<Record<string, unknown>>()
  return (result.results ?? []).map((raw) => ({
    sourceId: String(raw.sourceId),
    sha256: String(raw.sha256),
    version: raw.version === null || raw.version === undefined ? null : String(raw.version),
    createdAt: Number(raw.createdAt ?? 0),
    note: raw.note === null || raw.note === undefined ? null : String(raw.note),
  }))
}

/**
 * Bumps the registry revision. Every mutation calls this, so a client that caches the published
 * list by revision can never miss a change.
 */
export async function bumpRegistryRevision(db: D1Database, now: number): Promise<number> {
  await db
    .prepare('UPDATE lx_global_registry SET revision = revision + 1, updated_at = ? WHERE id = 1')
    .bind(now)
    .run()
  return readRegistryRevision(db)
}

/**
 * The statement that stores a snapshot. Append-only: the same digest is never written twice with
 * different bytes, because the digest *is* the content.
 *
 * Returned rather than executed so a caller can put it in the same `batch` as the row that owns it.
 * The snapshot references the source, so the source row has to be written in the same atomic batch —
 * otherwise D1's foreign-key check rejects the snapshot.
 */
export function snapshotStatement(
  db: D1Database,
  input: { sourceId: string; sha256: string; script: string; version: string | null; now: number; note: string | null },
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO lx_global_source_snapshots (source_id, sha256, script, version, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.sourceId, input.sha256, input.script, input.version, input.now, input.note)
}

/** Stores a snapshot on its own. Only valid when the source row already exists. */
export async function writeGlobalSnapshot(
  db: D1Database,
  input: { sourceId: string; sha256: string; script: string; version: string | null; now: number; note: string | null },
): Promise<void> {
  await snapshotStatement(db, input).run()
}

/** The statement that bumps the registry revision. Batched with the mutation it describes. */
export function bumpRevisionStatement(db: D1Database, now: number) {
  return db.prepare('UPDATE lx_global_registry SET revision = revision + 1, updated_at = ? WHERE id = 1').bind(now)
}

export async function readSnapshotScript(
  db: D1Database,
  sourceId: string,
  sha256: string,
): Promise<{ script: string; version: string | null } | null> {
  const row = await db
    .prepare('SELECT script, version FROM lx_global_source_snapshots WHERE source_id = ? AND sha256 = ?')
    .bind(sourceId, sha256)
    .first<{ script: string; version: string | null }>()
  return row ? { script: row.script, version: row.version ?? null } : null
}

/** Release-provided policy; GETs expose it without creating a database row. */
export const MANAGED_LX_SOURCE_ID = LX_BUILTIN_ID
/** A durable tombstone, independent of audit retention and immutable script snapshots. */
export const MANAGED_LX_DELETION_SETTING = 'lx.source.deleted.builtin-kulao-svip'

async function managedSourceDeleted(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT setting_json AS policy FROM admin_settings WHERE setting_key = ?')
    .bind(MANAGED_LX_DELETION_SETTING).first<{ policy: string }>()
  return row !== null
}

export function defaultManagedLxSource(): LxGlobalSourceRow | null {
  const source = configuredDefaultSource()
  if (!source) return null
  const analysis = analyseLxScript(source.script)
  return {
    id: source.id,
    name: source.name,
    version: source.version ?? null,
    originUrl: source.originUrl!,
    activeSha256: source.sha256,
    enabled: true,
    priority: source.priority,
    status: 'active',
    requiredOrigins: analysis.httpsOrigins,
    pendingOrigins: [],
    originKind: 'url',
    createdAt: 0,
    updatedAt: 0,
    lastCheckedAt: null,
    lastCheckNote: null,
  }
}

export async function readManagedLxSources(db: D1Database): Promise<LxGlobalSourceRow[]> {
  const rows = await readGlobalSources(db)
  if (await managedSourceDeleted(db)) return rows.filter((row) => row.id !== MANAGED_LX_SOURCE_ID)
  const configured = defaultManagedLxSource()
  if (configured && !rows.some((row) => row.id === MANAGED_LX_SOURCE_ID)) rows.push(configured)
  return rows.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

export async function readManagedLxSource(db: D1Database, id: string): Promise<LxGlobalSourceRow | null> {
  if (id === MANAGED_LX_SOURCE_ID && await managedSourceDeleted(db)) return null
  return await readGlobalSource(db, id) ?? (id === MANAGED_LX_SOURCE_ID ? defaultManagedLxSource() : null)
}

export async function readManagedSnapshotScript(
  db: D1Database, id: string, sha: string,
): Promise<{ script: string; version: string | null } | null> {
  const source = configuredDefaultSource()
  return await readSnapshotScript(db, id, sha)
    ?? (source && id === MANAGED_LX_SOURCE_ID && sha === source.sha256
      ? { script: source.script, version: source.version ?? null } : null)
}

export async function readManagedSnapshots(db: D1Database, id: string): Promise<LxGlobalSnapshot[]> {
  const snapshots = await readGlobalSnapshots(db, id)
  const source = configuredDefaultSource()
  if (source && id === MANAGED_LX_SOURCE_ID && !snapshots.some((snapshot) => snapshot.sha256 === source.sha256)) {
    snapshots.unshift({
      sourceId: id, sha256: source.sha256, version: source.version ?? null,
      createdAt: 0, note: 'Release-provided default',
    })
  }
  return snapshots
}

/** Only explicit Owner mutations execute these statements, in their publication/audit batch. */
export function materializeManagedLxSource(db: D1Database, id: string, stamp: number) {
  if (id !== MANAGED_LX_SOURCE_ID) return []
  const source = configuredDefaultSource()
  const row = defaultManagedLxSource()
  if (!source || !row) return []
  return [
    db.prepare(
      `INSERT OR IGNORE INTO lx_global_sources
       (id, name, version, origin_url, active_sha256, enabled, priority, status,
        required_origins, pending_origins, origin_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, '[]', 'url', ?, ?)`,
    ).bind(
      row.id, row.name, row.version, row.originUrl, row.activeSha256, row.priority,
      row.status, JSON.stringify(row.requiredOrigins), stamp, stamp,
    ),
    snapshotStatement(db, {
      sourceId: id, sha256: row.activeSha256, script: source.script,
      version: row.version, now: stamp, note: 'Release-provided default preserved on first Owner edit',
    }),
  ]
}
