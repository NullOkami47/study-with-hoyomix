import { readBoundedJsonResponse } from '../providers/boundedJson'
export interface GoogleSheetsEnv {
  CATALOGUE_SHEET_ID?: string
  GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?: string
  GOOGLE_SHEETS_PRIVATE_KEY?: string
}
export const SHEET_RANGES = {
  Tracks: "'Tracks'!A1:P15002",
  Sources: "'Sources'!A1:K30002",
  Aliases: "'Aliases'!A1:D30002",
  Instructions: "'Instructions'!A1:B202",
} as const
export type SheetTab = keyof typeof SHEET_RANGES
export type Workbook = Record<SheetTab, string[][]>
export const SHEET_LIMITS: Record<SheetTab, { rows: number; columns: number }> =
  {
    Tracks: { rows: 15001, columns: 15 },
    Sources: { rows: 30001, columns: 10 },
    Aliases: { rows: 30001, columns: 3 },
    Instructions: { rows: 201, columns: 1 },
  }
/**
 * Automation round-trip tabs, deliberately outside the staging workbook contract so
 * `parseStaging`, `exportWorkbook`, `diffStaging` and the staging fingerprint keep their
 * existing meaning. `Discoveries` is written by the Worker and read by an external agent;
 * `Suggestions` is written by that agent and read back. Neither tab can carry a provider
 * source ID into the catalogue: `SUGGESTION_HEADERS` has no such column and the header is
 * compared exactly, so an added column fails closed.
 */
// Read one column and one row beyond each contract to detect overflow instead of
// silently truncating an agent-authored column or a full tab at the API boundary.
export const AUTOMATION_RANGES = {
  Discoveries: "'Discoveries'!A1:Q5002",
  Suggestions: "'Suggestions'!A1:P5002",
} as const
export type AutomationTab = keyof typeof AUTOMATION_RANGES
export type AutomationBook = Record<AutomationTab, string[][]>
export const AUTOMATION_LIMITS: Record<
  AutomationTab,
  { rows: number; columns: number }
> = {
  Discoveries: { rows: 5001, columns: 16 },
  Suggestions: { rows: 5001, columns: 15 },
}
const automationTabs = Object.keys(AUTOMATION_RANGES) as AutomationTab[]
export async function workbookFingerprint(book: Workbook): Promise<string> {
  const serial = JSON.stringify(
    Object.fromEntries(
      (['Tracks', 'Sources', 'Aliases', 'Instructions'] as const).map((k) => [
        k,
        book[k],
      ]),
    ),
  )
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serial)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('')
}
class SheetsHttpError extends Error {
  constructor(readonly status: number) {
    super('sheets_http_error')
  }
}
const tabs = Object.keys(SHEET_RANGES) as SheetTab[]
const encoder = new TextEncoder()
const tokens = new Map<string, Promise<{ value: string; expires: number }>>()
const base64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
const encode = (value: unknown) =>
  base64url(encoder.encode(JSON.stringify(value)))
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
export function sheetsConfigured(env: GoogleSheetsEnv): boolean {
  return (
    !!env.CATALOGUE_SHEET_ID &&
    /^[A-Za-z0-9_-]{5,150}$/.test(env.CATALOGUE_SHEET_ID) &&
    !!env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL &&
    /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(
      env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL,
    ) &&
    !!env.GOOGLE_SHEETS_PRIVATE_KEY?.includes('BEGIN PRIVATE KEY')
  )
}
export function createGoogleSheetsClient(
  env: GoogleSheetsEnv,
  options: { fetch?: typeof fetch; now?: () => number; crypto?: Crypto } = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch,
    now = options.now ?? Date.now,
    cryptoApi = options.crypto ?? globalThis.crypto
  async function request(
    url: string,
    init: RequestInit,
    maximum: number,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new SheetsHttpError(response.status)
      }
      const result = await readBoundedJsonResponse(response, maximum)
      if (!result.ok || !record(result.value)) throw new Error()
      return result.value
    } finally {
      clearTimeout(timer)
    }
  }
  async function accessToken(): Promise<string> {
    if (!sheetsConfigured(env)) throw new Error()
    const keyHash = base64url(
      new Uint8Array(
        await cryptoApi.subtle.digest(
          'SHA-256',
          encoder.encode(
            env.CATALOGUE_SHEET_ID +
              '\n' +
              env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL +
              '\n' +
              env.GOOGLE_SHEETS_PRIVATE_KEY,
          ),
        ),
      ),
    )
    const cached = tokens.get(keyHash)
    if (cached) {
      const token = await cached
      if (token.expires > now() + 60000) return token.value
      tokens.delete(keyHash)
    }
    const pending = (async () => {
      const pem = env
        .GOOGLE_SHEETS_PRIVATE_KEY!.replace(/\\n/g, '\n')
        .replace(
          /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
          '',
        )
      if (pem.length > 16000) throw new Error()
      const key = await cryptoApi.subtle.importKey(
        'pkcs8',
        Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const issued = Math.floor(now() / 1000)
      const unsigned =
        encode({ alg: 'RS256', typ: 'JWT' }) +
        '.' +
        encode({
          iss: env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          aud: 'https://oauth2.googleapis.com/token',
          iat: issued,
          exp: issued + 3600,
        })
      const signature = await cryptoApi.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        encoder.encode(unsigned),
      )
      const token = await request(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: unsigned + '.' + base64url(new Uint8Array(signature)),
          }).toString(),
        },
        16384,
      )
      if (
        typeof token.access_token !== 'string' ||
        token.access_token.length > 8192 ||
        !token.access_token ||
        typeof token.expires_in !== 'number' ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 60
      )
        throw new Error()
      return {
        value: token.access_token,
        expires: now() + Math.min(token.expires_in, 3600) * 1000,
      }
    })()
    if (tokens.size >= 8) tokens.delete(tokens.keys().next().value!)
    tokens.set(keyHash, pending)
    try {
      return (await pending).value
    } catch {
      tokens.delete(keyHash)
      throw new Error()
    }
  }
  async function call(suffix: string, init: RequestInit) {
    const token = await accessToken()
    return request(
      'https://sheets.googleapis.com/v4/spreadsheets/' +
        encodeURIComponent(env.CATALOGUE_SHEET_ID!) +
        suffix,
      {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
        },
      },
      10 * 1024 * 1024,
    )
  }
  return {
    async read(): Promise<Workbook> {
      try {
        const query = new URLSearchParams({
          majorDimension: 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        })
        for (const range of Object.values(SHEET_RANGES))
          query.append('ranges', range)
        const body = await call('/values:batchGet?' + query, { method: 'GET' })
        if (!Array.isArray(body.valueRanges) || body.valueRanges.length !== 4)
          throw new Error()
        const ranges = body.valueRanges
        const workbook = {} as Workbook
        tabs.forEach((tab, index) => {
          const item = ranges[index] as Record<string, unknown>
          if (
            !record(item) ||
            typeof item.range !== 'string' ||
            item.range.split('!')[0].replace(/'/g, '') !== tab
          )
            throw new Error()
          const values = item.values ?? []
          const limit = SHEET_LIMITS[tab]
          if (!Array.isArray(values) || values.length > limit.rows)
            throw new Error()
          workbook[tab] = values.map((row) => {
            if (
              !Array.isArray(row) ||
              row.length > limit.columns ||
              row.some((cell) => typeof cell !== 'string' || cell.length > 4000)
            )
              throw new Error()
            return row as string[]
          })
        })
        return workbook
      } catch {
        throw new Error('sheets_unavailable')
      }
    },
    /** Append-only, one atomic Google batch; stringValue prevents formula execution. */
    async append(
      plan: Record<'Tracks' | 'Sources' | 'Aliases', string[][]>,
      expectedFingerprint: string,
    ): Promise<void> {
      let mutationStarted = false
      try {
        const current = await this.read()
        if ((await workbookFingerprint(current)) !== expectedFingerprint)
          throw new Error('stale_sheet')
        const names = ['Tracks', 'Sources', 'Aliases'] as const
        for (const tab of names) {
          const rows = plan[tab],
            limit = SHEET_LIMITS[tab]
          if (
            !Array.isArray(rows) ||
            rows.length + current[tab].length > limit.rows ||
            rows.some(
              (r) =>
                !Array.isArray(r) ||
                r.length > limit.columns ||
                r.some((v) => typeof v !== 'string' || v.length > 4000),
            )
          )
            throw new Error('staging_invalid')
        }
        if (names.reduce((n, k) => n + plan[k].length, 0) > 150)
          throw new Error('staging_too_many_changes')
        if (names.every((k) => !plan[k].length)) return
        const metadata = await call(
          '?fields=sheets(properties(sheetId,title))',
          { method: 'GET' },
        )
        if (!Array.isArray(metadata.sheets))
          throw new Error('sheets_unavailable')
        const ids = new Map<string, number>()
        for (const item of metadata.sheets) {
          if (!record(item) || !record(item.properties))
            throw new Error('sheets_unavailable')
          const p = item.properties
          if (
            typeof p.title === 'string' &&
            typeof p.sheetId === 'number' &&
            Number.isSafeInteger(p.sheetId)
          )
            ids.set(p.title, p.sheetId)
        }
        const requests = names
          .filter((k) => plan[k].length)
          .map((tab) => {
            const sheetId = ids.get(tab)
            if (sheetId === undefined) throw new Error('sheets_unavailable')
            return {
              appendCells: {
                sheetId,
                rows: plan[tab].map((r) => ({
                  values: r.map((stringValue) => ({
                    userEnteredValue: { stringValue },
                  })),
                })),
                fields: 'userEnteredValue',
              },
            }
          })
        // A lost response is uncertain. Caller reconciles by reading stable keys; never retry here.
        try {
          mutationStarted = true
          await call(':batchUpdate', {
            method: 'POST',
            body: JSON.stringify({ requests }),
          })
        } catch (error) {
          if (
            error instanceof SheetsHttpError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          )
            throw new Error(
              error.status === 429
                ? 'sheet_rate_limited'
                : 'sheet_append_rejected',
            )
          throw new Error('sheet_append_uncertain')
        }
      } catch (error) {
        if (!mutationStarted) {
          if (error instanceof SheetsHttpError && error.status === 429)
            throw new Error('sheet_rate_limited')
          if (
            error instanceof Error &&
            [
              'stale_sheet',
              'staging_invalid',
              'staging_too_many_changes',
              'sheets_unavailable',
            ].includes(error.message)
          )
            throw error
          throw new Error('sheet_append_not_sent')
        }
        throw error
      }
    },
    /**
     * Reads the automation round-trip tabs. A missing tab is reported as absent rather
     * than as an empty tab, so the caller can tell "operator has not created it" from
     * "agent wrote nothing"; silently treating the first as the second would let a
     * misconfigured workbook look like a quiet week forever.
     */
    async readAutomation(): Promise<Partial<AutomationBook>> {
      try {
        // A missing tab makes Google reject the whole batchGet, so each tab is read
        // separately and only its own absence is tolerated.
        const result: Partial<AutomationBook> = {}
        for (const tab of automationTabs) {
          let body: Record<string, unknown>
          try {
            body = await call(
              '/values/' +
                encodeURIComponent(AUTOMATION_RANGES[tab]) +
                '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE',
              { method: 'GET' },
            )
          } catch (error) {
            if (error instanceof SheetsHttpError && error.status === 400) continue
            throw error
          }
          const values = body.values ?? []
          const limit = AUTOMATION_LIMITS[tab]
          if (!Array.isArray(values) || values.length > limit.rows)
            throw new Error()
          result[tab] = values.map((row) => {
            if (
              !Array.isArray(row) ||
              row.length > limit.columns ||
              row.some((cell) => typeof cell !== 'string' || cell.length > 4000)
            )
              throw new Error()
            return row as string[]
          })
        }
        return result
      } catch (error) {
        if (error instanceof SheetsHttpError && error.status === 429)
          throw new Error('sheet_rate_limited')
        throw new Error('sheets_unavailable')
      }
    },
    /**
     * Append-only write to one automation tab, as string values so a cell beginning with
     * `=` is never evaluated as a formula. Unlike `append`, this does not take a staging
     * fingerprint: these tabs are outside the staging contract, and the caller dedupes on
     * a stable key instead.
     */
    async appendAutomation(tab: AutomationTab, rows: string[][]): Promise<void> {
      if (!rows.length) return
      const limit = AUTOMATION_LIMITS[tab]
      if (
        rows.length > limit.rows ||
        rows.some(
          (r) =>
            !Array.isArray(r) ||
            r.length > limit.columns ||
            r.some((v) => typeof v !== 'string' || v.length > 4000),
        )
      )
        throw new Error('automation_invalid')
      try {
        const current = await call('/values/' + encodeURIComponent(AUTOMATION_RANGES[tab]) +
          '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE', { method: 'GET' })
        const existing = current.values ?? []
        if (!Array.isArray(existing) || existing.length + rows.length > limit.rows)
          throw new Error('automation_capacity')
        if (existing.some((row) => !Array.isArray(row) || row.length > limit.columns ||
          row.some((cell) => typeof cell !== 'string' || cell.length > 4000)))
          throw new Error('automation_invalid')
        const metadata = await call('?fields=sheets(properties(sheetId,title))', {
          method: 'GET',
        })
        if (!Array.isArray(metadata.sheets)) throw new Error()
        const sheet = metadata.sheets.find(
          (item: unknown) =>
            record(item) &&
            record(item.properties) &&
            item.properties.title === tab,
        )
        if (!record(sheet) || !record(sheet.properties)) throw new Error()
        const sheetId = sheet.properties.sheetId
        if (typeof sheetId !== 'number' || !Number.isSafeInteger(sheetId))
          throw new Error()
        await call(':batchUpdate', {
          method: 'POST',
          body: JSON.stringify({
            requests: [
              {
                appendCells: {
                  sheetId,
                  rows: rows.map((r) => ({
                    values: r.map((stringValue) => ({
                      userEnteredValue: { stringValue },
                    })),
                  })),
                  fields: 'userEnteredValue',
                },
              },
            ],
          }),
        })
      } catch (error) {
        if (error instanceof Error && ['automation_capacity', 'automation_invalid'].includes(error.message)) throw error
        if (error instanceof SheetsHttpError && error.status === 429)
          throw new Error('sheet_rate_limited')
        throw new Error('automation_append_failed')
      }
    },
    async write(workbook: Workbook): Promise<void> {
      try {
        const data = tabs.map((tab) => {
          const limits = SHEET_LIMITS[tab],
            rows = workbook[tab]
          if (
            !Array.isArray(rows) ||
            rows.length > limits.rows ||
            rows.some(
              (row) =>
                row.length > limits.columns ||
                row.some(
                  (cell) => typeof cell !== 'string' || cell.length > 4000,
                ),
            )
          )
            throw new Error()
          // Explicit export replaces the dedicated tab ranges, including old trailing proposals.
          const values = Array.from({ length: limits.rows + 1 }, (_, i) =>
            Array.from(
              { length: limits.columns + 1 },
              (_, j) => rows[i]?.[j] ?? '',
            ),
          )
          return { range: SHEET_RANGES[tab], majorDimension: 'ROWS', values }
        })
        await call('/values:batchUpdate', {
          method: 'POST',
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        })
      } catch {
        throw new Error('sheets_unavailable')
      }
    },
  }
}
