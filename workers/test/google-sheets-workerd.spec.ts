import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from './miniflare-compat'

const TOKEN = 'synthetic-runtime-access-token'
const BODY_MARKER = 'synthetic-private-response-body'
const CELL = '=synthetic-literal-cell'
const EMAIL = 'runtime@synthetic.iam.gserviceaccount.com'
const book = {
  Tracks: [['runtime-track', CELL]],
  Sources: [],
  Aliases: [],
  Instructions: [['runtime-only instructions']],
}
type Call = { host: string; method: string; path: string }
let mf: Miniflare
let sequence = 0
let calls: Call[]
let jwtVerified: boolean
let bearerVerified: boolean
let writeVerified: boolean
let redirectAt: 'oauth' | 'sheets' | undefined
let redirectStatus: number

beforeAll(async () => {
  // Ephemeral RSA material belongs only to this test; it is never written or logged.
  const pair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(
      await webcrypto.subtle.exportKey('pkcs8', pair.privateKey),
    ).toString('base64') +
    '\n-----END PRIVATE KEY-----'
  const result = await build({
    stdin: {
      contents: `import { createGoogleSheetsClient } from './workers/catalogue/googleSheets';
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          const client = createGoogleSheetsClient({ ...env, CATALOGUE_SHEET_ID: url.searchParams.get('book') });
          try {
            if (url.searchParams.get('operation') === 'write') {
              await client.write({ Tracks: [[${JSON.stringify(CELL)}]], Sources: [], Aliases: [], Instructions: [] });
              return Response.json({ written: true });
            }
            return Response.json(await client.read());
          } catch (error) {
            return Response.json({ error: error.message }, { status: 502 });
          }
        }};`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0]!.text,
    compatibilityDate: '2025-12-01',
    bindings: {
      GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: EMAIL,
      GOOGLE_SHEETS_PRIVATE_KEY: pem,
    },
    // Keep the product's global fetch and workerd Request/redirect handling intact.
    // Only the outward network boundary is synthetic; it never contacts Google.
    outboundService: async (request) => {
      const url = new URL(request.url)
      calls.push({ host: url.host, method: request.method, path: url.pathname })
      const oauth =
        url.origin === 'https://oauth2.googleapis.com' &&
        url.pathname === '/token'
      const sheets =
        url.origin === 'https://sheets.googleapis.com' &&
        /^\/v4\/spreadsheets\/runtime-\d+\/values:batch(Get|Update)$/.test(
          url.pathname,
        )
      if (!oauth && !sheets) return new Response(null, { status: 500 })
      if (oauth) {
        const form = new URLSearchParams(await request.text())
        const [header, payload, signature] = (
          form.get('assertion') ?? ''
        ).split('.')
        const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
        const now = Math.floor(Date.now() / 1000)
        jwtVerified =
          request.method === 'POST' &&
          request.headers.get('content-type') ===
            'application/x-www-form-urlencoded' &&
          !request.headers.has('authorization') &&
          form.get('grant_type') ===
            'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
          JSON.parse(Buffer.from(header!, 'base64url').toString()).alg ===
            'RS256' &&
          claims.iss === EMAIL &&
          claims.aud === 'https://oauth2.googleapis.com/token' &&
          claims.scope === 'https://www.googleapis.com/auth/spreadsheets' &&
          Math.abs(now - claims.iat) < 60 &&
          claims.exp === claims.iat + 3600 &&
          (await webcrypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            pair.publicKey,
            Buffer.from(signature!, 'base64url'),
            Buffer.from(header + '.' + payload),
          ))
      } else {
        bearerVerified =
          request.headers.get('authorization') === 'Bearer ' + TOKEN
        if (request.method === 'POST') {
          const body = (await request.json()) as {
            valueInputOption: string
            data: { values: string[][] }[]
          }
          writeVerified =
            body.valueInputOption === 'RAW' &&
            body.data.length === 4 &&
            body.data[0]!.values[0]![0] === CELL
        }
      }
      if (redirectAt === (oauth ? 'oauth' : 'sheets')) {
        // Same-origin destinations would retain credentials on an accidental follow.
        return new Response(BODY_MARKER + ' ' + TOKEN, {
          status: redirectStatus,
          headers: { location: url.origin + '/redirect-sink' },
        })
      }
      if (oauth)
        return Response.json({
          access_token: TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      if (request.method === 'POST')
        return Response.json({ totalUpdatedCells: 1 })
      return Response.json({
        valueRanges: Object.entries(book).map(([tab, values]) => ({
          range: "'" + tab + "'!A1:Z100",
          values,
        })),
      })
    },
  })
})

beforeEach(() => {
  sequence++
  calls = []
  jwtVerified = bearerVerified = writeVerified = false
  redirectAt = undefined
})

afterAll(async () => {
  await mf?.dispose()
})

function dispatch(operation: 'read' | 'write') {
  return mf.dispatchFetch(
    `https://study.example/?book=runtime-${sequence}&operation=${operation}`,
  )
}

describe('Google Sheets native workerd transport', () => {
  it('reads Sheets through native fetch after a genuinely signed OAuth exchange', async () => {
    const response = await dispatch('read')
    const result = await response.json()
    expect({
      status: response.status,
      result,
      outboundCalls: calls.length,
    }).toEqual({
      status: 200,
      result: book,
      outboundCalls: 2,
    })
    expect(jwtVerified).toBe(true)
    expect(bearerVerified).toBe(true)
    expect(calls.map(({ host, method }) => ({ host, method }))).toEqual([
      { host: 'oauth2.googleapis.com', method: 'POST' },
      { host: 'sheets.googleapis.com', method: 'GET' },
    ])
  })

  it('writes literal Sheets cells through native fetch after a genuinely signed OAuth exchange', async () => {
    const response = await dispatch('write')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ written: true })
    expect(jwtVerified && bearerVerified && writeVerified).toBe(true)
    expect(calls.map(({ host, method }) => ({ host, method }))).toEqual([
      { host: 'oauth2.googleapis.com', method: 'POST' },
      { host: 'sheets.googleapis.com', method: 'POST' },
    ])
  })

  for (const [stage, operation] of [
    ['oauth', 'read'],
    ['sheets', 'read'],
    ['sheets', 'write'],
  ] as const) {
    it.each([301, 302, 303, 307, 308])(
      `refuses ${stage} ${operation} HTTP %s once without following or exposing credentials/body`,
      async (status) => {
        redirectAt = stage
        redirectStatus = status
        const response = await dispatch(operation)
        const text = await response.text()
        expect(response.status).toBe(502)
        // Boolean assertions keep even synthetic credentials out of failure diagnostics.
        expect(text === '{"error":"sheets_unavailable"}').toBe(true)
        expect(
          [TOKEN, BODY_MARKER, 'BEGIN PRIVATE KEY', 'assertion='].some(
            (value) => text.includes(value),
          ),
        ).toBe(false)
        expect(jwtVerified).toBe(true)
        expect(
          calls.filter(({ host }) => host === 'oauth2.googleapis.com'),
        ).toHaveLength(1)
        expect(
          calls.filter(({ host }) => host === 'sheets.googleapis.com'),
        ).toHaveLength(stage === 'oauth' ? 0 : 1)
        expect(calls.some(({ path }) => path === '/redirect-sink')).toBe(false)
        expect(calls).toHaveLength(stage === 'oauth' ? 1 : 2)
        if (stage === 'sheets') {
          expect(bearerVerified).toBe(true)
          if (operation === 'write') expect(writeVerified).toBe(true)
        }
      },
    )
  }
})
